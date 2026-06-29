/**
 * pi-packages-manager/ui/package-list.ts
 *
 * Custom scrollable list with relaxed spacing for the overlay panel.
 *
 * Two display modes:
 *   detailed (default): 3 lines + 1 blank separator per item
 *     ● <name>          <badge>
 *       <description>
 *       <meta>
 *   compact: 1 line per item, no separator
 *     ● <name>  <badge>  · <desc>  · <meta>
 *
 * Built-in `SelectList` collapses everything to a single line, so we
 * implement our own component with pi-tui primitives.
 */

import {
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

export interface PackageListItem {
	value: string;
	title: string;
	badge?: string;
	description?: string;
	meta?: string;
}

export interface PackageListTheme {
	selectedTitle: (text: string) => string;
	title: (text: string) => string;
	badge: (text: string) => string;
	description: (text: string) => string;
	meta: (text: string) => string;
	scrollInfo: (text: string) => string;
	empty: (text: string) => string;
	bullet: (text: string) => string;
	selectedBullet: (text: string) => string;
}

export class PackageList {
	private items: PackageListItem[];
	private maxRows: number;
	private theme: PackageListTheme;
	private selected = 0;
	private offset = 0;
	private cachedWidth?: number;
	private cachedLines?: string[];
	private emptyLabel: string;
	private _compact = false;

	public onSelect?: (item: PackageListItem) => void;
	public onCancel?: () => void;
	public onSelectionChange?: (item: PackageListItem) => void;

	constructor(
		items: PackageListItem[],
		maxRows: number,
		theme: PackageListTheme,
		options: { emptyLabel?: string; compact?: boolean } = {},
	) {
		this.items = items;
		this.maxRows = Math.max(1, maxRows);
		this.theme = theme;
		this.emptyLabel = options.emptyLabel ?? "No items";
		this._compact = options.compact ?? false;
	}

	/** Toggle compact mode and invalidate cache so the list re-renders. */
	toggleCompact(): boolean {
		this._compact = !this._compact;
		this.invalidate();
		return this._compact;
	}

	/** Get current compact state. */
	get compact(): boolean {
		return this._compact;
	}

	/** Set compact state and invalidate. */
	setCompact(v: boolean): void {
		if (this._compact === v) return;
		this._compact = v;
		this.invalidate();
	}

	setItems(items: PackageListItem[]): void {
		this.items = items;
		this.selected = 0;
		this.offset = 0;
		this.invalidate();
	}

	getSelected(): PackageListItem | undefined {
		return this.items[this.selected];
	}

	/** True if the selection is on the very first item (or list is empty). */
	isAtTop(): boolean {
		return this.items.length === 0 || this.selected === 0;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	handleInput(data: string): void {
		if (matchesKey(data, Key.up)) {
			this.move(-1);
		} else if (matchesKey(data, Key.down)) {
			this.move(1);
		} else if (matchesKey(data, Key.pageUp)) {
			this.move(-this.maxRows);
		} else if (matchesKey(data, Key.pageDown)) {
			this.move(this.maxRows);
		} else if (matchesKey(data, Key.home)) {
			this.selected = 0;
			this.ensureVisible();
			this.invalidate();
		} else if (matchesKey(data, Key.end)) {
			this.selected = Math.max(0, this.items.length - 1);
			this.ensureVisible();
			this.invalidate();
		} else if (matchesKey(data, Key.enter)) {
			const item = this.items[this.selected];
			if (item) this.onSelect?.(item);
		} else if (matchesKey(data, Key.escape)) {
			this.onCancel?.();
		}
	}

	private move(delta: number): void {
		if (this.items.length === 0) return;
		const last = this.items.length - 1;
		let next = this.selected + delta;
		if (next < 0) next = 0;
		if (next > last) next = last;
		if (next === this.selected) return;
		this.selected = next;
		this.ensureVisible();
		this.onSelectionChange?.(this.items[this.selected]);
		this.invalidate();
	}

	private ensureVisible(): void {
		if (this.selected < this.offset) {
			this.offset = this.selected;
		} else if (this.selected >= this.offset + this.maxRows) {
			this.offset = this.selected - this.maxRows + 1;
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		const lines: string[] = [];

		if (this.items.length === 0) {
			lines.push("");
			lines.push(
				"  " +
					this.theme.empty(
						truncateToWidth(this.emptyLabel, Math.max(1, width - 2), ""),
					),
			);
			lines.push("");
			this.cachedWidth = width;
			this.cachedLines = lines;
			return lines;
		}

		const start = this.offset;
		const end = Math.min(this.items.length, start + this.maxRows);

		for (let i = start; i < end; i++) {
			const item = this.items[i];
			const isSelected = i === this.selected;
			this.renderRow(lines, item, isSelected, width);
			// Compact mode: no blank gap between items
			if (!this._compact && i < end - 1) {
				lines.push(""); // blank gap
			}
		}

		if (this.items.length > this.maxRows) {
			const indicator = `  (${this.selected + 1}/${this.items.length})`;
			lines.push(
				this.theme.scrollInfo(
					truncateToWidth(indicator, Math.max(1, width - 2), ""),
				),
			);
		}

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderRow(
		lines: string[],
		item: PackageListItem,
		isSelected: boolean,
		width: number,
	): void {
		const bullet = isSelected
			? this.theme.selectedBullet("● ")
			: this.theme.bullet("○ ");
		const indent = "    ";

		// ── Compact mode: 1 line per item ──
		if (this._compact) {
			const titleStyled = isSelected
				? this.theme.selectedTitle(item.title)
				: this.theme.title(item.title);

			const parts: string[] = [`  ${bullet}${titleStyled}`];

			if (item.badge) {
				parts.push(this.theme.badge(item.badge));
			}

			const desc = (item.description ?? "").trim();
			if (desc) {
				parts.push(this.theme.description(desc));
			}

			const meta = (item.meta ?? "").trim();
			if (meta) {
				parts.push(this.theme.meta(meta));
			}

			const sep = this.theme.meta(" · ");
			const compactLine = parts.join(sep);
			lines.push(truncateToWidth(compactLine, width, "…"));
			return;
		}

		// ── Detailed mode: 3 lines per item (current) ──

		// Line 1: bullet + title (+ optional badge right-aligned)
		const titleStyled = isSelected
			? this.theme.selectedTitle(item.title)
			: this.theme.title(item.title);
		let titleLine = `  ${bullet}${titleStyled}`;
		if (item.badge) {
			const badgeStyled = this.theme.badge(item.badge);
			const visibleTitle = visibleWidth(`  ● ${item.title}`);
			const visibleBadge = visibleWidth(item.badge);
			const padding = Math.max(1, width - visibleTitle - visibleBadge - 2);
			titleLine = `  ${bullet}${titleStyled}${" ".repeat(padding)}${badgeStyled}`;
		}
		lines.push(truncateToWidth(titleLine, width, "…"));

		// Line 2: description
		const desc = item.description ?? "";
		const descTruncated = truncateToWidth(
			desc,
			Math.max(1, width - indent.length),
			"…",
		);
		lines.push(indent + this.theme.description(descTruncated));

		// Line 3: meta
		const meta = item.meta ?? "";
		const metaTruncated = truncateToWidth(
			meta,
			Math.max(1, width - indent.length),
			"…",
		);
		lines.push(indent + this.theme.meta(metaTruncated));
	}
}
