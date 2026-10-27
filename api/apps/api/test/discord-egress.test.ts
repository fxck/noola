import http from "node:http";
import net from "node:net";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { REST, RateLimitError } from "discord.js";
import { WebSocketManager } from "@discordjs/ws";
import { parseDiscordProxy, proxiedMakeRequest, type DiscordEgress } from "../src/discord-egress.js";
import { failFastOnLongRateLimit, gatewayStrategy, loginRetryDelayMs } from "../src/discord-gateway.js";

// Discord egress through a proxy (discord-egress.ts). Runs a local HTTP CONNECT proxy and a local SOCKS5
// proxy with password auth in front of a local target, then proves REST (incl. a multipart upload), the
// fail-fast rule on a Cloudflare-style 429 and the gateway websocket all go through the proxy. No DB.

let failures = 0;
function check(name: string, cond: boolean, got?: unknown) {
  if (cond) console.log(`  PASS  ${name}`);
  else {
    failures++;
    console.error(`  FAIL  ${name}${got !== undefined ? ` — got: ${JSON.stringify(got)}` : ""}`);
  }
}

const USER = "noola";
const PASS = "s3cr3t:p@ss";
const quietLog = { info: () => {}, warn: () => {}, error: () => {} };

function listen(server: net.Server, host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve) => server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port)));
}

function connectTarget(host: string, port: number): net.Socket {
  return net.connect(port, host === "localhost" ? "127.0.0.1" : host);
}

