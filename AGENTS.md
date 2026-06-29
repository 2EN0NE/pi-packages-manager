# pi-packages-manager — 核心逻辑要点

## 项目概览

一个 Pi 扩展插件管理器，提供类 Claude Code 风格的包管理体验：浏览、搜索、安装、卸载、更新 Pi 插件。支持 **overlay 面板** + **CLI 子命令** + **4 个 LLM 可调用工具** 三种交互模式。

---

## 核心架构（6 个模块）

```
src/
├── index.ts       # 入口：注册 /packages-list 命令，主循环
├── api.ts         # 数据层：npm registry 搜索、catalog 缓存、安装/卸载流程
├── search.ts      # 搜索层：查询解析、模糊排名打分
├── security.ts    # 安全层：两层静态审计（metadata + 源码扫描）
├── tools.ts       # 工具层：4 个 LLM 可调用工具
├── i18n.ts        # 本地化：5 语言 UI 文本 + 种子翻译
├── locale.ts      # 偏好持久化：语言设置存/读
└── ui/
    ├── panel.ts       # Overlay 面板：多 tab、filter chip、inline detail
    └── package-list.ts # 自定义滚动列表组件（3 行/条目）
```

---

## 关键逻辑要点

### 1. 安全审计（最核心的安全设计）— `security.ts`

**设计目标：Never auto-installs。高/危包必须用户显式确认。**

两层审计 + 4 级风险：

| 层级 | 方法 | 耗时 |
|------|------|------|
| Layer 1: Metadata | `npm view <pkg> --json` → 依赖数、文件数、npm flags.insecure | ~2s |
| Layer 2: Source scan | `npm pack` + `tar` + grep 15 种危险模式（eval, execSync, rm -rf, child_process...） | ~5-15s |

风险聚合规则（`evaluateRisk()`）：

- `critical`: 任何 critical 发现 → 强制两步确认
- `high`: 任何 high 发现 / extension 有 high 发现
- `medium`: 3+ medium 发现
- `low`: 1-2 medium 或任意 low
- `safe`: 深度扫描无发现
- `unknown`: 仅 metadata（扫描失败）

关键特性：

- **Fail-safe**：审计失败不阻塞安装，降级显示错误
- **1.5MB 文件跳过**：防止大文件拖慢扫描
- **Extension 更严格**：extension 高/危发现自动升级风险等级

### 2. 安装流程（最长的用户交互路径）— `index.ts:installPackageFlow()`

```
用户输入包名
  → 选择 scope（Global / Project）
  → 运行安全审计（auditPackage）
  → 风险展示
    ├─ high/critical → 必须选 "Install anyway"
    └─ safe/low/medium → 标准 yes/no 确认
  → 逐行 streaming 展示 pi install 进度
  → 安装成功 → 清 catalog 缓存 → 提示 reload
  → 安装失败 → 显示错误（含 EACCES 修复建议）
```

### 3. 卸载/清理 — `index.ts:removePackageFlow()`

```
找到设置中的引用（可能同时有 global + project）
  → 用户选择从哪个 scope 移除
  → 尝试 pi uninstall（异步）
    ├─ 成功 → 清缓存 → 提示 reload
    └─ 失败 → fallback：从 settings.json 直接移除引用
```

### 4. 更新检查 — `index.ts:updatePackages()`

- 跳过 git/local/pinned 源（标记 `skipReason`）
- npm 源包并发查 registry.dist-tags
- 支持"全部更新"和"逐个更新"

### 5. 搜索排名 — `search.ts:rankPackages()`

多重加权排名（`rankPackageDetails`）：

- 精确名称匹配: +1000
- 名称前缀: +300
- 名称包含: +150
- 关键字匹配: +80/个
- 类型匹配: +50
- 描述匹配: +30
- 作者匹配: +25
- Pi manifest 存在: +120（官方权重高）
- pi-package keyword: +100
- 已安装: +20
- 下载量对数: +~10~60
- 近 30 天更新: +20

查询语法：支持 `type:extension` / `source:npm` / `scope:project` / `installed` / `updates` 过滤器。

**2025 年搜索重构**：面板搜索不再过滤本地缓存。用户键入时触发 500ms debounce，停笔后自动调用 `searchNpmRegistry()` 从 npm registry 实时获取结果。按 Enter 立即搜索。搜索中显示 `◐ searching npm...` 指示。Esc 清空恢复。搜索总数（分母）始终是 npm registry 返回的真实结果数。

**CLI 命令行搜索**：`/packages-list search <query>` 带查询词时直接输出文本结果（非交互），例如 `/packages-list search worktree` 返回 **212 个**匹配包。

**独立 CLI 脚本**：`node cli-search.mjs <query>` 可直接搜索 npm registry 并输出结果。

### 6. 目录缓存体系 — `api.ts`

三级缓存，逐级退化：

1. **内存缓存** `catalogCache`: session 内复用
2. **磁盘缓存** `~/.pi/agent/cache/.../catalog.json`: 24h TTL
3. **实时 npm 查询**: fallback

