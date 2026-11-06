/**
 * PowerShell "host" kept alive for the plugin's lifetime. It reads one command per line on stdin:
 *   <id> TAB <command> [TAB <base64 utf-8 arg>]...
 * and replies on stdout:
 *   <id> TAB ok|miss|err TAB <base64 utf-8 message>
 * Passed to powershell.exe with -EncodedCommand, so script execution policy does not apply.
 * Only a fixed set of commands is accepted — nothing from settings is ever evaluated as code.
 */
export const HOST_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$utf8 = New-Object System.Text.UTF8Encoding $false
$script:apps = $null
$script:wsh = $null

function D([string]$s) { if ([string]::IsNullOrEmpty($s)) { return '' }; return $utf8.GetString([Convert]::FromBase64String($s)) }
function E([string]$s) { return [Convert]::ToBase64String($utf8.GetBytes([string]$s)) }
function X([string]$p) { return [Environment]::ExpandEnvironmentVariables($p.Trim().Trim('"')) }

# DPAPI uses the current Windows user; data travels over stdin, never process arguments.
function Protect-Password([string]$password, [string]$binding = '') {
	Add-Type -AssemblyName System.Security
	$bytes = $utf8.GetBytes($password)
	try { return 'dpapi:v1:' + [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes, $utf8.GetBytes('com.windowstoolkit.core.credentials.v1|' + $binding), [Security.Cryptography.DataProtectionScope]::CurrentUser)) }
	finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}
function Unprotect-Password([string]$protected, [string]$binding = '') {
	if (-not $protected.StartsWith('dpapi:v1:')) { throw 'Unsupported password format.' }
	Add-Type -AssemblyName System.Security
	$bytes = [Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($protected.Substring(9)), $utf8.GetBytes('com.windowstoolkit.core.credentials.v1|' + $binding), [Security.Cryptography.DataProtectionScope]::CurrentUser)
	try { return $utf8.GetString($bytes) }
	finally { [Array]::Clear($bytes, 0, $bytes.Length) }
}

function Get-Apps([bool]$refresh) {
	if ($refresh -or $null -eq $script:apps) { $script:apps = @(Get-StartApps | Where-Object { $_.AppID -and $_.Name }) }
	return $script:apps
}

function Find-App([string[]]$names) {
	foreach ($pass in 0, 1) {
		$all = Get-Apps ($pass -eq 1)
		foreach ($n in $names) {
			if (-not $n) { continue }
			# Prefer real desktop/Store apps over browser-installed web apps (Chrome/Edge "_crx_" shortcuts).
			$hit = $all | Where-Object { $_.Name -eq $n } | Sort-Object { [int]($_.AppID -match '_crx_') } | Select-Object -First 1
			if (-not $hit) {
				$pat = '*' + [Management.Automation.WildcardPattern]::Escape($n) + '*'
				$hit = $all | Where-Object { $_.Name -like $pat -and $_.Name -notmatch 'uninstall|help|readme|release notes' } |
					Sort-Object { [int]($_.AppID -match '_crx_') }, { $_.Name.Length } | Select-Object -First 1
			}
			if ($hit) { return $hit }
		}
	}
	return $null
}

