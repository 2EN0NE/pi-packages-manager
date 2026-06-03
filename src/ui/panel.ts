/**
 * pi-packages-manager/ui/panel.ts
 *
 * Claude-style overlay panel for the packages manager.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │  📦 Pi Packages Manager                      │
 *   │  [Installed]  Browse  Updates  Settings      │
 *   ├──────────────────────────────────────────────┤
 *   │  ● pi-tinyfish-tools                  v0.1   │
 *   │    TinyFish 网页代理工具                     │
 *   │    extension·skill · user · npm              │
 *   │                                              │
 *   │  ○ pi-autoname                       v0.5.13 │
 *   │    AI 驱动会话命名                           │
 *   │    ...                                       │
 *   ├──────────────────────────────────────────────┤
 *   │  Tab/⇧Tab 切换 · ↑↓ 选择 · ↵ 详情 · Esc 关闭  │
 *   └──────────────────────────────────────────────┘
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Box,
  Container,
  Input,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  checkForUpdates,
  fetchFullCatalog,
  getInstalledPackageRefs,
  getInstalledPackages,
  searchNpmRegistry,
  type PackageInfo,
} from "../api";
import {
  getTranslatedDescription,
  type Locale,
  SUPPORTED_LOCALES,
  t,
} from "../i18n";
import { rankPackages } from "../search";
import { PackageList, type PackageListItem } from "./package-list";

const TAB_KEYS = ["installed", "browse", "updates", "settings"] as const;
type TabKey = typeof TAB_KEYS[number];

export type PanelResult =
  | { action: "detail"; pkg: PackageInfo }
  | { action: "browse-search" }
  | { action: "settings-config" }
  | { action: "change-locale"; locale: Locale }
  | null;

interface PanelOptions {
  initialTab?: TabKey;
  locale: Locale;
}

export async function showPackagesPanel(
  ctx: ExtensionCommandContext,
  options: PanelOptions,
): Promise<PanelResult> {
  const { initialTab = "installed", locale } = options;

  return ctx.ui.custom<PanelResult>((tui, theme, _kb, done) => {
    let currentTab: TabKey = initialTab;
    let currentPkgs: PackageInfo[] = [];
    let unfilteredPkgs: PackageInfo[] = []; // full list before search filter
    let cachedCatalog: PackageInfo[] | null = null;
    let cachedUpdates: PackageInfo[] | null = null;

    // Focus: "search" = search input, "list" = package list
    let focusTarget: "search" | "list" = "list";

    // Guard: prevent async callbacks (loadBrowse/loadUpdates) from touching the
    // TUI after the panel has been dismissed via done().
    let dismissed = false;
    const safeDone = (result: PanelResult) => {
      if (dismissed) return;
      dismissed = true;
      done(result);
    };

    const container = new Container();
    let list: PackageList | null = null;
    let langSelector: SelectList | null = null;

    // The main custom component. We keep a reference so that async callbacks
    // (loadBrowse/loadUpdates) can safely check `dismissed` before touching the TUI.
    // Input routing is fully manual via handleInputImpl — we never delegate TUI
    // focus to child components (searchInput). Instead, we forward input to them
    // ourselves so we can intercept every keystroke for live search filtering.
    const mainComponent: { render(w: number): string[]; invalidate(): void; handleInput(d: string): void } = {
      render(w: number) { return container.render(w); },
      invalidate() { container.invalidate(); },
      handleInput(d: string) { handleInputImpl(d); },
    };

    // Search input component
    const searchInput = new Input();
    searchInput.onSubmit = () => {
      // Enter in search → move focus to list
      focusTarget = "list";
      searchInput.focused = false;
      rebuild();
      tui.requestRender();
    };
    searchInput.onEscape = () => {
      if (searchInput.getValue()) {
        // Clear search
        searchInput.setValue("");
        applySearch("");
        focusTarget = "list";
        searchInput.focused = false;
        rebuild();
        tui.requestRender();
      } else {
        // Empty search + Esc → back to list
        focusTarget = "list";
        searchInput.focused = false;
        rebuild();
        tui.requestRender();
      }
    };

    function listTheme() {
      return {
        selectedTitle: (s: string) => theme.fg("accent", theme.bold(s)),
        title: (s: string) => theme.fg("text", s),
        badge: (s: string) => theme.fg("success", s),
        description: (s: string) => theme.fg("muted", s),
        meta: (s: string) => theme.fg("dim", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        empty: (s: string) => theme.fg("muted", s),
        bullet: (s: string) => theme.fg("muted", s),
        selectedBullet: (s: string) => theme.fg("accent", s),
      };
    }

    function rebuild() {
      container.clear();

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("📦 " + t("menu.title", locale))), 1, 0));
      container.addChild(new Text(buildTabBar(theme, currentTab, locale), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

      if (currentTab === "settings") {
        renderSettingsTab();
      } else {
        // Prepare package data first so renderSearchBar can access result counts
        preparePackageData();
        renderSearchBar();
        renderPackageList();
      }

      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
      container.addChild(new Text(theme.fg("dim", buildHelpBar(currentTab, locale, focusTarget)), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    }

    function renderSearchBar() {
      const query = searchInput.getValue();
      const isActive = focusTarget === "search";

      if (isActive) {
        searchInput.focused = true;
        // Active search: render Input inside a highlighted Box
        const searchBox = new Box(1, 0, (s: string) => theme.fg("accent", theme.bold(s)));
        searchBox.addChild(searchInput);
        container.addChild(searchBox);
      } else if (query) {
        searchInput.focused = false;
        // Has query but not focused: show filter pill with result count
        const resultCount = currentPkgs.length;
        const totalCount = unfilteredPkgs.length;
        const pill = theme.fg("accent", theme.bold(" 🔍 ")) +
          theme.fg("text", truncateToWidth(query, 20, "…")) +
          theme.fg("dim", ` — ${resultCount}/${totalCount}`) +
          theme.fg("muted", `  [press / to edit]`);
        container.addChild(new Text(pill, 0, 0));
      } else {
        searchInput.focused = false;
        // No query: subtle hint with / shortcut
        const hint = theme.fg("dim", "  🔍 ") +
          theme.fg("muted", t("search.placeholder", locale)) +
          theme.fg("dim", "  [press /]");
        container.addChild(new Text(hint, 0, 0));
      }
    }

    function preparePackageData() {
      langSelector = null;
      const pkgs = collectPackages(currentTab, cachedCatalog, cachedUpdates);
      unfilteredPkgs = pkgs;
      currentPkgs = pkgs;

      // Apply current search filter
      const query = searchInput.getValue();
      if (query) {
        applySearch(query);
      }
    }

    function renderPackageList() {
      const items = currentPkgs.map((p) => packageToListItem(p, locale));
      list = new PackageList(items, 4, listTheme(), {
        emptyLabel: emptyMessage(currentTab, locale),
      });
      list.onSelect = (item) => {
        const pkg = currentPkgs.find((p) => p.name === item.value);
        if (pkg) safeDone({ action: "detail", pkg });
      };
      list.onCancel = () => safeDone(null);
      container.addChild(list);
    }

    function renderSettingsTab() {
      list = null;

      // Section header: language
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.fg("accent", theme.bold("  " + t("settings.section.language", locale))), 1, 0),
      );

      const langItems: SelectItem[] = SUPPORTED_LOCALES.map((entry) => ({
        value: entry.code,
        label: entry.code === locale ? `${entry.label}  ✓` : entry.label,
        description: entry.code,
      }));

      langSelector = new SelectList(langItems, Math.min(langItems.length, 6), {
        selectedPrefix: (s: string) => theme.fg("accent", s),
        selectedText: (s: string) => theme.fg("accent", s),
        description: (s: string) => theme.fg("dim", s),
        scrollInfo: (s: string) => theme.fg("dim", s),
        noMatch: (s: string) => theme.fg("warning", s),
      });
      langSelector.onSelect = (item) => {
        if (item.value !== locale) {
          safeDone({ action: "change-locale", locale: item.value });
        }
      };
      langSelector.onCancel = () => safeDone(null);
      container.addChild(langSelector);

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          theme.fg("muted", "  " + t("settings.tip.config", locale)),
          1,
          0,
        ),
      );
      container.addChild(new Spacer(1));
    }

    async function loadBrowse() {
      try {
        cachedCatalog = await fetchFullCatalog(80);
      } catch {
        cachedCatalog = [];
      }
      if (dismissed) return;
      if (currentTab === "browse") {
        rebuild();
        tui.requestRender();
      }
    }

    async function loadUpdates() {
      try {
        cachedUpdates = await checkForUpdates();
      } catch {
        cachedUpdates = [];
      }
      if (dismissed) return;
      if (currentTab === "updates") {
        rebuild();
        tui.requestRender();
      }
    }

    function switchTab(direction: 1 | -1) {
      const idx = TAB_KEYS.indexOf(currentTab);
      const next = TAB_KEYS[(idx + direction + TAB_KEYS.length) % TAB_KEYS.length];
      currentTab = next;
      // Clear search when switching tabs
      searchInput.setValue("");
      focusTarget = "list";
      searchInput.focused = false;
      rebuild();
      tui.requestRender();
      if (next === "browse" && cachedCatalog === null) {
        cachedCatalog = [];
        loadBrowse();
      }
      if (next === "updates" && cachedUpdates === null) {
        cachedUpdates = [];
        loadUpdates();
      }
    }

    /**
     * Apply search query to current package list.
     * For installed/updates: local fuzzy filter.
     * For browse: use rankPackages from search.ts.
     */
    function applySearch(query: string) {
      if (!query) {
        currentPkgs = unfilteredPkgs;
        return;
      }
      if (currentTab === "browse") {
        // For browse, use the ranking system which includes name/keyword/description matching
        currentPkgs = rankPackages(unfilteredPkgs, query, 60);
      } else {
        // For installed/updates: simple fuzzy local filter
        const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
        currentPkgs = unfilteredPkgs.filter((pkg) => {
          const text = `${pkg.name} ${pkg.description || ""} ${(pkg.keywords || []).join(" ")} ${pkg.author || ""}`.toLowerCase();
          return terms.every((term) => text.includes(term));
        });
      }
    }

    rebuild();

    if (initialTab === "browse" && cachedCatalog === null) {
      cachedCatalog = [];
      loadBrowse();
    }
    if (initialTab === "updates" && cachedUpdates === null) {
      cachedUpdates = [];
      loadUpdates();
    }

    // ─── Input handling (extracted so mainComponent can reference it) ───
    function handleInputImpl(data: string) {
      if (matchesKey(data, Key.tab)) {
        switchTab(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        switchTab(-1);
        return;
      }
      if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
        safeDone(null);
        return;
      }

      if (currentTab === "settings") {
        if (data === "g") {
          safeDone({ action: "settings-config" });
          return;
        }
        langSelector?.handleInput(data);
        tui.requestRender();
        return;
      }

      // ── Package tabs (installed / browse / updates) ──

      // Focus search input
      if (data === "/" && focusTarget === "list") {
        focusTarget = "search";
        searchInput.focused = true;
        // NOTE: We intentionally do NOT call tui.setFocus(searchInput) here.
        // Doing so would cause the TUI to route all input directly to the
        // searchInput, bypassing our handleInputImpl — which means the
        // per-keystroke applySearch() and list filter would never run.
        // Instead we keep focus on mainComponent and forward input manually.
        rebuild();
        tui.requestRender();
        return;
      }

      if (focusTarget === "search") {
        // Forward input to the search Input component manually.
        // We keep focus on mainComponent (not searchInput) so that we can
        // intercept every keystroke and update the filtered list in real time.
        searchInput.handleInput(data);

        // Re-filter on every keystroke
        const query = searchInput.getValue();
        applySearch(query);

        // Update the list items without full rebuild
        if (list) {
          const items = currentPkgs.map((p) => packageToListItem(p, locale));
          list.setItems(items);
        }

        tui.requestRender();
        return;
      }

      // focusTarget === "list"
      // Move focus to search on up arrow when at top of list
      if (matchesKey(data, Key.up) && list && list.isAtTop()) {
        focusTarget = "search";
        searchInput.focused = true;
        // Same as above: keep focus on mainComponent for manual routing.
        rebuild();
        tui.requestRender();
        return;
      }

      list?.handleInput(data);
      tui.requestRender();
    }

    return mainComponent;
  });
}

