# PLAN: 本地翻译特性 — pi-packages-manager

## 背景

用户希望在插件包的 detail 详情页内，通过快捷键 `t` 将 README 文档内容从英文翻译为中文。翻译依赖本地运行的 MTranServer（`http://localhost:8989`）。

## API 确认（实测）

| 项目 | 值 |
|------|-----|
| 默认地址 | `http://localhost:8989` |
| 健康检查 | `GET /health` → 200 OK |
| 翻译端点 | `POST /translate` |
| 请求体 | `{"from":"en","to":"zh-Hans","text":"..."}` |
| 响应体 | `{"result":"..."}` |
| 鉴权 | 无（已实测） |

## 架构改动

```
src/
├── translation.ts      ← 新增：MTranServer API 客户端 + 分段翻译缓存
├── locale.ts           ← 修改：Preferences 增加 translationUrl 字段
├── ui/
│   └── panel.ts        ← 修改：Settings 新增翻译配置区 + Detail 新增 t 快捷键
└── README.md           ← 修改：增加翻译配置说明
```

---

## 分步实现

### Step 1: 新增 `src/translation.ts`

**职责**:

- 调用 MTranServer API 做翻译
- 分段解析 README（按 `##` / `###` 标题切分）
- 管理翻译缓存（单独文件，不同于 i18n 的 `translations.json`）

**核心类型**:

```typescript
// 翻译服务配置
interface TranslationConfig {
  url: string;           // 默认 "http://localhost:8989"
  enabled: boolean;      // 健康检查通过后为 true
  targetLang: string;    // "zh-Hans"
}

// README 的一个分段
interface ReadmeSection {
  heading: string;       // "## Features"
  body: string;          // "- Tool A\n- Tool B\n..."
  translated?: string;   // 翻译后的 body
  loading: boolean;      // 是否正在翻译
}

// 缓存条目（按 pkgName 索引，整份 README 的翻译缓存）
interface TranslationCacheEntry {
  sections: Array<{ heading: string; body: string; translated: string }>;
  translatedAt: number;
}
```

**导出函数**:

| 函数 | 说明 |
|------|------|
| `checkService(url)` | `GET /health` 超时 3s → 返回 boolean |
| `translateText(url, text)` | `POST /translate` → 返回 `result` 字符串 |
| `parseReadme(readme)` | 按 `##`/`###`/`####` 标题解析为 `ReadmeSection[]` |
| `reconstructReadme(sections)` | 将 sections 合并回 markdown 字符串（原样保留标题） |
| `getTranslationCache(pkgName)` | 读缓存 |
| `setTranslationCache(pkgName, sections)` | 写缓存 |
| `clearTranslationCache()` | 清空（在设置中可操作） |

**缓存文件**: `~/.pi/agent/extensions/pi-packages-manager/data/translations_readme.json`

缓存 key: `"pkgName:en->zh-Hans"`，避免不同语言来源冲突。

**分段翻译策略**:

- 首次按 `t` 时，从前到后翻译所有 sections
- 每个 section 独立发起 `fetch` 请求
- 使用 `Promise.allSettled` 并行翻译所有 sections，但每个 section 独立更新 UI
- 正在翻译的 section 显示 `⠋ [译中...]`
- 翻译完的 section 显示翻译内容
- 再按 `t` 切换回原文（直接从缓存恢复，无需重新请求）

---

### Step 2: 修改 `src/locale.ts` — Preferences 增加翻译配置

```typescript
interface Preferences {
  locale?: Locale;
  translationUrl?: string;    // 新增
}
```

- 默认值：`"http://localhost:8989"`
- 导出 `getTranslationUrl()` / `setTranslationUrl(url)`
- 保存到同一个 `preferences.json` 文件

---

### Step 3: 修改 `src/ui/panel.ts` — Settings Tab + Detail View

#### 3a: Settings tab 新增「本地翻译」区域