/** The target stands in for discord.com: JSON routes, a Cloudflare-style 429 and a websocket upgrade. */
interface TargetRequest { method: string; url: string; contentType: string; body: string }
function targetServer() {
  const requests: TargetRequest[] = [];
  const upgrades: string[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", contentType: String(req.headers["content-type"] ?? ""), body: Buffer.concat(chunks).toString() });
      if (req.url?.endsWith("/banned")) {
        // Cloudflare's ban carries only Retry-After: no X-RateLimit-* bucket headers and no retry_after in the body.
        res.writeHead(429, { "content-type": "text/plain", "retry-after": "3600", server: "cloudflare" });
        res.end("You are being blocked from accessing our API temporarily due to exceeding global rate limits.");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  server.on("upgrade", (req, socket) => {
    upgrades.push(req.url ?? "");
    socket.destroy();
  });
  return { server, requests, upgrades };
}

function httpConnectProxy() {
  const seen = { auth: [] as string[], targets: [] as string[] };
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  server.on("connect", (req, client: net.Socket, head) => {
    seen.auth.push(String(req.headers["proxy-authorization"] ?? ""));
    seen.targets.push(req.url ?? "");
    const [host, port] = (req.url ?? "").split(":");
    const upstream = connectTarget(host, Number(port));
    upstream.on("connect", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { server, seen };
}

/** Minimal SOCKS5 (RFC 1928) with username/password auth (RFC 1929), CONNECT only. */
function socks5Proxy() {
  const seen = { auth: [] as string[], targets: [] as string[] };
  const server = net.createServer((client) => {
    client.on("error", () => {});
    client.once("data", (greeting) => {
      if (![...greeting.subarray(2)].includes(0x02)) return void client.end(Buffer.from([5, 0xff]));
      client.write(Buffer.from([5, 0x02]));
      client.once("data", (auth) => {
        const ulen = auth[1];
        const user = auth.subarray(2, 2 + ulen).toString();
        const plen = auth[2 + ulen];
        const pass = auth.subarray(3 + ulen, 3 + ulen + plen).toString();
        seen.auth.push(`${user}:${pass}`);
        const ok = user === USER && pass === PASS;
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) return void client.end();
        client.once("data", (req) => {
          const atyp = req[3];
          let host: string;
          let end: number;
          if (atyp === 0x03) {
            host = req.subarray(5, 5 + req[4]).toString();
            end = 5 + req[4];
            seen.targets.push(`domain:${host}`);
          } else {
            host = [...req.subarray(4, 8)].join(".");
            end = 8;
            seen.targets.push(`ip:${host}`);
          }
          const upstream = connectTarget(host, req.readUInt16BE(end));
          upstream.on("connect", () => {
            client.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
            const extra = req.subarray(end + 2);
            if (extra.length) upstream.write(extra);
            upstream.pipe(client);
            client.pipe(upstream);
          });
          upstream.on("error", () => client.destroy());
        });
      });
    });
  });
  return { server, seen };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return cond();
}

/** REST, the fail-fast rule and the gateway, through one proxy. `seen` is that proxy's record. */
async function exerciseProxy(kind: string, egress: DiscordEgress, seen: { auth: string[]; targets: string[] }, target: ReturnType<typeof targetServer>, targetPort: number) {
  const rest = new REST({
    api: `http://localhost:${targetPort}/api`,
    makeRequest: proxiedMakeRequest(egress.dispatcher),
    rejectOnRateLimit: (d) => failFastOnLongRateLimit(d, quietLog),
    retries: 0,
  }).setToken("test-token");

  const before = seen.targets.length;
  const got = (await rest.get("/gateway")) as { ok?: boolean };
  check(`${kind}: REST GET reaches the target`, got.ok === true);
  check(`${kind}: REST GET went through the proxy`, seen.targets.length > before && seen.targets.at(-1)!.includes("localhost"), seen.targets);

  await rest.post("/channels/1/messages", { body: { content: "hi" }, files: [{ name: "shot.png", data: Buffer.from("FILEBYTES-123") }] });
  const upload = target.requests.at(-1)!;
  check(`${kind}: multipart upload arrives intact`, upload.contentType.startsWith("multipart/form-data") && upload.body.includes("FILEBYTES-123") && upload.body.includes("shot.png"), upload.contentType);

  const t0 = Date.now();
  let rejected: unknown = null;
  try {
    await rest.get("/banned");
  } catch (e) {
    rejected = e;
  }
  check(`${kind}: an hour-long Cloudflare 429 rejects instead of waiting`, rejected instanceof RateLimitError && Date.now() - t0 < 5000, String(rejected));

  // Each run gets its own gateway path, so a socket from another run can't satisfy these checks.
  const gatewayPath = `/gw-${kind.replace(/\W+/g, "-")}`;
  const manager = new WebSocketManager({
    token: "test-token",
    intents: 0,
    rest: {
      get: async () => ({ url: `ws://localhost:${targetPort}${gatewayPath}`, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } }),
    } as never,
    buildStrategy: gatewayStrategy(egress.gatewayAgent),
  });
  // A shard that can't reach the proxy emits 'error'. Without a listener that crashes the run instead of failing a check.
  manager.on("error" as never, () => {});
  const viaProxyBefore = seen.targets.length;
  const ours = () => target.upgrades.filter((u) => u.startsWith(`${gatewayPath}?`) && u.includes("v=10"));
  void manager.connect().catch(() => {});
  const upgraded = await waitFor(() => ours().length > 0);
  check(`${kind}: the gateway socket reaches the target`, upgraded, target.upgrades);
  check(`${kind}: the gateway socket went through the proxy`, seen.targets.length > viaProxyBefore, seen.targets);
  await manager.destroy().catch(() => {});
}

async function main() {
  // Shard reconnect attempts after destroy() may reject on their own. They don't affect the checks.
  process.on("unhandledRejection", () => {});

  // ── parsing ──
  check("unset → direct", parseDiscordProxy(undefined) === null);
  check("empty → direct", parseDiscordProxy("") === null);
  check("whitespace → direct", parseDiscordProxy("   ") === null);
  const secret = "hunter2-very-secret";
  const errorOf = (raw: string) => {
    try {
      parseDiscordProxy(raw);
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const badScheme = errorOf(`ftp://u:${secret}@proxy.example:21`);
  check("unsupported scheme throws", badScheme.includes("not supported"), badScheme);
  check("the error never contains the password", !badScheme.includes(secret) && !errorOf(`socks5://u:${secret}@[bad`).includes(secret));
  const socks = parseDiscordProxy(` socks5://u:${secret}@[2001:db8::1] `)!;
  check("socks5 with an IPv6 host and a stray space parses", socks !== null);
  check("socks label shows the default port, no credentials", socks.label === "socks5://[2001:db8::1]:1080", socks.label);
  const httpProxy = parseDiscordProxy(`http://u:${secret}@proxy.example:3128`)!;
  check("http label has no credentials", httpProxy.label === "http://proxy.example:3128", httpProxy.label);

  // ── the patched gateway socket ──
  // Resolved from discord.js itself, so a nested unpatched copy under discord.js would fail this.
  const fromDiscordJs = createRequire(createRequire(import.meta.url).resolve("discord.js"));
  const wsEntry = fromDiscordJs.resolve("@discordjs/ws");
  for (const file of [wsEntry, wsEntry.replace(/index\.js$/, "index.mjs")]) {
    check(`@discordjs/ws patch applied (${file.split("/").pop()})`, readFileSync(file, "utf8").includes("agent: this.strategy.options.agent"));
  }

  // ── the fail-fast rule ──
  const limit = (over: Partial<Parameters<typeof failFastOnLongRateLimit>[0]>) =>
    failFastOnLongRateLimit({ global: false, method: "get", url: "", route: "/x", majorParameter: "global", hash: "", limit: 1, timeToReset: 0, retryAfter: 0, sublimitTimeout: 0, scope: "user", ...over }, quietLog);
  check("a short Discord limit waits", limit({ retryAfter: 2_000, timeToReset: 2_000 }) === false);
  check("a long sublimit fails fast", limit({ sublimitTimeout: 3_600_000 }) === true);
  check("a long bucket reset fails fast", limit({ timeToReset: 60_000 }) === true);

  // ── login retry ──
  const plain = new Error("ECONNRESET");
  check("login retry starts at 30 s", loginRetryDelayMs(1, plain) === 30_000);
  check("login retry doubles", loginRetryDelayMs(3, plain) === 120_000);
  check("login retry caps at 10 min", loginRetryDelayMs(10, plain) === 600_000);
  const banned = new RateLimitError({ global: false, method: "get", url: "", route: "/gateway/bot", majorParameter: "global", hash: "", limit: 1, timeToReset: 0, retryAfter: 3_600_000, sublimitTimeout: 3_600_000, scope: "user" });
  check("a banned login waits out the ban", loginRetryDelayMs(1, banned) === 3_600_000);
  const absurd = new RateLimitError({ global: false, method: "get", url: "", route: "/x", majorParameter: "global", hash: "", limit: 1, timeToReset: 0, retryAfter: 9e10, sublimitTimeout: 0, scope: "user" });
  check("the login retry delay is capped at an hour", loginRetryDelayMs(1, absurd) === 3_600_000);

  // ── end to end through both proxy kinds ──
  const target = targetServer();
  const targetPort = await listen(target.server);

  const connect = httpConnectProxy();
  const connectPort = await listen(connect.server);
  const viaHttp = parseDiscordProxy(`http://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${connectPort}`)!;
  await exerciseProxy("http", viaHttp, connect.seen, target, targetPort);
  const basic = `Basic ${Buffer.from(`${USER}:${PASS}`).toString("base64")}`;
  check("http: every tunnel authenticated with the proxy credentials", connect.seen.auth.length > 0 && connect.seen.auth.every((a) => a === basic), connect.seen.auth);

  const socksProxy = socks5Proxy();
  const socksPort = await listen(socksProxy.server);
  const viaSocks = parseDiscordProxy(`socks5://${USER}:${encodeURIComponent(PASS)}@127.0.0.1:${socksPort}`)!;
  await exerciseProxy("socks5", viaSocks, socksProxy.seen, target, targetPort);
  check("socks5: every connection authenticated", socksProxy.seen.auth.length > 0 && socksProxy.seen.auth.every((a) => a === `${USER}:${PASS}`), socksProxy.seen.auth);
  check("socks5: hostnames are resolved by the proxy", socksProxy.seen.targets.every((t) => t === "domain:localhost"), socksProxy.seen.targets);

  // The proxy is reached over IPv6 on Zerops, so the bracketed host must work for every path, the gateway included.
  const socksV6 = socks5Proxy();
  const socksV6Port = await listen(socksV6.server, "::1");
  const viaSocksV6 = parseDiscordProxy(`socks5://${USER}:${encodeURIComponent(PASS)}@[::1]:${socksV6Port}`)!;
  await exerciseProxy("socks5 over IPv6", viaSocksV6, socksV6.seen, target, targetPort);

  if (failures > 0) {
    console.error(`\nDISCORD-EGRESS: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nDISCORD-EGRESS: all checks green");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
