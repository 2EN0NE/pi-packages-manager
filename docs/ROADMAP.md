# Roadmap

pi-packages-manager 后续版本迭代计划。按优先级排列，标注工作量与参考来源。

更新时间：2026-06-03
当前版本：**1.0.3**

---

## 已完成

### v1.0.0 — 基础功能

- 项目化：独立仓库 + GitHub
- 数据层：catalog 缓存、关键字优先、filter 解析、fuzzy ranking
- 交互逻辑：Install/Remove/Update scope 选择、安全确认、reload 提示
- Settings 页（select 列表版）
- Claude 风格 overlay 面板（Tab 切换 / 异步加载）
- Settings 页内置语言切换器（5 种语言）
- 自定义 PackageList 组件（每项 3 行 + 1 空行）
- 命名统一：`/packages-list`、`pi-packages-manager`
- npm 发布 + GitHub Actions

### v1.0.3 — 搜索修复 + UI 优化

- 修复 TUI 焦点管理：搜索后无法按键操作的崩溃问题
- 搜索栏 UI 重设计：三种状态（空闲/活跃/有结果）视觉区分
- 引入 `dismissed` 防护，防止异步回调在面板关闭后操作 TUI
- 删除 `~/.pi/agent/extensions/` 旧版残留导致的命令重复注册

---

## 迭代计划

### v1.1.0 — 安全审计 + Tool 工具化

