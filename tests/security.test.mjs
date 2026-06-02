// ---------------------------------------------------------------------------
// Tests for src/security.ts
//
// Run with:  node --test tests/security.test.mjs
//
// The tests split into two layers:
//   1. Pure unit tests for risk evaluation (no IO, fast, always run)
//   2. Integration tests for auditPackage() against a real npm package
//      (requires `npm` on PATH and network access; skip if unavailable)
// ---------------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import {
  __test__,
  __rank__,
  auditPackage,
  DANGER_PATTERNS,
  RISK_BADGE,
} from "../src/security.ts";

const { evaluateRisk } = __test__;

// ---------------------------------------------------------------------------
// 1. Pure risk evaluation
// ---------------------------------------------------------------------------

test("evaluateRisk: no findings + deep scanned → safe", () => {
  assert.equal(evaluateRisk(false, [], true), "safe");
});

test("evaluateRisk: no findings + not deep scanned → unknown", () => {
  assert.equal(evaluateRisk(false, [], false), "unknown");
});

test("evaluateRisk: low-only findings → low", () => {
  const findings = [
    { severity: "low", pattern: "chmod", file: "x.ts", line: 1, context: "chmod(...)" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "low");
});

test("evaluateRisk: medium findings without extensions → low", () => {
  // 1 medium finding (non-extension) still classifies as low overall
  const findings = [
    { severity: "medium", pattern: "process.env", file: "x.ts", line: 1, context: "process.env" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "low");
});

test("evaluateRisk: 3+ medium findings → medium", () => {
  const findings = [
    { severity: "medium", pattern: "p1", file: "x.ts" },
    { severity: "medium", pattern: "p2", file: "x.ts" },
    { severity: "medium", pattern: "p3", file: "x.ts" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "medium");
});

test("evaluateRisk: any high finding → high", () => {
  const findings = [
    { severity: "high", pattern: "eval()", file: "x.ts" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "high");
});

test("evaluateRisk: any critical finding → critical (even without extensions)", () => {
  const findings = [
    { severity: "critical", pattern: "rm -rf", file: "x.ts" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "critical");
});

test("evaluateRisk: critical in non-extension is still critical", () => {
  const findings = [
    { severity: "critical", pattern: "fs.rm", file: "x.ts" },
  ];
  assert.equal(evaluateRisk(false, findings, true), "critical");
});

test("__rank__: critical > high > medium > low", () => {
  assert.ok(__rank__("critical") > __rank__("high"));
  assert.ok(__rank__("high") > __rank__("medium"));
  assert.ok(__rank__("medium") > __rank__("low"));
});

// ---------------------------------------------------------------------------
// 2. Pattern catalog sanity
// ---------------------------------------------------------------------------

test("DANGER_PATTERNS: covers critical categories", () => {
  const descs = DANGER_PATTERNS.map((p) => p.description.toLowerCase()).join(" ");
  assert.ok(descs.includes("rm"), "should detect rm -rf");
  assert.ok(descs.includes("eval") || descs.includes("function"), "should detect eval/Function");
  assert.ok(descs.includes("spawn") || descs.includes("exec"), "should detect process spawning");
});

test("DANGER_PATTERNS: every pattern has a valid severity", () => {
  for (const p of DANGER_PATTERNS) {
    assert.ok(["critical", "high", "medium", "low"].includes(p.severity), `bad severity: ${p.severity}`);
    assert.ok(p.pattern instanceof RegExp, "pattern must be a RegExp");
  }
});

test("RISK_BADGE: every level has a colored badge", () => {
  for (const level of ["safe", "low", "medium", "high", "critical", "unknown"]) {
    assert.ok(RISK_BADGE[level].length > 0, `missing badge for ${level}`);
  }
});

// ---------------------------------------------------------------------------
// 3. Integration: real audit against a well-known safe package
//
// Skipped when npm is not available or in offline environments.
// Uses `chalk` — a small, dependency-free utility widely used and audited.
// ---------------------------------------------------------------------------

function hasNpm() {
  try {
    execFileSync("npm", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("auditPackage(chalk): completes and returns a report", { skip: !hasNpm() }, async () => {
  const report = await auditPackage("chalk", { deepScan: true });
  assert.equal(report.packageName, "chalk");
  assert.ok(report.version.length > 0, "version should be present");
  assert.ok(["safe", "low", "medium", "high", "critical", "unknown"].includes(report.overallRisk));
  assert.equal(report.deepScanned, true);
  assert.ok(Array.isArray(report.findings));
  assert.ok(typeof report.summary === "string" && report.summary.length > 0);
  assert.ok(report.detailLines.length > 0);
  // chalk has no extension manifest, so it shouldn't claim to be an extension
  assert.equal(report.metadata.types.includes("extension"), false);
});

test("auditPackage: invalid package name does not throw", { skip: !hasNpm() }, async () => {
  // A non-existent package should produce a report with errors, not throw.
  const report = await auditPackage("this-package-does-not-exist-xyz12345", { deepScan: false });
  assert.ok(report.errors.length > 0, "should record at least one error");
  // Even with errors, the report should be structurally valid
  assert.equal(typeof report.summary, "string");
  assert.equal(report.deepScanned, false);
});
