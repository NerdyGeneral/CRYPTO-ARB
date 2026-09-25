import { spawn } from "node:child_process";
import http from "node:http";
import statusPage from "./status.html";
import { Engine } from "./engine";
import { Store, resolveDataDir } from "./store";

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

// Windows sleeps an idle PC after a few minutes, which would stop scanning. A hidden PowerShell
// helper holds a "system required" request for as long as this process lives, then exits on its own.
function keepAwake(): () => void {
  if (process.platform !== "win32" || !config.keepAwake) return () => {};
  const script = [
    "$sig = '[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'",
    "$api = Add-Type -MemberDefinition $sig -Name Power -Namespace Arbiter -PassThru",
    "$null = $api::SetThreadExecutionState([uint32]2147483649)", // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
    `while (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 20 }`,
  ].join("\n");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { stdio: "ignore", windowsHide: true });
  child.on("error", () => console.log("Could not keep the PC awake; set Windows sleep to Never while this runs."));
  return () => { child.kill(); };
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
  const path = (request.url || "/").split("?")[0];
  if (request.method === "GET" && path === "/") return send(200, "text/html; charset=utf-8", statusPage);
  if (request.method === "GET" && path === "/api/state") return send(200, "application/json", JSON.stringify(engine.state()));
  // Controls need a custom header, which a page on another site cannot send without a preflight this server never approves.
  if (request.method === "POST" && request.headers["x-arbiter"] === "1") {
    if (path === "/api/running") {
      const body = await readBody(request) as { running?: unknown };
      if (typeof body.running !== "boolean") return send(400, "application/json", '{"error":"running must be a boolean"}');
      engine.setRunning(body.running);
      console.log(`${new Date().toLocaleTimeString()}  Paper bot ${body.running ? "resumed" : "paused"}`);
      return send(200, "application/json", JSON.stringify({ running: engine.running }));
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

server.listen(config.port, "127.0.0.1", () => {
  engine.start();
  const releaseAwake = keepAwake();
  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal}: saving paper session and stopping.`);
    engine.stop();
    releaseAwake();
    server.close();
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const) process.on(signal, () => shutdown(signal));

  const { venues, assets } = config;
  console.log([
    "",
    "  ARBITER / LIVE — paper trading engine",
    "  Simulated trades only. No orders are sent to any exchange.",
    "",
    `  Dashboard:  ${url}`,
    `  Data:       ${store.dir}`,
    `  Scanning:   ${assets.length} assets across ${venues.length} venues (${venues.join(", ")})`,
    `  Balance:    $${engine.session.balance.toFixed(2)} paper · ${engine.session.tradeCount} trades so far`,
    "",
    "  Keep this window open. Close it (or press Ctrl+C) to stop; progress is saved.",
    "  Settings live in config.json in the data folder; restart after editing it.",
    "",
  ].join("\n"));
  openBrowser();
});
