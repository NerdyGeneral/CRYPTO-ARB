import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { isSea } from "node:sea";
import statusPage from "./status.html";
import { Engine } from "./engine";
import { Store, defaultConfig, resolveDataDir } from "./store";
import { settingRange, type Settings } from "../lib/market";

// An unattended run should log a stray error and keep scanning rather than exit.
for (const event of ["uncaughtException", "unhandledRejection"] as const)
  process.on(event, (error) => console.error(`${new Date().toLocaleTimeString()}  Unexpected error (still running):`, error));

const store = new Store(resolveDataDir());
const config = store.loadConfig();
const engine = new Engine(config, store);
const url = `http://127.0.0.1:${config.port}/`;
const headless = process.env.ARBITER_NO_BROWSER === "1";

function openBrowser() {
  if (headless || !config.openBrowser) return;
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]]
    : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  const child = spawn(command as string, args as string[], { stdio: "ignore", detached: true, windowsHide: true });
  child.on("error", () => { /* No browser available; the URL is printed below. */ });
  child.unref();
}

function powershell(script: string, options: { attachConsole?: boolean } = {}) {
  // A helper without its own window shares this console when there is one, so it can change its settings.
  return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "ignore", windowsHide: !options.attachConsole });
}

// One hidden PowerShell helper for two Windows problems:
//  - Clicking in a console window starts a text selection ("QuickEdit") that pauses the app writing to it,
//    which would freeze scanning until a key is pressed; the helper turns QuickEdit off for this console.
//  - Windows sleeps an idle PC after a few minutes; the helper holds a "system required" request for as long
//    as this process lives, then exits on its own.
function windowsHelper(): () => void {
  if (process.platform !== "win32") return () => {};
  const script = [
    // Any failure outside the console tweak ends the helper, so the smoke test's check that it is running
    // also proves the script compiles.
    "$ErrorActionPreference = 'Stop'",
    "$sig = @'",
    '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint esFlags);',
    '[DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);',
    '[DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr handle, out uint mode);',
    '[DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr handle, uint mode);',
    "'@",
    "$api = Add-Type -MemberDefinition $sig -Name Win32 -Namespace Arbiter -PassThru",
    // CONIN$ is this console's input, opened for GENERIC_READ | GENERIC_WRITE (written in decimal: PowerShell reads
    // 0xC0000000 as a negative Int32). Clear ENABLE_QUICK_EDIT_MODE (0x40), set ENABLE_EXTENDED_FLAGS (0x80).
    "try {",
    "  $in = $api::CreateFile('CONIN$', 3221225472, 3, [IntPtr]::Zero, 3, 0, [IntPtr]::Zero)",
    "  $mode = [uint32]0",
    "  if ($api::GetConsoleMode($in, [ref]$mode)) { $null = $api::SetConsoleMode($in, [uint32](($mode -band 0xFFBF) -bor 0x80)) }",
    "} catch {}",
    ...(config.keepAwake ? [
      "$null = $api::SetThreadExecutionState([uint32]2147483649)", // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
    ] : []),
  ].join("\n");
  const child = powershell(script, { attachConsole: Boolean(process.stdout.isTTY) });
  child.on("error", () => { if (config.keepAwake) console.log("Could not keep the PC awake; set Windows sleep to Never while this runs."); });
  return () => { child.kill(); };
}

// "Start with Windows" is a shortcut in the user's Startup folder that opens the exe minimized at sign-in.
// It is rewritten on every start so it follows the exe if the folder is moved.
const startupShortcut = process.env.APPDATA ? path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Arbiter Paper Engine.lnk") : null;
const autostartAvailable = process.platform === "win32" && isSea() && startupShortcut !== null;

function syncAutostart(enabled: boolean): Promise<boolean> {
  if (!autostartAvailable || !startupShortcut) return Promise.resolve(false);
  if (!enabled) {
    try { fs.rmSync(startupShortcut, { force: true }); } catch { /* Already gone. */ }
    return Promise.resolve(false);
  }
  const quote = (text: string) => `'${text.replace(/'/g, "''")}'`;
  const script = [
    `$link = (New-Object -ComObject WScript.Shell).CreateShortcut(${quote(startupShortcut)})`,
    `$link.TargetPath = ${quote(process.execPath)}`,
    `$link.WorkingDirectory = ${quote(path.dirname(process.execPath))}`,
    "$link.WindowStyle = 7", // minimized
    "$link.Description = 'Arbiter paper engine (simulated trades only)'",
    "$link.Save()",
  ].join("\n");
  return new Promise((resolve) => {
    const child = powershell(script);
    child.on("error", () => resolve(false));
    child.on("exit", () => resolve(fs.existsSync(startupShortcut)));
  });
}