多查询并行预取（`fetchFullCatalog`）：`keywords:pi-package` + `keywords:pi-extension` + `keywords:pi-skill` + `pi-coding-agent`，去重合并后按排名排序。

已安装包 5s TTL 内存缓存（`installedPackagesCache`），install/uninstall 后失效。

### 7. AI 语义搜索 — `api.ts:aiSemanticSearch()`

通过 `pi -p --no-session` 调用当前 LLM：

- 取 catalog 前 60 个包（按下载量）
- 构建 prompt：列出包名+描述 → 问 LLM 最匹配哪些
- 解析返回的包名 → 匹配 catalog → 返回结果
- 失败时自动 fallback 到关键词搜索

### 8. Overlay 面板交互 — `ui/panel.ts`

4 个 Tab（installed / browse / updates / settings）+ filter chip（All / extension / skill / prompt / theme）+ 搜索栏 + inline detail 视图。

关键交互模式：

- `Tab` / `⇧Tab`: 切换 tab
- `1-5`: 按类型过滤
- `/`: 聚焦搜索栏
- `i/r/u/a`: 安装/卸载/更新/审计快捷操作
- `?`: 帮助覆盖层
- `Enter`: 打开 inline detail（含 README 渲染 + 操作按钮）

### 9. LLM 工具注册 — `tools.ts`

4 个类型安全工具，用户可用自然语言调用：

- `packages_search(query, type?, limit?)` → 搜索
- `packages_detail(name)` → 包详情
- `packages_audit(name, deepScan?)` → 安全审计
- `packages_install(name, scope?)` → 审计 → 确认 → 安装

### 10. 多语言支持 — `i18n.ts` + `locale.ts`

5 语言：en / zh-CN / zh-TW / ja / ko

- `i18n.ts`: 全量 UI 文本映射 + 种子翻译（热门包的本地化描述）
- `locale.ts`: 偏好持久化（global > project 覆盖优先级）+ 一键重置
- `~/.pi/agent/extensions/pi-packages-manager/data/preferences.json` × `<cwd>/.pi/pi-packages-manager.json`

---

## 自动化验证命令

```bash
# ─── 所有测试 ───
node --test --experimental-strip-types tests/*.test.mjs

# ─── 仅安全审计单元测试（纯逻辑，无 IO） ───
node --test --test-name-pattern="evaluateRisk|DANGER_PATTERNS|RISK_BADGE|__rank__" tests/security.test.mjs

# ─── 安全审计集成测试（需要 npm + 网络） ───
node --test --test-name-pattern="auditPackage" tests/security.test.mjs

# ─── 类型检查（tsc，无 emit） ───
npx tsc --noEmit 2>&1 | head -30

# ─── 加载验证（确认 extension 能被 pi 加载） ───
pi -e ./src/index.ts --version

# ─── 打包 dry-run（检查 files 字段完整性） ───
npm pack --dry-run 2>&1

# ─── ESLint / 代码风格 ───
npx eslint src/ tests/ 2>&1 || echo "no eslint config"

# ─── 源码审计模式扫描自测 ───
# 对自身代码运行安全审计使用的 15 种危险模式 grep
grep -rn -E '\b(rm\s+-rf|rimraf|fs\.unlink|eval\s*\(|execSync|spawn|child_process)' src/ --include='*.ts' | grep -v 'DANGER_PATTERNS' | grep -v '//.*grep' || echo "no unexpected patterns"

# ─── 完整 catalog 缓存测试（离线模式） ───
# 清缓存 → 初始化时应有正确的 fallback
rm -f ~/.pi/agent/cache/pi-packages-manager/catalog.json

# ─── 缓存权限错误修复命令验证 ───
ls -la ~/.npm/_cacache 2>&1 | head -3
```

---

## 设计原则

1. **Never auto-installs** — 高/危包必须先展示审计结果，用户必须显式确认
2. **Fail-safe** — 审计/网络失败不阻塞，降级到 metadata-only / 缓存数据
3. **Cache everything** — 磁盘（24h TTL）+ 内存（session）+ 内存（5s installed）
4. **并行加速** — catalog 多查询并发、更新检查并发、下载量批量查询
5. **Streaming UX** — 安装进度逐行推送（非 execSync 阻塞）
6. **优先本地** — 搜索先查 catalog 缓存（免网络），不够再查 npm registry

### 11. 紧凑/详细列表模式切换

所有列表视图（面板 PackageList、CLI paginatedView、listInstalled）支持紧凑和详细两种显示模式：

| 模式 | 面板 (z 键) | CLI (操作按钮) | 条目高度 | maxRows |
|------|------------|---------------|---------|---------|
| detailed (默认) | 3 行 + 空行 | 2 行 + 空行 | ~4 行 | 8 |
| compact | 1 行，无空行 | 1 行 | ~1 行 | 24 |

紧凑模式可见数量大约是详细模式的 3-4 倍。

- **面板**：按 `z` 键切换（帮助栏会显示当前模式）
- **CLI**：在 `paginatedView` 操作区选择 "Compact view" / "Detailed view"
