/**
 * pi-packages-manager/security.ts
 *
 * 安全审计：在安装前对 npm 包做静态安全检查。
 *
 * 设计目标：
 * - "Never auto-installs"：高危包必须用户显式 override 才能装
 * - 两层检测：metadata（零成本，必跑）+ source code keyword scan（可选）
 * - 失败安全：审计失败不阻塞安装，但会显式提示用户
 *
 * 启发自 [pi-marketplace](https://github.com/507/pi-marketplace) 的 security.ts，
 * 在此基础上做精简与适配。
 */

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RiskLevel = "safe" | "low" | "medium" | "high" | "critical" | "unknown";

export interface Finding {
  severity: Exclude<RiskLevel, "safe" | "unknown">;
  pattern: string;
  file: string;
  line?: number;
  context?: string;
}

export interface MetadataCheck {
  /** Pi manifest 声明的资源类型 */
  types: string[];
  /** 运行时依赖数量 */
  dependencyCount: number;
  /** peer 依赖数量 */
  peerDependencyCount: number;
  /** 包含的文件数（来自 npm view） */
  fileCount?: number;
  /** 解压体积 bytes（来自 npm view） */
  unpackedSize?: number;
  /** npm registry flags.insecure 标记 */
  isInsecure: boolean;
  /** 最近发布版本号 */
  version: string;
  /** 发布时间（ISO） */
  publishedAt?: string;
}

