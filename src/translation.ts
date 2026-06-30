/**
 * pi-packages-manager/translation.ts
 *
 * 本地翻译引擎 — 对接 MTranServer（xxnuo/mtranserver）
 *
 * API（实测）：
 *   GET  /health                 → 200 OK
 *   POST /translate              → {"result":"..."}
 *     {"from":"en","to":"zh-Hans","text":"..."}
 *
 * 功能：
 *   1. 健康检查
 *   2. 单段文本翻译
 *   3. README 分段解析（按 ##/###/#### 标题拆分）
 *   4. 分段翻译缓存（独立文件，不同于 i18n 的 translations.json）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ─── 类型定义 ────────────────────────────────────────────

export interface ReadmeSection {
	/** 原标题文本，如 "## Features" */
	heading: string;
	/** 该标题下的 body 内容（不含标题行本身） */
	body: string;
	/** 翻译后的 body（undefined = 尚未翻译） */
	translated?: string;
	/** 是否正在翻译中 */
	loading: boolean;
}

interface CacheEntry {
	/** 语言对标识，如 "en->zh-Hans" */
	langPair: string;
	/** 分段缓存 */
	sections: Array<{ heading: string; body: string; translated: string }>;
	/** 完整原始 README（用于校验变更） */
	originalReadme: string;
	translatedAt: number;
}

type TranslationCache = Record<string, CacheEntry>; // key = pkgName

// ─── 路径 ────────────────────────────────────────────────

const HOME = process.env.HOME!;
const DATA_DIR = join(HOME, ".pi/agent/extensions/pi-packages-manager/data");
const CACHE_FILE = join(DATA_DIR, "translations_readme.json");

// ─── 健康检查 ────────────────────────────────────────────

/**
 * 检测 MTranServer 是否可达。
 * GET /health → 200 即为连通。
 */
export async function checkTranslationService(
	baseUrl: string,
	apiKey?: string,
	timeoutMs = 5000,
): Promise<boolean> {
	const url = `${baseUrl.replace(/\/+$/, "")}/health`;
	try {
		const headers: Record<string, string> = {};
		if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		const res = await fetch(url, {
			method: "GET",
			headers,
			signal: controller.signal,
		});
		clearTimeout(timer);
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * 测量 MTranServer 的响应延迟（毫秒）。
 * 返回 -1 表示不可达。
 */
export async function pingTranslationService(
	baseUrl: string,
	apiKey?: string,
	timeoutMs = 5000,
): Promise<number> {
	const start = performance.now();
	const ok = await checkTranslationService(baseUrl, apiKey, timeoutMs);
	return ok ? Math.round(performance.now() - start) : -1;
}

// ─── 单段翻译 ────────────────────────────────────────────

/**
 * 翻译一段文本。
 * POST /translate → {"result":"..."}
 */
export async function translateText(
	baseUrl: string,
	text: string,
	from = "en",
	to = "zh-Hans",
	apiKey?: string,
	timeoutMs = 30000,
): Promise<string> {
	const url = `${baseUrl.replace(/\/+$/, "")}/translate`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const res = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ from, to, text, html: false }),
			signal: controller.signal,
		});
		clearTimeout(timer);

		if (!res.ok) {
			throw new Error(`MTranServer HTTP ${res.status}: ${res.statusText}`);
		}

		const data = (await res.json()) as { result?: string };
		if (typeof data.result !== "string") {
			throw new Error(`Unexpected response format: ${JSON.stringify(data)}`);
		}
		return data.result;
	} catch (err) {
		clearTimeout(timer);
		throw err;
	}
}

// ─── README 分段 ─────────────────────────────────────────

