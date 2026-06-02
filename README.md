# pi-packages-manager

A Pi packages manager extension for browsing, searching, installing, updating, and removing Pi packages from inside Pi.

## Status

Early development. The current implementation is migrated from the global extension and will be iterated into a Claude-style packages manager UI.

## Commands

```text
/packages-list
/packages-list list
/packages-list search [query]
/packages-list install <source-or-package>
/packages-list remove <source-or-package>
/packages-list update [source-or-package]
/packages-list info <source-or-package>
/packages-list settings
/packages-list refresh
```

## Local development

Run the extension directly:

```bash
pi -e ./src/index.ts
```

Or install this local package:

```bash
pi install ./path/to/pi-packages-manager
```

After installing or changing extensions, reload Pi:

```text
/reload
```

## Roadmap

See [docs/PLUGIN_MANAGER_OPTIMIZATION.md](docs/PLUGIN_MANAGER_OPTIMIZATION.md).
```
