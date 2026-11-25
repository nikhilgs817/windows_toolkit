// Generates manifest.json and every static image from one table, so names, UUIDs and art never drift.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PRESET_ICONS, keySvg, monitorKeySvg, monoSvg } from "../../shared/icons.js";
import { Resvg } from "@resvg/resvg-js";
import { buildProfile, copyUi } from "../../tools/common.mjs";
import { toolkitCategorySvg, toolkitLogoSvg } from "./brand.mjs";
import { FEATURES, GROUPS } from "./features.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sd = join(here, "com.windowstoolkit.core.sdPlugin");
const VERSION = "3.1.0.0";
const PRODUCT_NAME = "Windows Toolkit";

/** id → [Name in action list, tooltip] — order = order in the Stream Deck action list. */
const ACTIONS = [
	["downloads", "Folders", "Open any folder — paste its full path in the key settings and choose a look."],
	["app", "Open App…", "Pick any installed app and an icon for it."],
	["folder", "Open Folder…", "Open any folder — set the path and icon in the key settings."],
	["website", "Open Website…", "Open any website."],
	["websitefolder", "Website Folder", "Opens your editable Websites collection. Add websites in Stream Deck; Back returns to your main keys."],
	["appsfolder", "Apps", "Opens the Apps page: your app keys plus a Back key. Add any app there in the Stream Deck app."],
	["back", "Back to Main Keys", "Returns to your main keys (used on the Apps page)."],
	["screenshot", "Screenshot", "Tap = select an area · double-tap = active window · hold = all screens. Saved to Pictures\\Screenshots and copied."],
	["showdesktop", "Show Desktop", "Show your desktop; press again to restore your windows. Animated Colourful and Vivid looks."],
	["volup", "Volume Up", "Raises the volume. Hold the key to keep going."],
	["voldown", "Volume Down", "Lowers the volume. Hold the key to keep going."],
	["monitorcontrol", "Monitor Control", "Choose a monitor in settings. Red TURN OFF while on; green TURN ON while off."],
	["copy", "Copy (Ctrl+C)", "Copies the selection in the active window."],
	["paste", "Paste (Ctrl+V)", "Pastes into the active window."],
];

// Windows Toolkit 3.0 feature keys, in catalogue order after the original actions.
for (const f of FEATURES) ACTIONS.push([f.id, f.name, f.tip]);

/** Stream Deck lists one flat category per plugin, so the action list is sorted group by group, most-used keys first. */
export const ACTION_GROUPS = [
	["Launch & Folders", ["app", "website", "websitefolder", "appsfolder", "downloads", "workspace", "terminal", "runcmd"]],
	["Display & Windows", ["showdesktop", "screenshot", "monitorcontrol", "rotate", "dispset", "nightlight", "hdr", "brightup", "brightdown", "project", "nextscreen", "toscreen", "snap", "ontop", "vdesk", "taskview", "screensoff"]],
	["Audio & Media", ["volup", "voldown", "mute", "micmute", "ptt", "miclevel", "output", "input", "appvol", "mixer", "soundboard", "prev", "playpause", "next"]],
	["Clipboard & Text", ["copy", "paste", "cliphist", "cliptools", "textcase", "snippet", "shortcut", "emoji", "guid", "timestamp"]],
	["System Monitor", ["cpu", "ram", "gpu", "disk", "diskfree", "netdown", "netup", "ping", "wifi", "battery", "uptime", "topapp", "procs", "taskmgr", "resmon"]],
	["Power & Connectivity", ["lockpc", "sleep", "restart", "shutdown", "signout", "hibernate", "powerplan", "wifiradio", "bluetooth", "airplane", "dnd", "closeapp", "forceclose", "service", "emptybin", "portcheck", "healthcheck"]],
	["Timers & Clocks", ["timer", "stopwatch", "pomodoro", "clock", "worldclock"]],
	["Gaming", ["gamebar", "gamemode", "clip30", "record", "gameshot", "perf"]],
	["Trading", ["market", "bell", "journal"]],
	["Profiles & Navigation", ["nextpage", "page", "persona", "back", "folder"]],
];
{
	const order = ACTION_GROUPS.flatMap(([, ids]) => ids);
	const missing = ACTIONS.map(([id]) => id).filter((id) => !order.includes(id));
	const unknown = order.filter((id) => !ACTIONS.some(([a]) => a === id));
	if (missing.length || unknown.length || new Set(order).size !== order.length) throw new Error(`Action groups out of date. Missing: ${missing} · Unknown: ${unknown}`);
	ACTIONS.sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
}
for (const f of FEATURES) PRESET_ICONS[f.id] = { glyph: f.glyph, theme: f.theme, label: f.label ?? f.name };

