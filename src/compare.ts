/**
 * pi-packages-manager/compare.ts
 *
 * 包对比模块：
 *   1. 下载多个 npm 包到临时目录
 *   2. 基于用户输入的 prompt，逐一分析每个包的代码
 *   3. 汇总生成对比结论
 *
 * 临时目录默认 ./.pi/tmp/pi-packages-manager，可通过 COMPARE_TMP_DIR 环境变量覆盖。
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { PackageInfo } from "./api";

// ─── 配置 ──────────────────────────────────────────────

/**
 * 对比用的临时目录。
 * 优先级：COMPARE_TMP_DIR 环境变量 > 当前工程 .pi/tmp/pi-packages-manager
 */
function getCompareTmpDir(): string {
	const env = process.env.COMPARE_TMP_DIR;
	if (env) return env;
	return join(process.cwd(), ".pi", "tmp", "pi-packages-manager");
}

/** 会话级别缓存：包名 → 已下载的解压目录路径。同一次会话内同一包不会重复下载。 */
const downloadedCache = new Map<string, string>();

// ─── 进度回调 ──────────────────────────────────────────

export interface CompareProgress {
	phase: "download" | "analyze" | "compare" | "cleanup";
	pkgName?: string;
	message: string;
	done?: number;
	total?: number;
}

// ─── 主入口 ────────────────────────────────────────────

/**
 * 对选中的多个包进行对比分析。
 *
 * @param pkgs         选中的包列表（至少2个）
 * @param userPrompt   用户输入的对比诉求（可为空字符串）
 * @param onProgress   进度回调（每次 phase/pkg 变更时调用，用于 UI 展示）
 * @returns            对比结论的 markdown 文本
 */
export async function comparePackages(
	pkgs: PackageInfo[],
	userPrompt: string,
	onProgress?: (progress: CompareProgress) => void,
): Promise<string> {
	if (pkgs.length < 2) {
		throw new Error("At least 2 packages are required for comparison");
	}

	const baseDir = getCompareTmpDir();
	await mkdir(baseDir, { recursive: true });

	// ── 2. 下载所有包（检查缓存，跳过已下载的）──
	const pkgDirs: Map<string, string> = new Map();
	const total = pkgs.length;
	let downloadedCount = 0;
	let cachedCount = 0;

	for (let i = 0; i < pkgs.length; i++) {
		const pkg = pkgs[i];
		const npmName = pkg.name.replace(/^npm:/, "");

		// 检查内存缓存
		const cached = downloadedCache.get(pkg.name);
		if (cached) {
			pkgDirs.set(pkg.name, cached);
			cachedCount++;
			onProgress?.({
				phase: "download",
				pkgName: pkg.name,
				message: `♻️ Using cached ${pkg.name}...`,
				done: i,
				total,
			});
			continue;
		}

		// 下载
		onProgress?.({
			phase: "download",
			pkgName: pkg.name,
			message: `📦 Downloading ${pkg.name}...`,
			done: i,
			total,
		});
		const dir = await downloadPackage(pkg.name, baseDir);
		downloadedCache.set(pkg.name, dir);
		pkgDirs.set(pkg.name, dir);
		downloadedCount++;
	}
	onProgress?.({
		phase: "download",
		message:
			cachedCount > 0
				? `✅ ${downloadedCount} downloaded, ${cachedCount} cached`
				: `✅ All ${total} downloaded`,
		done: total,
		total,
	});

	// ── 3. 逐一分析每个包 ──
	const analyses: Array<{ name: string; analysis: string }> = [];
	for (let i = 0; i < pkgs.length; i++) {
		const pkg = pkgs[i];
		const dir = pkgDirs.get(pkg.name)!;
		onProgress?.({
			phase: "analyze",
			pkgName: pkg.name,
			message: `🔍 Analyzing ${pkg.name}...`,
			done: i,
			total,
		});
		const analysis = await analyzePackage(pkg.name, dir, userPrompt);
		analyses.push({ name: pkg.name, analysis });
	}
	onProgress?.({
		phase: "analyze",
		message: `✅ All ${total} packages analyzed`,
		done: total,
		total,
	});

	// ── 4. 生成对比结论 ──
	onProgress?.({
		phase: "compare",
		message: "📊 Generating comparison summary...",
	});
	const comparison = await generateComparison(analyses, userPrompt);

	return comparison;
}

// ─── 下载包 ────────────────────────────────────────────

/**
 * 通过 npm pack 将包下载到临时目录并解压。
 * 返回包内容所在的目录路径。
 */
async function downloadPackage(
	pkgName: string,
	workDir: string,
): Promise<string> {
	const npmName = pkgName.replace(/^npm:/, "");

	// npm pack
	await runCommand(
		"npm",
		["pack", npmName, `--pack-destination=${workDir}`],
		60_000,
		`npm pack ${npmName}`,
	);

	// Find the .tgz
	const files = await readdir(workDir);
	const tgz = files.find((f) => f.endsWith(".tgz"));
	if (!tgz) throw new Error(`No tarball found for ${npmName} after npm pack`);

	// Create a named subdirectory for this package
	const pkgDir = join(workDir, npmName.replace("/", "_"));
	await mkdir(pkgDir, { recursive: true });

	// Extract
	await runCommand(
		"tar",
		["-xzf", join(workDir, tgz), "-C", pkgDir],
		20_000,
		`tar extract ${npmName}`,
	);

	// npm tarballs extract to ./package/ — use that
	try {
		await readdir(join(pkgDir, "package"));
		return join(pkgDir, "package");
	} catch {
		return pkgDir;
	}
}

