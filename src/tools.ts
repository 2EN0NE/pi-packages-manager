/**
 * pi-packages-manager/tools.ts
 *
 * Registers Pi tools that the LLM can call directly via natural language.
 * Users can say things like:
 *   "Find me a Pi package for MCP"
 *   "Show me details of pi-tinyfish-tools"
 *   "Audit the package pi-mcp-adapter"
 *   "Install pi-autoname"
 *
 * These tools complement the /packages-list command — both coexist.
 */

import {
  type ExtensionAPI,
  truncateHead,
  formatSize,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import {
  searchNpmRegistry,
  getPackageDetail,
  fetchFullCatalog,
  normalizeInstallSource,
  clearCatalogCache,
  type PackageInfo,
} from "./api";
import { auditPackage, RISK_BADGE } from "./security";

/** 统一截断工具输出，避免大结果撜爆 LLM 上下文（官方 50KB / 2000 行上限）。 */
function textResult(text: string, details: Record<string, unknown> = {}) {
  const trunc = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  let out = trunc.content;
  if (trunc.truncated) {
    out += `\n\n[Results truncated: showing ${trunc.outputLines}/${trunc.totalLines} lines (${formatSize(trunc.outputBytes)} / ${formatSize(trunc.totalBytes)}). Refine your query or lower the limit.]`;
  }
  return { content: [{ type: "text" as const, text: out }], details };
}

export function registerTools(pi: ExtensionAPI): void {
  // ─── packages_search ────────────────────────────────

  pi.registerTool({
    name: "packages_search",
    label: "Search Pi Packages",
    description:
      "Search for pi packages on npm by keyword, type, or description. " +
      "Returns a list of matching packages with name, description, version, and install status.",
    promptSnippet: "Search for pi packages by keyword or type",
    promptGuidelines: [
      "Use packages_search when the user wants to find, browse, or discover pi packages.",
      "The query can be a keyword (e.g. 'mcp', 'theme'), a package type filter, or a natural language description.",
      "Results include install status so the user can decide whether to install.",
    ],
    parameters: Type.Object({
      query: Type.String({ description: "Search keyword or phrase (e.g. 'mcp', 'browser automation', 'theme')" }),
      type: Type.Optional(
        StringEnum(["extension", "skill", "prompt", "theme"] as const, {
          description: "Filter by package resource type",
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Max results to return (default 20, max 60)", minimum: 1, maximum: 60 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const limit = Math.min(params.limit ?? 20, 60);
      let results: PackageInfo[];

      try {
        // If there's a type filter, append it to the query
        const fullQuery = params.type ? `type:${params.type} ${params.query}` : params.query;
        results = await searchNpmRegistry(fullQuery, limit);
      } catch (err) {
        return textResult(`Search failed: ${(err as Error).message}`);
      }

      if (results.length === 0) {
        return textResult(`No packages found matching "${params.query}".`, { query: params.query, count: 0 });
      }

      const lines = results.map((pkg, i) => {
        const badge = pkg.installed ? " ✅" : "";
        const dl = pkg.downloads ? ` (${formatNumber(pkg.downloads)}/mo)` : "";
        const types = pkg.types?.length ? ` [${pkg.types.join(", ")}]` : "";
        return `${i + 1}. **${pkg.name}**${badge}${dl}${types} — ${pkg.description || "No description"}`;
      });

      const header = `Found ${results.length} package(s) matching "${params.query}":\n`;
      return textResult(header + lines.join("\n"), {
        query: params.query,
        count: results.length,
        packages: results.map(formatPkgSummary),
      });
    },
  });

  // ─── packages_detail ────────────────────────────────

  pi.registerTool({
    name: "packages_detail",
    label: "Package Details",
    description:
      "Get detailed information about a specific pi package: version, author, license, " +
      "resources (extensions, skills, prompts, themes), dependencies, and install status.",
    promptSnippet: "View details of a specific pi package",
    promptGuidelines: [
      "Use packages_detail when the user asks about a specific package by name.",
      "Returns full metadata including declared resources, install status, and links.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name (e.g. 'pi-tinyfish-tools', '@scope/pkg')" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const detail = await getPackageDetail(params.name);

      if (!detail) {
        return textResult(`Package "${params.name}" not found on npm.`);
      }

      const lines: string[] = [
        `📦 **${detail.name}** v${detail.version || detail.latestVersion || "?"}`,
        ``,
        detail.description || "(No description)",
        ``,
        `Status: ${detail.installed ? `✅ Installed (v${detail.installedVersion})` : "⬜ Not installed"}`,
      ];

      if (detail.author) lines.push(`Author: ${detail.author}`);
      if (detail.license) lines.push(`License: ${detail.license}`);
      if (detail.types?.length) lines.push(`Resources: ${detail.types.join(", ")}`);
      if (detail.keywords?.length) lines.push(`Keywords: ${detail.keywords.join(", ")}`);
      if (detail.downloads) lines.push(`Downloads: ${formatNumber(detail.downloads)}/mo`);
      if (detail.npmUrl) lines.push(`npm: ${detail.npmUrl}`);
      if (detail.repoUrl) lines.push(`Repo: ${detail.repoUrl}`);

      if (detail.piManifest && Object.keys(detail.piManifest).length > 0) {
        lines.push("", "Pi manifest:");
        const manifest = detail.piManifest as Record<string, unknown>;
        for (const key of ["extensions", "skills", "prompts", "themes"]) {
          const val = manifest[key];
          if (Array.isArray(val) && val.length > 0) {
            lines.push(`  ${key}: ${val.join(", ")}`);
          }
        }
      }

      lines.push("", "Install:", `  pi install npm:${detail.name}`);

      return textResult(lines.join("\n"), formatPkgSummary(detail));
    },
  });

  // ─── packages_audit ─────────────────────────────────

  pi.registerTool({
    name: "packages_audit",
    label: "Security Audit Package",
    description:
      "Run a security audit on a pi package before installing. Checks metadata and scans " +
      "source code for 15 known-dangerous patterns (eval, execSync, rm -rf, etc.). " +
      "Returns a risk classification from safe to critical.",
    promptSnippet: "Audit a pi package for security risks",
    promptGuidelines: [
      "Use packages_audit when the user wants to check if a package is safe to install.",
      "The audit is informational only — it does not block installation.",
      "Risk levels: safe, low, medium, high, critical.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name to audit (e.g. 'pi-tinyfish-tools')" }),
      deepScan: Type.Optional(Type.Boolean({ description: "Download and scan source code (default true)" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const report = await auditPackage(params.name, {
        deepScan: params.deepScan !== false,
      });

      const lines: string[] = [
        `🔒 Security Audit: **${report.packageName}**`,
        ``,
        `Overall risk: ${RISK_BADGE[report.overallRisk]}`,
        `Version: ${report.version}`,
        report.summary,
      ];

      if (report.detailLines.length > 0) {
        lines.push("", "Details:");
        lines.push(...report.detailLines.map((l) => `  ${l}`));
      }

      if (report.errors.length > 0) {
        lines.push("", "⚠️ Audit warnings:", ...report.errors.map((e) => `  - ${e}`));
      }

      return textResult(lines.join("\n"), {
        packageName: report.packageName,
        version: report.version,
        overallRisk: report.overallRisk,
        findingCount: report.findings.length,
        deepScanned: report.deepScanned,
        errors: report.errors,
      });
    },
  });

  // ─── packages_install ───────────────────────────────

  pi.registerTool({
    name: "packages_install",
    label: "Install Pi Package",
    description:
      "Install a pi package. Runs a security audit first, then requires user confirmation. " +
      "The audit result is shown to the user before proceeding.",
    promptSnippet: "Install a pi package with security review",
    promptGuidelines: [
      "Use packages_install when the user explicitly asks to install a package.",
      "This tool always runs a security audit first and shows the result to the user.",
      "The user must confirm before installation proceeds.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Package name to install (e.g. 'pi-tinyfish-tools')" }),
      scope: Type.Optional(
        StringEnum(["user", "project"] as const, {
          description: "Install scope: 'user' (global, default) or 'project' (local .pi/)",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const pkgName = params.name.trim();
      if (!pkgName) {
        return textResult("Please specify a package name to install.");
      }

      // Run security audit first
      const report = await auditPackage(pkgName, { deepScan: true });

      // Show audit result and ask for confirmation
      const riskEmoji = RISK_BADGE[report.overallRisk];
      const auditInfo = [
        `📦 Install: pi install npm:${pkgName}`,
        ``,
        `Security audit: ${riskEmoji}`,
        report.summary,
        ``,
        `Pi packages may run arbitrary code. Only install from sources you trust.`,
      ].join("\n");

      // For high/critical risk, use a stronger confirmation
      if (report.overallRisk === "high" || report.overallRisk === "critical") {
        const dangerChoice = await ctx.ui.select(
          `⚠️ ${report.overallRisk.toUpperCase()}-risk package`,
          [
            "🚫 Cancel installation (recommended)",
            `⚠️ Install anyway — ${report.findings.length} risky pattern(s) detected`,
          ],
        );
        if (!dangerChoice?.includes("Install anyway")) {
          return textResult(`Installation of ${pkgName} cancelled by user.`, { installed: false, audit: report.overallRisk });
        }
      } else {
        const confirmed = await ctx.ui.confirm(`Install ${pkgName}?`, auditInfo);
        if (!confirmed) {
          return textResult(`Installation of ${pkgName} cancelled by user.`, { installed: false, audit: report.overallRisk });
        }
      }

      // Proceed with installation
      const scope = params.scope ?? "user";
      const result = await (await import("./api")).runPiInstallAsync(pkgName, scope);

      if (result.success) {
        clearCatalogCache();
        return textResult(
          `✅ ${pkgName} installed successfully! (Audit: ${riskEmoji})\nRun /reload or restart Pi to activate new resources.`,
          { installed: true, audit: report.overallRisk },
        );
      } else {
        return textResult(`❌ Installation failed: ${result.output}`, { installed: false, error: result.output });
      }
    },
  });
}

// ─── Helpers ─────────────────────────────────────────────

function formatPkgSummary(pkg: PackageInfo): Record<string, unknown> {
  return {
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    installed: pkg.installed,
    installedVersion: pkg.installedVersion,
    types: pkg.types,
    downloads: pkg.downloads,
    author: pkg.author,
  };
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}
