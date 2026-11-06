// Renders every bundled profile page with the real key renderer (docs/images/profile-*.png + an animated GIF frame set).
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { unzipSync, strFromU8 } from "fflate";
import { PRESET_ICONS, keySvg, monitorKeySvg } from "../shared/icons.js";
import { FEATURES } from "../plugins/windowstoolkit/features.mjs";
for (const f of FEATURES) PRESET_ICONS[f.id] = { glyph: f.glyph, theme: f.theme, label: f.label ?? f.name };
const sd = "plugins/windowstoolkit/com.windowstoolkit.core.sdPlugin";
const SAMPLE = { cpu: { v: 34 }, ram: { v: 62 }, gpu: { v: 88 }, disk: { text: "12.4", unit: "MB/s" }, netdown: { text: "94.2", unit: "Mb/s" }, netup: { text: "8.1", unit: "Mb/s" }, ping: { text: "18" }, topapp: { name: "chrome", pct: 21 }, uptime: { text: "3d 4h" },
	micmute: { muted: false }, mute: { muted: false }, miclevel: { level: 40 }, market: { state: "open", text: "2:41", frac: .55 }, timer: { text: "05:00", frac: 0 }, pomodoro: { text: "25", frac: 0 }, stopwatch: { text: "00:00" }, clock: { time: "9:41", date: "THU 5 NOV" }, worldclock: { text: "NYC 09:41" }, portcheck: { port: 3000, up: true }, gamemode: { on: true }, bell: { off: false }, record: {}, toscreen: { from: 1, n: 2 } };
const LABEL = { micmute: "On Air", page: null };
mkdirSync("docs/images", { recursive: true }); mkdirSync("test-output/profiles", { recursive: true });
const names = ["Core", "Developer", "Podcast", "Gaming", "Trading"];
const sheets = [];
for (const name of names) {
	const zip = unzipSync(readFileSync(join(sd, `profiles/${name}.streamDeckProfile`)));
	const pages = Object.entries(zip).filter(([p]) => /Profiles\/[^/]+\/manifest\.json$/.test(p) && !p.endsWith(".sdProfile/manifest.json")).map(([, b]) => JSON.parse(strFromU8(b))).filter((m) => m.Controllers[0].Actions);
	const root = JSON.parse(strFromU8(Object.entries(zip).find(([p]) => /\.sdProfile\/manifest\.json$/.test(p))[1]));
	pages.sort((a, b) => (a.Name ? 1 : 0) - (b.Name ? 1 : 0));
	pages.forEach((pg, i) => {
		const render = (phase) => {
			let body = `<rect width="790" height="520" rx="24" fill="#0B0D14"/><text x="28" y="35" font-family="Segoe UI" font-size="21" font-weight="700" fill="#E8EDF6">Windows Toolkit · ${root.Name} · page ${i + 1}</text>`;
			for (const [pos, a] of Object.entries(pg.Controllers[0].Actions)) {
				const [c, r] = pos.split(",").map(Number), id = a.UUID.split(".").pop(), s = a.Settings || {};
				const look = PRESET_ICONS[id] || PRESET_ICONS.app;
				let label = s.iconLabel || (id === "persona" ? s.profile : id === "toscreen" ? `To Screen ${s.screen || 1}` : id === "worldclock" ? s.city : undefined) || look.label;
				const svg = id === "monitorcontrol" ? monitorKeySvg({ n: 1, state: "on", caption: "Monitor 1", motion: { kind: id, phase } }) : keySvg({ glyph: look.glyph, theme: s.iconTheme || look.theme, label, style: look.style || "neon", motion: { kind: id, phase }, data: SAMPLE[id] || {} });
				body += `<g transform="translate(${28 + c * 150} ${60 + r * 150}) scale(${134 / 144})">${svg}</g>`;
			}
			return new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="790" height="520">${body}</svg>`, { font: { loadSystemFonts: true } }).render().asPng();
		};
		const file = `profile-${name.toLowerCase()}-${i + 1}.png`;
		writeFileSync(join("docs/images", file), render(0.3));
		sheets.push(file);
		if (process.argv.includes("--frames")) for (let k = 0; k < 96; k++) writeFileSync(join("test-output/profiles", `${name}-${i + 1}-${String(k).padStart(3, "0")}.png`), render(k / 96));
	});
}
console.log("Rendered", sheets.join(", "));
