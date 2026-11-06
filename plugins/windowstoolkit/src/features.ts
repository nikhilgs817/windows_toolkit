// Windows Toolkit 3.0 feature keys. One generic action class per row of features.json (generated from features.mjs).
// Behaviour lives here; artwork in shared/icons-fx.js; native work in the PowerShell host (shared/host-script.ts).
import streamDeck, { action, type Action, type KeyDownEvent, type KeyUpEvent, type WillAppearEvent, type WillDisappearEvent } from "@elgato/streamdeck";
import { readFileSync, statfsSync } from "node:fs";
import type { JsonObject } from "@elgato/utils";
import { cpus, freemem, totalmem, uptime } from "node:os";
import { randomUUID } from "node:crypto";
import { ToolkitAction, launchApp, looksLikeUrl, log, type Appearance } from "../../../shared/base.js";
import { PRESET_ICONS, keySvg, svgDataUri } from "../../../shared/icons.js";
import { ps, type PsResult } from "../../../shared/ps.js";

type Field = { key: string; label: string; type: string; def?: string | number | boolean };
export type Feature = { id: string; group: string; name: string; glyph: string; theme: string; label?: string; tip: string; hold?: boolean; fields?: Field[] };
type FeatureSettings = Appearance & JsonObject;
type Data = Record<string, unknown>;

export const FEATURES: Feature[] = JSON.parse(readFileSync(new URL("../features.json", import.meta.url), "utf8"));
export const PROFILE_NAMES = ["Core", "Developer", "Podcast", "Gaming", "Trading"];

const ok = (message = ""): PsResult => ({ status: "ok", message });
const miss = (message: string): PsResult => ({ status: "miss", message });
const HOLD_MS = 1000, LONG_PRESS_MS = 600;

/* ---------------- keyboard ---------------- */
const VK: Record<string, number> = {
	win: 91, ctrl: 17, control: 17, shift: 16, alt: 18, tab: 9, enter: 13, return: 13, esc: 27, escape: 27, space: 32, backspace: 8, delete: 46, del: 46, insert: 45, ins: 45,
	home: 36, end: 35, pageup: 33, pgup: 33, pagedown: 34, pgdn: 34, left: 37, up: 38, right: 39, down: 40, prtscn: 44, printscreen: 44, prtsc: 44,
	".": 190, ",": 188, "/": 191, ";": 186, "'": 222, "[": 219, "]": 221, "\\": 220, "-": 189, "=": 187, "`": 192, plus: 187, minus: 189,
	playpause: 179, next: 176, prev: 177, mute: 173, volup: 175, voldown: 174,
};
/** "Ctrl+Shift+Esc" → [17,16,27]; undefined when a part is unknown. */
export function chordFor(text: string): number[] | undefined {
	const parts = text.split("+").map((p) => p.trim().toLowerCase()).filter(Boolean);
	if (!parts.length || parts.length > 5) return undefined;
	const out: number[] = [];
	for (const p of parts) {
		if (VK[p] !== undefined) out.push(VK[p]);
		else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(p)) out.push(111 + Number(p.slice(1)));
		else if (/^[a-z0-9]$/.test(p)) out.push(p.toUpperCase().charCodeAt(0));
		else return undefined;
	}
	return out;
}
const chord = (...vks: number[]) => ps.run("chord", [vks.join(",")]);