> 竞品参考：[pi-marketplace](https://www.npmjs.com/package/pi-marketplace)（作者 diwu507）

| # | 特性 | 说明 | 工作量 |
|---|------|------|--------|
| **A** | 🔒 源码安全审计 | 下载 tarball 扫描 `.ts/.js/.mjs`，分四级标记危险模式（🔴 Critical / 🟠 High / 🟡 Medium / 🟢 Low）。两层审计：Layer 1 元数据检查（零成本），Layer 2 源码关键词扫描。参考 pi-marketplace 的审计实现 | 2 天 |
| **B** | 🛠 注册 Pi 工具 | 注册 `packages_search` / `packages_detail` / `packages_audit` / `packages_install` 四个工具，用户可通过自然语言触发（"帮我找一个 MCP 相关的包"）。与现有 `/packages-list` 命令并存 | 1.5 天 |
| **C** | 🌐 pi.dev 数据富化 | 动态检测可用 web fetch 工具（tinyfish / web-fetch 等），搜索结果补全 pi.dev 上的展示数据（截图、分类标签） | 1 天 |
| **D** | 📝 审计报告嵌入详情页 | 在 `showPackageDetail` 的 Security 区域展示源码扫描结果，用颜色标记各级别，附免责声明 | 0.5 天 |

**预计工期：5 天**

---

### v1.2.0 — 面板交互升级

| # | 特性 | 说明 | 工作量 |
|---|------|------|--------|
| **E** | 📋 详情侧栏 | `Enter` 不关闭 panel，右侧 split 区渲染详情（版本、作者、Resources、Security）。`←` 收起。安装/删除/更新直接在右侧执行 | 1.5 天 |
| **F** | ⚡ 操作快捷键 | 面板内不进详情直接操作：`i` 安装、`r` 删除、`u` 更新、`?` 帮助 overlay | 0.5 天 |
| **G** | 🏷 过滤器 chip | Tab 下方加 chip 栏：`[All] [extension] [skill] [prompt] [theme]`，按 `1-5` 切换。Browse 加来源筛选 `[npm] [git] [local]` | 0.5 天 |
| **H** | 📊 状态增强 | Loading spinner（异步加载时）、空状态重试（网络错误时"按 r 重试"）、visual scrollbar | 0.5 天 |

**预计工期：3 天**

---

### v1.3.0 — 质量 + 扩展

| # | 特性 | 说明 | 工作量 |
|---|------|------|--------|
| **I** | 🧪 单元测试 | `search.ts`（filter parser、ranking）、`locale.ts`（持久化优先级）、`api.ts`（mock registry）。vitest + fixtures | 1-2 天 |
| **J** | ⚙️ Settings 扩展 | catalog 缓存状态 + 刷新、项目级 vs 全局级语言开关、偏好重置、pi config 集成 | 1 天 |
| **K** | 📖 包详情 README 渲染 | 详情页展示包的 README（用 pi-tui 的 Markdown 组件） | 1 天 |
| **L** | 📦 安装进度条 | 捕获 `pi install` stdout，在面板内展示安装进度 | 0.5 天 |

**预计工期：3.5-4 天**

---

### v2.0.0 — 架构重构

| # | 特性 | 说明 | 工作量 |
|---|------|------|--------|
| **M** | 🏗 flows 拆分 | `index.ts` 800+ 行拆到 `src/flows/` 下（install、remove、update、detail） | 0.5 天 |
| **N** | 🗑 删 legacy 菜单 | `/packages-list legacy` 完全移除，panel 是唯一入口 | 0.5 天 |
| **O** | 🌍 i18n 重构 | 5 种语言从单文件拆成独立 JSON + loader，加 key 时只改一处 | 1 天 |
| **P** | 🔄 网络错误重试 + 离线降级 | registry 请求失败自动重试，离线时只展示已安装 + 缓存数据 | 1 天 |
| **Q** | 🤖 AI 推荐 | 基于已装包推荐相关包，纳入 Browse tab 的 AI 搜索结果 | 1 天 |
| **R** | ❤️ 收藏/置顶包 | 本地收藏列表，置顶显示在 Browse 和 Installed 顶部 | 0.5 天 |
| **S** | 📌 主界面状态栏 | Pi footer 展示可用更新数量 | 0.5 天 |

**预计工期：5 天**

---

## 版本时间线

```
v1.0.3 ─── 当前（搜索修复 + UI 优化）
  │
  ▼
v1.1.0 ─── 安全审计 + Tool 工具化（核心差异化升级）
  │
  ▼
v1.2.0 ─── 面板交互升级（侧栏 + 快捷键 + chip）
  │
  ▼
v1.3.0 ─── 质量 + 扩展（测试 + Settings + README + 进度条）
  │
  ▼
v2.0.0 ─── 架构重构（拆分 + 删 legacy + i18n + AI 推荐）
```

---

## 竞品参考笔记

### pi-marketplace（diwu507）

- **值得学习**：
  - 🔒 两层安全审计（元数据 + 源码扫描），分 4 级标记 — **v1.1.0 直接引入**
  - 🛠 Tool 架构让用户通过自然语言触发 — **v1.1.0 注册 Pi 工具**
  - 🔌 Tool-agnostic web fetch 检测 — **v1.1.0 pi.dev 富化时参考**
  - 零依赖，纯 TypeScript
- **我们的差异化优势**：
  - 🖥 完整 TUI 面板（Tab 切换、分页、键盘导航）vs 他的纯工具调用
  - 📋 全生命周期管理（安装/卸载/更新/设置）vs 他只做搜索+安装
  - 🌍 多语言 i18n vs 他只有英文
  - 📦 本地目录预取缓存 + AI 语义搜索
  - ⚡ 实时搜索过滤（输入即过滤列表）

---

## 已知技术债

- `index.ts` 800+ 行，逻辑都在一个 closure 里。v2.0 拆到 `src/flows/`
- `panel.ts` rebuild 每次重建整个 Container，性能可优化
- legacy 菜单还在（`/packages-list legacy`），v2.0 删除
- i18n.ts 5 种语言写死，加 key 时 5 处改。v2.0 改成独立 JSON 文件

---

## 链接

- 仓库：<https://github.com/RexYoung000/pi-packages-manager>
- npm：<https://www.npmjs.com/package/pi-packages-manager>
- 设计文档：[PLUGIN_MANAGER_OPTIMIZATION.md](./PLUGIN_MANAGER_OPTIMIZATION.md)
