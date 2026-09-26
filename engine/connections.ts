import https from "node:https";

// One pool of kept-open HTTPS connections per exchange host. Node's fetch drops a connection after a few idle
// seconds, so a request every 30s paid for a new TCP and TLS handshake each time: measured from the cloud, a
// kept-open connection answered Bitstamp in about 21 ms and Gemini in about 48 ms, a reopened one in over 300 ms.
// Latency probes use these pools, which also keeps them open for order requests once trading is enabled.

export type Timed = { status: number; body: string; ms: number; reused: boolean };

export class Connections {
  private readonly agents = new Map<string, https.Agent>();

  private agent(host: string) {
    let agent = this.agents.get(host);
    if (!agent) {
      agent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10_000, maxSockets: 4, maxFreeSockets: 2, scheduling: "lifo" });
      this.agents.set(host, agent);
    }
    return agent;
  }

  // Times a request from sending to the last byte of the response. `reused` says whether it went over a
  // connection that was already open, i.e. whether the time is a true round trip or includes a handshake.
  request(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<Timed> {
    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const started = performance.now();
      const req = https.request(target, {
        method: init.method || "GET", agent: this.agent(target.host), timeout: init.timeoutMs ?? 5_000,
        headers: { Accept: "application/json", "User-Agent": "arbiter-live/0.1", ...init.headers, ...(init.body ? { "Content-Length": Buffer.byteLength(init.body) } : {}) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString("utf8"), ms: performance.now() - started, reused: req.reusedSocket }));
        res.on("error", reject);
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(init.body);
    });
  }

  close() { for (const agent of this.agents.values()) agent.destroy(); }
}
