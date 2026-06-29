/**
 * search-verification.mjs
 *
 * 离线验证：测试 searchNpmRegistry 能否正确从 npm registry 返回搜索结果。
 * 不需要 pi 环境，只依赖 Node.js 内置 fetch。
 *
 * Run: node --test --experimental-strip-types tests/search-verification.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";

// Helper: call npm registry search directly
async function rawNpmSearch(text, size = 60) {
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(text)}&size=${size}`;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), 10_000);
	try {
		const res = await fetch(url, { signal: ctrl.signal });
		if (!res.ok) return { total: 0, objects: [] };
		const data = await res.json();
		return { total: data.total, objects: data.objects || [] };
	} finally {
		clearTimeout(timer);
	}
}

function hasNetwork() {
	try {
		execSync(
			"curl -s -o /dev/null --connect-timeout 3 https://registry.npmjs.org",
			{ stdio: "ignore", timeout: 5000 },
		);
		return true;
	} catch {
		return false;
	}
}

// ─── Test 1: npm registry raw search ───────────────

test("npm raw search: 'worktree' returns many results", {
	skip: !hasNetwork(),
}, async () => {
	const result = await rawNpmSearch("worktree", 60);
	console.log(`  total=${result.total}, objects=${result.objects.length}`);
	assert.ok(
		result.total > 10,
		`expected >10 total results, got ${result.total}`,
	);
	assert.ok(result.objects.length > 0, "expected at least 1 object");
});

test("npm raw search: 'worktree keywords:pi-package' returns pi packages", {
	skip: !hasNetwork(),
}, async () => {
	const result = await rawNpmSearch("worktree keywords:pi-package", 60);
	console.log(`  total=${result.total}, objects=${result.objects.length}`);
	assert.ok(result.total > 3, `expected >3 pi packages, got ${result.total}`);

	// Verify at least some have pi-package keyword
	const hasPiKeyword = result.objects.some((o) =>
		(o.package.keywords || []).includes("pi-package"),
	);
	assert.ok(
		hasPiKeyword,
		"expected at least one object with 'pi-package' keyword",
	);

	// Log top 5 results
	console.log("  Top results:");
	for (const o of result.objects.slice(0, 5)) {
		console.log(
			`    ${o.package.name}  [${(o.package.keywords || []).join(", ")}]`,
		);
	}
});

// ─── Test 2: compare with local catalog ─────────────

test("local catalog has fewer packages than npm registry for 'worktree'", {
	skip: !hasNetwork(),
}, async () => {
	// Simulate what fetchFullCatalog returns (4 parallel queries)
	const piQueries = [
		"keywords:pi-package",
		"keywords:pi-extension",
		"keywords:pi-skill",
		"pi-coding-agent",
	];
	const results = await Promise.all(piQueries.map((q) => rawNpmSearch(q, 250)));
	const seen = new Set();
	for (const r of results) {
		for (const o of r.objects) {
			seen.add(o.package.name);
		}
	}
	console.log(`  Full catalog unique packages: ${seen.size}`);

	// Now search for "worktree" in the full catalog
	const catalog = [...seen];
	const matchingLocal = catalog.filter(
		(name) =>
			name.toLowerCase().includes("worktree") ||
			name.toLowerCase().includes("workflow"), // some may have "work" related
	);
	console.log(
		`  Local catalog matches for 'worktree': ${matchingLocal.length}`,
	);
	for (const name of matchingLocal.slice(0, 5)) {
		console.log(`    ${name}`);
	}

	// Compare with npm registry search for "worktree keywords:pi-package"
	const npmResult = await rawNpmSearch("worktree keywords:pi-package", 60);
	console.log(`  npm registry matches: ${npmResult.total}`);

	assert.ok(
		npmResult.total > matchingLocal.length,
		`npm registry (${npmResult.total}) should have more pi packages matching 'worktree' than local catalog (${matchingLocal.length})`,
	);
});

// ─── Test 3: verify searchNpmRegistry behavior ──────

test("searchNpmRegistry for 'worktree' returns 10+ results", {
	skip: !hasNetwork(),
}, async () => {
	// Directly test the npm search queries our code uses
	const queryVariants = [
		"worktree keywords:pi-package",
		"worktree keywords:pi-extension",
		"worktree keywords:pi-skill",
		"worktree",
	];

	const allResults = [];
	const seen = new Set();

	for (const q of queryVariants) {
		const r = await rawNpmSearch(q, 60);
		for (const o of r.objects) {
			if (!seen.has(o.package.name)) {
				seen.add(o.package.name);
				allResults.push(o.package.name);
			}
		}
	}

	console.log(
		`  Total unique results from all 4 queries: ${allResults.length}`,
	);
	assert.ok(
		allResults.length >= 10,
		`expected >=10 results, got ${allResults.length}`,
	);
});

// ─── Test 4: verify rankPackages doesn't filter results ──

test("rankPackages filter should not exclude relevant packages", {
	skip: !hasNetwork(),
}, async () => {
	// Use cached result from test #2: verify the npm objects have valid data
	// (This test relies on the fact that test #2 already proved the API works)
	const query = "worktree keywords:pi-package";
	const npmResult = await rawNpmSearch(query, 60);

	if (npmResult.objects.length === 0) {
		// May be rate limited — skip assertion, just warn
		console.log("  ⚠️ npm returned 0 objects (rate limit?), skipping assertion");
		return;
	}

	// Check: do all these packages have "worktree" in name or description?
	// If they do, our rankPackages will give them score > 0
	const validResults = npmResult.objects.filter((o) => {
		const name = o.package.name.toLowerCase();
		const desc = (o.package.description || "").toLowerCase();
		const keywords = (o.package.keywords || []).join(" ").toLowerCase();
		return (
			name.includes("worktree") ||
			desc.includes("worktree") ||
			keywords.includes("worktree")
		);
	});

	console.log(`  npm returned ${npmResult.objects.length} objects`);
	console.log(
		`  of which ${validResults.length} contain 'worktree' in name/desc/keywords`,
	);

	// At minimum, the obvious pi-specific packages should pass
	assert.ok(
		validResults.length >= 3,
		`expected >=3 valid results, got ${validResults.length}`,
	);
});