/* ---------------- live system stats (one shared reading per second) ---------------- */
type Stats = { cpu: number; gpu: number; disk: number; netIn: number; netOut: number; procs: number; at: number };
let stats: Stats | undefined, statsBusy: Promise<Stats | undefined> | undefined;
let lastCpu = cpus().map((c) => c.times);
function nodeCpu(): number {
	const now = cpus().map((c) => c.times);
	let idle = 0, total = 0;
	now.forEach((t, i) => { const p = lastCpu[i] ?? t; const d = (k: keyof typeof t) => t[k] - p[k]; idle += d("idle"); total += d("user") + d("nice") + d("sys") + d("idle") + d("irq"); });
	lastCpu = now;
	return total > 0 ? Math.max(0, Math.min(100, 100 * (1 - idle / total))) : 0;
}
async function readStats(): Promise<Stats | undefined> {
	if (stats && Date.now() - stats.at < 900) return stats;
	if (statsBusy) return statsBusy;
	statsBusy = (async () => {
		const r = await ps.run("fx", ["stats"], 8000);
		const cpu = nodeCpu();
		if (r.status !== "ok") return stats;
		const [, gpu, disk, netIn, netOut, procs] = r.message.split(",").map(Number);
		stats = { cpu, gpu: gpu || 0, disk: disk || 0, netIn: netIn || 0, netOut: netOut || 0, procs: procs || 0, at: Date.now() };
		return stats;
	})().finally(() => { statsBusy = undefined; });
	return statsBusy;
}
const mbps = (bytesPerSec: number) => { const v = bytesPerSec * 8 / 1e6; return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2); };
const mbs = (bytesPerSec: number) => { const v = bytesPerSec / 1048576; return v >= 100 ? v.toFixed(0) : v.toFixed(1); };
const duration = (sec: number) => { const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60); return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; };
const mmss = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = s % 60; return h ? `${h}:${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${String(m).padStart(2, "0")}:${String(ss).padStart(2, "0")}`; };

/* ---------------- time zones (market clock, world clock) ---------------- */
function zoned(tz: string, at = new Date()): { h: number; m: number; s: number; weekday: number } {
	try {
		const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "short" }).formatToParts(at);
		const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
		return { h: Number(get("hour")) % 24, m: Number(get("minute")), s: Number(get("second")), weekday: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")) };
	} catch { return zoned("America/New_York", at); }
}
const hm = (t: unknown, def: string) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(t || def).trim()) ?? /^(\d{1,2}):(\d{2})$/.exec(def)!; return Number(m[1]) * 60 + Number(m[2]); };
/** US-style session state with countdown to the next boundary. Weekends are closed. */
export function marketState(s: FeatureSettings, at = new Date()): { state: string; text: string; frac: number } {
	const z = zoned(String(s.tz || "America/New_York"), at);
	const now = z.h * 60 + z.m + z.s / 60;
	const pre = hm(s.pre, "04:00"), open = hm(s.open, "09:30"), close = hm(s.close, "16:00"), after = hm(s.after, "20:00");
	const left = (to: number) => { const mins = Math.max(0, to - now); return `${Math.floor(mins / 60)}:${String(Math.floor(mins % 60)).padStart(2, "0")}`; };
	if (z.weekday === 0 || z.weekday === 6) return { state: "closed", text: "WKND", frac: 0 };
	if (now < pre) return { state: "closed", text: left(pre), frac: 0 };
	if (now < open) return { state: "pre", text: left(open), frac: (now - pre) / (open - pre) };
	if (now < close) return { state: "open", text: left(close), frac: (now - open) / (close - open) };
	if (now < after) return { state: "after", text: left(after), frac: (now - close) / (after - close) };
	return { state: "closed", text: "", frac: 0 };
}

/* ---------------- per-key runtime state ---------------- */
type KeyState = { data: Data; timer?: NodeJS.Timeout; downAt?: number; holdTimer?: NodeJS.Timeout; holdTick?: NodeJS.Timeout; held?: boolean; run?: Record<string, unknown> };
const str = (v: unknown) => (v === undefined || v === null ? "" : String(v));
const num = (v: unknown, def: number, min: number, max: number) => { const n = Number(v); return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : def; };

/** How often a key re-reads its live value (ms). */
const LIVE: Record<string, number> = {
	mute: 2000, micmute: 1500, miclevel: 400, output: 5000, input: 5000, appvol: 3000,
	cpu: 1000, ram: 2000, gpu: 1000, disk: 1000, diskfree: 30000, netdown: 1000, netup: 1000, ping: 3000, wifi: 10000, battery: 30000, uptime: 60000, topapp: 3000, procs: 3000,
	powerplan: 10000, wifiradio: 10000, bluetooth: 10000, airplane: 10000, gamemode: 10000, brightup: 0, brightdown: 0,
	toscreen: 60000, timer: 500, stopwatch: 500, pomodoro: 500, clock: 1000, worldclock: 1000, portcheck: 5000, record: 1000, market: 1000, bell: 1000,
};

