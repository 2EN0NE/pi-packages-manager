/**
 * pi-packages-manager/ui/panel.ts
 *
 * Claude-style overlay panel for the packages manager.
 *
 * Layout:
 *   ┌──────────────────────────────────────────────┐
 *   │  📦 Pi Packages Manager                      │
 *   │  [Installed]  Browse  Updates  Settings      │
 *   │  [All] extension skill prompt theme           │
 *  ├──────────────────────────────────────────────┤
 *   │  🔍 search or press /                        │
 *   │                                              │
 *   │  ● pi-tinyfish-tools                  v0.1   │
 *   │    TinyFish 网页代理工具                     │
 *   │    extension·skill · user · npm              │
 *   ├──────────────────────────────────────────────┤
 *   │  Tab/⇧Tab · ↑↓ · ↵ detail · / 🔍 · ? help  │
 *   └──────────────────────────────────────────────┘
 *
 * v1.2.0 adds:
 *   - Quick shortcuts: i=install, r=remove, u=update, ?=help overlay
 *   - Filter chips: [All] [extension] [skill] [prompt] [theme]
 *   - Inline detail view (Enter opens detail without closing panel)
 *   - Loading/empty state improvements
 */

import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	DynamicBorder,
	getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
	Box,
	Container,
	Input,
	Key,
	Markdown,
	matchesKey,
	type SelectItem,
	SelectList,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import {
	checkForUpdates,
	fetchFullCatalog,
	fetchNpmDownloadsBulk,
	getCatalogCacheInfo,
	getInstalledPackages,
	persistCatalogCache,
	searchNpmRegistry,
	type PackageInfo,
} from "../api";
import {
	formatRelativeTime,
	getTranslatedDescription,
	localizeType,
	type Locale,
	SUPPORTED_LOCALES,
	t,
} from "../i18n";
import {
	getLocaleSource,
	getTranslationUrl,
	getTranslationApiKey,
	setTranslationUrl,
	setTranslationApiKey,
	DEFAULT_TRANSLATION_URL,
} from "../locale";
import {
	checkTranslationService,
	pingTranslationService,
	translateText,
	parseReadme,
	reconstructReadme,
	getTranslationCache,
	setTranslationCache,
	clearTranslationCache,
	getTranslationCacheInfo,
	type ReadmeSection,
} from "../translation";
import { rankPackages } from "../search";
import { auditPackage, RISK_BADGE } from "../security";

import { PackageList, type PackageListItem } from "./package-list";

const TAB_KEYS = ["installed", "browse", "updates", "settings"] as const;
type TabKey = (typeof TAB_KEYS)[number];

const FILTER_ALL = "all";
const FILTER_TYPES = ["extension", "skill", "prompt", "theme"] as const;
type FilterType = (typeof FILTER_TYPES)[number] | "all";

export type PanelResult =
	| { action: "detail"; pkg: PackageInfo }
	| { action: "browse-search" }
	| { action: "compare"; selectedPkgNames: string[] }
	| { action: "settings-config" }
	| { action: "settings-refresh-catalog" }
	| { action: "settings-clear-catalog" }
	| { action: "settings-reset" }
	| { action: "change-locale"; locale: Locale }
	| { action: "settings-translation-url" }
	| { action: "settings-translation-apikey" }
	| { action: "settings-translation-test" }
	| { action: "settings-translation-clear" }
	| null;

interface PanelOptions {
	initialTab?: TabKey;
	locale: Locale;
	translationConnected?: boolean | null;
}