function Start-AppId([string]$id) {
	try { Start-Process -FilePath ('shell:AppsFolder\' + $id) }
	catch { Start-Process -FilePath "$env:WINDIR\explorer.exe" -ArgumentList ('shell:AppsFolder\' + $id) }
}

function Shots-Folder { return (Join-Path ([Environment]::GetFolderPath('MyPictures')) 'Screenshots') }

function Shell { if ($null -eq $script:wsh) { $script:wsh = New-Object -ComObject WScript.Shell }; return $script:wsh }

function Downloads-Path {
	try { $p = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path; if ($p) { return $p } } catch { }
	return (Join-Path $env:USERPROFILE 'Downloads')
}

$nativeSrc = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class WinToolkitIcon {
	[ComImport, Guid("bcc18b79-ba16-442f-80c4-8a59c30c463b"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
	private interface IShellItemImageFactory { [PreserveSig] int GetImage(SIZE size, int flags, out IntPtr phbm); }
	[StructLayout(LayoutKind.Sequential)] private struct SIZE { public int cx; public int cy; }
	[StructLayout(LayoutKind.Sequential)] private struct BITMAP { public int bmType; public int bmWidth; public int bmHeight; public int bmWidthBytes; public ushort bmPlanes; public ushort bmBitsPixel; public IntPtr bmBits; }
	[StructLayout(LayoutKind.Sequential)] private struct BITMAPINFOHEADER { public uint biSize; public int biWidth; public int biHeight; public ushort biPlanes; public ushort biBitCount; public uint biCompression; public uint biSizeImage; public int biXPelsPerMeter; public int biYPelsPerMeter; public uint biClrUsed; public uint biClrImportant; }
	[StructLayout(LayoutKind.Sequential)] private struct DIBSECTION { public BITMAP dsBm; public BITMAPINFOHEADER dsBmih; public uint b0; public uint b1; public uint b2; public IntPtr dshSection; public uint dsOffset; }
	[DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
	private static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, [MarshalAs(UnmanagedType.Interface)] out IShellItemImageFactory ppv);
	[DllImport("gdi32.dll")] private static extern int GetObject(IntPtr h, int c, ref DIBSECTION ds);
	[DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr h);

	// Returns the item's icon (the same art Windows shows in Start / the taskbar) as a base64 PNG.
	public static string Png(string parsingName, int size) {
		IShellItemImageFactory f;
		SHCreateItemFromParsingName(parsingName, IntPtr.Zero, typeof(IShellItemImageFactory).GUID, out f);
		IntPtr hbm;
		int hr = f.GetImage(new SIZE { cx = size, cy = size }, 0x1 | 0x4, out hbm); // BIGGERSIZEOK | ICONONLY
		if (hr != 0) Marshal.ThrowExceptionForHR(hr);
		try {
			DIBSECTION ds = new DIBSECTION();
			int n = GetObject(hbm, Marshal.SizeOf(typeof(DIBSECTION)), ref ds);
			Bitmap result;
			if (n > 0 && ds.dsBm.bmBitsPixel == 32 && ds.dsBm.bmBits != IntPtr.Zero) {
				int w = ds.dsBm.bmWidth, h = Math.Abs(ds.dsBm.bmHeight), stride = ds.dsBm.bmWidthBytes;
				bool hasAlpha = false;
				byte[] row = new byte[stride];
				for (int y = 0; y < h && !hasAlpha; y++) {
					Marshal.Copy(new IntPtr(ds.dsBm.bmBits.ToInt64() + (long)stride * y), row, 0, stride);
					for (int x = 3; x < w * 4; x += 4) { if (row[x] != 0) { hasAlpha = true; break; } }
				}
				bool bottomUp = ds.dsBmih.biHeight > 0;
				IntPtr scan0 = bottomUp ? new IntPtr(ds.dsBm.bmBits.ToInt64() + (long)stride * (h - 1)) : ds.dsBm.bmBits;
				using (Bitmap src = new Bitmap(w, h, bottomUp ? -stride : stride, hasAlpha ? PixelFormat.Format32bppPArgb : PixelFormat.Format32bppRgb, scan0)) {
					result = new Bitmap(w, h, PixelFormat.Format32bppArgb);
					using (Graphics g = Graphics.FromImage(result)) { g.DrawImage(src, new Rectangle(0, 0, w, h)); }
				}
			} else {
				result = Image.FromHbitmap(hbm);
			}
			using (result) using (MemoryStream ms = new MemoryStream()) { result.Save(ms, ImageFormat.Png); return Convert.ToBase64String(ms.ToArray()); }
		} finally { DeleteObject(hbm); }
	}
}
public static class WinToolkitWin {
	private delegate bool EnumProc(IntPtr h, IntPtr l);
	private delegate bool MonitorEnumProc(IntPtr hMon, IntPtr hdc, ref RECT r, IntPtr d);
	[StructLayout(LayoutKind.Sequential)] public struct RECT { public int L; public int T; public int R; public int B; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MONITORINFOEX { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
	public class Mon { public IntPtr H; public RECT Area; public RECT Work; public bool Primary; public int Num; }
	[DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc cb, IntPtr l);
	[DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr h);
	[DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr h);
	[DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr h, uint cmd);
	[DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr h, int idx);
	[DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
	[DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr h);
	[DllImport("user32.dll")] private static extern bool IsIconic(IntPtr h);
	[DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr h, int cmd);
	[DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out RECT r);
	[DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr h);
	[DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc cb, IntPtr d);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr hMon, ref MONITORINFOEX mi);
	[DllImport("user32.dll")] private static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
	[DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr ctx);

	private static void PerMonitorDpi() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }

	// A normal, user-facing top-level window (not a tool window, popup owner, hidden or cloaked UWP shell).
	private static bool IsAppWindow(IntPtr h) {
		if (h == IntPtr.Zero || !IsWindowVisible(h)) return false;
		if (GetWindow(h, 4) != IntPtr.Zero) return false;
		int ex = GetWindowLong(h, -20);
		if ((ex & 0x80) != 0) return false;
		if (GetWindowTextLength(h) == 0) return false;
		int cloaked;
		if (DwmGetWindowAttribute(h, 14, out cloaked, 4) == 0 && cloaked != 0) return false;
		return true;
	}

	public static long[] Snapshot() {
		List<long> list = new List<long>();
		EnumWindows(delegate (IntPtr h, IntPtr l) { if (IsAppWindow(h)) list.Add(h.ToInt64()); return true; }, IntPtr.Zero);
		return list.ToArray();
	}

	public static long Foreground() { return GetForegroundWindow().ToInt64(); }

	// "\\.\DISPLAY3" -> 3 (the number Windows shows in Settings > Display, in most setups).
	private static int DisplayNumber(string dev) {
		if (string.IsNullOrEmpty(dev)) return 999;
		int i = dev.Length;
		while (i > 0 && char.IsDigit(dev[i - 1])) i--;
		int n;
		return int.TryParse(dev.Substring(i), out n) ? n : 999;
	}

	// order "windows": same numbers as Windows Display settings. "primary": main display = 1, then left-to-right.
	// "left": strictly left-to-right.
	public static List<Mon> Monitors(string order) {
		PerMonitorDpi();
		List<Mon> mons = new List<Mon>();
		EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hm, IntPtr hdc, ref RECT r, IntPtr d) {
			MONITORINFOEX mi = new MONITORINFOEX(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
			if (GetMonitorInfo(hm, ref mi)) mons.Add(new Mon { H = hm, Area = mi.rcMonitor, Work = mi.rcWork, Primary = (mi.dwFlags & 1) != 0, Num = DisplayNumber(mi.szDevice) });
			return true;
		}, IntPtr.Zero);
		mons.Sort(delegate (Mon a, Mon b) {
			if (order == "windows" && a.Num != b.Num) return a.Num.CompareTo(b.Num);
			if (order == "primary" && a.Primary != b.Primary) return a.Primary ? -1 : 1;
			if (a.Area.L != b.Area.L) return a.Area.L.CompareTo(b.Area.L);
			return a.Area.T.CompareTo(b.Area.T);
		});
		return mons;
	}

	public static string Describe(string order) {
		List<Mon> m = Monitors(order);
		List<string> parts = new List<string>();
		for (int i = 0; i < m.Count; i++) parts.Add("{\"n\":" + (i + 1) + ",\"w\":" + (m[i].Area.R - m[i].Area.L) + ",\"h\":" + (m[i].Area.B - m[i].Area.T) + ",\"x\":" + m[i].Area.L + ",\"y\":" + m[i].Area.T + ",\"primary\":" + (m[i].Primary ? "true" : "false") + ",\"win\":" + m[i].Num + "}");
		return "[" + string.Join(",", parts.ToArray()) + "]";
	}

	// Waits (on a background thread) for the window the launch produced, then moves it to monitor #index (0-based).
	public static void PlaceAsync(long[] before, long fgBefore, int index, string order, int timeoutMs) {
		Thread t = new Thread(delegate () { try { Place(before, new IntPtr(fgBefore), index, order, timeoutMs); } catch { } });
		t.IsBackground = true;
		t.Start();
	}

	private static void Place(long[] before, IntPtr fgBefore, int index, string order, int timeoutMs) {
		PerMonitorDpi();
		HashSet<long> seen = new HashSet<long>(before);
		IntPtr target = IntPtr.Zero;
		Stopwatch sw = Stopwatch.StartNew();
		while (sw.ElapsedMilliseconds < timeoutMs && target == IntPtr.Zero) {
			Thread.Sleep(120);
			IntPtr found = IntPtr.Zero;
			EnumWindows(delegate (IntPtr h, IntPtr l) { if (!seen.Contains(h.ToInt64()) && IsAppWindow(h)) { found = h; return false; } return true; }, IntPtr.Zero);
			if (found != IntPtr.Zero) { target = found; break; }
			// Single-instance apps (already open) don't create a window — they come to the front instead.
			if (sw.ElapsedMilliseconds > 1200) {
				IntPtr fg = GetForegroundWindow();
				if (fg != fgBefore && IsAppWindow(fg)) target = fg;
			}
		}
		if (target == IntPtr.Zero) return;
		Thread.Sleep(300); // let the app finish its own start-up positioning
		Move(target, index, order);
		Thread.Sleep(900); // some apps restore a saved position a moment later — correct once more
		Move(target, index, order);
	}

	public static bool Move(IntPtr h, int index, string order) {
		List<Mon> mons = Monitors(order);
		if (mons.Count == 0) return false;
		Mon m = mons[Math.Max(0, Math.Min(index, mons.Count - 1))];
		IntPtr current = MonitorFromWindow(h, 2);
		bool wasMax = IsZoomed(h);
		if (current == m.H && !IsIconic(h)) { SetForegroundWindow(h); return true; }
		if (wasMax || IsIconic(h)) ShowWindow(h, 9);
		RECT r; GetWindowRect(h, out r);
		int w = r.R - r.L, hh = r.B - r.T;
		int ww = m.Work.R - m.Work.L, wh = m.Work.B - m.Work.T;
		w = Math.Min(w, ww); hh = Math.Min(hh, wh);
		int x = m.Work.L + (ww - w) / 2, y = m.Work.T + (wh - hh) / 2;
		SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010);
		if (wasMax) ShowWindow(h, 3);
		SetForegroundWindow(h);
		return true;
	}
	[DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] private static extern bool AttachThreadInput(uint a, uint b, bool attach);
	[DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
	[DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr h);
	[DllImport("user32.dll")] private static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);

	public static string ForegroundProcess() {
		IntPtr h = GetForegroundWindow();
		if (h == IntPtr.Zero) return "";
		uint pid; GetWindowThreadProcessId(h, out pid);
		try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
	}
	public static string ForegroundIdentity() {
		IntPtr h = GetForegroundWindow(); uint pid;
		if (h == IntPtr.Zero) return "\n\n0";
		GetWindowThreadProcessId(h, out pid);
		try { Process p = Process.GetProcessById((int)pid); string path = ""; try { path = p.MainModule.FileName; } catch { }
			return p.ProcessName + "\n" + path + "\n" + pid.ToString();
		} catch { return "\n\n0"; }
	}

	// Brings the most recent window of any of the named processes to the front. Returns false if none is running.
	public static bool Activate(string names) {
		HashSet<uint> pids = new HashSet<uint>();
		foreach (string n in names.Split('|')) { foreach (Process p in Process.GetProcessesByName(n)) pids.Add((uint)p.Id); }
		if (pids.Count == 0) return false;
		IntPtr fg = GetForegroundWindow(); uint fpid; GetWindowThreadProcessId(fg, out fpid);
		if (pids.Contains(fpid)) return true;
		IntPtr best = IntPtr.Zero;
		EnumWindows(delegate (IntPtr h, IntPtr l) { uint wp; GetWindowThreadProcessId(h, out wp); if (pids.Contains(wp) && IsAppWindow(h)) { best = h; return false; } return true; }, IntPtr.Zero);
		if (best == IntPtr.Zero) return false;
		if (IsIconic(best)) ShowWindow(best, 9);
		uint fgThread = GetWindowThreadProcessId(fg, out fpid), me = GetCurrentThreadId();
		bool attached = fgThread != 0 && fgThread != me && AttachThreadInput(me, fgThread, true);
		BringWindowToTop(best);
		bool ok = SetForegroundWindow(best);
		if (attached) AttachThreadInput(me, fgThread, false);
		if (!ok) { keybd_event(0x12, 0, 0, UIntPtr.Zero); keybd_event(0x12, 0, 2, UIntPtr.Zero); SetForegroundWindow(best); }
		return true;
	}

	private static Thread watcher;
	// Emits "0<TAB>fg<TAB><base64 process name>" whenever the foreground app changes.
	public static void WatchForeground(int intervalMs) {
		if (watcher != null) return;
		watcher = new Thread(delegate () {
			string last = null;
			while (true) {
				try {
					string identity = ForegroundIdentity();
					string n = identity.Split('\n')[0];
					if (identity != last) {
						last = identity;
						Console.Out.WriteLine("0\tfg\t" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(n)));
						Console.Out.WriteLine("0\tfgdetail\t" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(identity)));
						Console.Out.Flush();
					}
				} catch { }
				Thread.Sleep(intervalMs);
			}
		});
		watcher.IsBackground = true;
		watcher.Start();
	}
}
// Turns individual screens on and off (Windows "Disconnect this display" + DDC/CI sleep) and reports their state.
public static class WinToolkitDisplay {
	[StructLayout(LayoutKind.Sequential)] public struct LUID { public uint Low; public int High; }
	[StructLayout(LayoutKind.Sequential)] public struct PSRC { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
	[StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint N; public uint D; }
	[StructLayout(LayoutKind.Sequential)] public struct PTGT { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling; public RATIONAL refreshRate; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
	[StructLayout(LayoutKind.Sequential)] public struct PATH { public PSRC src; public PTGT tgt; public uint flags; }
	[StructLayout(LayoutKind.Explicit, Size = 64)] public struct MODE {
		[FieldOffset(0)] public uint infoType; [FieldOffset(4)] public uint id; [FieldOffset(8)] public LUID adapterId;
		[FieldOffset(16)] public uint width; [FieldOffset(20)] public uint height; [FieldOffset(28)] public int x; [FieldOffset(32)] public int y;
		[FieldOffset(16)] public ulong u16; [FieldOffset(24)] public ulong u24; [FieldOffset(32)] public ulong u32; [FieldOffset(40)] public ulong u40; [FieldOffset(48)] public ulong u48; [FieldOffset(56)] public ulong u56;
	}
	[StructLayout(LayoutKind.Sequential)] public struct HDR { public uint type; public uint size; public LUID adapterId; public uint id; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct SRCNAME { public HDR h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string gdi; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct TGTNAME { public HDR h; public uint flags; public uint tech; public ushort mfg; public ushort product; public uint connector; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string friendly; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string path; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct ADAPTERNAME { public HDR h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string path; }
	public class Target { public PATH Path; public TGTNAME Name; public string Adapter; public int Number; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct PHYS { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }
	[StructLayout(LayoutKind.Sequential)] private struct RC { public int L; public int T; public int R; public int B; }
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] private struct MINFO { public int cbSize; public RC rcMonitor; public RC rcWork; public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
	private delegate bool MonProc(IntPtr hMon, IntPtr hdc, ref RC r, IntPtr d);

	[DllImport("user32.dll")] private static extern int GetDisplayConfigBufferSizes(uint flags, out uint np, out uint nm);
	[DllImport("user32.dll")] private static extern int QueryDisplayConfig(uint flags, ref uint np, [Out] PATH[] paths, ref uint nm, [Out] MODE[] modes, IntPtr topology);
	[DllImport("user32.dll")] private static extern int SetDisplayConfig(uint np, [In] PATH[] paths, uint nm, [In] MODE[] modes, uint flags);
	[DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref SRCNAME r);
	[DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref TGTNAME r);
	[DllImport("user32.dll")] private static extern int DisplayConfigGetDeviceInfo(ref ADAPTERNAME r);
	[DllImport("user32.dll")] private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonProc cb, IntPtr d);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool GetMonitorInfo(IntPtr hMon, ref MINFO mi);
	[DllImport("dxva2.dll")] private static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr h, out uint n);
	[DllImport("dxva2.dll")] private static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr h, uint n, [Out] PHYS[] arr);
	[DllImport("dxva2.dll")] private static extern bool SetVCPFeature(IntPtr h, byte code, uint value);
	[DllImport("dxva2.dll")] private static extern bool DestroyPhysicalMonitors(uint n, [In] PHYS[] arr);

	private const uint QDC_ALL_PATHS = 1, QDC_ONLY_ACTIVE_PATHS = 2, ACTIVE = 1, INVALID = 0xffffffff;
	private const uint SDC_TOPOLOGY_EXTEND = 0x4, SDC_TOPOLOGY_SUPPLIED = 0x10, SDC_USE_SUPPLIED = 0x20, SDC_APPLY = 0x80, SDC_SAVE = 0x200, SDC_ALLOW_CHANGES = 0x400, SDC_ALLOW_PATH_ORDER = 0x2000;

	private static void Query(uint flags, out PATH[] paths, out MODE[] modes) {
		for (int attempt = 0; ; attempt++) {
			uint np, nm;
			int r = GetDisplayConfigBufferSizes(flags, out np, out nm);
			if (r != 0) throw new Exception("Can't read the display setup (error " + r + ").");
			paths = new PATH[np]; modes = new MODE[nm];
			r = QueryDisplayConfig(flags, ref np, paths, ref nm, modes, IntPtr.Zero);
			if (r == 122 && attempt < 5) continue; // screens changed between the two calls
			if (r != 0) throw new Exception("Can't read the display setup (error " + r + ").");
			Array.Resize(ref paths, (int)np); Array.Resize(ref modes, (int)nm);
			return;
		}
	}

	private static string Gdi(LUID a, uint id) {
		SRCNAME s = new SRCNAME(); s.h.type = 1; s.h.size = (uint)Marshal.SizeOf(typeof(SRCNAME)); s.h.adapterId = a; s.h.id = id;
		return DisplayConfigGetDeviceInfo(ref s) == 0 ? (s.gdi ?? "") : "";
	}
	private static TGTNAME Tgt(LUID a, uint id) {
		TGTNAME t = new TGTNAME(); t.h.type = 2; t.h.size = (uint)Marshal.SizeOf(typeof(TGTNAME)); t.h.adapterId = a; t.h.id = id;
		DisplayConfigGetDeviceInfo(ref t);
		return t;
	}
	private static string AdapterName(LUID a) {
		ADAPTERNAME n = new ADAPTERNAME(); n.h.type = 4; n.h.size = (uint)Marshal.SizeOf(typeof(ADAPTERNAME)); n.h.adapterId = a;
		return DisplayConfigGetDeviceInfo(ref n) == 0 ? (n.path ?? "") : a.High + ":" + a.Low;
	}
	private static int ConnectorPriority(uint tech) {
		// CCD connector ordering follows Settings on the verified hardware. GDI DISPLAYn
		// and QueryDisplayConfig path order instead follow mutable source/primary order.
		// Windows does not expose a documented Settings-number API; do not use GDI as one.
		switch (tech) {
			case 0x80000000: return 0; // internal
			case 11: case 6: return 1; // embedded DisplayPort / LVDS
			case 4: return 2; // DVI
			case 10: return 3; // external DisplayPort
			case 5: return 4; // HDMI
			default: return 5;
		}
	}
	private static void NumberTargets(List<Target> targets) {
		targets.Sort(delegate(Target a, Target b) {
			int c = StringComparer.OrdinalIgnoreCase.Compare(a.Adapter, b.Adapter);
			if (c == 0) c = ConnectorPriority(a.Name.tech).CompareTo(ConnectorPriority(b.Name.tech));
			if (c == 0) c = a.Name.connector.CompareTo(b.Name.connector);
			if (c == 0) c = a.Path.tgt.id.CompareTo(b.Path.tgt.id);
			return c;
		});
		for (int i = 0; i < targets.Count; i++) targets[i].Number = i + 1;
	}
	private static string RawKey(PTGT t) { return t.adapterId.High + ":" + t.adapterId.Low + ":" + t.id; }
	// Stable identity of a screen: its monitor device path (survives reboots), else adapter + target.
	private static string KeyOf(PTGT t) { TGTNAME n = Tgt(t.adapterId, t.id); return string.IsNullOrEmpty(n.path) ? RawKey(t) : n.path; }
	private static bool Same(LUID a, LUID b) { return a.Low == b.Low && a.High == b.High; }
	private static int Num(string dev) {
		if (string.IsNullOrEmpty(dev)) return 0;
		int i = dev.Length; while (i > 0 && char.IsDigit(dev[i - 1])) i--;
		int n; return int.TryParse(dev.Substring(i), out n) ? n : 0;
	}
	private static string J(string s) { return "\"" + (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"") + "\""; }
	private static bool IsMain(PATH p, MODE[] modes) {
		uint mi = p.src.modeInfoIdx;
		return mi < modes.Length && modes[mi].infoType == 1 && modes[mi].x == 0 && modes[mi].y == 0;
	}

	// The physical display number is separate from the GDI source number used to restore a path.
	public static string List() {
		PATH[] paths; MODE[] modes; Query(QDC_ALL_PATHS, out paths, out modes);
		HashSet<string> seen = new HashSet<string>();
		Dictionary<string, string> adapters = new Dictionary<string, string>();
		List<Target> targets = new List<Target>();
		List<string> outp = new List<string>();
		for (int pass = 0; pass < 2; pass++) {
			foreach (PATH p in paths) {
				bool on = (p.flags & ACTIVE) != 0;
				if (pass == 0 ? !on : (on || p.tgt.targetAvailable == 0)) continue;
				string raw = RawKey(p.tgt);
				if (!seen.Add(raw)) continue;
				TGTNAME n = Tgt(p.tgt.adapterId, p.tgt.id);
				string adapter = p.tgt.adapterId.High + ":" + p.tgt.adapterId.Low;
				if (!adapters.ContainsKey(adapter)) adapters[adapter] = AdapterName(p.tgt.adapterId);
				targets.Add(new Target { Path = p, Name = n, Adapter = adapters[adapter] });
			}
		}
		NumberTargets(targets);
		foreach (Target t in targets) {
			PATH p = t.Path; TGTNAME n = t.Name; bool on = (p.flags & ACTIVE) != 0;
			string key = string.IsNullOrEmpty(n.path) ? RawKey(p.tgt) : n.path;
			int source = on ? Num(Gdi(p.src.adapterId, p.src.id)) : 0;
			outp.Add("{\"key\":" + J(key) + ",\"name\":" + J(n.friendly) + ",\"on\":" + (on ? "true" : "false") + ",\"num\":" + t.Number + ",\"gdiNum\":" + source + ",\"primary\":" + (on && IsMain(p, modes) ? "true" : "false") + "}");
		}
		return "[" + string.Join(",", outp.ToArray()) + "]";
	}

	public static bool IsOn(string key) {
		PATH[] paths; MODE[] modes; Query(QDC_ONLY_ACTIVE_PATHS, out paths, out modes);
		foreach (PATH p in paths) if (KeyOf(p.tgt) == key) return true;
		return false;
	}

	// Keys of connected screens that are currently off.
	public static string[] OffKeys() {
		PATH[] paths; MODE[] modes; Query(QDC_ALL_PATHS, out paths, out modes);
		HashSet<string> on = new HashSet<string>(), off = new HashSet<string>();
		foreach (PATH p in paths) if ((p.flags & ACTIVE) != 0) on.Add(KeyOf(p.tgt));
		foreach (PATH p in paths) if ((p.flags & ACTIVE) == 0 && p.tgt.targetAvailable != 0) { string k = KeyOf(p.tgt); if (!on.Contains(k)) off.Add(k); }
		string[] r = new string[off.Count]; off.CopyTo(r); return r;
	}

	private static PATH[] Compact(List<PATH> keep, MODE[] modes, out MODE[] outModes) {
		List<MODE> km = new List<MODE>();
		Dictionary<uint, uint> map = new Dictionary<uint, uint>();
		PATH[] r = new PATH[keep.Count];
		for (int i = 0; i < keep.Count; i++) {
			PATH p = keep[i];
			p.src.modeInfoIdx = Remap(p.src.modeInfoIdx, modes, km, map);
			p.tgt.modeInfoIdx = Remap(p.tgt.modeInfoIdx, modes, km, map);
			r[i] = p;
		}
		outModes = km.ToArray();
		return r;
	}
	private static uint Remap(uint idx, MODE[] modes, List<MODE> km, Dictionary<uint, uint> map) {
		if (idx == INVALID || idx >= modes.Length) return INVALID;
		uint n;
		if (!map.TryGetValue(idx, out n)) { n = (uint)km.Count; km.Add(modes[idx]); map[idx] = n; }
		return n;
	}

	// Windows considers the source at (0,0) primary. When removing it, give another
	// remaining source the origin while preserving the screens' relative positions.
	private static void RebaseSources(MODE[] modes) {
		int first = -1;
		for (int i = 0; i < modes.Length; i++) {
			if (modes[i].infoType != 1) continue;
			if (modes[i].x == 0 && modes[i].y == 0) return; // e.g. a clone still uses the primary source
			if (first < 0) first = i;
		}
		if (first < 0) return;
		int ox = modes[first].x, oy = modes[first].y;
		for (int i = 0; i < modes.Length; i++) {
			if (modes[i].infoType != 1) continue;
			modes[i].x -= ox; modes[i].y -= oy;
		}
	}

	public static string Off(string key, bool sleep) {
		PATH[] paths; MODE[] modes; Query(QDC_ONLY_ACTIVE_PATHS, out paths, out modes);
		List<PATH> keep = new List<PATH>(); PATH victim = new PATH(); bool found = false;
		foreach (PATH p in paths) { if (KeyOf(p.tgt) == key) { if (!found) victim = p; found = true; } else keep.Add(p); }
		if (!found) return "already off";
		if (keep.Count == 0) throw new Exception("That is the only screen that is on.");
		string gdi = Gdi(victim.src.adapterId, victim.src.id);
		MODE[] km; PATH[] kp = Compact(keep, modes, out km);
		if (IsMain(victim, modes)) RebaseSources(km);
		bool slept = sleep && Power(gdi, false);
		int r = SetDisplayConfig((uint)kp.Length, kp, (uint)km.Length, km, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES | SDC_SAVE);
		if (r != 0) { if (slept) Power(gdi, true); throw new Exception("Windows refused to turn that screen off (error " + r + ")."); }
		return slept ? "off (monitor asleep)" : "off";
	}

	public static string On(string key, bool wake, int preferNum) {
		PATH[] all; MODE[] modes; Query(QDC_ALL_PATHS, out all, out modes);
		List<PATH> active = new List<PATH>();
		foreach (PATH p in all) if ((p.flags & ACTIVE) != 0) active.Add(p);
		foreach (PATH p in active) if (KeyOf(p.tgt) == key) { if (wake) WakeLater(key); return "already on"; }
		// Pick a free source for it — the one that gives it back its old display number if possible, else the lowest.
		int cand = -1;
		for (int i = 0; i < all.Length; i++) {
			PATH p = all[i];
			if ((p.flags & ACTIVE) != 0 || p.tgt.targetAvailable == 0 || KeyOf(p.tgt) != key) continue;
			bool busy = false;
			foreach (PATH a in active) if (Same(a.src.adapterId, p.src.adapterId) && a.src.id == p.src.id) { busy = true; break; }
			if (busy) continue;
			if (preferNum > 0 && Num(Gdi(p.src.adapterId, p.src.id)) == preferNum) { cand = i; break; }
			if (cand < 0 || p.src.id < all[cand].src.id) cand = i;
		}
		if (cand < 0) throw new Exception("That screen isn't connected. Check its cable and power.");
		PATH c = all[cand]; c.flags |= ACTIVE; c.src.modeInfoIdx = INVALID; c.tgt.modeInfoIdx = INVALID;
		// Inactive paths can carry zeroed fields that aren't valid values; use "identity" / "preferred" / "unspecified".
		if (c.tgt.rotation == 0) c.tgt.rotation = 1;
		if (c.tgt.scaling == 0) c.tgt.scaling = 128;
		c.tgt.refreshRate = new RATIONAL(); c.tgt.scanLineOrdering = 0;

		// 1) Let Windows restore the arrangement it remembers for this set of screens.
		PATH[] t1 = new PATH[active.Count + 1];
		for (int i = 0; i < active.Count; i++) { PATH p = active[i]; p.src.modeInfoIdx = INVALID; p.tgt.modeInfoIdx = INVALID; t1[i] = p; }
		t1[active.Count] = c;
		int r = SetDisplayConfig((uint)t1.Length, t1, 0, null, SDC_APPLY | SDC_TOPOLOGY_SUPPLIED | SDC_ALLOW_PATH_ORDER);
		if (r == 0) SaveCurrent(); // so it stays on after a restart
		else {
			// 2) Keep the other screens exactly as they are; Windows picks a mode for this one.
			MODE[] km; PATH[] kp = Compact(active, modes, out km);
			PATH[] t2 = new PATH[kp.Length + 1]; Array.Copy(kp, t2, kp.Length); t2[kp.Length] = c;
			r = SetDisplayConfig((uint)t2.Length, t2, (uint)km.Length, km, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES | SDC_SAVE);
		}
		if (r != 0) throw new Exception("Windows refused to turn that screen on (error " + r + ").");
		if (wake) WakeLater(key);
		return "on";
	}

	// Stores the layout that is active now as the one Windows restores.
	private static void SaveCurrent() {
		try {
			PATH[] paths; MODE[] modes; Query(QDC_ONLY_ACTIVE_PATHS, out paths, out modes);
			SetDisplayConfig((uint)paths.Length, paths, (uint)modes.Length, modes, SDC_APPLY | SDC_USE_SUPPLIED | SDC_ALLOW_CHANGES | SDC_SAVE);
		} catch { }
	}

	// Last resort for turning a screen on: Windows "Extend" (every connected screen on). Returns the Windows error code.
	public static int ExtendAll() { return SetDisplayConfig(0, null, 0, null, SDC_APPLY | SDC_TOPOLOGY_EXTEND); }

	// Wakes the monitor (DDC/CI) once Windows has brought it back.
	public static void WakeLater(string key) {
		Thread t = new Thread(delegate () {
			try {
				for (int i = 0; i < 20; i++) {
					Thread.Sleep(250);
					PATH[] paths; MODE[] modes; Query(QDC_ONLY_ACTIVE_PATHS, out paths, out modes);
					foreach (PATH p in paths) if (KeyOf(p.tgt) == key && Power(Gdi(p.src.adapterId, p.src.id), true)) return;
				}
			} catch { }
		});
		t.IsBackground = true;
		t.Start();
	}

	private static IntPtr FindMonitor(string gdi) {
		IntPtr hit = IntPtr.Zero;
		EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hm, IntPtr hdc, ref RC r, IntPtr d) {
			MINFO mi = new MINFO(); mi.cbSize = Marshal.SizeOf(typeof(MINFO));
			if (GetMonitorInfo(hm, ref mi) && string.Equals(mi.szDevice, gdi, StringComparison.OrdinalIgnoreCase)) { hit = hm; return false; }
			return true;
		}, IntPtr.Zero);
		return hit;
	}

	// DDC/CI power mode (VCP 0xD6): 1 = on, 4 = standby. Returns false when the monitor doesn't support it.
	private static bool Power(string gdi, bool on) {
		try {
			IntPtr hm = FindMonitor(gdi);
			if (hm == IntPtr.Zero) return false;
			uint n;
			if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hm, out n) || n == 0) return false;
			PHYS[] arr = new PHYS[n];
			if (!GetPhysicalMonitorsFromHMONITOR(hm, n, arr)) return false;
			bool ok = false;
			try { foreach (PHYS p in arr) ok |= SetVCPFeature(p.h, 0xD6, on ? 1u : 4u); }
			finally { DestroyPhysicalMonitors(n, arr); }
			return ok;
		} catch { return false; }
	}
}

// Screenshots: active window or all screens (saved as PNG and/or copied), plus saving a copy of area snips.
public static class WinToolkitShot {
	[DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] private static extern int GetSystemMetrics(int i);
	[DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr c);
	[DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr h, int attr, out WinToolkitWin.RECT r, int size);
	[DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr h, out WinToolkitWin.RECT r);
	[DllImport("user32.dll")] private static extern uint GetClipboardSequenceNumber();
	[DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);

	private static void Emit(string type, string data) {
		Console.Out.WriteLine("0\t" + type + "\t" + Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(data ?? "")));
		Console.Out.Flush();
	}

	// mode "window" or "all". Returns the saved file path ("" when only copied).
	public static string Capture(string mode, string folder, bool save, bool clip) {
		string result = null; Exception err = null;
		Thread t = new Thread(delegate () { try { result = CaptureSta(mode, folder, save, clip); } catch (Exception e) { err = e; } });
		t.SetApartmentState(ApartmentState.STA); // the clipboard needs an STA thread
		t.Start();
		if (!t.Join(20000)) throw new Exception("Screenshot timed out.");
		if (err != null) throw err;
		return result ?? "";
	}

	private static string CaptureSta(string mode, string folder, bool save, bool clip) {
		try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } // real pixels on scaled screens
		int x, y, w, h; string tag = "";
		if (mode == "window") {
			IntPtr hw = GetForegroundWindow();
			if (hw == IntPtr.Zero) throw new Exception("No active window.");
			WinToolkitWin.RECT r;
			if (DwmGetWindowAttribute(hw, 9, out r, Marshal.SizeOf(typeof(WinToolkitWin.RECT))) != 0) GetWindowRect(hw, out r); // 9 = frame without shadow
			x = r.L; y = r.T; w = r.R - r.L; h = r.B - r.T;
			uint pid; GetWindowThreadProcessId(hw, out pid);
			try { tag = " " + Process.GetProcessById((int)pid).ProcessName; } catch { }
		} else {
			x = GetSystemMetrics(76); y = GetSystemMetrics(77); w = GetSystemMetrics(78); h = GetSystemMetrics(79); // virtual screen
		}
		if (w <= 0 || h <= 0) throw new Exception("Nothing to capture.");
		using (Bitmap bmp = new Bitmap(w, h, PixelFormat.Format32bppArgb)) {
			using (Graphics g = Graphics.FromImage(bmp)) g.CopyFromScreen(x, y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
			string path = save ? SaveTo(bmp, folder, tag) : "";
			if (clip) SetClipboard(bmp);
			return path;
		}
	}

	private static string SaveTo(Image img, string folder, string tag) {
		Directory.CreateDirectory(folder);
		string clean = tag ?? "";
		foreach (char c in Path.GetInvalidFileNameChars()) clean = clean.Replace(c.ToString(), "");
		string baseName = "Screenshot " + DateTime.Now.ToString("yyyy-MM-dd HH-mm-ss") + clean;
		string p = Path.Combine(folder, baseName + ".png");
		for (int i = 2; File.Exists(p); i++) p = Path.Combine(folder, baseName + " (" + i + ").png");
		img.Save(p, ImageFormat.Png);
		return p;
	}

	private static void SetClipboard(Image img) {
		for (int i = 0; i < 6; i++) {
			try { System.Windows.Forms.Clipboard.SetImage(img); return; } catch (ExternalException) { Thread.Sleep(80); }
		}
	}

	public static uint ClipSeq() { return GetClipboardSequenceNumber(); }

	private static string NewestSince(string folder, DateTime since) {
		try {
			if (string.IsNullOrEmpty(folder) || !Directory.Exists(folder)) return null;
			string best = null; DateTime bt = since;
			foreach (string f in Directory.GetFiles(folder, "*.png")) { DateTime t = File.GetCreationTime(f); if (t >= bt) { bt = t; best = f; } }
			return best;
		} catch { return null; }
	}

	// Area snips come from Windows' own snipping overlay, which puts the picture on the clipboard.
	// Waits for it and saves a copy — unless the Snipping Tool already saved one in the same folder.
	private static int snipGen;
	public static void SaveNextClipboardImage(uint seqBefore, string folder, string snippingToolFolder, int timeoutMs) {
		int my = Interlocked.Increment(ref snipGen); // a newer snip replaces this watcher
		Thread t = new Thread(delegate () {
			try {
				DateTime started = DateTime.Now.AddSeconds(-1);
				Stopwatch sw = Stopwatch.StartNew();
				while (sw.ElapsedMilliseconds < timeoutMs) {
					Thread.Sleep(200);
					if (snipGen != my) return;
					if (GetClipboardSequenceNumber() == seqBefore) continue;
					Thread.Sleep(400); // let the overlay finish writing every format
					Image img = null;
					for (int i = 0; i < 5 && img == null; i++) {
						try { if (System.Windows.Forms.Clipboard.ContainsImage()) img = System.Windows.Forms.Clipboard.GetImage(); } catch { }
						if (img == null) Thread.Sleep(150);
					}
					if (img == null) return; // something other than a picture was copied: the snip was cancelled
					using (img) {
						Thread.Sleep(1200);
						string already = NewestSince(snippingToolFolder, started);
						bool sameFolder = string.Equals(Path.GetFullPath(folder).TrimEnd('\\'), Path.GetFullPath(snippingToolFolder).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
						Emit("shot", already != null && sameFolder ? already : SaveTo(img, folder, ""));
					}
					return;
				}
				Emit("shot", "");
			} catch (Exception e) { Emit("shoterr", e.Message); }
		});
		t.SetApartmentState(ApartmentState.STA);
		t.IsBackground = true;
		t.Start();
	}
}
'@
$script:nativeReady = $false
$script:snap = @()
$script:fg = 0
function SK-Escape([string]$t) { return (($t.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ } }) -join '') }
function Ensure-Native { if (-not $script:nativeReady) { Add-Type -TypeDefinition $nativeSrc -ReferencedAssemblies System.Drawing, System.Windows.Forms; $script:nativeReady = $true } }