在现有的 Settings tab（`renderSettingsTab` 函数中），语言区之后、缓存区之前，插入新的 section：

```
┌─ 本地翻译 ─────────────────────────────┐
│  MTranServer: http://localhost:8989     │
│  Status: ✅ 已连接 (ping xx ms)          │
│                                         │
│  [m] 修改地址 · [t] 测试连接            │
│  [x] 清空翻译缓存                       │
└─────────────────────────────────────────┘
```

- `m` 键：调用 `ctx.ui.input()` 输入新 URL
- `t` 键：健康检查 → 更新状态显示
- `x` 键：清空 README 翻译缓存

进入 settings tab 时自动做一次健康检查。

#### 3b: Detail view 新增翻译快捷键 `t`

**状态变量（在 panel closure 中）**:

```typescript
let translationMode = false;         // false=原文, true=翻译模式
let translatedSections: ReadmeSection[] | null = null;  // 翻译后的分段
```

**快捷键 `t`**:

1. 按 `t` 第一次：进入翻译模式
   - 如果缓存命中 → 直接显示翻译（全量切换）
   - 如果缓存未命中 → 解析 README → 分段并行翻译
   - 每个 section 完成后更新 UI → `rebuild(); tui.requestRender();`
   - 正在翻译显示 `⠋ [译中...]`
2. 按 `t` 第二次：切回原文
   - `translationMode = false`，rebuild 显示原始 README
3. 按 `t` 第三次：切回翻译模式（已有缓存，立即显示）
   - `translationMode = true`，用缓存数据 rebuild

**README 渲染逻辑修改**:

```typescript
// 渲染 README
if (info.readme) {
  if (translationMode && translatedSections) {
    // 用翻译后的 sections 重建 markdown
    const translatedMd = reconstructReadme(translatedSections);
    container.addChild(new Markdown(translatedMd, 1, 0, mdTheme));
  } else {
    // 原始 README
    container.addChild(new Markdown(info.readme, 1, 0, mdTheme));
  }
}
```

**分段渲染中，未完成翻译的 section 显示**：

```
## Features
⠋ [翻译中...]
```

翻译完成后替换为：

```
## Features
该包提供了以下功能：...
```

**帮助信息更新**: 底部 help bar 增加 `· t 翻译` 提示。

---

### Step 4: 更新 `README.md`

在文档末尾增加「本地翻译」配置说明：

```markdown
## 本地翻译

本插件支持通过 [MTranServer](https://github.com/xxnuo/MTranServer) 
对包详情页的 README 文档进行实时翻译。

### 配置要求

1. 启动 MTranServer：
   ```bash
   docker run -d -p 8989:8989 xxnuo/mtranserver:latest
   ```
1. 在插件 Settings 中配置翻译地址（默认 `http://localhost:8989`）
2. 在包详情页按 `t` 键切换翻译

### 支持的翻译语言

MTranServer 支持 55+ 种语言互译（见 `/languages` 端点）。
默认目标语言为简体中文（zh-Hans），如需其他语言可在 Settings 中修改。

```

---

## 执行步骤

- [ ] Step 1: 创建 `src/translation.ts` — API 客户端 + README 分段解析 + 缓存
- [ ] Step 2: 修改 `src/locale.ts` — Preferences 增加 translationUrl
- [ ] Step 3: 修改 `src/ui/panel.ts` — Settings 翻译区 + Detail 翻译快捷键
- [ ] Step 4: 更新 `README.md` — 翻译配置文档

## 验证

1. 启动 MTranServer（Docker）
2. 打开 `/packages-list panel` → Settings tab → 确认「MTranServer: ✅ 已连接」
3. 进入任意包详情页 → 按 `t` → 看到分段翻译 + 旋转指示符 → 翻译完成
4. 再按 `t` → 回到原文
5. 再按 `t` → 从缓存读取，立即显示翻译
6. 断开 MTranServer → 按 `t` → 应有友好提示