/** 用于按标题拆分的正则：## / ### / #### 标题行 */
const HEADING_RE = /^(#{2,4})\s+(.+)$/gm;

/**
 * 将 README markdown 按标题拆分为多个 section。
 * 标题前的引言部分（无标题前缀）作为第一个 section 返回（heading=""）。
 */
export function parseReadme(readme: string): ReadmeSection[] {
	if (!readme) return [];

	const sections: ReadmeSection[] = [];

	// 找到所有标题的位置
	const matches: Array<{ heading: string; index: number }> = [];
	let match: RegExpExecArray | null;
	HEADING_RE.lastIndex = 0;
	while ((match = HEADING_RE.exec(readme)) !== null) {
		matches.push({ heading: match[0], index: match.index });
	}

	if (matches.length === 0) {
		// 没有标题 → 整个文档作为一个 section
		sections.push({ heading: "", body: readme.trim(), loading: false });
		return sections;
	}

	// 标题前的内容（intro）
	if (matches[0].index > 0) {
		sections.push({
			heading: "",
			body: readme.slice(0, matches[0].index).trim(),
			loading: false,
		});
	}

	// 每个标题到下一个标题之间的内容
	for (let i = 0; i < matches.length; i++) {
		const start = matches[i].index + matches[i].heading.length;
		const end = i + 1 < matches.length ? matches[i + 1].index : readme.length;
		const body = readme.slice(start, end).trim();
		sections.push({
			heading: matches[i].heading,
			body,
			loading: false,
		});
	}

	return sections;
}

/**
 * 将 section 列表重新合并为 markdown 字符串。
 * 如果 section 有 translated 字段则使用翻译内容，否则保持原始 body。
 */
export function reconstructReadme(sections: ReadmeSection[]): string {
	return sections
		.map((s) => {
			const content = s.translated ?? s.body;
			if (!s.heading) return content; // intro section，无标题
			return `${s.heading}\n${content}`;
		})
		.join("\n\n");
}

// ─── 缓存管理 ────────────────────────────────────────────

function loadCache(): TranslationCache {
	try {
		if (existsSync(CACHE_FILE)) {
			return JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
		}
	} catch {
		/* ignore corrupt cache */
	}
	return {};
}

function saveCache(cache: TranslationCache): void {
	try {
		mkdirSync(DATA_DIR, { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
	} catch {
		/* best-effort */
	}
}

/**
 * 构建缓存 key，包含源语言和目标语言。
 */
function cacheKey(pkgName: string, from: string, to: string): string {
	return `${pkgName}:${from}->${to}`;
}

/**
 * 从缓存中读取指定包的翻译分段。
 * 会校验原始 README 是否变更（以 detect 文档更新后需要重新翻译）。
 */
export function getTranslationCache(
	pkgName: string,
	from: string,
	to: string,
	originalReadme: string,
): ReadmeSection[] | null {
	const cache = loadCache();
	const key = cacheKey(pkgName, from, to);
	const entry = cache[key];

	if (!entry) return null;
	// 如果原始 README 变了，缓存失效
	if (entry.originalReadme !== originalReadme) return null;

	return entry.sections.map((s) => ({
		heading: s.heading,
		body: s.body,
		translated: s.translated,
		loading: false,
	}));
}

/**
 * 保存翻译结果到缓存。
 */
export function setTranslationCache(
	pkgName: string,
	from: string,
	to: string,
	originalReadme: string,
	sections: ReadmeSection[],
): void {
	const cache = loadCache();
	const key = cacheKey(pkgName, from, to);
	cache[key] = {
		langPair: `${from}->${to}`,
		sections: sections.map((s) => ({
			heading: s.heading,
			body: s.body,
			translated: s.translated ?? "",
		})),
		originalReadme,
		translatedAt: Date.now(),
	};
	saveCache(cache);
}

/**
 * 清空全部 README 翻译缓存。
 */
export function clearTranslationCache(): number {
	const cache = loadCache();
	const count = Object.keys(cache).length;
	if (count > 0) {
		try {
			mkdirSync(DATA_DIR, { recursive: true });
			writeFileSync(CACHE_FILE, JSON.stringify({}, null, 2), "utf-8");
		} catch {
			/* best-effort */
		}
	}
	return count;
}

/**
 * 返回缓存条目数和总大小估算（字节），用于 UI 显示。
 */
export function getTranslationCacheInfo(): {
	count: number;
	sizeBytes: number;
} {
	try {
		if (existsSync(CACHE_FILE)) {
			const stat = existsSync(CACHE_FILE);
			// 简单统计
			const raw = readFileSync(CACHE_FILE, "utf-8");
			const cache = JSON.parse(raw) as TranslationCache;
			return {
				count: Object.keys(cache).length,
				sizeBytes: Buffer.byteLength(raw, "utf-8"),
			};
		}
	} catch {
		/* ignore */
	}
	return { count: 0, sizeBytes: 0 };
}