const write = (rel, data) => {
	const p = join(sd, rel);
	mkdirSync(dirname(p), { recursive: true });
	writeFileSync(p, data);
};

// Remove stale generated artwork for retired presets when rebuilding an existing checkout.
for (const id of ["chrome", "youtube", "claude", "chatgpt", "vscode", "thinkorswim", "fidelity"]) {
	for (const group of ["keys", "actions"]) rmSync(join(sd, "imgs", group, `${id}.svg`), { force: true });
}
for (const [id] of ACTIONS) {
	const look = PRESET_ICONS[id];
	if (!look) throw new Error(`No icon for ${id}`);
	write(`imgs/keys/${id}.svg`, id === "monitorcontrol" ? monitorKeySvg({ n: "?", state: "unconfigured", caption: "Monitor Control" }) : keySvg(look));
	write(`imgs/actions/${id}.svg`, monoSvg(look.glyph, 20));
}
// The approved master stays in source; only optimized plugin PNGs ship.
rmSync(join(sd, "imgs/plugin/logo.svg"), { force: true });
write("imgs/plugin/category.svg", toolkitCategorySvg());
for (const [file, size] of [["icon.png", 256], ["icon@2x.png", 512]]) {
	write(`imgs/plugin/${file}`, new Resvg(toolkitLogoSvg(size)).render().asPng());
}

/** Bundled Apps page (15-key decks): Back + the app keys; empty slots are for the user's own apps. */
const APPS_LAYOUT = {
	"0,0": "back", "3,1": "app",
};
const APPS_PROFILE = "profiles/Apps"; // must match nav.ts APPS_PROFILE
const P = (o) => o; // readability: [action, settings]
const nextPage = (profile) => ["nextpage", { profile }];
const page = (profile, n, label) => ["page", { profile, page: String(n), ...(label ? { iconLabel: label } : {}) }];
const persona = (name, theme) => ["persona", { profile: name, iconTheme: theme }];
const grid = (rows) => Object.fromEntries(rows.flatMap((row, r) => row.map((v, c) => [`${c},${r}`, v]).filter(([, v]) => v)));
/** Persona profiles (approved Nov 2026). Each has Back to the main keys and a second page. */
const PERSONAS = {
	Core: { title: "Windows Toolkit", pages: [
		grid([["appsfolder", "websitefolder", "screenshot", "showdesktop", "dispset"], ["mute", "volup", "voldown", "micmute", "playpause"], ["lockpc", "cliphist", "copy", "paste", nextPage("Core")]]),
		grid([[page("Core", 1, "‹ Main"), persona("Developer", "tropical"), persona("Podcast", "crimson"), persona("Gaming", "electric"), persona("Trading", "mint")], ["monitorcontrol", "nightlight", "hdr", "brightdown", "brightup"], ["project", "nextscreen", "snap", "vdesk", "taskview"]]),
	] },
	Developer: { title: "Developer", pages: [
		grid([["back", "terminal", "runcmd", "portcheck", "shortcut"], ["cpu", "ram", "gpu", "netdown", "topapp"], ["snippet", "guid", "timestamp", "cliptools", nextPage("Developer")]]),
		grid([[page("Developer", 1, "‹ Back"), "workspace", "pomodoro", "timer", "stopwatch"], ["ontop", "snap", "nextscreen", "vdesk", "taskview"], ["cliphist", "textcase", "clock", "worldclock", "lockpc"]]),
	] },
	Podcast: { title: "Podcast", pages: [
		grid([["back", "micmute", "ptt", "miclevel", "mute"], ["input", "output", "appvol", "mixer", "soundboard"], ["prev", "playpause", "next", "stopwatch", nextPage("Podcast")]]),
		grid([[page("Podcast", 1, "‹ Back"), "record", "timer", "dnd", "screensoff"], ["volup", "voldown", "brightdown", "brightup", "nightlight"], ["clock", "worldclock", "cpu", "netup", "lockpc"]]),
	] },
	Gaming: { title: "Gaming", pages: [
		grid([["back", "gamebar", "gamemode", "clip30", "record"], ["gameshot", "perf", "hdr", "powerplan", "micmute"], ["cpu", "gpu", "ram", "ping", nextPage("Gaming")]]),
		grid([[page("Gaming", 1, "‹ Back"), "output", "input", "mute", "appvol"], ["netdown", "netup", "topapp", "closeapp", "forceclose"], ["volup", "voldown", "playpause", "next", "screensoff"]]),
	] },
	Trading: { title: "Trading", pages: [
		grid([["back", "market", "bell", "journal", "screenshot"], [["toscreen", { screen: "1" }], ["toscreen", { screen: "2" }], ["toscreen", { screen: "3" }], "snap", "ontop"], [["worldclock", { tz: "America/New_York", city: "NYC" }], "clock", "timer", "lockpc", nextPage("Trading")]]),
		grid([[page("Trading", 1, "‹ Back"), "dnd", "nextscreen", "vdesk", "taskview"], ["cpu", "ram", "netdown", "ping", "uptime"], ["micmute", "mute", "playpause", "cliphist", "screensoff"]]),
	] },
};
buildProfile({ sd, uuid: "com.windowstoolkit.core", pluginName: PRODUCT_NAME, version: VERSION, profile: APPS_PROFILE, title: "Apps", layout: APPS_LAYOUT, actions: ACTIONS });
buildProfile({ sd, uuid: "com.windowstoolkit.core", pluginName: PRODUCT_NAME, version: VERSION, profile: "profiles/Websites", title: "Websites", layout: { "0,0": "back", "1,0": "website" }, actions: ACTIONS });
for (const [name, def] of Object.entries(PERSONAS)) {
	buildProfile({ sd, uuid: "com.windowstoolkit.core", pluginName: PRODUCT_NAME, version: VERSION, profile: `profiles/${name}`, title: def.title, pages: def.pages.map((layout, i) => ({ name: i ? "More" : "", layout })), actions: ACTIONS });
}
// The plugin runtime and the settings panel read the same catalogue.
write("features.json", JSON.stringify(FEATURES, null, "\t") + "\n");