export async function showPackagesPanel(
	ctx: ExtensionCommandContext,
	options: PanelOptions,
): Promise<PanelResult> {
	const {
		initialTab = "installed",
		locale,
		translationConnected: initialTransConnected,
	} = options;
	const initialTransConnectedVal =
		initialTransConnected === undefined ? null : initialTransConnected;

	return ctx.ui.custom<PanelResult>((tui, theme, _kb, done) => {
		let currentTab: TabKey = initialTab;
		let currentPkgs: PackageInfo[] = [];
		let unfilteredPkgs: PackageInfo[] = [];
		let cachedCatalog: PackageInfo[] | null = null;
		let cachedUpdates: PackageInfo[] | null = null;
		// Installed tab 的包读本地 package.json，没有 downloads 字段；
		// 首次进入该 tab 时异步拉一次 npm 下载量合并进来。
		let cachedInstalledDownloads: Map<string, number> | null = null;
		let focusTarget: "search" | "list" = "list";
		let activeFilter: FilterType = FILTER_ALL;
		let showHelp = false;
		let compactList = false;
		let searchLoading = false;

		// Inline detail view state
		let detailPkg: PackageInfo | null = null;
		let detailAudit: Awaited<ReturnType<typeof auditPackage>> | null = null;
		let detailLoading = false;

		// Translation state (inline detail view)
		let translationMode = false;
		let translatedSections: ReadmeSection[] | null = null;
		let translating: boolean = false; // true while async translation is running
		const translationServiceCached: boolean | null = initialTransConnectedVal; // null = untested

		let dismissed = false;
		const safeDone = (result: PanelResult) => {
			if (dismissed) return;
			dismissed = true;
			done(result);
		};

		const container = new Container();
		let list: PackageList | null = null;
		let langSelector: SelectList | null = null;

		const mainComponent = {
			render(w: number) {
				return container.render(w);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(d: string) {
				handleInputImpl(d);
			},
		};

		// ─── Search input ─────────────────────────────────

		const searchInput = new Input();
		// onSubmit 置空：Enter/提交由 handleInputImpl 中的 Key.enter 检测统一处理
		searchInput.onSubmit = () => {};

		// ─── Theme helpers ───────────────────────────────

		function listTheme() {
			return {
				selectedTitle: (s: string) => theme.fg("accent", theme.bold(s)),
				title: (s: string) => theme.fg("text", s),
				badge: (s: string) => theme.fg("success", s),
				description: (s: string) => theme.fg("muted", s),
				meta: (s: string) => s, // 内容已在 packageToListItem 中着色，这里透传
				scrollInfo: (s: string) => theme.fg("dim", s),
				empty: (s: string) => theme.fg("muted", s),
				bullet: (s: string) => theme.fg("muted", s),
				selectedBullet: (s: string) => theme.fg("accent", s),
			};
		}

		// ─── Rebuild ─────────────────────────────────────

		function rebuild() {
			container.clear();

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("📦 " + t("menu.title", locale))),
					1,
					0,
				),
			);
			container.addChild(
				new Text(buildTabBar(theme, currentTab, locale), 1, 0),
			);

			// Help overlay (toggled by ?)
			if (showHelp) {
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
				);
				renderHelpOverlay();
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
				);
				container.addChild(
					new Text(theme.fg("dim", "Press ? or Esc to close help"), 1, 0),
				);
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("accent", s)),
				);
				return;
			}

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			if (currentTab === "settings") {
				renderSettingsTab();
			} else if (detailPkg) {
				renderDetailView();
			} else {
				// Filter chips (only for package tabs)
				renderFilterChips();
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
				);
				preparePackageData();
				renderSearchBar();
				// Selected count badge
				if (list && list.selectedCount > 0) {
					container.addChild(
						new Text(
							theme.fg(
								"accent",
								`  ☑ ${list.selectedCount} selected — press [c] to compare`,
							),
							1,
							0,
						),
					);
				}
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
				);
				renderPackageList();
			}

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						buildHelpBar(
							currentTab,
							locale,
							focusTarget,
							!!detailPkg,
							compactList,
						),
					),
					1,
					0,
				),
			);
			container.addChild(
				new DynamicBorder((s: string) => theme.fg("accent", s)),
			);
		}

		// ─── Filter chips ────────────────────────────────

		function renderFilterChips() {
			const chips = [
				{ key: FILTER_ALL as string, label: "All", shortcut: "1" },
				...FILTER_TYPES.map((tp, i) => ({
					key: tp,
					label: localizeType(tp, locale),
					shortcut: String(i + 2),
				})),
			];

			const parts = chips.map((chip) => {
				const isActive = activeFilter === chip.key;
				const styled = isActive
					? theme.fg("accent", theme.bold(`[${chip.label}]`))
					: theme.fg("dim", ` ${chip.label} `);
				return `${styled}${theme.fg("dim", chip.shortcut)}`;
			});

			container.addChild(new Text("  " + parts.join("  ") + " ", 0, 0));
		}

		function applyFilter() {
			// First apply search, then filter by type
			const query = searchInput.getValue();
			let base = unfilteredPkgs;

			if (query) {
				if (currentTab === "browse") {
					base = rankPackages(unfilteredPkgs, query, 60);
				} else {
					const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
					base = unfilteredPkgs.filter((pkg) => {
						const text =
							`${pkg.name} ${pkg.description || ""} ${(pkg.keywords || []).join(" ")} ${pkg.author || ""}`.toLowerCase();
						return terms.every((term) => text.includes(term));
					});
				}
			}

			if (activeFilter === FILTER_ALL) {
				currentPkgs = base;
			} else {
				currentPkgs = base.filter(
					(pkg) => pkg.types?.includes(activeFilter) ?? false,
				);
			}
		}

		// ─── Search bar ──────────────────────────────────

		function renderSearchBar() {
			const query = searchInput.getValue();
			const isActive = focusTarget === "search";

			if (isActive) {
				searchInput.focused = true;
				const searchBox = new Box(1, 0, (s: string) =>
					theme.fg("accent", theme.bold(s)),
				);
				searchBox.addChild(searchInput);
				container.addChild(searchBox);
			} else if (query && searchLoading) {
				searchInput.focused = false;
				const pill =
					theme.fg("accent", theme.bold(" 🔍 ")) +
					theme.fg("text", truncateToWidth(query, 20, "…")) +
					theme.fg("warning", "  ◐ searching npm...");
				container.addChild(new Text(pill, 0, 0));
			} else if (query) {
				searchInput.focused = false;
				const resultCount = currentPkgs.length;
				const totalCount = unfilteredPkgs.length;
				const pill =
					theme.fg("accent", theme.bold(" 🔍 ")) +
					theme.fg("text", truncateToWidth(query, 20, "…")) +
					theme.fg("dim", ` — ${resultCount}/${totalCount}`) +
					theme.fg("muted", `  [press / to edit]`);
				container.addChild(new Text(pill, 0, 0));
			} else {
				searchInput.focused = false;
				const hint =
					theme.fg("dim", "  🔍 ") +
					theme.fg("muted", t("search.placeholder", locale)) +
					theme.fg("dim", "  [press /]");
				container.addChild(new Text(hint, 0, 0));
			}
		}

		// ─── Package list ────────────────────────────────

		function preparePackageData() {
			langSelector = null;
			const pkgs = collectPackages(currentTab, cachedCatalog, cachedUpdates);
			// Installed tab：合并 npm 下载量（本地数据无此字段）
			if (currentTab === "installed" && cachedInstalledDownloads) {
				for (const p of pkgs) {
					const dl = cachedInstalledDownloads.get(p.name);
					if (dl !== undefined) p.downloads = dl;
				}
			}
			unfilteredPkgs = pkgs;
			applyFilter();
		}

		function renderPackageList() {
			// Preserve multi-selection and cursor position across rebuilds
			const prevSelected = list?.selectedValues ?? new Set();
			const prevIndex = list?.selectedIndex ?? 0;

			const items = currentPkgs.map((p) => packageToListItem(p, locale, theme));
			list = new PackageList(items, compactList ? 24 : 8, listTheme(), {
				emptyLabel: emptyMessage(currentTab, locale),
				compact: compactList,
			});
			// Restore multi-selection for items that still exist
			if (prevSelected.size > 0) {
				list.setSelectedValues(prevSelected);
			}
			// Restore cursor position
			if (prevIndex > 0 && items.length > 0) {
				list.setSelectedIndex(prevIndex);
			}
			list.onSelect = (item) => {
				// v1.2.0: open inline detail instead of closing panel
				const pkg = currentPkgs.find((p) => p.name === item.value);
				if (pkg) openDetail(pkg);
			};
			list.onCancel = () => safeDone(null);
			container.addChild(list);
		}

		// ─── Inline detail view ──────────────────────────

		async function openDetail(pkg: PackageInfo) {
			detailPkg = pkg;
			detailAudit = null;
			detailLoading = true;
			focusTarget = "list";
			rebuild();
			tui.requestRender();

			// Fetch fresh detail from npm in background
			try {
				const { getPackageDetail } = await import("../api");
				const fresh = await getPackageDetail(pkg.name);
				if (fresh && !dismissed) {
					detailPkg = {
						...pkg,
						...fresh,
						downloads: fresh.downloads ?? pkg.downloads,
					};
				}
			} catch {
				// use local data
			}

			detailLoading = false;
			if (!dismissed) {
				rebuild();
				tui.requestRender();
			}
		}

		function closeDetail() {
			detailPkg = null;
			detailAudit = null;
			detailLoading = false;
			translationMode = false;
			translatedSections = null;
			translating = false;
			rebuild();
			tui.requestRender();
		}

		/** 并行翻译 README 的所有 section，逐段更新 UI */
		async function translateAllSections(
			baseUrl: string,
			apiKey: string,
			pkgName: string,
			sections: ReadmeSection[],
		) {
			await Promise.allSettled(
				sections.map(async (sec, idx) => {
					// 跳过空 body 的 section
					if (!sec.body.trim()) {
						if (translatedSections) {
							translatedSections[idx] = {
								...sec,
								translated: "",
								loading: false,
							};
						}
						return null;
					}
					const translated = await translateText(
						baseUrl,
						sec.body,
						"en",
						"zh-Hans",
						apiKey,
					);
					if (translatedSections) {
						translatedSections[idx] = { ...sec, translated, loading: false };
					}
					return translated;
				}),
			);

			// 所有 section 完成后，保存到缓存
			if (translatedSections && detailPkg?.readme) {
				// 检查是否全部翻译完成（无 loading）
				const allDone = translatedSections.every((s) => !s.loading);
				if (allDone) {
					setTranslationCache(
						pkgName,
						"en",
						"zh-Hans",
						detailPkg.readme,
						translatedSections,
					);
				}
			}

			// 最后一次 UI 刷新（最后一次 section 完成已经触发了 rebuild）
			if (!dismissed) {
				rebuild();
				tui.requestRender();
			}
		}

		function renderDetailView() {
			list = null;
			const pkg = detailPkg!;
			const info = pkg;

			const status = info.installed
				? theme.fg(
						"success",
						`✅ ${t("detail.installed", locale)} (v${info.installedVersion || info.version})`,
					)
				: theme.fg("muted", `⬜ ${t("detail.not_installed", locale)}`);

			const hasUpdate =
				info.latestVersion &&
				info.installedVersion &&
				info.latestVersion !== info.installedVersion;

			const lines: string[] = [];
			lines.push(`  📦 ${theme.fg("accent", theme.bold(info.name))}`);
			lines.push(`  ${theme.fg("muted", info.description || "")}`);
			lines.push(`  ${status}`);

			if (hasUpdate) {
				lines.push(
					`  ${theme.fg("warning", `⬆️  ${info.installedVersion} → ${info.latestVersion}`)}`,
				);
			}
			if (info.author)
				lines.push(
					`  ${theme.fg("dim", `${t("detail.author", locale)}: ${info.author}`)}`,
				);
			if (info.license)
				lines.push(
					`  ${theme.fg("dim", `${t("detail.license", locale)}: ${info.license}`)}`,
				);
			if (info.types?.length)
				lines.push(
					`  ${theme.fg("dim", `${t("detail.types", locale)}: ${info.types.map((tp) => localizeType(tp, locale)).join(", ")}`)}`,
				);
			if (info.downloads)
				lines.push(
					`  ${theme.fg("dim", `${t("detail.downloads", locale)}: ${formatNumber(info.downloads)}/mo`)}`,
				);
			if (info.npmUrl)
				lines.push(`  ${theme.fg("dim", `npm: ${info.npmUrl}`)}`);

			// Audit result
			if (detailAudit) {
				lines.push("");
				lines.push(
					`  ${theme.fg("accent", `🔒 ${RISK_BADGE[detailAudit.overallRisk]}`)}`,
				);
				lines.push(`  ${theme.fg("dim", `Version: ${detailAudit.version}`)}`);
				lines.push(`  ${theme.fg("dim", detailAudit.summary.split("\n")[0])}`);
				if (detailAudit.findings.length > 0) {
					lines.push(
						`  ${theme.fg("dim", `Findings: ${detailAudit.findings.length} pattern(s) detected`)}`,
					);
				}
			} else if (detailLoading) {
				lines.push(`  ${theme.fg("dim", "⠋ Loading details...")}`);
			}

			for (const line of lines) {
				container.addChild(new Text(line, 0, 0));
			}

			// v1.2.2: README inline rendering (with translation support)
			if (info.readme) {
				container.addChild(new Spacer(1));
				container.addChild(
					new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
				);
				const readmeLabel = translationMode
					? theme.fg(
							"accent",
							`  📖 ${t("detail.readme", locale)} ${theme.fg("dim", "[翻译中]")}`,
						)
					: theme.fg("dim", `  📖 ${t("detail.readme", locale)}`);
				container.addChild(new Text(readmeLabel, 0, 0));
				try {
					const mdTheme = getMarkdownTheme();
					if (translationMode && translatedSections) {
						// 翻译模式：重建 markdown，未完成的 section 显示 spinner
						const md = reconstructReadme(translatedSections);
						container.addChild(new Markdown(md, 1, 0, mdTheme));
					} else {
						container.addChild(new Markdown(info.readme, 1, 0, mdTheme));
					}
				} catch {
					// Markdown component unavailable — fall back to plain text
					const source =
						translationMode && translatedSections
							? reconstructReadme(translatedSections)
							: info.readme;
					const previewLines = source.split("\n").slice(0, 30);
					for (const ln of previewLines) {
						container.addChild(new Text(`  ${theme.fg("muted", ln)}`, 0, 0));
					}
				}
			} else if (!detailLoading) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(
						theme.fg("dim", `  📖 ${t("detail.no_readme", locale)}`),
						0,
						0,
					),
				);
			}

			// Action buttons
			container.addChild(new Spacer(1));
			const actionParts: string[] = [];

			if (!detailAudit) {
				actionParts.push(theme.fg("accent", "  [a] Audit"));
			} else {
				actionParts.push(theme.fg("accent", "  [a] Re-audit"));
			}

			if (info.readme) {
				if (translating) {
					actionParts.push(theme.fg("accent", "  ⠋ [t] Translating..."));
				} else {
					actionParts.push(theme.fg("accent", "  [t] Translate"));
				}
			}
			if (info.installed) {
				if (hasUpdate) actionParts.push(theme.fg("warning", "  [u] Update"));
				actionParts.push(theme.fg("error", "  [r] Remove"));
			} else {
				actionParts.push(theme.fg("success", "  [i] Install"));
			}
			actionParts.push(theme.fg("dim", "  [←] Back"));

			container.addChild(new Text(actionParts.join(""), 0, 0));
		}

		// ─── Help overlay ────────────────────────────────

		function renderHelpOverlay() {
			const lines = [
				theme.fg("accent", theme.bold("  ⌨  Keyboard shortcuts")),
				"",
				theme.fg("text", "  Navigation") +
					theme.fg("dim", "─────────────────────────"),
				theme.fg("dim", "  Tab / ⇧Tab     Switch tabs"),
				theme.fg("dim", "  ↑ / ↓          Navigate list"),
				theme.fg("dim", "  Enter           Open detail view"),
				theme.fg("dim", "  Esc / q         Close panel"),
				"",
				theme.fg("text", "  Search & Filter") +
					theme.fg("dim", "─────────────────────"),
				theme.fg("dim", "  /               Focus search bar"),
				theme.fg("dim", "  1-5             Filter by type"),
				theme.fg(
					"dim",
					"                  1=All 2=ext 3=skill 4=prompt 5=theme",
				),
				"",
				theme.fg("text", "  Actions") +
					theme.fg("dim", "─────────────────────────────"),
				theme.fg("dim", "  i               Install selected package"),
				theme.fg("dim", "  r               Remove selected package"),
				theme.fg("dim", "  u               Update selected package"),
				theme.fg("dim", "  a               Run security audit"),
				"",
				theme.fg("text", "  Multi-Select") +
					theme.fg("dim", "───────────────────────────"),
				theme.fg("dim", "  Space           Toggle selection"),
				theme.fg("dim", "  c               Compare selected (≥2)"),
				"",
				theme.fg("text", "  Detail View") +
					theme.fg("dim", "─────────────────────────"),
				theme.fg("dim", "  ← / Backspace   Back to list"),
				theme.fg("dim", "  t               Toggle README translation"),
				theme.fg("dim", "  Esc             Close panel"),
			];

			for (const line of lines) {
				container.addChild(new Text(line, 0, 0));
			}
		}

		// ─── Settings tab ────────────────────────────────

		function renderSettingsTab() {
			list = null;

			// === J4: 当前生效的偏好来源 ===
			const localeSource = getLocaleSource();
			const sourceLabel = t(
				`settings.locale.source.${localeSource.source}`,
				locale,
			);
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						"  " + t("settings.locale.source", locale, { source: sourceLabel }),
					),
					1,
					0,
				),
			);

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			// === 语言区 ===
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("  🌐 " + t("settings.section.language", locale)),
					),
					1,
					0,
				),
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

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			// === 翻译区 ===
			const transUrl = getTranslationUrl();
			const transKey = getTranslationApiKey();
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("  🌐 " + t("settings.section.translation", locale)),
					),
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${t("settings.translation.url", locale)}: ${transUrl}`,
					),
					1,
					0,
				),
			);
			if (transKey) {
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`  ${t("settings.translation.apikey", locale)}: ****${transKey.slice(-4)}`,
						),
						1,
						0,
					),
				);
			}
			const svcStatus =
				translationServiceCached === null
					? t("settings.translation.status.unknown", locale)
					: translationServiceCached
						? t("settings.translation.status.ok", locale)
						: t("settings.translation.status.err", locale);
			const svcColor =
				translationServiceCached === null
					? "dim"
					: translationServiceCached
						? "success"
						: "error";
			container.addChild(
				new Text(
					theme.fg(
						svcColor,
						`  ${t("settings.translation.status", locale)}: ${svcStatus}`,
					),
					1,
					0,
				),
			);
			const cacheInfo2 = getTranslationCacheInfo();
			const cacheLabel =
				cacheInfo2.count > 0
					? `${cacheInfo2.count} ${t("settings.translation.cached", locale)} (${(cacheInfo2.sizeBytes / 1024).toFixed(1)} KB)`
					: t("settings.translation.cache.empty", locale);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${t("settings.translation.cache", locale)}: ${cacheLabel}`,
					),
					1,
					0,
				),
			);
			// 快捷键提示
			container.addChild(
				new Text(
					theme.fg("muted", `  ${t("settings.translation.shortcuts", locale)}`),
					1,
					0,
				),
			);

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			// === J1: 目录缓存区 ===
			const cacheInfo = getCatalogCacheInfo();
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("  📦 " + t("settings.section.cache", locale)),
					),
					1,
					0,
				),
			);
			const cacheStatusText = cacheInfo.cached
				? t("settings.cache.cached", locale, {
						count: cacheInfo.count,
						age: formatRelativeTime(cacheInfo.fetchedAt!, locale),
					})
				: t("settings.cache.empty", locale);
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`  ${t("settings.cache.status", locale)}: ${cacheStatusText}`,
					),
					1,
					0,
				),
			);
			// 快捷键提示行
			container.addChild(
				new Text(
					theme.fg(
						"muted",
						`  ${t("settings.cache.refresh", locale)}    ${t("settings.cache.clear", locale)}`,
					),
					1,
					0,
				),
			);

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			// === J3: 偏好区 ===
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("  ⚙️  " + t("settings.section.preferences", locale)),
					),
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg("muted", "  " + t("settings.preferences.reset", locale)),
					1,
					0,
				),
			);

			container.addChild(
				new DynamicBorder((s: string) => theme.fg("borderMuted", s)),
			);

			// === 提示区 ===
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold("  💡 " + t("settings.section.tip", locale)),
					),
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg("muted", "  " + t("settings.tip.config", locale)),
					1,
					0,
				),
			);
			container.addChild(new Spacer(1));
		}

		// ─── Async npm registry search (on Enter) ──────────

		function doNetworkSearch(query: string) {
			searchLoading = true;
			// 立即显示 "searching npm..." 提示
			if (!dismissed) {
				rebuild();
				tui.requestRender();
			}

			searchNpmRegistry(query, 60).then(
				(npmResults) => {
					if (dismissed) return;
					// 合并 npm 结果到本地缓存：同名包用 npm 数据覆盖（更新 metadata），新增包加入
					const cc = cachedCatalog!;
					const byName = new Map(cc.map((p) => [p.name, p]));
					let changed = false;
					for (const npmPkg of npmResults) {
						const existing = byName.get(npmPkg.name);
						if (!existing) {
							changed = true;
						} else if (
							existing.version !== npmPkg.version ||
							existing.description !== npmPkg.description ||
							existing.downloads !== npmPkg.downloads
						) {
							changed = true;
						}
						// npm 结果优先（metadata 更新），保留已安装状态
						byName.set(npmPkg.name, {
							...npmPkg,
							installed: existing?.installed ?? npmPkg.installed,
							installedVersion:
								existing?.installedVersion ?? npmPkg.installedVersion,
							scope: existing?.scope ?? npmPkg.scope,
							source: existing?.source || npmPkg.source,
							sourceType: existing?.sourceType || npmPkg.sourceType,
							piManifest: existing?.piManifest ?? npmPkg.piManifest,
						});
					}
					if (changed) {
						cachedCatalog = rankPackages([...byName.values()], "", byName.size);
						persistCatalogCache(cachedCatalog);
					}
					// 显示：npm 结果优先，补上本地独有的匹配
					const merged = [...npmResults];
					if (cachedCatalog) {
						const npmNames = new Set(npmResults.map((p) => p.name));
						for (const pkg of cachedCatalog) {
							if (!npmNames.has(pkg.name)) {
								merged.push(pkg);
							}
						}
					}
					unfilteredPkgs = rankPackages(merged, query, merged.length);
					searchLoading = false;
					if (!dismissed) {
						rebuild();
						tui.requestRender(true);
					}
				},
				(err) => {
					searchLoading = false;
					console.error("[pm] network search error:", err);
					if (!dismissed) {
						// 网络搜索失败，回退到本地结果
						unfilteredPkgs = collectPackages(
							currentTab,
							cachedCatalog,
							cachedUpdates,
						);
						rebuild();
						tui.requestRender(true);
					}
				},
			);
		}

		// ─── Async loaders ───────────────────────────────

		async function loadBrowse() {
			try {
				cachedCatalog = await fetchFullCatalog();
				console.error("[pm] catalog=%d", cachedCatalog.length);
			} catch {
				cachedCatalog = [];
			}
			if (dismissed) return;
			if (currentTab === "browse" && !detailPkg) {
				rebuild();
				tui.requestRender(true);
			}
		}

		async function loadUpdates() {
			try {
				cachedUpdates = await checkForUpdates();
			} catch {
				cachedUpdates = [];
			}
			if (dismissed) return;
			if (currentTab === "updates" && !detailPkg) {
				rebuild();
				tui.requestRender();
			}
		}

		// 为 Installed tab 异步拉取 npm 月下载量。本地 package.json 没有下载量，
		// 这里补齐，让用户能看到自己装的包火不火（包括自己的包）。
		async function loadInstalledDownloads() {
			try {
				const names = getInstalledPackages()
					.map((p) => p.name)
					.filter(Boolean);
				cachedInstalledDownloads = await fetchNpmDownloadsBulk(names);
			} catch {
				cachedInstalledDownloads = new Map();
			}
			if (dismissed) return;
			if (currentTab === "installed" && !detailPkg) {
				rebuild();
				tui.requestRender();
			}
		}

		// ─── Tab switching ───────────────────────────────

		function switchTab(direction: 1 | -1) {
			const idx = TAB_KEYS.indexOf(currentTab);
			const next =
				TAB_KEYS[(idx + direction + TAB_KEYS.length) % TAB_KEYS.length];
			currentTab = next;
			searchInput.setValue("");
			focusTarget = "list";
			searchInput.focused = false;
			activeFilter = FILTER_ALL;
			detailPkg = null;
			detailAudit = null;
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
			if (next === "installed" && cachedInstalledDownloads === null) {
				cachedInstalledDownloads = new Map();
				loadInstalledDownloads();
			}
		}

		// ─── Search ──────────────────────────────────────

		// ─── Quick action handlers ───────────────────────

		async function handleQuickInstall() {
			const pkg = getSelectedPkg();
			if (!pkg) return;
			safeDone({ action: "detail", pkg });
		}

		async function handleQuickRemove() {
			const pkg = getSelectedPkg();
			if (!pkg || !pkg.installed) return;
			safeDone({ action: "detail", pkg });
		}

		async function handleQuickUpdate() {
			const pkg = getSelectedPkg();
			if (!pkg || !pkg.installed) return;
			safeDone({ action: "detail", pkg });
		}

		async function handleQuickAudit() {
			if (detailPkg) {
				// Audit from detail view
				detailLoading = true;
				rebuild();
				tui.requestRender();
				try {
					detailAudit = await auditPackage(detailPkg.name, { deepScan: true });
				} catch {
					detailAudit = null;
				}
				detailLoading = false;
				if (!dismissed) {
					rebuild();
					tui.requestRender();
				}
				return;
			}

			// Audit from list view
			const pkg = getSelectedPkg();
			if (!pkg) return;
			await openDetail(pkg);
			// Then auto-trigger audit
			detailLoading = true;
			rebuild();
			tui.requestRender();
			try {
				detailAudit = await auditPackage(pkg.name, { deepScan: true });
			} catch {
				detailAudit = null;
			}
			detailLoading = false;
			if (!dismissed) {
				rebuild();
				tui.requestRender();
			}
		}

		function getSelectedPkg(): PackageInfo | null {
			if (detailPkg) return detailPkg;
			const selected = list?.getSelected();
			if (!selected) return null;
			return currentPkgs.find((p) => p.name === selected.value) || null;
		}

		// ─── Build & init ────────────────────────────────

		rebuild();

		if (initialTab === "browse" && cachedCatalog === null) {
			cachedCatalog = [];
			loadBrowse();
		}
		if (initialTab === "updates" && cachedUpdates === null) {
			cachedUpdates = [];
			loadUpdates();
		}
		if (initialTab === "installed" && cachedInstalledDownloads === null) {
			cachedInstalledDownloads = new Map();
			loadInstalledDownloads();
		}

		// ─── Input handling ──────────────────────────────

		function handleInputImpl(data: string) {
			// Help overlay
			if (showHelp) {
				if (data === "?" || matchesKey(data, Key.escape)) {
					showHelp = false;
					rebuild();
					tui.requestRender();
				}
				return;
			}

			// Toggle help
			if (data === "?") {
				showHelp = true;
				rebuild();
				tui.requestRender();
				return;
			}

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
				// 缓存快捷键
				if (data === "r") {
					safeDone({ action: "settings-refresh-catalog" });
					return;
				}
				if (data === "c") {
					safeDone({ action: "settings-clear-catalog" });
					return;
				}
				// 偏好重置快捷键
				if (data === "p") {
					safeDone({ action: "settings-reset" });
					return;
				}
				if (data === "g") {
					safeDone({ action: "settings-config" });
					return;
				}
				// 翻译快捷键
				if (data === "m") {
					safeDone({ action: "settings-translation-url" });
					return;
				}
				if (data === "k") {
					safeDone({ action: "settings-translation-apikey" });
					return;
				}
				if (data === "y") {
					safeDone({ action: "settings-translation-test" });
					return;
				}
				if (data === "x") {
					safeDone({ action: "settings-translation-clear" });
					return;
				}
				langSelector?.handleInput(data);
				tui.requestRender();
				return;
			}

			// ── Detail view shortcuts ──
			if (detailPkg) {
				if (
					matchesKey(data, Key.escape) ||
					matchesKey(data, Key.left) ||
					matchesKey(data, Key.backspace)
				) {
					closeDetail();
					return;
				}
				if (data === "i" && !detailPkg.installed) {
					safeDone({ action: "detail", pkg: detailPkg });
					return;
				}
				if (data === "r" && detailPkg.installed) {
					safeDone({ action: "detail", pkg: detailPkg });
					return;
				}
				if (data === "u" && detailPkg.installed) {
					safeDone({ action: "detail", pkg: detailPkg });
					return;
				}
				if (data === "a") {
					handleQuickAudit();
					return;
				}
				// t: 切换翻译模式
				if (data === "t") {
					if (!detailPkg.readme) {
						ctx.ui.notify("No README to translate", "warning");
						return;
					}
					if (!translationMode) {
						// 进入翻译模式
						const transUrl = getTranslationUrl();
						translationMode = true;
						const cached = getTranslationCache(
							detailPkg.name,
							"en",
							"zh-Hans",
							detailPkg.readme,
						);
						if (cached) {
							translatedSections = cached;
							rebuild();
							tui.requestRender();
						} else {
							// 拆分 + 异步翻译
							const sections = parseReadme(detailPkg.readme);
							translatedSections = sections.map((s) => ({
								...s,
								loading: true,
							}));
							translating = true;
							rebuild();
							tui.requestRender();
							// 并行翻译所有 section
							translateAllSections(
								transUrl,
								getTranslationApiKey(),
								detailPkg.name,
								sections,
							).finally(() => {
								translating = false;
								if (!dismissed) {
									rebuild();
									tui.requestRender();
								}
							});
						}
					} else {
						// 切换回原文
						translationMode = false;
						translating = false;
						rebuild();
						tui.requestRender();
					}
					return;
				}
				// Enter in detail view also goes to full detail (for install/remove/update)
				if (matchesKey(data, Key.enter)) {
					safeDone({ action: "detail", pkg: detailPkg });
					return;
				}
				return;
			}

			// ── Package list shortcuts (when not in search) ──
			if (focusTarget === "list") {
				// Filter chips: 1-5
				if (data === "1") {
					activeFilter = FILTER_ALL;
					rebuild();
					tui.requestRender();
					return;
				}
				if (data === "2") {
					activeFilter = "extension";
					rebuild();
					tui.requestRender();
					return;
				}
				if (data === "3") {
					activeFilter = "skill";
					rebuild();
					tui.requestRender();
					return;
				}
				if (data === "4") {
					activeFilter = "prompt";
					rebuild();
					tui.requestRender();
					return;
				}
				if (data === "5") {
					activeFilter = "theme";
					rebuild();
					tui.requestRender();
					return;
				}

				// Quick actions
				if (data === "i") {
					handleQuickInstall();
					return;
				}
				if (data === "r") {
					handleQuickRemove();
					return;
				}
				if (data === "u") {
					handleQuickUpdate();
					return;
				}
				if (data === "a") {
					handleQuickAudit();
					return;
				}
				// z: 切换紧凑/详细列表模式
				if (data === "z") {
					compactList = !compactList;
					if (list) {
						list.setCompact(compactList);
					}
					rebuild();
					tui.requestRender();
					return;
				}
				// c: 对比选中的包（需要 ≥2 个选中）
				if (data === "c") {
					const selectedValues = list?.selectedValues ?? new Set();
					if (selectedValues.size < 2) {
						// 提示至少选2个
						ctx.ui.notify(
							"Select ≥2 packages (press Space to select) before comparing",
							"warning",
						);
						return;
					}
					safeDone({
						action: "compare",
						selectedPkgNames: [...selectedValues],
					});
					return;
				}
			}

			// Focus search input
			if (data === "/" && focusTarget === "list") {
				focusTarget = "search";
				searchInput.focused = true;
				rebuild();
				tui.requestRender();
				return;
			}

			if (focusTarget === "search") {
				// Enter：切换焦点并触发网络搜索
				if (matchesKey(data, Key.enter)) {
					searchInput.handleInput(data);
					focusTarget = "list";
					searchInput.focused = false;
					const query = searchInput.getValue().trim();
					if (currentTab === "browse" && query && cachedCatalog) {
						doNetworkSearch(query);
					} else {
						rebuild();
						tui.requestRender();
					}
					return;
				}

				// Escape：清空搜索
				if (matchesKey(data, Key.escape)) {
					searchInput.handleInput(data);
					if (searchInput.getValue()) {
						searchInput.setValue("");
						unfilteredPkgs = collectPackages(
							currentTab,
							cachedCatalog,
							cachedUpdates,
						);
						currentPkgs = unfilteredPkgs;
					}
					focusTarget = "list";
					searchInput.focused = false;
					rebuild();
					tui.requestRender();
					return;
				}

				// 普通键盘输入：每键同步过滤（重新基于完整 catalog）
				searchInput.handleInput(data);
				unfilteredPkgs = collectPackages(
					currentTab,
					cachedCatalog,
					cachedUpdates,
				);
				applyFilter();
				if (list) {
					const items = currentPkgs.map((p) =>
						packageToListItem(p, locale, theme),
					);
					list.setItems(items);
				}
				tui.requestRender();
				return;
			}

			// Move focus to search on up arrow when at top of list
			if (matchesKey(data, Key.up) && list && list.isAtTop()) {
				focusTarget = "search";
				searchInput.focused = true;
				rebuild();
				tui.requestRender();
				return;
			}

			// Space: handle multi-select toggle + rebuild to update badge
			if (data === " ") {
				list?.handleInput(data);
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

// ─── Helper functions ────────────────────────────────────

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

function typeColor(type: string): string {
	switch (type) {
		case "extension":
			return "accent";
		case "skill":
			return "success";
		case "prompt":
			return "warning";
		case "theme":
			return "muted";
		default:
			return "dim";
	}
}

function packageToListItem(
	pkg: PackageInfo,
	locale: Locale,
	theme: { fg: (color: string, text: string) => string },
): PackageListItem {
	const desc = getTranslatedDescription(pkg.name, pkg.description, locale);
	const dim = (s: string) => theme.fg("dim", s);
	const sep = dim(" · ");
	const metaParts: string[] = [];
	if (pkg.types?.length) {
		// 类型彩色 chip：extension/skill/prompt/theme 各配辨识色
		metaParts.push(
			pkg.types
				.map((tp) => theme.fg(typeColor(tp), localizeType(tp, locale)))
				.join(dim("·")),
		);
	}
	if (pkg.scope) metaParts.push(dim(pkg.scope));
	if (pkg.sourceType) metaParts.push(dim(pkg.sourceType));
	if (pkg.downloads) metaParts.push(dim(`${formatNumber(pkg.downloads)}/mo`));
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
		meta: metaParts.join(sep),
	};
}

function buildTabBar(
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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

function buildHelpBar(
	tab: TabKey,
	locale: Locale,
	focus?: "search" | "list",
	inDetail?: boolean,
	compact?: boolean,
): string {
	const base = t("panel.help.base", locale);
	if (inDetail)
		return `${base} · ← back · a audit · t translate · i/r/u action · Esc close`;
	if (focus === "search") return `${base} · ↵ search · Esc clear`;
	if (tab === "settings") return `${base} · ${t("panel.help.config", locale)}`;
	const modeLabel = compact === true ? "[z] detailed" : "[z] compact";
	return `${base} · Space sel · [c] compare · / 🔍 · ? help · ${modeLabel}`;
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
