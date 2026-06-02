# Pi Discussion 草稿

> 用途：在 <https://github.com/earendil-works/pi/discussions/new?category=show-and-tell>
> （或选 General）发布介绍贴。
>
> 发之前请检查：npm 已发布、`pi install npm:pi-packages-manager` 能跑通、
> README 与 CHANGELOG 已 push 到 main、Release v1.0.0 在 GitHub 上可见。

---

## 英文版（推荐主帖用）

**Title**

```
pi-packages-manager — a Claude-style overlay panel for managing pi packages from inside pi
```

**Body**

```markdown
Hey folks 👋

I've been using pi for a while and noticed that managing packages is a bit
repetitive — install, /reload, list, search, repeat. So I built a small
extension that brings everything together in one Claude-style overlay panel.

**Repo**: https://github.com/RexYoung000/pi-packages-manager
**npm**: `pi install npm:pi-packages-manager`
**git**: `pi install git:github.com/RexYoung000/pi-packages-manager`

### What it does

- 📦 Overlay panel with `Tab` to switch Installed / Browse / Updates / Settings
- 🔍 Catalog with disk cache (24h TTL), keyword priority, fuzzy ranking, and
  filters like `type:skill`, `source:npm`, `scope:project`, `installed`,
  `updates`
- ⬇️ Install / remove / update flows with scope picker (Global vs Project),
  safety confirmation showing the actual `pi install` command, and reload
  prompts after success
- ⬆️ "Update all" with skip detection for pinned, git, and local sources
- 🛡️ Detail page surfacing extensions / skills / prompts / themes plus
  source type and trust warnings
- 🌐 Multi-language UI (English, 简体中文, 繁體中文, 日本語, 한국어) with an
  in-panel language switcher that takes effect immediately, no reload

### Quick start

```bash
pi install npm:pi-packages-manager
```

Then in pi:

```text
/reload
/packages-list
```

`Tab` / `⇧Tab` to switch tabs, `Enter` to open detail, `Esc` / `q` to close.

### Why I built it

I wanted to learn the extension API end to end, and the existing flows felt
fine for one-off commands but heavy when I'm testing several packages back
to back. The overlay keeps state across actions so I can browse → detail →
install → back to list without losing my place.

### Roadmap (v1.1 candidates)

- Live search input inside the panel (replace `/` flow)
- Detail side panel (split layout instead of close-and-reopen)
- In-panel install / remove / update shortcuts (`i` / `r` / `u`)
- Filter chips per tab (extension / skill / prompt / theme · npm / git / local)

Full roadmap: https://github.com/RexYoung000/pi-packages-manager/blob/main/docs/ROADMAP.md

Feedback and issues very welcome — especially if you have ideas for the
panel layout or shortcuts. Thanks for reading!
```

---

## 中文版（独立发或在英文帖下回贴）

**Title**

```
pi-packages-manager — Claude 风格的 pi 包管理面板
```

**Body**

```markdown
大家好 👋

最近在用 pi 时发现包管理流程比较碎：install、/reload、list、search 来来回回。
所以做了一个扩展，把这些操作聚合到一个 Claude 风格的 overlay 面板里。

**仓库**：https://github.com/RexYoung000/pi-packages-manager
**npm**：`pi install npm:pi-packages-manager`
**git**：`pi install git:github.com/RexYoung000/pi-packages-manager`

### 主要功能

- 📦 Overlay 面板，`Tab` 切换 已安装 / 社区 / 更新 / 设置
- 🔍 catalog 本地缓存（24h TTL）+ 关键字优先 + 模糊排序，支持过滤器：
  `type:skill`、`source:npm`、`scope:project`、`installed`、`updates`
- ⬇️ 安装 / 卸载 / 更新流程支持作用域选择（全局 / 项目）、安全确认（显示
  真实 `pi install` 命令）、成功后 reload 提示
- ⬆️ Update all 一键更新，自动跳过 pinned / git / local 来源
- 🛡️ 详情页展示 extension / skill / prompt / theme 资源以及来源类型与信任警告
- 🌐 多语言 UI（English / 简体中文 / 繁體中文 / 日本語 / 한국어），面板内
  即时切换，无需 reload

### 快速开始

```bash
pi install npm:pi-packages-manager
```

在 pi 里执行：

```text
/reload
/packages-list
```

`Tab` / `⇧Tab` 切换标签页，`Enter` 进入详情，`Esc` / `q` 关闭。

### 路线图（v1.1）

- 面板内嵌实时搜索框（替换 `/` 流程）
- 详情侧栏（split 布局，避免 close-and-reopen）
- 面板内 install / remove / update 快捷键
- 每个 tab 加 chip 过滤器

完整路线图：
https://github.com/RexYoung000/pi-packages-manager/blob/main/docs/ROADMAP.md

欢迎 issue 和反馈，尤其是面板布局和快捷键的建议。
```

---

## 备用：Show HN / Reddit r/LocalLLaMA 文案

**Title**

```
Show HN: pi-packages-manager — Claude-style overlay panel for the pi coding agent
```

**Body** 同上英文版的前两段（Hey folks 那段 + What it does），结尾加：

```
Source on GitHub: https://github.com/RexYoung000/pi-packages-manager
Built on top of pi (https://pi.dev) — terminal-based AI coding agent.
Happy to chat about how the overlay handles async catalog loading and
in-place language switching.
```

---

## 发布前 checklist

- [ ] `npm publish` 成功，`npm view pi-packages-manager` 能看到 1.0.0
- [ ] `pi install npm:pi-packages-manager` 能装上（可在干净目录验证）
- [ ] gallery 收录（一般 24h 内出现在 https://pi.dev/packages）
- [ ] GitHub release v1.0.0 已带 tarball
- [ ] README 顶部有 [English](README.md) · [简体中文](README.zh-CN.md) 切换
- [ ] CHANGELOG 1.0.0 条目完整
- [ ] LICENSE 存在

发完帖后建议把帖子链接填回到 README 顶部 "Discussion" 一节，方便后来者找到。
