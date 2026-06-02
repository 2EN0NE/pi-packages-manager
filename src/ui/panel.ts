/**
 * pi-packages-manager/ui/panel.ts
 *
 * Claude-style overlay panel for the packages manager.
 *
 * Layout:
 *   ┌────────────────────────────────────────┐
 *   │  📦 Pi Packages Manager                │
 *   │  [Installed] Browse  Updates  Settings │
 *   ├────────────────────────────────────────┤
 *   │  ● pi-tinyfish-tools          ✅ v0.1  │
 *   │    description                         │
 *   │    extension·skill · 3.2k/mo           │
 *   ├────────────────────────────────────────┤
 *   │  Tab/⇧Tab switch · Enter detail · q ✕  │
 *   └────────────────────────────────────────┘
 *
 * Returns a value through `done(...)`:
 *   { action: "detail", pkg }    user picked a package → show detail
 *   { action: "browse-search" }  user pressed `/` on Browse tab
 *   null                         user pressed Esc / `q`
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SelectItem,
  SelectList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import {
  checkForUpdates,
  fetchFullCatalog,
  getInstalledPackageRefs,
  getInstalledPackages,
  type PackageInfo,
} from "../api";
import { getTranslatedDescription, type Locale } from "../i18n";

const TAB_KEYS = ["installed", "browse", "updates", "settings"] as const;
type TabKey = typeof TAB_KEYS[number];

const TAB_LABELS: Record<TabKey, string> = {
  installed: "Installed",
  browse: "Browse",
  updates: "Updates",
  settings: "Settings",
};

export type PanelResult =
  | { action: "detail"; pkg: PackageInfo }
  | { action: "browse-search" }
  | { action: "settings-config" }
  | null;

/**
 * Show the overlay panel and resolve when the user picks an action or closes it.
 */
