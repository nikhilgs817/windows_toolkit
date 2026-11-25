// Renders the five key looks side by side for the README (docs/images/looks.png).
import { writeFileSync, mkdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { keySvg } from "../shared/icons.js";

const keys = [["folder", "gold", "Folders"], ["rocket", "aurora", "Open App"], ["capture", "candy", "Screenshot"], ["micmute", "berry", "On Air"], ["cpu", "azure", "CPU"], ["terminal", "mint", "Terminal"], ["market", "midas", "Market"], ["back", "champagne", "Back"]];
const looks = [["vivid", "Vivid (default)"], ["glass", "Glass"], ["neon", "Neon"], ["mono", "Mono"], ["pro", "Pro"]];
const S = 120, G = 12, L = 150, W = L + keys.length * (S + G) + G, H = looks.length * (S + G) + G;
let body = `<rect width="${W}" height="${H}" rx="18" fill="#0B0D14"/>`;
looks.forEach(([style, name], r) => {
	body += `<text x="22" y="${G + r * (S + G) + S / 2 + 6}" fill="#E8EDF6" font-size="17" font-weight="600" font-family="Segoe UI, Arial, sans-serif">${name}</text>`;
	keys.forEach(([glyph, theme, label], c) => {
		const svg = keySvg({ glyph, theme, label, style, motion: { kind: glyph, phase: 0.18 } });
		body += `<g transform="translate(${L + G + c * (S + G)} ${G + r * (S + G)}) scale(${S / 144})"><clipPath id="k${r}_${c}"><rect width="144" height="144" rx="16"/></clipPath><g clip-path="url(#k${r}_${c})">${svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "")}</g></g>`;
	});
});
mkdirSync("docs/images", { recursive: true });
writeFileSync("docs/images/looks.png", new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}">${body}</svg>`, { font: { loadSystemFonts: true }, fitTo: { mode: "width", value: W } }).render().asPng());
console.log("Rendered docs/images/looks.png");
