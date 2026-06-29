/**
 * cli-search.mjs — 命令行搜索 pi 包，直接输出结果
 *
 * Usage: node --experimental-strip-types cli-search.mjs <query>
 *   node --experimental-strip-types cli-search.mjs worktree
 *
 * 绕过 TS 模块加载问题，直接调 npm registry API。
 */

const query = process.argv[2];
if (!query) {
	console.error("Usage: node cli-search.mjs <query>");
	process.exit(1);
}

// 直接从 npm registry 搜索（与 searchNpmRegistry 相同逻辑）
const queryVariants = [
	`${query} keywords:pi-package`,
	`${query} keywords:pi-extension`,
	`${query} keywords:pi-skill`,
	query,
];

console.log(`\n🔍 Searching npm for "${query}"...\n`);

const allResults = [];
const seen = new Set();

for (const q of queryVariants) {
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(q)}&size=60`;
	try {
		const res = await fetch(url);
		if (!res.ok) continue;
		const data = await res.json();
		for (const obj of data.objects || []) {
			if (!seen.has(obj.package.name)) {
				seen.add(obj.package.name);
				allResults.push(obj.package);
			}
		}
	} catch (e) {
		console.error(`  ⚠️ Query "${q}" failed: ${e.message}`);
	}
}

console.log(`📦 Found ${allResults.length} unique package(s):\n`);

allResults.slice(0, 60).forEach((pkg, i) => {
	const keywords = (pkg.keywords || []).join(", ");
	const hasPiKeyword = keywords.includes("pi-") ? " 🏷️" : "";
	const desc = (pkg.description || "").slice(0, 80);
	console.log(`  ${String(i + 1).padStart(2)}. ${pkg.name}${hasPiKeyword}`);
	console.log(`     ${desc}`);
});