export async function showPackagesPanel(
  ctx: ExtensionCommandContext,
  locale: Locale,
  initialTab: TabKey = "installed",
): Promise<PanelResult> {
  return ctx.ui.custom<PanelResult>((tui, theme, _kb, done) => {
    let currentTab: TabKey = initialTab;
    let currentItems: PackageInfo[] = [];
    let cachedCatalog: PackageInfo[] | null = null;
    let cachedUpdates: PackageInfo[] | null = null;

    const container = new Container();
    let selectList: SelectList | null = null;

    function rebuild() {
      container.clear();

      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
      container.addChild(new Text(theme.fg("accent", theme.bold("📦 Pi Packages Manager")), 1, 0));
      container.addChild(new Text(buildTabBar(theme, currentTab), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));

      const { items, info } = buildItems(currentTab);
      currentItems = info;

      if (items.length === 0) {
        container.addChild(new Spacer(1));
        container.addChild(new Text(theme.fg("muted", emptyMessage(currentTab)), 2, 0));
        container.addChild(new Spacer(1));
        selectList = null;
      } else {
        selectList = new SelectList(items, Math.min(items.length, 12), {
          selectedPrefix: (t) => theme.fg("accent", t),
          selectedText: (t) => theme.fg("accent", t),
          description: (t) => theme.fg("muted", t),
          scrollInfo: (t) => theme.fg("dim", t),
          noMatch: (t) => theme.fg("warning", t),
        });
        selectList.onSelect = (item) => {
          const pkg = currentItems.find((p) => p.name === item.value);
          if (pkg) done({ action: "detail", pkg });
        };
        selectList.onCancel = () => done(null);
        container.addChild(selectList);
      }

      container.addChild(new DynamicBorder((s: string) => theme.fg("borderMuted", s)));
      container.addChild(new Text(theme.fg("dim", buildHelpBar(currentTab)), 1, 0));
      container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
    }

    function buildItems(tab: TabKey): { items: SelectItem[]; info: PackageInfo[] } {
      let pkgs: PackageInfo[] = [];

      if (tab === "installed") {
        pkgs = getInstalledPackages();
      } else if (tab === "browse") {
        pkgs = cachedCatalog || [];
      } else if (tab === "updates") {
        pkgs = cachedUpdates || [];
      } else if (tab === "settings") {
        // For settings tab we list all installed refs (one per scope).
        const refs = getInstalledPackageRefs();
        const installed = getInstalledPackages();
        pkgs = refs
          .map((ref) => installed.find((p) => p.source === ref.ref))
          .filter((pkg): pkg is PackageInfo => Boolean(pkg));
      }

      return {
        items: pkgs.map((pkg) => packageToSelectItem(pkg, locale)),
        info: pkgs,
      };
    }

    async function loadBrowse() {
      try {
        cachedCatalog = await fetchFullCatalog(80);
      } catch {
        cachedCatalog = [];
      }
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
      if (currentTab === "updates") {
        rebuild();
        tui.requestRender();
      }
    }

    function switchTab(direction: 1 | -1) {
      const idx = TAB_KEYS.indexOf(currentTab);
      const next = TAB_KEYS[(idx + direction + TAB_KEYS.length) % TAB_KEYS.length];
      currentTab = next;
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

    rebuild();

    if (initialTab === "browse" && cachedCatalog === null) {
      cachedCatalog = [];
      loadBrowse();
    }
    if (initialTab === "updates" && cachedUpdates === null) {
      cachedUpdates = [];
      loadUpdates();
    }

    return {
      render(width: number) {
        return container.render(width);
      },
      invalidate() {
        container.invalidate();
      },
      handleInput(data: string) {
        if (matchesKey(data, Key.tab)) {
          switchTab(1);
          return;
        }
        if (matchesKey(data, Key.shift("tab"))) {
          switchTab(-1);
          return;
        }
        if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
          done(null);
          return;
        }
        if (data === "/" && currentTab === "browse") {
          done({ action: "browse-search" });
          return;
        }
        if (data === "g" && currentTab === "settings") {
          done({ action: "settings-config" });
          return;
        }
        selectList?.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

function packageToSelectItem(pkg: PackageInfo, locale: Locale): SelectItem {
  const desc = getTranslatedDescription(pkg.name, pkg.description, locale);
  const meta: string[] = [];
  if (pkg.types?.length) meta.push(pkg.types.join("·"));
  if (pkg.scope) meta.push(pkg.scope);
  if (pkg.sourceType) meta.push(pkg.sourceType);
  if (pkg.installedVersion) meta.push(`v${pkg.installedVersion}`);
  if (pkg.downloads) meta.push(`${formatNumber(pkg.downloads)}/mo`);
  const badge = pkg.installed ? "✅ " : "";
  const description = [desc, meta.join(" · ")].filter(Boolean).join("  —  ");
  return {
    value: pkg.name,
    label: `${badge}${pkg.name}`,
    description,
  };
}

function buildTabBar(theme: { fg: (color: string, text: string) => string; bold: (text: string) => string }, current: TabKey): string {
  return TAB_KEYS.map((tab) => {
    const label = TAB_LABELS[tab];
    if (tab === current) return theme.fg("accent", theme.bold(`[${label}]`));
    return theme.fg("muted", ` ${label} `);
  }).join("  ");
}

function buildHelpBar(tab: TabKey): string {
  const base = "Tab/⇧Tab switch · ↑↓ navigate · Enter detail · Esc/q close";
  if (tab === "browse") return `${base} · / search`;
  if (tab === "settings") return `${base} · g configure`;
  return base;
}

function emptyMessage(tab: TabKey): string {
  if (tab === "installed") return "No packages installed.";
  if (tab === "browse") return "Loading community catalog... (press Tab to switch)";
  if (tab === "updates") return "Checking for updates... (press Tab to switch)";
  if (tab === "settings") return "No packages found in user/project settings.";
  return "Empty";
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