function readBody(request: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; if (body.length > 10_000) request.destroy(); });
    request.on("end", () => { try { resolve(JSON.parse(body || "{}")); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (request, response) => {
  const send = (status: number, type: string, body: string) => {
    response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
    response.end(body);
  };
  // Only answer requests addressed to this machine by name, which defeats DNS-rebinding pages.
  const host = String(request.headers.host || "");
  if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) return send(403, "application/json", '{"error":"forbidden host"}');
  const path = (request.url || "/").split("?")[0];
  if (request.method === "GET" && path === "/") return send(200, "text/html; charset=utf-8", statusPage);
  if (request.method === "GET" && path === "/api/state") return send(200, "application/json", JSON.stringify(engine.state()));
  if (request.method === "GET" && path === "/api/config") {
    const ranges = Object.fromEntries(Object.keys(defaultConfig.settings).map((key) => [key, settingRange(key as keyof Settings)]));
    return send(200, "application/json", JSON.stringify({ config: engine.currentConfig, defaults: defaultConfig, ranges, autostartAvailable }));
  }
  // Controls need a custom header, which a page on another site cannot send without a preflight this server never approves.
  if (request.method === "POST" && request.headers["x-arbiter"] === "1") {
    if (path === "/api/running") {
      const body = await readBody(request) as { running?: unknown };
      if (typeof body.running !== "boolean") return send(400, "application/json", '{"error":"running must be a boolean"}');
      engine.setRunning(body.running);
      console.log(`${new Date().toLocaleTimeString()}  Paper bot ${body.running ? "resumed" : "paused"}`);
      return send(200, "application/json", JSON.stringify({ running: engine.running }));
    }
    if (path === "/api/config") {
      const body = await readBody(request);
      if (!body || typeof body !== "object" || Array.isArray(body)) return send(400, "application/json", '{"error":"expected an object"}');
      const before = engine.currentConfig.startWithWindows;
      const result = engine.updateConfig(body as Record<string, unknown>);
      const autostart = result.config.startWithWindows !== before ? await syncAutostart(result.config.startWithWindows) : null;
      console.log(`${new Date().toLocaleTimeString()}  Settings saved from the dashboard${result.reloadingMarkets ? "; reloading markets" : ""}` +
        (autostart === null ? "" : autostart ? "; will start when you sign in to Windows" : "; won't start with Windows"));
      return send(200, "application/json", JSON.stringify({ ...result, autostart }));
    }
    if (path === "/api/verify") {
      const body = await readBody(request) as { key?: unknown };
      if (typeof body.key !== "string") return send(400, "application/json", '{"error":"key must be a string"}');
      const verdict = await engine.verifyRoute(body.key);
      return send(verdict ? 200 : 409, "application/json", JSON.stringify(verdict ? { verdict } : { error: "Route is no longer a suspect, or a check is already running" }));
    }
    if (path === "/api/reset") {
      engine.resetSession();
      console.log(`${new Date().toLocaleTimeString()}  Paper session reset; previous logs archived`);
      return send(200, "application/json", '{"ok":true}');
    }
  }
  send(404, "application/json", '{"error":"not found"}');
});

server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    console.log(`Arbiter is already running (port ${config.port} is in use). Opening its dashboard: ${url}`);
    openBrowser();
    setTimeout(() => process.exit(0), 3000);
    return;
  }
  throw error;
});

server.listen(config.port, "127.0.0.1", async () => {
  const releaseHelper = windowsHelper();
  void syncAutostart(engine.currentConfig.startWithWindows);
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: saving paper session and stopping.`);
    engine.stop();
    releaseHelper();
    server.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => shutdown(signal));

  console.log("\n  ARBITER / LIVE — paper trading engine\n  Simulated trades only. No orders are sent to any exchange.\n\n  Finding markets on each exchange…");
  openBrowser();
  await engine.start();
  const { coins, markets, source, errors } = engine.summary;
  console.log([
    "",
    `  Dashboard:  ${url}`,
    `  Data:       ${store.dir}`,
    `  Scanning:   ${coins} coins, ${markets} order books across ${config.venues.length} exchanges (${config.venues.join(", ")})`,
    `  Routes:     cross-exchange in USD/USDT/USDC${config.triangular ? " + triangles within each exchange" : ""}`,
    ...(source !== "live" ? [`  Listings:   using ${source === "cache" ? "the last saved listings" : "the built-in coin list"} (${errors.join("; ") || "exchanges unreachable"})`] : []),
    `  Balance:    $${engine.session.balance.toFixed(2)} paper · ${engine.session.tradeCount} trades so far`,
    "",
    "  Keep this window open. Close it (or press Ctrl+C) to stop; progress is saved.",
    "  Change settings on the dashboard's Settings tab.",
    "",
  ].join("\n"));
});