export interface AuditReport {
  packageName: string;
  version: string;
  overallRisk: RiskLevel;
  metadata: MetadataCheck;
  findings: Finding[];
  /** 用户可读摘要（已根据 locale 渲染 emoji 与文案） */
  summary: string;
  /** 详细 findings 列表文本（多行） */
  detailLines: string[];
  /** 是否执行了源码扫描（vs 仅 metadata） */
  deepScanned: boolean;
  /** 审计过程中出现的错误（不阻塞安装） */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Danger Patterns
// ---------------------------------------------------------------------------

interface DangerPattern {
  pattern: RegExp;
  severity: Exclude<RiskLevel, "safe" | "unknown">;
  description: string;
}

const DANGER_PATTERNS: DangerPattern[] = [
  { pattern: /\brm\s+(-rf|--recursive)\b/g, severity: "critical", description: "Recursive file deletion" },
  { pattern: /rimraf\s*\(/g, severity: "critical", description: "rimraf (recursive delete)" },
  { pattern: /fs\.unlink/g, severity: "critical", description: "File unlink" },
  { pattern: /fs\.rmdir/g, severity: "critical", description: "Directory removal" },
  { pattern: /fs\.rm\b/g, severity: "critical", description: "fs.rm (recursive delete)" },
  { pattern: /eval\s*\(/g, severity: "high", description: "eval() — dynamic code execution" },
  { pattern: /new\s+Function\s*\(/g, severity: "high", description: "Function() constructor" },
  { pattern: /execSync\s*\(/g, severity: "high", description: "Synchronous command execution" },
  { pattern: /exec\s*\(\s*`/g, severity: "high", description: "exec() with template literal" },
  { pattern: /spawn\s*\(/g, severity: "high", description: "Child process spawn" },
  { pattern: /child_process/g, severity: "medium", description: "child_process module import" },
  { pattern: /process\.env/g, severity: "medium", description: "Environment variable access" },
  { pattern: /https?:\/\/(?!registry\.npmjs\.org|api\.npmjs\.com)/gi, severity: "low", description: "External HTTP endpoint" },
  { pattern: /chmod\s*\(/g, severity: "low", description: "File permission change" },
  { pattern: /chown\s*\(/g, severity: "low", description: "File ownership change" },
];

/** Exported for testing — read-only view of the danger pattern catalog. */
export { DANGER_PATTERNS as DANGER_PATTERNS };


const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", ".cache", "coverage", "test", "tests", "__tests__"]);
const SOURCE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs"]);

// ---------------------------------------------------------------------------
// Risk evaluation
// ---------------------------------------------------------------------------

function evaluateRisk(
  hasExtensions: boolean,
  findings: Finding[],
  deepScanned: boolean,
): RiskLevel {
  if (!deepScanned && findings.length === 0) return "unknown";
  const crit = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const low = findings.filter((f) => f.severity === "low").length;

  // Extensions are higher stakes: a critical finding in any extension is critical overall.
  if (hasExtensions && crit > 0) return "critical";
  if (crit > 0) return "critical";
  if (hasExtensions && high > 0) return "high";
  if (high > 0) return "high";
  if (med > 2) return "medium";
  if (med > 0) return "low";
  if (low > 0) return "low";
  if (deepScanned) return "safe";
  return "unknown";
}

/** Exported for testing — pure risk evaluation, no IO. */
export const __test__ = { evaluateRisk };

const RISK_BADGE: Record<RiskLevel, string> = {
  safe: "🟢 safe",
  low: "🟢 low",
  medium: "🟡 medium",
  high: "🟠 high",
  critical: "🔴 critical",
  unknown: "⚪ unknown",
};

// ---------------------------------------------------------------------------
// Layer 1: metadata check (npm view)
// ---------------------------------------------------------------------------

/** 调 `npm view <name> --json` 拿完整 metadata。 */
export async function fetchPackageMetadata(pkgName: string): Promise<{
  metadata: MetadataCheck;
  raw: Record<string, unknown>;
}> {
  const npmName = pkgName.replace(/^npm:/, "");
  const stdout = await runCommand("npm", ["view", npmName, "--json"], 20_000, "npm view");
  const data = JSON.parse(stdout) as Record<string, unknown>;

  const deps = (data.dependencies as Record<string, string>) || {};
  const peerDeps = (data.peerDependencies as Record<string, string>) || {};
  const types = extractTypes(data.pi as Record<string, unknown> | undefined);
  const flags = (data.flags as { insecure?: number } | undefined) || {};

  const metadata: MetadataCheck = {
    types,
    dependencyCount: Object.keys(deps).length,
    peerDependencyCount: Object.keys(peerDeps).length,
    fileCount: typeof data.fileCount === "number" ? data.fileCount : undefined,
    unpackedSize: typeof data.unpackedSize === "number" ? data.unpackedSize : undefined,
    isInsecure: (flags.insecure ?? 0) > 0,
    version: (data.version as string) || "unknown",
    publishedAt: data.time && typeof (data.time as Record<string, string>).modified === "string"
      ? (data.time as Record<string, string>).modified
      : undefined,
  };

  return { metadata, raw: data };
}

function extractTypes(pi?: Record<string, unknown>): string[] {
  if (!pi) return [];
  const out: string[] = [];
  if (pi.extensions) out.push("extension");
  if (pi.skills) out.push("skill");
  if (pi.prompts) out.push("prompt");
  if (pi.themes) out.push("theme");
  return out;
}

// ---------------------------------------------------------------------------
// Layer 2: source code keyword scan (npm pack + tar + grep)
// ---------------------------------------------------------------------------

/**
 * 下载 npm tarball、解压、扫描危险模式。返回 findings。
 * 失败抛错，调用方应捕获并降级为 metadata-only。
 */
export async function sourceScan(pkgName: string, signal?: AbortSignal): Promise<Finding[]> {
  const findings: Finding[] = [];
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const workDir = join(tmpdir(), `ppm-audit-${stamp}`);

  try {
    await mkdir(workDir, { recursive: true });

    // npm pack into a deterministic location
    await runCommand("npm", ["pack", pkgName.replace(/^npm:/, ""), `--pack-destination=${workDir}`], 60_000, "npm pack", signal);

    const files = await readdir(workDir);
    const tgz = files.find((f) => f.endsWith(".tgz"));
    if (!tgz) throw new Error("No tarball found after npm pack");

    await runCommand("tar", ["-xzf", join(workDir, tgz), "-C", workDir], 20_000, "tar extract", signal);

    // npm tarballs extract to ./package/ — use that if present.
    let scanDir = workDir;
    try {
      await readdir(join(workDir, "package"));
      scanDir = join(workDir, "package");
    } catch {
      // Some packages may extract flat; fall back to workDir.
    }

    await walkAndScan(scanDir, scanDir, findings);
  } finally {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return findings;
}

async function walkAndScan(dir: string, root: string, findings: Finding[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (IGNORED_DIRECTORIES.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkAndScan(full, root, findings);
      continue;
    }
    if (!entry.isFile()) continue;
    const dot = entry.name.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = entry.name.slice(dot);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;
    await scanFile(full, root, findings);
  }
}

async function scanFile(filePath: string, root: string, findings: Finding[]): Promise<void> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return;
  }
  if (content.length > 1_500_000) {
    // Skip very large files (>1.5MB) to keep audits snappy.
    return;
  }
  const rel = relative(root, filePath) || filePath;
  const lines = content.split("\n");

  for (const danger of DANGER_PATTERNS) {
    const regex = new RegExp(danger.pattern.source, danger.pattern.flags);
    let m: RegExpExecArray | null;
    while ((m = regex.exec(content)) !== null) {
      findings.push({
        severity: danger.severity,
        pattern: danger.description,
        file: rel,
        line: lineOf(content, lines, m.index),
        context: truncate(lines[lineOf(content, lines, m.index) - 1]?.trim() ?? "", 100),
      });
    }
  }
}

function lineOf(content: string, lines: string[], index: number): number {
  let acc = 0;
  for (let i = 0; i < lines.length; i++) {
    acc += lines[i]!.length + 1;
    if (acc > index) return i + 1;
  }
  return lines.length;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

// ---------------------------------------------------------------------------
// Top-level audit orchestrator
// ---------------------------------------------------------------------------

export interface AuditOptions {
  /** 是否跑源码扫描（耗时，默认 true；metadata 始终跑） */
  deepScan?: boolean;
  /** 外部 abort 控制器 */
  signal?: AbortSignal;
}

/**
 * 对一个 npm 包做安全审计。始终跑 metadata；可选跑 source scan。
 * 永不抛错——所有失败降级为 error 字段。
 */
export async function auditPackage(
  pkgName: string,
  options: AuditOptions = {},
): Promise<AuditReport> {
  const deepScan = options.deepScan !== false;
  const errors: string[] = [];

  let metadata: MetadataCheck;
  let version = "unknown";
  try {
    const fetched = await fetchPackageMetadata(pkgName);
    metadata = fetched.metadata;
    version = fetched.metadata.version;
  } catch (err) {
    errors.push(`metadata: ${err instanceof Error ? err.message : String(err)}`);
    metadata = {
      types: [],
      dependencyCount: 0,
      peerDependencyCount: 0,
      isInsecure: false,
      version: "unknown",
    };
  }

  let findings: Finding[] = [];
  if (deepScan) {
    try {
      findings = await sourceScan(pkgName, options.signal);
    } catch (err) {
      errors.push(`source scan: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const hasExtensions = metadata.types.includes("extension");
  const overallRisk = evaluateRisk(hasExtensions, findings, deepScan);

  return {
    packageName: pkgName.replace(/^npm:/, ""),
    version,
    overallRisk,
    metadata,
    findings,
    summary: buildSummary(overallRisk, findings, deepScan, hasExtensions, errors),
    detailLines: buildDetailLines(overallRisk, metadata, findings, deepScan),
    deepScanned: deepScan,
    errors,
  };
}

function buildSummary(
  risk: RiskLevel,
  findings: Finding[],
  deepScanned: boolean,
  hasExtensions: boolean,
  errors: string[],
): string {
  const crit = findings.filter((f) => f.severity === "critical").length;
  const high = findings.filter((f) => f.severity === "high").length;
  const med = findings.filter((f) => f.severity === "medium").length;
  const parts: string[] = [];
  parts.push(`Risk: ${RISK_BADGE[risk]}`);

  if (deepScanned) {
    if (findings.length === 0) {
      parts.push("No dangerous patterns detected in source.");
    } else {
      parts.push(`Findings: ${crit} critical · ${high} high · ${med} medium · ${findings.length - crit - high - med} low`);
    }
    if (hasExtensions && (crit > 0 || high > 0)) {
      parts.push("⚠️ This package declares an extension — high-risk patterns can affect your Pi agent.");
    }
  } else {
    parts.push("Metadata-only audit (deep scan skipped).");
  }
  if (errors.length > 0) {
    parts.push(`Audit warnings: ${errors.join("; ")}`);
  }
  return parts.join("\n");
}

function buildDetailLines(
  risk: RiskLevel,
  meta: MetadataCheck,
  findings: Finding[],
  deepScanned: boolean,
): string[] {
  const lines: string[] = [];
  lines.push(`Risk: ${RISK_BADGE[risk]}`);
  lines.push(`Version: ${meta.version}`);
  lines.push(`Types: ${meta.types.length > 0 ? meta.types.join(", ") : "(none declared)"}`);
  lines.push(`Dependencies: ${meta.dependencyCount} runtime, ${meta.peerDependencyCount} peer`);
  if (meta.fileCount !== undefined) lines.push(`Files: ${meta.fileCount}`);
  if (meta.unpackedSize !== undefined) lines.push(`Unpacked size: ${formatBytes(meta.unpackedSize)}`);
  if (meta.publishedAt) lines.push(`Last published: ${meta.publishedAt}`);
  if (meta.isInsecure) lines.push("⚠️ npm registry flagged this package as insecure");

  if (deepScanned && findings.length > 0) {
    lines.push("");
    lines.push(`Findings (${findings.length}):`);
    // Cap to 10 most severe to keep the confirm dialog readable
    const sorted = [...findings].sort((a, b) => severityRank(b.severity) - severityRank(a.severity));
    for (const f of sorted.slice(0, 10)) {
      lines.push(`  ${RISK_BADGE[f.severity]}  ${f.file}${f.line ? `:${f.line}` : ""}  ${f.pattern}`);
      if (f.context) lines.push(`    ${f.context}`);
    }
    if (findings.length > 10) lines.push(`  … and ${findings.length - 10} more`);
  }
  return lines;
}

function severityRank(s: Finding["severity"]): number {
  return s === "critical" ? 4 : s === "high" ? 3 : s === "medium" ? 2 : 1;
}

/** Exported for testing — pure risk severity ranking. */
export { severityRank as __rank__ };

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Run an external command, return stdout. Rejects on non-zero exit or timeout.
 * Used for `npm view`, `npm pack`, and `tar`.
 */
function runCommand(
  command: string,
  args: string[],
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        const msg = stderr?.toString() || err.message;
        reject(new Error(`${label} failed: ${msg.trim()}`));
        return;
      }
      resolve(stdout?.toString() ?? "");
    });
    if (signal) {
      const onAbort = () => {
        child.kill("SIGTERM");
        reject(new Error(`${label} aborted`));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}

export { RISK_BADGE };