// ─── 分析单个包 ────────────────────────────────────────

async function analyzePackage(
	name: string,
	dir: string,
	userPrompt: string,
): Promise<string> {
	// Build a directory tree summary for the prompt context
	const tree = await buildDirTree(dir, dir, 3);

	// Read package.json if available
	let pkgJson = "";
	try {
		pkgJson = await readFile(join(dir, "package.json"), "utf-8");
	} catch {
		pkgJson = "{}";
	}

	const prompt = [
		`You are analyzing a Pi coding agent package or extension.`,
		`Package name: ${name}`,
		``,
		`## Directory structure:`,
		tree,
		``,
		`## package.json:`,
		pkgJson,
		``,
		userPrompt ? `## Analysis focus: ${userPrompt}` : `## Analysis`,
		``,
		`Please analyze this package. Focus on:`,
		`- What problem does it solve?`,
		`- Key features and architecture`,
		`- Code quality and structure`,
		`- Dependencies and complexity`,
		userPrompt ? `- Specifically address: ${userPrompt}` : ``,
		``,
		`Provide a concise analysis (2-3 paragraphs).`,
	]
		.filter(Boolean)
		.join("\n");

	return await runPiPrompt(prompt, `analyzing ${name}`, dir);
}

// ─── 生成对比结论 ───────────────────────────────────────

async function generateComparison(
	analyses: Array<{ name: string; analysis: string }>,
	userPrompt: string,
): Promise<string> {
	const analysisBlock = analyses
		.map((a) => `=== ${a.name} ===\n${a.analysis}`)
		.join("\n\n");

	const prompt = [
		`You are comparing multiple Pi coding agent packages.`,
		`User's comparison focus: ${userPrompt || "(general comparison)"}`,
		``,
		`## Individual analyses:`,
		``,
		analysisBlock,
		``,
		`## Task:`,
		`Provide a structured comparison of these packages. Cover:`,
		`- Overview: one-line summary of what each package does`,
		`- Direct comparison: how they differ in approach, features, and architecture`,
		userPrompt ? `- How each addresses: ${userPrompt}` : ``,
		`- Recommendations: when to use which package`,
		``,
		`Format as markdown with sections. Be concise but thorough.`,
	]
		.filter(Boolean)
		.join("\n");

	return await runPiPrompt(prompt, "generating comparison", process.cwd());
}

// ─── 调用 pi 模型 ──────────────────────────────────────

async function runPiPrompt(
	prompt: string,
	label: string,
	cwd: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const proc = execFile(
			"pi",
			["-p", "--no-session"],
			{
				encoding: "utf-8",
				timeout: 120_000,
				maxBuffer: 1024 * 1024,
				cwd,
			},
			(err, stdout, stderr) => {
				if (err) {
					reject(
						new Error(
							`pi -p ${label} failed: ${(stderr || err.message).trim()}`,
						),
					);
				} else {
					resolve(stdout?.trim() || stderr?.trim() || "(no output)");
				}
			},
		);
		if (proc.stdin) {
			proc.stdin.write(prompt);
			proc.stdin.end();
		}
	});
}

// ─── 目录树构建 ────────────────────────────────────────

interface TreeNode {
	name: string;
	isDir: boolean;
	children?: TreeNode[];
}

async function buildDirTree(
	dir: string,
	root: string,
	maxDepth: number,
	currentDepth = 0,
): Promise<string> {
	if (currentDepth > maxDepth) return "";

	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return "";
	}

	const ignored = new Set([
		"node_modules",
		".git",
		"__pycache__",
		".cache",
		"coverage",
	]);
	const sourceExts = new Set([
		".ts",
		".js",
		".mjs",
		".cjs",
		".json",
		".md",
		".yaml",
		".yml",
	]);

	const nodes: TreeNode[] = [];
	for (const entry of entries) {
		if (ignored.has(entry.name)) continue;
		if (entry.name.startsWith(".") && entry.name !== ".gitignore") continue;
		nodes.push({
			name: entry.name,
			isDir: entry.isDirectory(),
		});
	}

	// Sort: dirs first, then alphabetical
	nodes.sort((a, b) => {
		if (a.isDir && !b.isDir) return -1;
		if (!a.isDir && b.isDir) return 1;
		return a.name.localeCompare(b.name);
	});

	const lines: string[] = [];
	for (const node of nodes) {
		const prefix = "  ".repeat(currentDepth);
		if (node.isDir) {
			lines.push(`${prefix}📁 ${node.name}/`);
			const sub = await buildDirTree(
				join(dir, node.name),
				root,
				maxDepth,
				currentDepth + 1,
			);
			if (sub) lines.push(sub);
		} else {
			const ext = node.name.slice(node.name.lastIndexOf("."));
			if (!currentDepth || currentDepth <= maxDepth || sourceExts.has(ext)) {
				lines.push(`${prefix}📄 ${node.name}`);
			}
		}
	}

	return lines.join("\n");
}

// ─── 工具 ──────────────────────────────────────────────

function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
	label: string,
): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = execFile(
			command,
			args,
			{
				timeout: timeoutMs,
				maxBuffer: 32 * 1024 * 1024,
			},
			(err, stdout, stderr) => {
				if (err) {
					const msg = stderr?.toString() || err.message;
					reject(new Error(`${label} failed: ${msg.trim()}`));
					return;
				}
				resolve(stdout?.toString() ?? "");
			},
		);
	});
}