const manifest = {
	$schema: "https://schemas.elgato.com/streamdeck/plugins/manifest.json",
	Name: PRODUCT_NAME,
	Version: VERSION,
	Author: "Windows Toolkit",
	Description: "Animated Windows controls for developers, podcasters, gamers and traders: display, audio, live system stats, power, timers, developer tools, Game Bar and market clock. Plus app, folder and website launchers.",
	UUID: "com.windowstoolkit.core",
	Icon: "imgs/plugin/icon",
	Category: PRODUCT_NAME,
	CategoryIcon: "imgs/plugin/category",
	CodePath: "bin/plugin.js",
	PropertyInspectorPath: "ui/pi.html",
	SDKVersion: 2,
	Software: { MinimumVersion: "7.1" },
	OS: [{ Platform: "windows", MinimumVersion: "10" }],
	Nodejs: { Version: "20" },
	Profiles: [APPS_PROFILE, "profiles/Websites", ...Object.keys(PERSONAS).map((n) => `profiles/${n}`)].map((Name) => ({ Name, DeviceType: 0, Readonly: false, DontAutoSwitchWhenInstalled: true, AutoInstall: true })),
	Actions: ACTIONS.map(([id, name, tip]) => ({
		Name: name,
		UUID: `com.windowstoolkit.core.${id}`,
		Icon: `imgs/actions/${id}`,
		Tooltip: tip,
		...(id === "folder" ? { VisibleInActionsList: false } : {}), // Retain old keys without a duplicate palette entry.
		Controllers: ["Keypad"],
		States: [{ Image: `imgs/keys/${id}`, ShowTitle: false, TitleAlignment: "bottom" }],
	})),
};
copyUi(sd);
write("ui/features.js", `window.WinToolkitFeatures = ${JSON.stringify({ groups: GROUPS, features: FEATURES })};
for (const { id, glyph, theme, label, name } of window.WinToolkitFeatures.features) {
	window.WinToolkitIcons.PRESET_ICONS[id] = { glyph, theme, label: label ?? name };
}
`);
write("manifest.json", JSON.stringify(manifest, null, "\t") + "\n");
console.log(`Generated manifest + ${ACTIONS.length} actions`);
