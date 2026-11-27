# Screen capture helper of dsh-screen-afkllm (started hidden by index.js; Windows PowerShell 5.1, no modules).
#   -Mode once    capture the window the user was looking at before switching to Harness (the topmost app window that
#                 is not Harness) and print one JSON line
#   -Mode hotkey  register a global hotkey (-Mods/-Vk as for RegisterHotKey) and print one JSON line per press with
#                 the foreground window captured; exits when -ParentPid exits
# JSON lines: {"ready":true} | {"path","title","process","width","height","how","dark"} | {"error","detail"}
# Pictures are PNG files in -OutDir; index.js moves them into Harness' attachment store and deletes them.
param(
  [ValidateSet('once', 'hotkey')][string]$Mode = 'once',
  [int]$Mods = 0,
  [int]$Vk = 0,
  [string]$OutDir = $env:TEMP,
  [int]$ParentPid = 0,
  [string]$Skip = 'DeepSeek Harness'
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class AfkScreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MSG { public IntPtr hwnd; public uint message; public UIntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential)] public struct MONITORINFO { public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);

  [DllImport("user32.dll", SetLastError = true)] static extern bool RegisterHotKey(IntPtr h, int id, uint mods, uint vk);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint a, uint b, uint remove);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int v, int size);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MONITORINFO mi);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr h, int idx);

  static string[] skip = new string[0];
  static string outDir = ".";

  static string J(string s) {
    var sb = new StringBuilder("\"");
    foreach (char c in s ?? "") {
      if (c == '"' || c == '\\') sb.Append('\\').Append(c);
      else if (c < 0x20) sb.AppendFormat("\\u{0:x4}", (int)c);
      else sb.Append(c);
    }
    return sb.Append('"').ToString();
  }
  static void Emit(string json) { Console.Out.WriteLine(json); Console.Out.Flush(); }
  static void Error(string code, string detail) { Emit("{\"error\":" + J(code) + ",\"detail\":" + J(detail) + "}"); }

  static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, sb.Capacity); return sb.ToString(); }
  static string ProcName(IntPtr h) {
    uint pid; GetWindowThreadProcessId(h, out pid);
    try { return Process.GetProcessById((int)pid).ProcessName; } catch { return ""; }
  }
  static bool Skipped(IntPtr h) {
    string p = ProcName(h);
    foreach (var s in skip) if (string.Equals(p, s, StringComparison.OrdinalIgnoreCase)) return true;
    return false;
  }
  // the visible frame (without the invisible resize borders of Windows 10/11)
  static Rectangle Bounds(IntPtr h) {
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r);
    return Rectangle.FromLTRB(r.L, r.T, r.R, r.B);
  }
  static Rectangle Monitor(IntPtr h) {
    var mi = new MONITORINFO(); mi.cbSize = Marshal.SizeOf(typeof(MONITORINFO));
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    return Rectangle.FromLTRB(mi.rcMonitor.L, mi.rcMonitor.T, mi.rcMonitor.R, mi.rcMonitor.B);
  }
  static bool Cloaked(IntPtr h) { int v; return DwmGetWindowAttribute(h, 14, out v, 4) == 0 && v != 0; }

  // The topmost ordinary app window (z-order) that is not Harness: what the user looked at before switching over.
  static IntPtr TopWindow() {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h) || IsIconic(h) || Cloaked(h)) return true;
      if (GetWindow(h, 4) != IntPtr.Zero) return true;           // owned popups and dialogs
      if ((GetWindowLong(h, -20) & 0x80) != 0) return true;      // tool windows
      string t = Title(h);
      if (t.Length == 0 || t == "Program Manager") return true;
      var b = Bounds(h);
      if (b.Width < 200 || b.Height < 150) return true;
      if (Skipped(h)) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }

  // What is on screen over the window's area, clipped to its monitor (the whole monitor for a small window).
  static Bitmap FromScreen(IntPtr h) {
    Rectangle mon = Monitor(h);
    Rectangle r = Rectangle.Intersect(Bounds(h), mon);
    if (r.Width < 320 || r.Height < 240) r = mon;
    var bmp = new Bitmap(r.Width, r.Height, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) g.CopyFromScreen(r.Left, r.Top, 0, 0, r.Size, CopyPixelOperation.SourceCopy);
    return bmp;
  }
  // A window behind others, drawn by itself (PW_RENDERFULLCONTENT), cropped to its visible frame.
  static Bitmap FromWindow(IntPtr h) {
    RECT wr; GetWindowRect(h, out wr);
    var full = Rectangle.FromLTRB(wr.L, wr.T, wr.R, wr.B);
    var bmp = new Bitmap(full.Width, full.Height, PixelFormat.Format32bppArgb);
    using (var g = Graphics.FromImage(bmp)) {
      IntPtr dc = g.GetHdc();
      try { PrintWindow(h, dc, 2); } finally { g.ReleaseHdc(dc); }
    }
    var vis = Rectangle.Intersect(Bounds(h), full);
    if (vis.Width > 0 && vis.Height > 0 && vis != full) {
      var crop = bmp.Clone(new Rectangle(vis.Left - full.Left, vis.Top - full.Top, vis.Width, vis.Height), bmp.PixelFormat);
      bmp.Dispose();
      return crop;
    }
    return bmp;
  }
  // under 2% of sampled pixels brighter than near-black: the window gave no picture (exclusive fullscreen, DRM)
  static bool Dark(Bitmap b) {
    int bright = 0, n = 0;
    int sy = Math.Max(1, b.Height / 40), sx = Math.Max(1, b.Width / 40);
    for (int y = 0; y < b.Height; y += sy) for (int x = 0; x < b.Width; x += sx) {
      var c = b.GetPixel(x, y); n++;
      if (c.R + c.G + c.B > 30) bright++;
    }
    return bright * 50 < n;
  }

  static void Save(IntPtr h, Bitmap bmp, string how) {
    using (bmp) {
      bool dark = Dark(bmp);
      string path = Path.Combine(outDir, "screen-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".png");
      bmp.Save(path, ImageFormat.Png);
      Emit("{\"path\":" + J(path) + ",\"title\":" + J(Title(h)) + ",\"process\":" + J(ProcName(h)) +
        ",\"width\":" + bmp.Width + ",\"height\":" + bmp.Height + ",\"how\":" + J(how) + ",\"dark\":" + (dark ? "true" : "false") + "}");
    }
  }

  // /screen typed in Harness: Harness is in front, so take the window behind it. A window on another monitor is
  // taken from the screen (works for games too); one under Harness draws itself.
  static void CaptureBehind() {
    IntPtr h = TopWindow();
    if (h == IntPtr.Zero) { Error("no-window", "no visible app window besides Harness"); return; }
    IntPtr fg = GetForegroundWindow();
    bool otherMonitor = fg != IntPtr.Zero && Skipped(fg) && MonitorFromWindow(h, 2) != MonitorFromWindow(fg, 2);
    if (otherMonitor) { Save(h, FromScreen(h), "screen"); return; }
    Save(h, FromWindow(h), "window");
  }
  // the hotkey: the window in front, exactly as it is on screen; Harness in front = the window behind it
  static void CaptureForeground() {
    IntPtr fg = GetForegroundWindow();
    if (fg == IntPtr.Zero || Skipped(fg)) { CaptureBehind(); return; }
    Bitmap bmp = FromScreen(fg);
    if (Dark(bmp)) {
      Bitmap own = FromWindow(fg);
      if (!Dark(own)) { bmp.Dispose(); Save(fg, own, "window"); return; }
      own.Dispose();
    }
    Save(fg, bmp, "screen");
  }

  static void Init(string dir, string skipList) {
    try { SetProcessDpiAwarenessContext(new IntPtr(-4)); } catch { }  // physical pixels on scaled displays
    outDir = dir;
    Directory.CreateDirectory(dir);
    skip = skipList.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries);
  }

  public static void Once(string dir, string skipList) {
    Init(dir, skipList);
    try { CaptureBehind(); } catch (Exception e) { Error("capture", e.Message); }
  }

  public static void Hotkey(uint mods, uint vk, int parentPid, string dir, string skipList) {
    Init(dir, skipList);
    if (!RegisterHotKey(IntPtr.Zero, 1, mods | 0x4000, vk)) {   // MOD_NOREPEAT
      Error("hotkey", "RegisterHotKey failed, code " + Marshal.GetLastWin32Error() + " (taken by another program?)");
      return;
    }
    Emit("{\"ready\":true}");
    MSG m;
    int tick = 0;
    while (true) {
      while (PeekMessage(out m, IntPtr.Zero, 0x0312, 0x0312, 1)) {      // WM_HOTKEY, PM_REMOVE
        try { CaptureForeground(); } catch (Exception e) { Error("capture", e.Message); }
      }
      if (parentPid > 0 && ++tick % 25 == 0) {
        try { if (Process.GetProcessById(parentPid).HasExited) return; } catch { return; }
      }
      Thread.Sleep(40);
    }
  }
}
'@

if ($Mode -eq 'once') { [AfkScreen]::Once($OutDir, $Skip) }
else { [AfkScreen]::Hotkey([uint32]$Mods, [uint32]$Vk, $ParentPid, $OutDir, $Skip) }
