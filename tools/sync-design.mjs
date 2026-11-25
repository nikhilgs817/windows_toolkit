// Keeps the shared design system identical in every companion plugin repository.
//
// Windows Toolkit is the source of truth for the look of every key and for the shared settings panel.
// Usage, from this repository:
//   node tools/sync-design.mjs ../streamdeck_claude ../streamdeck_chatgpt …   copy the design files into each repo
//   node tools/sync-design.mjs --check ../streamdeck_claude …                 fail if any repo has drifted
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Files that make up the design system: key artwork, motion, look settings and the settings panel. */
export const DESIGN_FILES = [
	"shared/icons.js",
	"shared/icons-fx.js",
	"shared/app-design.js",
	"shared/brands/brand-keys.js",
	"shared/base.ts",
	"shared/motion.ts",
	"shared/ui/pi.html",
	"shared/ui/pi.js",
	"shared/ui/pi.css",
	"shared/ui/companion.js",
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const check = args.includes("--check");
const targets = args.filter((a) => !a.startsWith("--"));
if (!targets.length) {
	console.error("Name one or more companion repositories, for example: node tools/sync-design.mjs ../streamdeck_claude");
	process.exit(2);
}

let drift = 0;
for (const target of targets) {
	const repo = resolve(target);
	if (!existsSync(join(repo, "shared"))) { console.error(`${target}: no shared/ folder, skipped`); drift++; continue; }
	for (const file of DESIGN_FILES) {
		const source = readFileSync(join(root, file));
		const dest = join(repo, file);
		const same = existsSync(dest) && readFileSync(dest).equals(source);
		if (same) continue;
		if (check) { console.log(`${target}: ${file} differs from Windows Toolkit`); drift++; continue; }
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, source);
		console.log(`${target}: updated ${file}`);
	}
}
if (check) {
	console.log(drift ? `${drift} design file(s) out of sync.` : "Design files match Windows Toolkit.");
	process.exit(drift ? 1 : 0);
}