export function makeFeatureActions(): (new () => ToolkitAction<FeatureSettings>)[] {
	const classes: (new () => ToolkitAction<FeatureSettings>)[] = [];
	for (const def of FEATURES) {
		PRESET_ICONS[def.id] = { glyph: def.glyph, theme: def.theme, label: def.label ?? def.name };
		const defaults = Object.fromEntries((def.fields ?? []).filter((f) => f.def !== undefined).map((f) => [f.key, f.def]));
		const setting = (s: FeatureSettings, k: string) => (s[k] === undefined || s[k] === "" ? defaults[k] : s[k]);

		@action({ UUID: `com.windowstoolkit.core.${def.id}` })
		class FeatureKey extends ToolkitAction<FeatureSettings> {
			protected readonly kind = def.id;
			#keys = new Map<string, KeyState>();
			#paintingFor = "";

			#state(id: string): KeyState { let k = this.#keys.get(id); if (!k) this.#keys.set(id, k = { data: {} }); return k; }

			protected override dynamicLabel(s: FeatureSettings): string | undefined {
				const d = this.#keys.get(this.#paintingFor)?.data ?? {};
				switch (def.id) {
					case "output": case "input": return d.device ? String(d.device).replace(/\s*\(.*\)\s*$/, "").slice(0, 14) : undefined;
					case "micmute": return d.muted ? "Mic Muted" : "On Air";
					case "powerplan": return d.plan ? String(d.plan).replace(/^(Ultimate|High) performance$/i, "Performance").slice(0, 14) : undefined;
					case "brightup": case "brightdown": return d.level !== undefined ? `Bright ${d.level}%` : undefined;
					case "stopwatch": return d.text ? String(d.text) : undefined;
					case "toscreen": return `To Screen ${setting(s, "screen") ?? 1}`;
					case "persona": return String(setting(s, "profile") ?? "Developer");
					case "page": return s.iconLabel ? undefined : `Page ${setting(s, "page") ?? 2}`;
					case "worldclock": return s.city ? String(s.city) : undefined;
					case "appvol": return s.process ? String(s.process).slice(0, 14) : undefined;
					case "wifiradio": case "bluetooth": case "airplane": case "gamemode": case "ontop": return d.on === undefined ? undefined : `${def.label ?? def.name} ${d.on ? "On" : "Off"}`.slice(0, 14);
					case "bell": return d.on ? "Bell On" : "Bell Off";
				}
				return undefined;
			}

			override imageNow(s: FeatureSettings): { image: string; pending?: undefined } {
				const motion = this.motion(s);
				if (typeof s.iconImage === "string" && s.iconImage.startsWith("data:image/")) return super.imageNow(s) as { image: string };
				const look = this.look(s);
				const style = look.style === "real" ? "neon" : look.style;
				return { image: svgDataUri(keySvg({ ...look, style, motion, data: this.#keys.get(this.#paintingFor)?.data ?? {} })) };
			}
			protected override async paint(a: Action<FeatureSettings>, s: FeatureSettings): Promise<void> {
				this.#paintingFor = a.id;
				await super.paint(a, s);
			}
			async #repaint(a: Action<FeatureSettings>): Promise<void> { try { await this.paint(a, await a.getSettings()); } catch { /* key gone */ } }

			override async onWillAppear(ev: WillAppearEvent<FeatureSettings>): Promise<void> {
				await super.onWillAppear(ev);
				const k = this.#state(ev.action.id);
				const every = LIVE[def.id];
				if (every) {
					const tick = async () => { try { const s = await ev.action.getSettings(); Object.assign(k.data, await read(def.id, s, k)); await this.paint(ev.action, s); } catch (e) { log.debug(`${def.id} live: ${(e as Error).message}`); } };
					void tick();
					clearInterval(k.timer); k.timer = setInterval(() => void tick(), every);
				}
			}
			override onWillDisappear(ev: WillDisappearEvent<FeatureSettings>): void {
				const k = this.#keys.get(ev.action.id);
				if (k) { clearInterval(k.timer); clearTimeout(k.holdTimer); clearInterval(k.holdTick); }
				// Timers and stopwatches keep their state while you switch pages.
				if (k && !["timer", "stopwatch", "pomodoro", "record", "bell"].includes(def.id)) this.#keys.delete(ev.action.id);
				super.onWillDisappear(ev);
			}

			override async onKeyDown(ev: KeyDownEvent<FeatureSettings>): Promise<void> {
				const k = this.#state(ev.action.id), s = ev.payload.settings;
				k.downAt = Date.now(); k.held = false;
				if (def.id === "ptt") { await this.feedback(ev.action, await ps.run("audio", ["mute-set", "mic", "0"]), false); k.data.on = true; await this.#repaint(ev.action); return; }
				if (def.hold) {
					// Risky action: a red ring fills while the key is held; it runs only after 1 second.
					clearTimeout(k.holdTimer); clearInterval(k.holdTick);
					k.holdTick = setInterval(() => { k.data.hold = Math.min(1, (Date.now() - (k.downAt ?? Date.now())) / HOLD_MS); void this.#repaint(ev.action); }, 80);
					k.holdTimer = setTimeout(async () => {
						clearInterval(k.holdTick); k.held = true; k.data.hold = 0; await this.#repaint(ev.action);
						try { await this.feedback(ev.action, await press(def.id, s, k)); } catch (e) { await this.feedback(ev.action, { status: "err", message: (e as Error).message }); }
					}, HOLD_MS);
					return;
				}
				if (["timer", "stopwatch", "pomodoro"].includes(def.id)) {
					clearTimeout(k.holdTimer);
					k.holdTimer = setTimeout(async () => { k.held = true; resetClock(def.id, k, s); await this.#repaint(ev.action); await ev.action.showOk(); }, LONG_PRESS_MS);
				}
			}
			override async onKeyUp(ev: KeyUpEvent<FeatureSettings>): Promise<void> {
				const k = this.#state(ev.action.id), s = ev.payload.settings;
				clearTimeout(k.holdTimer); clearInterval(k.holdTick);
				if (def.id === "ptt") { await ps.run("audio", ["mute-set", "mic", "1"]); k.data.on = false; await this.#repaint(ev.action); return; }
				if (def.hold) {
					if (!k.held) { k.data.hold = 0; await this.#repaint(ev.action); await ev.action.showAlert(); log.info(`${def.id}: hold the key for 1 second`); }
					return;
				}
				if (k.held) return; // long press already handled (reset)
				currentDevice = ev.action.device.id;
				try {
					const r = await press(def.id, s, k);
					Object.assign(k.data, await read(def.id, s, k).catch(() => ({})));
					await this.#repaint(ev.action);
					await this.feedback(ev.action, r, !SILENT.has(def.id));
				} catch (e) { await this.feedback(ev.action, { status: "err", message: (e as Error).message }); }
			}
		}
		classes.push(FeatureKey);
	}
	return classes;
}
/** Keys whose own picture changes on press do not also flash ✓. */
const SILENT = new Set(["page", "mute", "micmute", "ontop", "timer", "stopwatch", "pomodoro", "record", "bell", "wifiradio", "bluetooth", "airplane", "gamemode", "powerplan", "output", "input", "appvol", "textcase", "persona", "runcmd"]);

function resetClock(id: string, k: KeyState, s: FeatureSettings): void {
	k.run = undefined;
	k.data = id === "timer" ? { text: mmss(num(s.minutes, 5, 1, 600) * 60000), frac: 0 } : id === "pomodoro" ? { text: String(num(s.work, 25, 1, 120)), frac: 0 } : { text: "00:00" };
}

/* ---------------- what a press does ---------------- */
const tick = async (r: PsResult) => r;
async function press(id: string, s: FeatureSettings, k: KeyState): Promise<PsResult> {
	const v = (key: string, def = "") => (s[key] === undefined || s[key] === "" ? def : String(s[key]));
	switch (id) {
		case "dispset": return ps.run("url", ["ms-settings:display"]);
		case "nightlight": return ps.run("url", ["ms-settings:nightlight"]);
		case "hdr": return chord(91, 18, 66);
		case "brightup": case "brightdown": {
			const r = await ps.run("fx", ["bright", String((id === "brightup" ? 1 : -1) * num(s.step, 10, 1, 50))]);
			if (r.status === "ok") k.data.level = Number(r.message.split(",")[0]);
			return r;
		}
		case "project": { const m = v("mode", "menu"); return m === "menu" ? chord(91, 80) : ps.run("display", [m]); }
		case "nextscreen": return chord(91, 16, v("dir", "right") === "left" ? 37 : 39);
		case "snap": return chord(91, ({ left: 37, right: 39, max: 38, min: 40 } as Record<string, number>)[v("side", "left")] ?? 37);
		case "ontop": { const r = await ps.run("fx", ["ontop"]); if (r.status === "ok") k.data.on = r.message === "on"; return r; }
		case "vdesk": return v("dir", "next") === "new" ? chord(91, 17, 68) : chord(91, 17, v("dir", "next") === "prev" ? 37 : 39);
		case "taskview": return chord(91, 9);
		case "cliphist": return chord(91, 86);
		case "emoji": return chord(91, 190);
		case "lockpc": return ps.run("fx", ["lock"]);
		case "screensoff": return ps.run("fx", ["screensoff"]);
		case "mute": return ps.run("audio", ["mute-toggle", "spk"]);
		case "micmute": return ps.run("audio", ["mute-toggle", "mic"]);
		case "miclevel": return ps.run("url", ["ms-settings:sound"]);
		case "output": case "input": { const r = await ps.run("audio", ["cycle", id === "input" ? "mic" : "spk", v("only")]); if (r.status === "ok") k.data.device = r.message; return r; }
		case "appvol": {
			if (!v("process")) return miss("Choose the app in the key settings");
			const r = await ps.run("audio", ["app", "spk", v("process"), v("op", "toggle"), String(num(s.step, 10, 1, 50))]);
			if (r.status === "ok") { const [vol, mu] = r.message.split(","); k.data.vol = Number(vol); k.data.muted = mu === "1"; }
			return r;
		}
		case "mixer": return ps.run("url", ["ms-settings:apps-volume"]);
		case "soundboard": return v("file") ? ps.run("sound", [v("file"), String(num(s.volume, 80, 1, 100))]) : miss("Choose a sound file in the key settings");
		case "prev": return chord(177);
		case "playpause": return chord(179);
		case "next": return chord(176);
		case "cpu": case "ram": case "gpu": case "disk": case "netdown": case "netup": case "topapp": case "procs": case "uptime": case "taskmgr": return ps.run("cmd", ["taskmgr.exe"]);
		case "diskfree": return ps.run("folder", [v("drive", "C:").replace(/[\\/]*$/, "\\")]);
		case "ping": return tick(ok());
		case "wifi": return ps.run("url", ["ms-settings:network-wifi"]);
		case "battery": return ps.run("url", ["ms-settings:batterysaver"]);
		case "resmon": return ps.run("cmd", ["resmon.exe"]);
		case "sleep": case "hibernate": case "restart": case "shutdown": case "signout": return ps.run("power", [id]);
		case "powerplan": { const r = await ps.run("powerplan", v("plan") ? ["set", v("plan")] : ["next"]); if (r.status === "ok") k.data.plan = r.message; return r; }
		case "closeapp": return ps.run("fx", ["close"]);
		case "forceclose": return ps.run("fx", ["kill"]);
		case "service": return v("name") ? ps.run("service", [v("name")], 30000) : miss("Enter the service name in the key settings");
		case "emptybin": return ps.run("recycle", [], 60000);
		case "wifiradio": case "bluetooth": case "airplane": {
			const r = await ps.run("radio", [id === "wifiradio" ? "wifi" : id === "bluetooth" ? "bluetooth" : "all", "toggle"], 15000);
			if (r.status === "ok") k.data.on = r.message === "on";
			return r;
		}
		case "dnd": return chord(91, 78);
		case "timer": case "pomodoro": case "stopwatch": {
			const r = k.run ?? {};
			if (r.running) { r.elapsed = Number(r.elapsed ?? 0) + Date.now() - Number(r.since); r.running = false; }
			else { r.since = Date.now(); r.running = true; r.done = false; }
			k.run = r;
			return ok(r.running ? "started" : "paused");
		}
		case "clock": case "worldclock": return ps.run("url", ["ms-settings:dateandtime"]);
		case "runcmd": {
			if (!v("command")) return miss("Enter a command in the key settings");
			k.data.state = "running";
			const r = await ps.run("run", [v("command"), v("folder")], 610000);
			k.data.state = r.status === "ok" ? "ok" : "fail";
			return r;
		}
		case "terminal": return ps.run("terminal", [v("folder")]);
		case "snippet": return v("text") ? ps.run("type", [v("text")]) : miss("Enter the text in the key settings");
		case "shortcut": { const c = chordFor(v("keys")); return c ? chord(...c) : miss("Use a shortcut such as Ctrl+Shift+Esc"); }
		case "workspace": {
			const items = v("items").split(/\r?\n/).map((x) => x.trim()).filter(Boolean).slice(0, 12);
			if (!items.length) return miss("List the apps, folders or websites in the key settings");
			let bad = 0;
			for (const item of items) {
				const r = looksLikeUrl(item) ? await ps.run("url", [/^[a-z]+:/i.test(item) ? item : "https://" + item]) : /^[a-z]:\\|^%|^\\\\/i.test(item) ? await ps.run("folder", [item]).then((x) => x.status === "ok" ? x : ps.run("cmd", [item])) : await launchApp({ target: item });
				if (r.status !== "ok") bad++;
			}
			return bad ? miss(`${bad} of ${items.length} items did not open`) : ok();
		}
		case "portcheck": return ps.run("url", [`http://${v("host", "127.0.0.1") === "127.0.0.1" ? "localhost" : v("host")}:${num(s.port, 3000, 1, 65535)}/`]);
		case "guid": return ps.run("clip-set", [randomUUID()]);
		case "timestamp": {
			const d = new Date(), f = v("format", "iso");
			const pad = (n: number) => String(n).padStart(2, "0");
			const text = f === "unix" ? String(Math.floor(d.getTime() / 1000)) : f === "local" ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}` : d.toISOString().replace(/\.\d{3}Z$/, "Z");
			return ps.run("clip-set", [text]);
		}
		case "cliptools": case "textcase": {
			const got = await ps.run("clip-get", []);
			if (got.status !== "ok" || !got.message) return miss("The clipboard has no text");
			let out = got.message;
			try {
				if (id === "textcase") {
					const n = (Number(k.data.case ?? -1) + 1) % 3; k.data.case = n;
					out = n === 0 ? out.toUpperCase() : n === 1 ? out.toLowerCase() : out.toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
				} else switch (v("op", "json")) {
					case "json": out = JSON.stringify(JSON.parse(out), null, 2); break;
					case "jsonmin": out = JSON.stringify(JSON.parse(out)); break;
					case "b64e": out = Buffer.from(out, "utf8").toString("base64"); break;
					case "b64d": out = Buffer.from(out.trim(), "base64").toString("utf8"); break;
					case "urle": out = encodeURIComponent(out); break;
					case "urld": out = decodeURIComponent(out); break;
					case "trim": out = out.split(/\r?\n/).map((l) => l.trim()).join("\n").trim(); break;
				}
			} catch { return miss("The clipboard text isn't in that format"); }
			return ps.run("clip-set", [out]);
		}
		case "gamebar": case "perf": return chord(91, 71);
		case "gamemode": { const r = await ps.run("gamemode", ["toggle"]); if (r.status === "ok") k.data.on = r.message === "on"; return r; }
		case "clip30": return chord(91, 18, 71);
		case "record": {
			const r = await chord(91, 18, 82);
			if (r.status === "ok") { const on = !k.data.on; k.data.on = on; k.run = on ? { since: Date.now() } : undefined; }
			return r;
		}
		case "gameshot": return chord(91, 18, 44);
		case "market": return ps.run("url", ["ms-settings:dateandtime"]);
		case "bell": k.data.on = !k.data.on; k.run = { last: "" }; return ok(k.data.on ? "on" : "off");
		case "journal": {
			let text = v("text");
			if (!text) { const c = await ps.run("clip-get", []); text = c.status === "ok" ? c.message.trim().split(/\r?\n/).join(" ").slice(0, 500) : ""; }
			if (!text) return miss("Type a note in the key settings or copy some text first");
			return ps.run("journal", [v("file", "%USERPROFILE%\\Documents\\Trading Journal.txt"), text]);
		}
		case "toscreen": { const r = await ps.run("movewin", [v("screen", "1")]); if (r.status === "ok") { const [from, to] = r.message.split(","); k.data.from = Number(from); k.data.n = Number(to); } return r; }
		case "persona": return openPersona(v("profile", "Developer"), 0);
		case "page": return openPersona(v("profile", "Core"), num(s.page, 2, 1, 3) - 1);
	}
	return miss("Not available");
}

/* ---------------- what a live key shows ---------------- */
async function read(id: string, s: FeatureSettings, k: KeyState): Promise<Data> {
	const v = (key: string, def = "") => (s[key] === undefined || s[key] === "" ? def : String(s[key]));
	switch (id) {
		case "mute": { const r = await ps.run("audio", ["mute-get", "spk"]); return r.status === "ok" ? { muted: r.message === "muted" } : {}; }
		case "micmute": { const r = await ps.run("audio", ["mute-get", "mic"]); return r.status === "ok" ? { muted: r.message === "muted" } : {}; }
		case "miclevel": { const r = await ps.run("audio", ["peak", "mic"]); return r.status === "ok" ? { level: Number(r.message) } : { level: 0 }; }
		case "output": case "input": { const r = await ps.run("audio", ["current", id === "input" ? "mic" : "spk"]); return r.status === "ok" ? { device: r.message } : {}; }
		case "appvol": {
			if (!v("process")) return {};
			const r = await ps.run("audio", ["app", "spk", v("process"), "get", "0"]);
			if (r.status !== "ok") return { muted: undefined };
			const [vol, mu] = r.message.split(","); return { vol: Number(vol), muted: mu === "1" };
		}
		case "cpu": { const st = await readStats(); return { v: st ? st.cpu : nodeCpu() }; }
		case "ram": return { v: 100 * (1 - freemem() / totalmem()) };
		case "gpu": { const st = await readStats(); return st ? { v: st.gpu } : {}; }
		case "disk": { const st = await readStats(); return st ? { text: mbs(st.disk), unit: "MB/s" } : {}; }
		case "netdown": { const st = await readStats(); return st ? { text: mbps(st.netIn), unit: "Mb/s" } : {}; }
		case "netup": { const st = await readStats(); return st ? { text: mbps(st.netOut), unit: "Mb/s" } : {}; }
		case "procs": { const st = await readStats(); return st ? { n: st.procs } : {}; }
		case "diskfree": {
			try {
				const f = statfsSync(v("drive", "C:").replace(/[\\/]*$/, "\\"));
				const free = f.bavail * f.bsize, total = f.blocks * f.bsize, gb = free / 1073741824;
				return gb >= 1000 ? { text: (gb / 1024).toFixed(1), unit: "TB", frac: free / total } : { text: gb.toFixed(0), unit: "GB", frac: free / total };
			} catch { return { text: "–", unit: "" }; }
		}
		case "ping": { const r = await ps.run("pinghost", [v("host", "1.1.1.1")], 5000); return r.status === "ok" ? { text: r.message } : { text: "×" }; }
		case "wifi": { const r = await ps.run("wifisignal", []); return r.status === "ok" ? { pct: Number(r.message) } : { pct: 0 }; }
		case "battery": { const r = await ps.run("battery", []); if (r.status !== "ok") return {}; const [p, c] = r.message.split(","); return { pct: Number(p), charging: c === "True" }; }
		case "uptime": return { text: duration(uptime()) };
		case "topapp": { const r = await ps.run("fx", ["topapp"]); if (r.status !== "ok") return {}; const [name, pct] = r.message.split(","); return { name, pct: Number(pct) }; }
		case "powerplan": { const r = await ps.run("powerplan", ["get"]); return r.status === "ok" ? { plan: r.message } : {}; }
		case "wifiradio": case "bluetooth": case "airplane": { const r = await ps.run("radio", [id === "wifiradio" ? "wifi" : id === "bluetooth" ? "bluetooth" : "all", "get"], 15000); return r.status === "ok" ? { on: r.message === "on", off: r.message !== "on" && id !== "airplane" } : {}; }
		case "gamemode": { const r = await ps.run("gamemode", ["get"]); return r.status === "ok" ? { on: r.message === "on", off: r.message !== "on" } : {}; }
		case "timer": case "pomodoro": case "stopwatch": return clockData(id, s, k);
		case "clock": {
			const d = new Date(), h24 = s.h24 === true;
			const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: !h24 }).replace(/\s?[AP]M$/i, "");
			return { time, date: d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" }).toUpperCase().replace(",", "") };
		}
		case "worldclock": {
			const tz = v("tz", "Europe/London");
			let t = ""; try { t = new Date().toLocaleTimeString("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" }); } catch { t = "--:--"; }
			const city = v("city") || tz.split("/").pop()!.replace(/_/g, " ").slice(0, 3).toUpperCase();
			return { text: `${city} ${t}` };
		}
		case "portcheck": { const port = num(s.port, 3000, 1, 65535); const r = await ps.run("port", [v("host", "127.0.0.1"), String(port)], 3000); return { port, up: r.status === "ok" && r.message === "up" }; }
		case "record": return k.data.on && k.run ? { text: mmss(Date.now() - Number(k.run.since)) } : {};
		case "market": return marketState(s);
		case "toscreen": return k.data.from ? {} : { from: "·", n: Number(v("screen", "1")) };
		case "bell": {
			if (k.data.on) {
				const z = zoned(v("tz", "America/New_York"));
				const now = `${String(z.h).padStart(2, "0")}:${String(z.m).padStart(2, "0")}`;
				const weekday = z.weekday > 0 && z.weekday < 6;
				const hit = weekday && [hm(s.open, "09:30"), hm(s.close, "16:00")].includes(z.h * 60 + z.m);
				const run = (k.run ??= { last: "" });
				if (hit && run.last !== now) { run.last = now; void ps.run("sound", [v("file") || "chime", "90"]); }
			}
			return { off: !k.data.on };
		}
	}
	return {};
}

function clockData(id: string, s: FeatureSettings, k: KeyState): Data {
	const r = k.run ?? {};
	const elapsed = Number(r.elapsed ?? 0) + (r.running ? Date.now() - Number(r.since) : 0);
	if (id === "stopwatch") return { text: mmss(elapsed), running: !!r.running };
	if (id === "timer") {
		const total = num(s.minutes, 5, 1, 600) * 60000, left = total - elapsed;
		if (r.running && left <= 0 && !r.done) { r.done = true; r.running = false; r.elapsed = total; void ps.run("sound", [String(s.file || "chime"), "90"]); }
		return { text: mmss(Math.max(0, left)), frac: Math.min(1, elapsed / total) };
	}
	// Pomodoro: work → break, 4th break is long.
	const work = num(s.work, 25, 1, 120) * 60000, rest = num(s.rest, 5, 1, 60) * 60000, long = num(s.long, 15, 1, 90) * 60000;
	const round = Number(r.round ?? 0), phase = String(r.phase ?? "work");
	const length = phase === "work" ? work : round % 4 === 3 ? long : rest;
	if (r.running && elapsed >= length) {
		void ps.run("sound", ["chime", "90"]);
		r.phase = phase === "work" ? "break" : "work"; if (phase !== "work") r.round = round + 1;
		r.elapsed = 0; r.since = Date.now(); k.run = r;
		return { text: mmss(r.phase === "work" ? work : (round % 4 === 3 ? long : rest)), frac: 0, rest: r.phase !== "work" };
	}
	return { text: elapsed === 0 && !r.running ? String(Math.round(work / 60000)) : mmss(length - elapsed), frac: elapsed / length, rest: phase !== "work" };
}

/* ---------------- persona profiles ---------------- */
let currentDevice = "";
let personaOpener: ((name: string, device: string, page: number) => Promise<void>) | undefined;
export function setPersonaOpener(fn: (name: string, device: string, page: number) => Promise<void>): void { personaOpener = fn; }
async function openPersona(name: string, page: number): Promise<PsResult> {
	if (!PROFILE_NAMES.includes(name)) return miss("Unknown profile");
	if (!personaOpener || !currentDevice) return miss("Profiles are unavailable");
	await personaOpener(name, currentDevice, page);
	return ok(name);
}
export { streamDeck };
