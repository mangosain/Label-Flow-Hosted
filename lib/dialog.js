"use strict";
/**
 * Native OS folder picker, opened SERVER-side. Works because the admin UI is
 * loopback-only: whoever clicks the button is sitting at this machine, so
 * the dialog appears on their own screen. Windows Explorer dialog / macOS
 * Finder chooser / zenity or kdialog on Linux.
 */

const { execFile, execFileSync } = require("node:child_process");
const os = require("node:os");

const TIMEOUT = 5 * 60 * 1000;

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        notFound: Boolean(err && err.code === "ENOENT"),
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
      });
    });
  });
}

// Prefixes the one line of output we actually care about, so a stray banner,
// profile-script echo, or PSReadLine warning on stdout can never be mistaken
// for the chosen path (we only trust a line that starts with this marker).
const WIN_MARKER = "LABELER_PICKED_FOLDER::";

// Pass the PowerShell script as -EncodedCommand (base64 UTF-16LE): the script
// contains double quotes, and Node's execFile/spawn on Windows does NOT escape
// embedded quotes in command-line args -- a raw multi-line -Command would get
// corrupted. Base64 has no shell-special characters, so this is bulletproof.
function winEncodedCommand(script) {
  return Buffer.from(script, "utf16le").toString("base64");
}

// Windows: FolderBrowserDialog (a legacy common dialog) is notoriously bad at
// coming to the front when spawned from a hidden console process -- it has no
// relation to the browser that triggered it, so other windows (the browser
// included) can sit on top of it. We make a TopMost, invisible owner form and
// additionally run a timer that pins every top-level window belonging to THIS
// powershell process to HWND_TOPMOST for as long as the dialog is open, so it
// stays in front of the browser. The owner form's MainWindowHandle is only
// valid after ShowDialog starts its modal loop, hence the pin-on-timer.
const winScript = (title) => `
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms | Out-Null
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class LFWin32 {
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  public static void PinMyWindows(uint myPid) {
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_SHOWWINDOW = 0x0040;
    IntPtr HWND_TOPMOST = new IntPtr(-1);
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (pid == myPid) SetWindowPos(h, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
      return true;
    }, IntPtr.Zero);
  }
}
"@
$owner = New-Object System.Windows.Forms.Form -Property @{ ShowInTaskbar = $false; Width = 0; Height = 0; Opacity = 0; TopMost = $true }
$owner.Show()
$owner.Activate()
$d = New-Object System.Windows.Forms.FolderBrowserDialog
$d.Description = '${String(title).replace(/'/g, "''")}'
$myPid = [System.Diagnostics.Process]::GetCurrentProcess().Id
[LFWin32]::PinMyWindows($myPid) | Out-Null
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 150
$timer.Add_Tick({ [LFWin32]::PinMyWindows($myPid) | Out-Null })
$timer.Start()
try {
  $result = $d.ShowDialog($owner)
} finally {
  $timer.Stop()
  $timer.Dispose()
  $owner.Dispose()
}
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.WriteLine('${WIN_MARKER}' + $d.SelectedPath) }
`.trim();

// macOS: A bare `choose folder` belongs to whatever process context is
// running this script -- osascript itself has no Dock presence or frontmost
// status, so without intervention the dialog can open BEHIND every other
// window instead of on top of them. We first activate the frontmost
// application (the browser that sent the request), wait for it to come
// forward, then open the dialog so the OS places it above that window.
const macScript = (title) => `
tell application "System Events"
  set frontApp to name of first application process whose frontmost is true
  activate frontApp
end tell
delay 0.3
POSIX path of (choose folder with prompt "${String(title).replace(/"/g, '\\"')}")
`.trim();

// Linux helper: try to get the active X11 window ID for --attach
function getActiveWinId() {
  try {
    const out = execFileSync("xdotool", ["getactivewindow"], { timeout: 3000, encoding: "utf8" });
    return out.trim();
  } catch { return null; }
}

/**
 * @param {string} [title] Prompt text -- reused for both the dataset folder
 *   and the (optional) annotations folder picker, so the dialog always says
 *   which one you're choosing.
 * @returns {Promise<{status:"selected",path:string}|{status:"cancelled"}|{status:"unavailable",message:string}>}
 */
async function pickFolder(title = "Select a dataset folder") {
  if (process.platform === "win32") {
    // Windows PowerShell (powershell.exe, ships with every Windows install)
    // is tried first; PowerShell 7+ (pwsh.exe) is a fallback for machines
    // where Windows PowerShell has been removed/disabled.
    let r = await run("powershell.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", winEncodedCommand(winScript(title))]);
    if (r.notFound) r = await run("pwsh.exe", ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-EncodedCommand", winEncodedCommand(winScript(title))]);
    if (r.notFound) return { status: "unavailable", message: "PowerShell not found (tried powershell.exe and pwsh.exe)." };
    if (!r.ok) return { status: "unavailable", message: "Could not open the Windows folder dialog." };
    const line = r.stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(WIN_MARKER));
    if (!line) return { status: "cancelled" };
    const p = line.slice(WIN_MARKER.length).trim();
    return p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  if (process.platform === "darwin") {
    const r = await run("osascript", ["-e", macScript(title)]);
    if (r.notFound) return { status: "unavailable", message: "osascript not found." };
    if (!r.ok) return /cancel/i.test(r.stderr) ? { status: "cancelled" } : { status: "unavailable", message: "Could not open the folder dialog." };
    const p = r.stdout.trim().replace(/\/$/, "");
    return p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  // Try to get active X11 window so the dialog opens on top of the browser
  const winId = getActiveWinId();
  const attach = winId ? [`--attach=${winId}`] : [];
  const zArgs = ["--file-selection", "--directory", "--modal", `--title=${title}`, ...attach];
  const z = await run("zenity", zArgs);
  if (!z.notFound) {
    const p = z.stdout.trim();
    return z.ok && p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  const kArgs = ["--getexistingdirectory", os.homedir(), `--title=${title}`];
  if (winId) kArgs.push(`--attach=${winId}`);
  const k = await run("kdialog", kArgs);
  if (!k.notFound) {
    const p = k.stdout.trim();
    return k.ok && p ? { status: "selected", path: p } : { status: "cancelled" };
  }
  return { status: "unavailable", message: "No graphical folder picker available (headless, or zenity/kdialog missing)." };
}

module.exports = { pickFolder };
