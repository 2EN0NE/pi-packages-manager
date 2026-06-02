# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Pre-install security audit** (`src/security.ts`): a static analysis
  module that runs before every install. It checks package metadata via
  `npm view` and performs a keyword scan of the published source code
  (`npm pack` + `tar` + grep against 15 known-dangerous patterns including
  `rm -rf`, `rimraf`, `fs.unlink`, `eval`, `Function`, `execSync`, `spawn`).
- **4-tier risk classification** (`safe` / `low` / `medium` / `high` /
  `critical`): extensions with `critical` or `high` findings trigger a
  two-step confirmation (a select with an explicit "Install anyway"
  option) instead of a regular yes/no prompt. Lower-risk packages still
  see the audit summary in their confirmation dialog.
- **`npm test`** script: 14 unit + integration tests covering risk
  evaluation, pattern catalog integrity, and end-to-end audit against a
  real npm package. Requires Node ≥ 22.6 for `--experimental-strip-types`.

### Credits

- Security audit module adapted from
  [pi-marketplace](https://github.com/507/pi-marketplace) by
  [@ssdiwu](https://github.com/ssdiwu).

## [1.0.1] - 2026-06-02

### Changed

- Updated README release links for npm, Pi Discussion, and public package
  install instructions.
- Refreshed status badges to `1.0.1`.

## [1.0.0] - 2026-06-02

First stable release. Project is now ready to be shared via the Pi packages
gallery.

### Added

- Claude-style overlay panel as the default UI (`/packages-list`)
  - Tabs: Installed / Browse / Updates / Settings
  - Custom `PackageList` component with relaxed line spacing (3 lines per item
    plus a blank gap)
  - Async lazy loading of catalog and updates
- Multi-language UI: English, 简体中文, 繁體中文, 日本語, 한국어
  - In-panel language switcher (Settings tab)
  - Effective immediately (no reload)
  - Persisted to `~/.pi/agent/extensions/pi-packages-manager/data/preferences.json`
  - Project-level override via `<cwd>/.pi/pi-packages-manager.json`
- Subcommands: `list`, `search`, `install`, `remove`, `update`, `info`,
  `settings`, `refresh`, `panel`, `legacy`
- Catalog disk cache with 24h TTL, `keywords:pi-package` priority, fuzzy
  ranking and filter parser (`type:`, `source:`, `scope:`, `installed`,
  `updates`, ...)
- Install/Remove/Update flows
  - Scope selection (Global vs Project)
  - Safety confirmation showing the actual `pi install` / `pi uninstall` command
  - Reload prompt after success
  - Update all + per-package update with auto scope detection
  - Skips pinned/git/local sources during update with reasons
- Detail page resources (Extensions / Skills / Prompts / Themes) and Security
  info (source / sourceType / pinned / trust warning)
- Settings page (legacy select-list version) showing global and project
  packages with scope, pinned, source type, version and types

### Changed

- Renamed extension from `plugin-manager` (global) to standalone
  `pi-packages-manager`
- Command renamed from `/plugin` to `/packages-list`
- Catalog cache moved to `~/.pi/agent/cache/pi-packages-manager/`

### Fixed

- npm `npm:` prefix duplication when normalising sources
- Scoped registry URL handling
- execFile usage to avoid shell injection
- Settings reads now traverse multiple scopes correctly