# Windows Toolkit feature helpers (Core Audio, window, power, DDC/CI brightness, live stats). Compiled on first use.
$fxSrc = @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// ---------------- Core Audio (Windows built-in) ----------------
[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class WtMMDeviceEnumerator { }
[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDeviceEnumerator {
	int EnumAudioEndpoints(int dataFlow, int stateMask, out IWtMMDeviceCollection devices);
	int GetDefaultAudioEndpoint(int dataFlow, int role, out IWtMMDevice device);
	int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IWtMMDevice device);
}
[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDeviceCollection { int GetCount(out int count); int Item(int index, out IWtMMDevice device); }
[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtMMDevice {
	int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
	int OpenPropertyStore(int access, out IWtPropertyStore store);
	int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
	int GetState(out int state);
}
[StructLayout(LayoutKind.Sequential)] struct WtPropertyKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit)] struct WtPropVariant { [FieldOffset(0)] public short vt; [FieldOffset(8)] public IntPtr p; [FieldOffset(16)] public IntPtr p2; }
[ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtPropertyStore {
	int GetCount(out int count);
	int GetAt(int prop, out WtPropertyKey key);
	int GetValue(ref WtPropertyKey key, out WtPropVariant value);
}
[ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioEndpointVolume {
	int RegisterControlChangeNotify(IntPtr notify);
	int UnregisterControlChangeNotify(IntPtr notify);
	int GetChannelCount(out int count);
	int SetMasterVolumeLevel(float level, ref Guid ctx);
	int SetMasterVolumeLevelScalar(float level, ref Guid ctx);
	int GetMasterVolumeLevel(out float level);
	int GetMasterVolumeLevelScalar(out float level);
	int SetChannelVolumeLevel(int ch, float level, ref Guid ctx);
	int SetChannelVolumeLevelScalar(int ch, float level, ref Guid ctx);
	int GetChannelVolumeLevel(int ch, out float level);
	int GetChannelVolumeLevelScalar(int ch, out float level);
	int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
	int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
[ComImport, Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioMeterInformation { int GetPeakValue(out float peak); }
[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionManager2 {
	int GetAudioSessionControl(IntPtr guid, int flags, out IntPtr control);
	int GetSimpleAudioVolume(IntPtr guid, int flags, out IntPtr volume);
	int GetSessionEnumerator(out IWtAudioSessionEnumerator sessions);
}
[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionEnumerator { int GetCount(out int count); int GetSession(int index, out IWtAudioSessionControl2 session); }
[ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtAudioSessionControl2 {
	int GetState(out int state);
	int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string name);
	int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string name, ref Guid ctx);
	int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string path);
	int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string path, ref Guid ctx);
	int GetGroupingParam(out Guid g);
	int SetGroupingParam(ref Guid g, ref Guid ctx);
	int RegisterAudioSessionNotification(IntPtr n);
	int UnregisterAudioSessionNotification(IntPtr n);
	int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
	int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string id);
	int GetProcessId(out uint pid);
}
[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtSimpleAudioVolume {
	int SetMasterVolume(float level, ref Guid ctx);
	int GetMasterVolume(out float level);
	int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, ref Guid ctx);
	int GetMute([MarshalAs(UnmanagedType.Bool)] out bool mute);
}
// Undocumented but stable since Windows 7: used by Windows' own sound panel to set the default device.
[ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")] class WtPolicyConfigClient { }
[ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IWtPolicyConfig {
	int GetMixFormat(IntPtr a, IntPtr b);
	int GetDeviceFormat(IntPtr a, int b, IntPtr c);
	int ResetDeviceFormat(IntPtr a);
	int SetDeviceFormat(IntPtr a, IntPtr b, IntPtr c);
	int GetProcessingPeriod(IntPtr a, int b, IntPtr c, IntPtr d);
	int SetProcessingPeriod(IntPtr a, IntPtr b);
	int GetShareMode(IntPtr a, IntPtr b);
	int SetShareMode(IntPtr a, IntPtr b);
	int GetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
	int SetPropertyValue(IntPtr a, IntPtr b, IntPtr c);
	int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
	int SetEndpointVisibility([MarshalAs(UnmanagedType.LPWStr)] string id, int visible);
}

public static class WinToolkitAudio {
	static Guid IID_Volume = new Guid("5CDF2C82-841E-4546-9722-0CF74078229A");
	static Guid IID_Meter = new Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064");
	static Guid IID_Sessions = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
	static IWtMMDeviceEnumerator Enum() { return (IWtMMDeviceEnumerator)new WtMMDeviceEnumerator(); }
	// flow: 0 = render (speakers), 1 = capture (microphones)
	static IWtMMDevice Default(int flow) { IWtMMDevice d; Marshal.ThrowExceptionForHR(Enum().GetDefaultAudioEndpoint(flow, 1, out d)); return d; }
	static T Activate<T>(IWtMMDevice d, Guid iid) { object o; Guid g = iid; Marshal.ThrowExceptionForHR(d.Activate(ref g, 23, IntPtr.Zero, out o)); return (T)o; }
	static IWtAudioEndpointVolume Volume(int flow) { return Activate<IWtAudioEndpointVolume>(Default(flow), IID_Volume); }

	public static bool GetMute(int flow) { bool m; Volume(flow).GetMute(out m); return m; }
	public static bool SetMute(int flow, bool mute) { Guid g = Guid.Empty; Marshal.ThrowExceptionForHR(Volume(flow).SetMute(mute, ref g)); return mute; }
	public static bool ToggleMute(int flow) { return SetMute(flow, !GetMute(flow)); }
	public static int GetVolume(int flow) { float v; Volume(flow).GetMasterVolumeLevelScalar(out v); return (int)Math.Round(v * 100); }
	public static int Peak(int flow) { float v; Activate<IWtAudioMeterInformation>(Default(flow), IID_Meter).GetPeakValue(out v); return (int)Math.Round(v * 100); }

	static string Name(IWtMMDevice d) {
		IWtPropertyStore s; if (d.OpenPropertyStore(0, out s) != 0) return "";
		WtPropertyKey k = new WtPropertyKey(); k.fmtid = new Guid("a45c254e-df1c-4efd-8020-67d146a850e0"); k.pid = 14;
		WtPropVariant v; if (s.GetValue(ref k, out v) != 0 || v.vt != 31) return "";
		return Marshal.PtrToStringUni(v.p) ?? "";
	}
	/** Lines "id<TAB>name<TAB>1 if default". */
	public static string List(int flow) {
		IWtMMDeviceCollection c; Marshal.ThrowExceptionForHR(Enum().EnumAudioEndpoints(flow, 1, out c));
		int n; c.GetCount(out n);
		string def = ""; try { Default(flow).GetId(out def); } catch { }
		StringBuilder sb = new StringBuilder();
		for (int i = 0; i < n; i++) { IWtMMDevice d; c.Item(i, out d); string id; d.GetId(out id); sb.Append(id).Append('\t').Append(Name(d)).Append('\t').Append(id == def ? "1" : "0").Append('\n'); }
		return sb.ToString().TrimEnd('\n');
	}
	public static string SetDefault(string id) {
		IWtPolicyConfig p = (IWtPolicyConfig)new WtPolicyConfigClient();
		for (int role = 0; role < 3; role++) Marshal.ThrowExceptionForHR(p.SetDefaultEndpoint(id, role));
		IWtMMDevice d; Enum().GetDevice(id, out d); return d == null ? id : Name(d);
	}
	/** Next device after the current default; when only is set, cycle only names containing one of the '|' parts. */
	public static string Cycle(int flow, string only) {
		string[] lines = List(flow).Split('\n');
		List<string[]> ok = new List<string[]>(); int cur = -1;
		string[] want = string.IsNullOrEmpty(only) ? new string[0] : only.ToLowerInvariant().Split('|');
		foreach (string l in lines) {
			string[] f = l.Split('\t'); if (f.Length < 3) continue;
			bool keep = want.Length == 0; foreach (string w in want) if (w.Trim().Length > 0 && f[1].ToLowerInvariant().Contains(w.Trim())) keep = true;
			if (!keep) continue;
			if (f[2] == "1") cur = ok.Count; ok.Add(f);
		}
		if (ok.Count == 0) throw new Exception("No matching audio device");
		return SetDefault(ok[(cur + 1) % ok.Count][0]);
	}
	public static string Current(int flow) { return Name(Default(flow)); }

	/** Per-app volume: every session whose process name matches. op: mute | unmute | toggle | up | down | get. Returns "volume,muted". */
	public static string App(string process, string op, int step) {
		IWtAudioSessionManager2 m = Activate<IWtAudioSessionManager2>(Default(0), IID_Sessions);
		IWtAudioSessionEnumerator e; Marshal.ThrowExceptionForHR(m.GetSessionEnumerator(out e));
		int n; e.GetCount(out n); int found = 0; float last = 0; bool lastMute = false; Guid g = Guid.Empty;
		string want = process.ToLowerInvariant().Replace(".exe", "");
		for (int i = 0; i < n; i++) {
			IWtAudioSessionControl2 s; e.GetSession(i, out s); uint pid; s.GetProcessId(out pid); if (pid == 0) continue;
			string pn = ""; try { pn = Process.GetProcessById((int)pid).ProcessName.ToLowerInvariant(); } catch { continue; }
			if (pn != want) continue;
			IWtSimpleAudioVolume v = (IWtSimpleAudioVolume)s; float cur; bool mu; v.GetMasterVolume(out cur); v.GetMute(out mu);
			if (op == "toggle") mu = !mu; else if (op == "mute") mu = true; else if (op == "unmute") mu = false;
			else if (op == "up") cur = Math.Min(1f, cur + step / 100f); else if (op == "down") cur = Math.Max(0f, cur - step / 100f);
			if (op != "get") { v.SetMute(mu, ref g); v.SetMasterVolume(cur, ref g); }
			found++; last = cur; lastMute = mu;
		}
		if (found == 0) throw new Exception(process + " is not playing audio");
		return ((int)Math.Round(last * 100)).ToString() + "," + (lastMute ? "1" : "0");
	}
}

// ---------------- Windows, power, display, system stats ----------------
public static class WinToolkitFx {
	[DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
	[DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
	[DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
	[DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
	[DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr result);
	[DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int index);
	[DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
	[DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
	[DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
	[DllImport("user32.dll")] static extern bool LockWorkStation();
	[DllImport("dxva2.dll")] static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hmon, out uint count);
	[DllImport("dxva2.dll")] static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hmon, uint count, [Out] PHYSICAL_MONITOR[] arr);
	[DllImport("dxva2.dll")] static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr h, byte code, IntPtr type, out uint cur, out uint max);
	[DllImport("dxva2.dll")] static extern bool SetVCPFeature(IntPtr h, byte code, uint value);
	[DllImport("dxva2.dll")] static extern bool DestroyPhysicalMonitors(uint count, PHYSICAL_MONITOR[] arr);
	[DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnum cb, IntPtr data);
	delegate bool MonitorEnum(IntPtr hmon, IntPtr hdc, IntPtr rect, IntPtr data);
	[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct PHYSICAL_MONITOR { public IntPtr h; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string desc; }

	/** Press a chord of virtual-key codes (e.g. 0x5B,0x11,0x27 = Win+Ctrl+Right), released in reverse order. */
	public static void Chord(int[] vks) {
		foreach (int vk in vks) keybd_event((byte)vk, 0, IsExtended(vk) ? 1u : 0u, UIntPtr.Zero);
		Thread.Sleep(30);
		for (int i = vks.Length - 1; i >= 0; i--) keybd_event((byte)vks[i], 0, (IsExtended(vks[i]) ? 1u : 0u) | 2u, UIntPtr.Zero);
	}
	static bool IsExtended(int vk) { return vk == 0x5B || (vk >= 0x21 && vk <= 0x2E) || (vk >= 0xA6 && vk <= 0xB7); }

	public static uint ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
	public static string ForegroundName() { try { return Process.GetProcessById((int)ForegroundPid()).ProcessName; } catch { return ""; } }
	static readonly string[] Protected = { "explorer", "streamdeck", "csrss", "winlogon", "dwm", "lsass", "svchost", "system", "idle", "searchhost", "shellexperiencehost", "startmenuexperiencehost", "textinputhost" };
	static bool IsProtected(string n) { n = n.ToLowerInvariant(); foreach (string p in Protected) if (p == n) return true; return false; }
	/** Ask the active app to close (same as clicking its X). */
	public static string CloseActive() {
		IntPtr h = GetForegroundWindow(); string n = ForegroundName();
		if (h == IntPtr.Zero || IsProtected(n)) throw new Exception("No app window is active");
		PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero); return n;
	}
	/** End the active app's process (for frozen apps). Never Windows itself or Stream Deck. */
	public static string KillActive() {
		uint pid = ForegroundPid(); Process p = Process.GetProcessById((int)pid);
		if (IsProtected(p.ProcessName)) throw new Exception("That app can't be force-closed");
		string n = p.ProcessName; p.Kill(); return n;
	}
	/** Toggle "always on top" for the active window. Returns true when now on top. */
	public static bool ToggleTopmost() {
		IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero) throw new Exception("No window is active");
		bool top = (GetWindowLong(h, -20) & 0x8) != 0;
		SetWindowPos(h, new IntPtr(top ? -2 : -1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
		return !top;
	}
	public static void Lock() { LockWorkStation(); }
	public static void ScreensOff() { IntPtr r; SendMessageTimeout(new IntPtr(0xFFFF), 0x0112, new IntPtr(0xF170), new IntPtr(2), 2, 1000, out r); }

	/** External monitors via DDC/CI (VCP 0x10). delta in %, returns "levels" joined by comma; empty when none answers. */
	public static string ExternalBrightness(int delta) {
		List<string> res = new List<string>();
		EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, delegate (IntPtr hmon, IntPtr hdc, IntPtr rect, IntPtr data) {
			uint n; if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, out n) || n == 0) return true;
			PHYSICAL_MONITOR[] arr = new PHYSICAL_MONITOR[n];
			if (!GetPhysicalMonitorsFromHMONITOR(hmon, n, arr)) return true;
			foreach (PHYSICAL_MONITOR m in arr) {
				uint cur, max; if (!GetVCPFeatureAndVCPFeatureReply(m.h, 0x10, IntPtr.Zero, out cur, out max) || max == 0) continue;
				int next = (int)Math.Max(0, Math.Min(max, cur + delta * (int)max / 100));
				if (delta != 0) SetVCPFeature(m.h, 0x10, (uint)next);
				res.Add(((int)Math.Round(next * 100.0 / max)).ToString());
			}
			DestroyPhysicalMonitors(n, arr); return true;
		}, IntPtr.Zero);
		return string.Join(",", res.ToArray());
	}

	[DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out WtRect r);
	[DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
	[DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
	[StructLayout(LayoutKind.Sequential)] public struct WtRect { public int L, T, R, B; }
	/** Screens ordered left to right (then top to bottom) — the same numbering as the keys. */
	static System.Windows.Forms.Screen[] Ordered() {
		List<System.Windows.Forms.Screen> list = new List<System.Windows.Forms.Screen>(System.Windows.Forms.Screen.AllScreens);
		list.Sort(delegate (System.Windows.Forms.Screen a, System.Windows.Forms.Screen b) { int c = a.Bounds.X.CompareTo(b.Bounds.X); return c != 0 ? c : a.Bounds.Y.CompareTo(b.Bounds.Y); });
		return list.ToArray();
	}
	/** Move the active window to screen n (1-based), keeping its relative position and maximized state. Returns "from,to". */
	public static string MoveActiveTo(int n) {
		IntPtr h = GetForegroundWindow(); if (h == IntPtr.Zero || IsProtected(ForegroundName())) throw new Exception("No app window is active");
		System.Windows.Forms.Screen[] all = Ordered();
		if (n < 1 || n > all.Length) throw new Exception("Screen " + n + " is not connected");
		System.Windows.Forms.Screen from = System.Windows.Forms.Screen.FromHandle(h), to = all[n - 1];
		int fromIndex = Array.IndexOf(all, from) + 1; if (fromIndex < 1) { for (int i = 0; i < all.Length; i++) if (all[i].DeviceName == from.DeviceName) fromIndex = i + 1; }
		bool max = IsZoomed(h); if (max) ShowWindow(h, 9);
		WtRect r; GetWindowRect(h, out r);
		System.Drawing.Rectangle a = from.WorkingArea, b = to.WorkingArea;
		int w = Math.Min(r.R - r.L, b.Width), hh = Math.Min(r.B - r.T, b.Height);
		int x = b.X + (int)((r.L - a.X) * (double)b.Width / Math.Max(1, a.Width)), y = b.Y + (int)((r.T - a.Y) * (double)b.Height / Math.Max(1, a.Height));
		x = Math.Max(b.X, Math.Min(x, b.Right - w)); y = Math.Max(b.Y, Math.Min(y, b.Bottom - hh));
		SetWindowPos(h, IntPtr.Zero, x, y, w, hh, 0x0004 | 0x0010);
		if (max) ShowWindow(h, 3);
		return fromIndex + "," + n;
	}

	// ---- system stats: counters stay open in this process, so each reading is instant ----
	static PerformanceCounter cpu, diskIo;
	static List<PerformanceCounter> netIn = new List<PerformanceCounter>(), netOut = new List<PerformanceCounter>(), gpu = new List<PerformanceCounter>();
	static DateTime gpuListed = DateTime.MinValue;
	static void Open() {
		if (cpu != null) return;
		cpu = new PerformanceCounter("Processor", "% Processor Time", "_Total"); cpu.NextValue();
		try { diskIo = new PerformanceCounter("PhysicalDisk", "Disk Bytes/sec", "_Total"); diskIo.NextValue(); } catch { }
		try {
			foreach (string inst in new PerformanceCounterCategory("Network Interface").GetInstanceNames()) {
				if (inst.ToLowerInvariant().Contains("loopback") || inst.ToLowerInvariant().Contains("isatap")) continue;
				PerformanceCounter a = new PerformanceCounter("Network Interface", "Bytes Received/sec", inst); a.NextValue(); netIn.Add(a);
				PerformanceCounter b = new PerformanceCounter("Network Interface", "Bytes Sent/sec", inst); b.NextValue(); netOut.Add(b);
			}
		} catch { }
	}
	static void ListGpu() {
		if ((DateTime.Now - gpuListed).TotalSeconds < 30) return;
		gpuListed = DateTime.Now; foreach (PerformanceCounter c in gpu) c.Dispose(); gpu.Clear();
		try {
			foreach (string inst in new PerformanceCounterCategory("GPU Engine").GetInstanceNames()) {
				if (!inst.Contains("engtype_3D")) continue;
				PerformanceCounter c = new PerformanceCounter("GPU Engine", "Utilization Percentage", inst); c.NextValue(); gpu.Add(c);
			}
		} catch { }
	}
	static float Sum(List<PerformanceCounter> list) { float s = 0; foreach (PerformanceCounter c in list) { try { s += c.NextValue(); } catch { } } return s; }
	/** "cpu,gpu,diskBytesPerSec,netInBytesPerSec,netOutBytesPerSec,processCount". */
	public static string Stats() {
		Open(); ListGpu();
		float c = cpu.NextValue(), d = 0; if (diskIo != null) d = diskIo.NextValue();
		float g = Math.Min(100f, Sum(gpu));
		return string.Format(System.Globalization.CultureInfo.InvariantCulture, "{0:0.0},{1:0.0},{2:0},{3:0},{4:0},{5}", c, g, d, Sum(netIn), Sum(netOut), Process.GetProcesses().Length);
	}
	static Dictionary<int, TimeSpan> lastCpu = new Dictionary<int, TimeSpan>(); static DateTime lastTop = DateTime.MinValue;
	/** Busiest app since the previous call: "name,percent". */
	public static string TopApp() {
		DateTime now = DateTime.Now; double span = (now - lastTop).TotalMilliseconds; lastTop = now;
		Dictionary<string, double> byName = new Dictionary<string, double>(); Dictionary<int, TimeSpan> seen = new Dictionary<int, TimeSpan>();
		foreach (Process p in Process.GetProcesses()) {
			try {
				TimeSpan t = p.TotalProcessorTime; seen[p.Id] = t; TimeSpan prev;
				if (p.Id == 0 || !lastCpu.TryGetValue(p.Id, out prev)) continue;
				double v = (t - prev).TotalMilliseconds; string n = p.ProcessName;
				byName[n] = (byName.ContainsKey(n) ? byName[n] : 0) + v;
			} catch { }
		}
		lastCpu = seen; string best = ""; double bv = 0;
		foreach (KeyValuePair<string, double> kv in byName) if (kv.Value > bv && kv.Key.ToLowerInvariant() != "idle") { bv = kv.Value; best = kv.Key; }
		double pct = span > 0 && span < 60000 ? bv / span / Environment.ProcessorCount * 100 : 0;
		return best + "," + Math.Round(Math.Min(100, pct)).ToString();
	}
}
'@
$script:fxReady = $false
function Ensure-Fx { if (-not $script:fxReady) { Add-Type -TypeDefinition $fxSrc -ReferencedAssemblies System.Windows.Forms, System.Drawing; $script:fxReady = $true } }

$reader = [Console]::In
while ($true) {
	$line = $reader.ReadLine()
	if ($null -eq $line) { break }
	$p = $line.Split([char]9)
	$id = $p[0]
	$a = @($p | Select-Object -Skip 2 | ForEach-Object { D $_ })
	$status = 'ok'; $msg = ''
	try {
		switch ($p[1]) {
			'ping' { $msg = 'pong' }
			'secret-protect' { if ($a[0].Length -gt 4096) { throw 'Password too long.' }; $msg = Protect-Password $a[0] $a[1] }
			'secret-unprotect' { if ($a[0].Length -gt 32768) { throw 'Password data too long.' }; $msg = Unprotect-Password $a[0] $a[1] }
			'warm' { $null = Get-Apps $true; $msg = [string]$script:apps.Count + ' apps'; try { Ensure-Native } catch { $msg += ' (native helpers unavailable: ' + $_.Exception.Message + ')' } }
			'snap' { Ensure-Native; $script:snap = [WinToolkitWin]::Snapshot(); $script:fg = [WinToolkitWin]::Foreground(); $msg = [string]$script:snap.Count }
			'place' {
				Ensure-Native
				[WinToolkitWin]::PlaceAsync([long[]]$script:snap, [long]$script:fg, [int]$a[0], $a[1], [int]$a[2])
				$msg = 'placing on monitor ' + ([int]$a[0] + 1)
			}
			'sendto' {
				# a[0] = process names ("Code|Code - Insiders"), a[1] = JSON steps [{k:"^+p"},{w:200},{t:"Git: Push"}]
				Ensure-Native
				if ($a[0] -and -not [WinToolkitWin]::Activate($a[0])) { $status = 'miss'; $msg = 'not running: ' + $a[0]; break }
				$sh = Shell
				$first = $true
				foreach ($st in @(ConvertFrom-Json $a[1])) {
					if ($first -and $a[0]) { Start-Sleep -Milliseconds 90 }
					$first = $false
					if ($st.w) { Start-Sleep -Milliseconds ([int]$st.w) }
					if ($st.k) { $sh.SendKeys([string]$st.k) }
					if ($st.t) { $sh.SendKeys((SK-Escape ([string]$st.t))) }
				}
				$msg = 'sent'
			}
			'watchfg' { Ensure-Native; [WinToolkitWin]::WatchForeground(250); $msg = 'watching' }
			'monitors' { Ensure-Native; $msg = [WinToolkitWin]::Describe($a[0]) }
			'mlist' { Ensure-Native; $msg = [WinToolkitDisplay]::List() }
			'moff' { Ensure-Native; $msg = [WinToolkitDisplay]::Off($a[0], ($a[1] -eq '1')) }
			'mon' {
				# a[0] = screen key, a[1] = wake 1/0, a[2] = the Windows number it had before (0 = unknown)
				Ensure-Native
				$prefer = 0; if ($a.Count -gt 2 -and $a[2]) { $prefer = [int]$a[2] }
				try { $msg = [WinToolkitDisplay]::On($a[0], ($a[1] -eq '1'), $prefer) }
				catch {
					$e = $_.Exception; if ($e.InnerException) { $e = $e.InnerException }
					if ($e.Message -notmatch 'refused') { throw $e.Message }
					# Windows refused the exact layout. Last resort: "Extend" (every connected screen on), then switch the others back off.
					$offBefore = @([WinToolkitDisplay]::OffKeys())
					$code = [WinToolkitDisplay]::ExtendAll()
					if ($code -ne 0) { throw $e.Message }
					Start-Sleep -Milliseconds 1500
					foreach ($k in $offBefore) { if ($k -ne $a[0]) { try { $null = [WinToolkitDisplay]::Off($k, $false) } catch { } } }
					if (-not [WinToolkitDisplay]::IsOn($a[0])) { throw $e.Message }
					if ($a[1] -eq '1') { [WinToolkitDisplay]::WakeLater($a[0]) }
					$msg = 'on (via extend)'
				}
			}
			'shot' {
				# a[0] = area|window|all, a[1] = folder ('' = Pictures\Screenshots), a[2] = save 1/0, a[3] = clipboard 1/0
				Ensure-Native
				$folder = if ($a[1]) { X $a[1] } else { Shots-Folder }
				$save = $a[2] -ne '0'; $clip = $a[3] -ne '0'
				if ($a[0] -eq 'area') {
					$seq = [WinToolkitShot]::ClipSeq()
					try { Start-Process -FilePath 'ms-screenclip:' }
					catch { Start-Process -FilePath "$env:WINDIR\System32\SnippingTool.exe" -ArgumentList '/clip' }
					if ($save) { [WinToolkitShot]::SaveNextClipboardImage($seq, $folder, (Shots-Folder), 45000) }
					$msg = 'snipping'
				}
				elseif (@('window', 'all') -contains $a[0]) { $msg = [WinToolkitShot]::Capture($a[0], $folder, $save, $clip) }
				else { throw ('bad screenshot mode: ' + $a[0]) }
			}
			'apps' {
				$list = Get-Apps $true | Sort-Object Name -Unique | ForEach-Object { [ordered]@{ n = $_.Name; id = $_.AppID } }
				$msg = ConvertTo-Json -InputObject @($list) -Compress
			}
			'start' {
				$names = $a[0].Split('|')
				$hit = Find-App $names
				if ($null -eq $hit) { $status = 'miss'; $msg = 'Not in Start menu: ' + ($names -join ', ') }
				else { Start-AppId $hit.AppID; $msg = $hit.Name }
			}
			'appid' { Start-AppId $a[0]; $msg = $a[0] }
			'resolve' {
				$hit = Find-App ($a[0].Split('|'))
				if ($null -eq $hit) { $status = 'miss'; $msg = 'not found' } else { $msg = $hit.AppID }
			}
			'icon' {
				Ensure-Native
				$t = $a[0]
				if ($t -notmatch '^shell:') { $t = X $t; if (-not (Test-Path -LiteralPath $t)) { throw ('Not found: ' + $t) } }
				$size = 256; if ($a.Count -gt 1 -and $a[1]) { $size = [int]$a[1] }
				$msg = [WinToolkitIcon]::Png($t, $size)
			}
			'path' {
				$t = X $a[0]
				if (-not (Test-Path -LiteralPath $t)) { $status = 'miss'; $msg = 'Not found: ' + $t }
				else {
					$wd = Split-Path -Parent $t
					if ($a.Count -gt 1 -and $a[1]) { Start-Process -FilePath $t -ArgumentList $a[1] -WorkingDirectory $wd }
					else { Start-Process -FilePath $t -WorkingDirectory $wd }
					$msg = $t
				}
			}
			'cmd' {
				if ($a.Count -gt 1 -and $a[1]) { Start-Process -FilePath $a[0] -ArgumentList $a[1] } else { Start-Process -FilePath $a[0] }
				$msg = $a[0]
			}
			'url' { Start-Process -FilePath $a[0]; $msg = $a[0] }
			'folder' {
				$t = if ($a[0] -eq '::downloads') { Downloads-Path } else { X $a[0] }
				if (Test-Path -LiteralPath $t -PathType Container) { Invoke-Item -LiteralPath $t; $msg = $t }
				else { $status = 'miss'; $msg = 'Folder not found: ' + $t }
			}
			'desktop' {
				(New-Object -ComObject Shell.Application).ToggleDesktop()
				$msg = 'desktop toggled'
			}
			'vol' {
				$ch = switch ($a[0]) { 'up' { [char]175 } 'down' { [char]174 } default { [char]173 } }
				$n = [Math]::Max(1, [Math]::Min(50, [int]$a[1]))
				$w = Shell
				for ($i = 0; $i -lt $n; $i++) { $w.SendKeys([string]$ch) }
				$msg = $a[0]
			}
			'keys' {
				if (@('^c', '^v', '^x', '^z', '^a') -notcontains $a[0]) { throw ('key combo not allowed: ' + $a[0]) }
				(Shell).SendKeys($a[0]); $msg = $a[0]
			}
			'display' {
				if (@('extend', 'clone', 'internal', 'external') -notcontains $a[0]) { throw ('bad display mode: ' + $a[0]) }
				Start-Process -FilePath "$env:WINDIR\System32\DisplaySwitch.exe" -ArgumentList ('/' + $a[0]); $msg = $a[0]
			}
			'chord' {
				# a[0] = comma-separated virtual-key codes, e.g. "91,17,39" = Win+Ctrl+Right
				Ensure-Fx
				$vks = @($a[0].Split(',') | Where-Object { $_ -match '^\d{1,3}$' } | ForEach-Object { [int]$_ })
				if ($vks.Count -lt 1 -or $vks.Count -gt 5) { throw 'bad key chord' }
				[WinToolkitFx]::Chord([int[]]$vks); $msg = $a[0]
			}
			'audio' {
				Ensure-Fx
				$flow = if ($a[1] -eq 'mic') { 1 } else { 0 }
				switch ($a[0]) {
					'mute-get' { $msg = if ([WinToolkitAudio]::GetMute($flow)) { 'muted' } else { 'live' } }
					'mute-toggle' { $msg = if ([WinToolkitAudio]::ToggleMute($flow)) { 'muted' } else { 'live' } }
					'mute-set' { $msg = if ([WinToolkitAudio]::SetMute($flow, ($a[2] -eq '1'))) { 'muted' } else { 'live' } }
					'peak' { $msg = [string][WinToolkitAudio]::Peak($flow) }
					'volume' { $msg = [string][WinToolkitAudio]::GetVolume($flow) }
					'list' { $msg = [WinToolkitAudio]::List($flow) }
					'current' { $msg = [WinToolkitAudio]::Current($flow) }
					'cycle' { $msg = [WinToolkitAudio]::Cycle($flow, [string]$a[2]) }
					'set' { $msg = [WinToolkitAudio]::SetDefault([string]$a[2]) }
					'app' { $msg = [WinToolkitAudio]::App([string]$a[2], [string]$a[3], [int]$a[4]) }
					default { throw ('bad audio op: ' + $a[0]) }
				}
			}
			'fx' {
				Ensure-Fx
				switch ($a[0]) {
					'close' { $msg = [WinToolkitFx]::CloseActive() }
					'kill' { $msg = [WinToolkitFx]::KillActive() }
					'ontop' { $msg = if ([WinToolkitFx]::ToggleTopmost()) { 'on' } else { 'off' } }
					'lock' { [WinToolkitFx]::Lock(); $msg = 'locked' }
					'screensoff' { [WinToolkitFx]::ScreensOff(); $msg = 'screens off' }
					'stats' { $msg = [WinToolkitFx]::Stats() }
					'topapp' { $msg = [WinToolkitFx]::TopApp() }
					'fgname' { $msg = [WinToolkitFx]::ForegroundName() }
					'bright' {
						$d = [int]$a[1]; $levels = @()
						try {
							$wmi = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
							if ($wmi) {
								$next = [Math]::Max(0, [Math]::Min(100, [int]$wmi.CurrentBrightness + $d))
								if ($d -ne 0) { $m = Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods | Select-Object -First 1; Invoke-CimMethod -InputObject $m -MethodName WmiSetBrightness -Arguments @{ Timeout = [uint32]1; Brightness = [byte]$next } | Out-Null }
								$levels += [string]$next
							}
						} catch { }
						$ext = [WinToolkitFx]::ExternalBrightness($d); if ($ext) { $levels += $ext.Split(',') }
						if ($levels.Count -eq 0) { $status = 'miss'; $msg = 'No screen accepts brightness control (turn on DDC/CI in the monitor menu)' } else { $msg = ($levels -join ',') }
					}
					default { throw ('bad fx op: ' + $a[0]) }
				}
			}
			'power' {
				switch ($a[0]) {
					'sleep' { Add-Type -AssemblyName System.Windows.Forms; [void][System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false); $msg = 'sleep' }
					'hibernate' { Add-Type -AssemblyName System.Windows.Forms; if (-not [System.Windows.Forms.Application]::SetSuspendState('Hibernate', $false, $false)) { $status = 'miss'; $msg = 'Hibernate is turned off on this PC' } else { $msg = 'hibernate' } }
					'restart' { Start-Process -FilePath "$env:WINDIR\System32\shutdown.exe" -ArgumentList '/r /t 0' -WindowStyle Hidden; $msg = 'restart' }
					'shutdown' { Start-Process -FilePath "$env:WINDIR\System32\shutdown.exe" -ArgumentList '/s /t 0' -WindowStyle Hidden; $msg = 'shutdown' }
					'signout' { Start-Process -FilePath "$env:WINDIR\System32\shutdown.exe" -ArgumentList '/l' -WindowStyle Hidden; $msg = 'signout' }
					default { throw ('bad power op: ' + $a[0]) }
				}
			}
			'powerplan' {
				$plans = @(powercfg.exe /list | ForEach-Object { if ($_ -match '([0-9a-fA-F-]{36})\s+\((.+?)\)(\s*\*)?') { [pscustomobject]@{ Id = $Matches[1]; Name = $Matches[2]; Active = [bool]$Matches[3] } } })
				if ($plans.Count -eq 0) { throw 'No power plans found' }
				$cur = [Array]::IndexOf(@($plans | ForEach-Object { $_.Active }), $true)
				if ($a[0] -eq 'next') { $n = $plans[($cur + 1) % $plans.Count]; powercfg.exe /setactive $n.Id | Out-Null; $msg = $n.Name }
				elseif ($a[0] -eq 'set') { $n = $plans | Where-Object { $_.Name -like ('*' + $a[1] + '*') } | Select-Object -First 1; if (-not $n) { throw ('No power plan named ' + $a[1]) }; powercfg.exe /setactive $n.Id | Out-Null; $msg = $n.Name }
				else { $msg = if ($cur -ge 0) { $plans[$cur].Name } else { '' } }
			}
			'service' {
				$name = [string]$a[0]
				if ($name -notmatch '^[A-Za-z0-9_.\- ]{1,80}$') { throw 'bad service name' }
				$svc = Get-Service -Name $name -ErrorAction Stop
				Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList ('-NoProfile -Command Restart-Service -Name ''' + $svc.Name + ''' -Force')
				$msg = $svc.DisplayName
			}
			'recycle' {
				try { Clear-RecycleBin -Force -ErrorAction Stop } catch { if ($_.Exception.Message -notmatch 'cannot find|0x80070003') { throw } }
				$msg = 'emptied'
			}
			'radio' {
				Add-Type -AssemblyName System.Runtime.WindowsRuntime
				$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' })[0]
				$await = { param($op, $type) $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
				$null = [Windows.Devices.Radios.Radio, Windows.System.Devices, ContentType = WindowsRuntime]
				$null = & $await ([Windows.Devices.Radios.Radio]::RequestAccessAsync()) ([Windows.Devices.Radios.RadioAccessStatus])
				$radios = & $await ([Windows.Devices.Radios.Radio]::GetRadiosAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.Radios.Radio]])
				$pick = switch ($a[0]) { 'wifi' { @($radios | Where-Object { [string]$_.Kind -eq 'WiFi' }) } 'bluetooth' { @($radios | Where-Object { [string]$_.Kind -eq 'Bluetooth' }) } default { @($radios) } }
				if ($pick.Count -eq 0) { $status = 'miss'; $msg = 'No ' + $a[0] + ' radio on this PC'; break }
				$on = @($pick | Where-Object { [string]$_.State -eq 'On' }).Count -gt 0
				if ($a[0] -eq 'all') { $on = -not $on }  # airplane mode is ON when the radios are off
				if ($a[1] -eq 'toggle') {
					$target = if ($a[0] -eq 'all') { if ($on) { 'On' } else { 'Off' } } elseif ($on) { 'Off' } else { 'On' }
					foreach ($r in $pick) { $null = & $await ($r.SetStateAsync($target)) ([Windows.Devices.Radios.RadioAccessStatus]) }
					$on = -not $on
				}
				$msg = if ($on) { 'on' } else { 'off' }
			}
			'gamemode' {
				$k = 'HKCU:\Software\Microsoft\GameBar'
				$v = (Get-ItemProperty -Path $k -Name AutoGameModeEnabled -ErrorAction SilentlyContinue).AutoGameModeEnabled
				$on = $v -ne 0
				if ($a[0] -eq 'toggle') { if (-not (Test-Path $k)) { New-Item -Path $k -Force | Out-Null }; Set-ItemProperty -Path $k -Name AutoGameModeEnabled -Type DWord -Value ([int](-not $on)); $on = -not $on }
				$msg = if ($on) { 'on' } else { 'off' }
			}
			'wifisignal' {
				$line = netsh.exe wlan show interfaces | Where-Object { $_ -match '^\s*Signal\s*:\s*(\d+)%' } | Select-Object -First 1
				if ($line -and $line -match '(\d+)%') { $msg = $Matches[1] } else { $status = 'miss'; $msg = 'Not on Wi-Fi' }
			}
			'battery' {
				Add-Type -AssemblyName System.Windows.Forms
				$s = [System.Windows.Forms.SystemInformation]::PowerStatus
				if ([string]$s.BatteryChargeStatus -match 'NoSystemBattery') { $status = 'miss'; $msg = 'No battery' } else { $msg = [string][int]($s.BatteryLifePercent * 100) + ',' + ([string]$s.PowerLineStatus -eq 'Online') }
			}
			'pinghost' {
				$r = (New-Object System.Net.NetworkInformation.Ping).Send([string]$a[0], 900)
				if ($r.Status -eq 'Success') { $msg = [string]$r.RoundtripTime } else { $status = 'miss'; $msg = [string]$r.Status }
			}
			'port' {
				$c = New-Object System.Net.Sockets.TcpClient
				try { $ok = $c.ConnectAsync([string]$a[0], [int]$a[1]).Wait(700) -and $c.Connected } catch { $ok = $false } finally { $c.Close() }
				$msg = if ($ok) { 'up' } else { 'down' }
			}
			'clip-get' { Add-Type -AssemblyName System.Windows.Forms; $msg = [System.Windows.Forms.Clipboard]::GetText() }
			'clip-set' { Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::SetText([string]$a[0]); $msg = 'copied' }
			'type' {
				# Paste text through the clipboard (fast and layout-safe), then put the old clipboard back.
				Add-Type -AssemblyName System.Windows.Forms
				$old = $null; try { if ([System.Windows.Forms.Clipboard]::ContainsText()) { $old = [System.Windows.Forms.Clipboard]::GetText() } } catch { }
				[System.Windows.Forms.Clipboard]::SetText([string]$a[0]); Start-Sleep -Milliseconds 60
				(Shell).SendKeys('^v'); Start-Sleep -Milliseconds 250
				if ($null -ne $old) { [System.Windows.Forms.Clipboard]::SetText($old) }
				$msg = 'typed'
			}
			'run' {
				# a[0] = command line, a[1] = working folder. Returns the exit code; the window stays hidden.
				$wd = if ($a[1] -and (Test-Path -LiteralPath (X $a[1]) -PathType Container)) { X $a[1] } else { $env:USERPROFILE }
				$p = Start-Process -FilePath "$env:ComSpec" -ArgumentList ('/d /c ' + $a[0]) -WorkingDirectory $wd -WindowStyle Hidden -PassThru
				if (-not $p.WaitForExit(600000)) { $status = 'miss'; $msg = 'still running after 10 minutes' } elseif ($p.ExitCode -eq 0) { $msg = 'exit 0' } else { $status = 'miss'; $msg = 'exit ' + $p.ExitCode }
			}
			'terminal' {
				$wd = if ($a[0] -and (Test-Path -LiteralPath (X $a[0]) -PathType Container)) { X $a[0] } else { $env:USERPROFILE }
				$wt = Get-Command wt.exe -ErrorAction SilentlyContinue
				if ($wt) { Start-Process -FilePath $wt.Source -ArgumentList ('-d "' + $wd + '"') } else { Start-Process -FilePath 'powershell.exe' -WorkingDirectory $wd }
				$msg = $wd
			}
			'sound' {
				$f = X ([string]$a[0])
				if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { if ($a[0] -eq 'chime') { [System.Media.SystemSounds]::Asterisk.Play(); $msg = 'chime'; break }; $status = 'miss'; $msg = 'Sound file not found'; break }
				Add-Type -AssemblyName PresentationCore
				if (-not $script:players) { $script:players = New-Object System.Collections.ArrayList }
				$pl = New-Object System.Windows.Media.MediaPlayer; $pl.Volume = [Math]::Max(0, [Math]::Min(1, [double]$a[1] / 100)); $pl.Open([Uri]$f); $pl.Play()
				[void]$script:players.Add($pl); while ($script:players.Count -gt 6) { $script:players[0].Close(); $script:players.RemoveAt(0) }
				$msg = 'playing'
			}
			'journal' {
				$f = X ([string]$a[0]); $dir = Split-Path -Parent $f
				if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
				Add-Content -LiteralPath $f -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '  ' + [string]$a[1]) -Encoding UTF8
				$msg = $f
			}
			'movewin' { Ensure-Fx; $msg = [WinToolkitFx]::MoveActiveTo([int]$a[0]) }
			default { $status = 'err'; $msg = 'unknown command: ' + $p[1] }
		}
	}
	catch {
		$status = 'err'; $ex = $_.Exception
		if ($ex.InnerException -and $ex -is [System.Management.Automation.MethodInvocationException]) { $ex = $ex.InnerException }
		$msg = $ex.Message
		if ($p[1] -like 'secret-*') { $msg = 'The password could not be protected or opened for this Windows account.' }
	}
	[Console]::Out.WriteLine($id + [char]9 + $status + [char]9 + (E $msg))
	[Console]::Out.Flush()
	if ($p[1] -like 'secret-*') { $a = @(); $line = ''; $p = @(); $msg = '' }
}
`;