function collectPackages(
  tab: TabKey,
  cachedCatalog: PackageInfo[] | null,
  cachedUpdates: PackageInfo[] | null,
): PackageInfo[] {
  if (tab === "installed") return getInstalledPackages();
  if (tab === "browse") return cachedCatalog || [];
  if (tab === "updates") return cachedUpdates || [];
  return [];
}

function packageToListItem(pkg: PackageInfo, locale: Locale): PackageListItem {
  const desc = getTranslatedDescription(pkg.name, pkg.description, locale);
  const metaParts: string[] = [];
  if (pkg.types?.length) metaParts.push(pkg.types.join("·"));
  if (pkg.scope) metaParts.push(pkg.scope);
  if (pkg.sourceType) metaParts.push(pkg.sourceType);
  if (pkg.downloads) metaParts.push(`${formatNumber(pkg.downloads)}/mo`);
  const badge = pkg.installedVersion
    ? `✅ v${pkg.installedVersion}`
    : pkg.installed
      ? "✅"
      : "";
  return {
    value: pkg.name,
    title: pkg.name,
    badge: badge || undefined,
    description: desc || "",
    meta: metaParts.join(" · "),
  };
}

function buildTabBar(
  theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
  current: TabKey,
  locale: Locale,
): string {
  const tabLabels: Record<TabKey, string> = {
    installed: t("panel.tab.installed", locale),
    browse: t("panel.tab.browse", locale),
    updates: t("panel.tab.updates", locale),
    settings: t("panel.tab.settings", locale),
  };
  return TAB_KEYS.map((tab) => {
    const label = tabLabels[tab];
    if (tab === current) return theme.fg("accent", theme.bold(`[${label}]`));
    return theme.fg("muted", ` ${label} `);
  }).join("  ");
}

function buildHelpBar(tab: TabKey, locale: Locale, focus?: "search" | "list"): string {
  const base = t("panel.help.base", locale);
  if (focus === "search") return `${base} · ↵ search · Esc clear`;
  if (tab === "settings") return `${base} · ${t("panel.help.config", locale)}`;
  return `${base} · / 🔍`;
}

function emptyMessage(tab: TabKey, locale: Locale): string {
  if (tab === "installed") return t("panel.empty.installed", locale);
  if (tab === "browse") return t("panel.empty.browse", locale);
  if (tab === "updates") return t("panel.empty.updates", locale);
  return "";
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
