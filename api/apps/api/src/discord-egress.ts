// Discord's Cloudflare edge bans by IP, and the default Zerops egress IPv4 is shared with other projects.
// DISCORD_PROXY_URL sends all Discord traffic (REST, gateway, CDN) through a proxy with its own IP.
// Unset or empty connects directly. Supported schemes: socks5://, socks5h://, socks://, http://, https://.
import type { Agent as HttpAgent } from "node:http";
import { ProxyAgent, type Dispatcher } from "undici";
import { socksDispatcher } from "fetch-socks";
import { SocksProxyAgent } from "socks-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";

export interface DiscordEgress {
  /** For REST and CDN requests made with fetch. */
  dispatcher: Dispatcher;
  /** For the gateway websocket. */
  gatewayAgent: HttpAgent;
  /** The proxy without its credentials, safe to log. */
  label: string;
}

const SOCKS_SCHEMES = new Set(["socks:", "socks5:", "socks5h:"]);
const HTTP_SCHEMES = new Set(["http:", "https:"]);
const SOCKS_DEFAULT_PORT = 1080;

/** socks-proxy-agent keeps the brackets of an IPv6 host, and net.connect can't resolve "[2001:db8::1]". */
function socksGatewayAgent(url: URL): SocksProxyAgent {
  const agent = new SocksProxyAgent(url);
  (agent.proxy as { host: string }).host = url.hostname.replace(/^\[|\]$/g, "");
  return agent;
}

/** Errors never include the raw value, because it carries the proxy password. */
export function parseDiscordProxy(raw: string | undefined): DiscordEgress | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("DISCORD_PROXY_URL is not a valid URL");
  }
  const label = `${url.protocol}//${url.host}`;
  if (!url.hostname) throw new Error(`DISCORD_PROXY_URL has no host (${label})`);

  if (SOCKS_SCHEMES.has(url.protocol)) {
    const port = Number(url.port || SOCKS_DEFAULT_PORT);
    // The dispatcher always lets the proxy resolve hostnames. socks5h makes the gateway agent do the same.
    const agentUrl = new URL(value);
    agentUrl.protocol = "socks5h:";
    agentUrl.port = String(port);
    return {
      dispatcher: socksDispatcher({
        type: 5,
        host: url.hostname.replace(/^\[|\]$/g, ""),
        port,
        userId: url.username ? decodeURIComponent(url.username) : undefined,
        password: url.password ? decodeURIComponent(url.password) : undefined,
      }),
      gatewayAgent: socksGatewayAgent(agentUrl),
      label: `${url.protocol}//${url.hostname}:${port}`,
    };
  }
  if (HTTP_SCHEMES.has(url.protocol)) {
    return { dispatcher: new ProxyAgent(value), gatewayAgent: new HttpsProxyAgent(value), label };
  }
  throw new Error(`DISCORD_PROXY_URL scheme ${url.protocol} is not supported (${label})`);
}

let egress: DiscordEgress | null | undefined;

/** The configured Discord egress, parsed once. */
export function discordEgress(): DiscordEgress | null {
  if (egress === undefined) egress = parseDiscordProxy(process.env.DISCORD_PROXY_URL);
  return egress;
}

// The undici-types bundled with @types/node lag the undici package, so its Dispatcher type doesn't line up with fetch's.
function withDispatcher(init: RequestInit, dispatcher: Dispatcher): RequestInit {
  return { ...init, dispatcher } as unknown as RequestInit;
}

/** fetch options for a Discord request made outside discord.js, such as a CDN download. */
export function discordFetchInit(init: RequestInit = {}): RequestInit {
  const e = discordEgress();
  return e ? withDispatcher(init, e.dispatcher) : init;
}

/** discord.js REST `makeRequest` that sends every call through the proxy dispatcher. */
export function proxiedMakeRequest(dispatcher: Dispatcher) {
  return (url: string, init: RequestInit) => fetch(url, withDispatcher(init, dispatcher));
}
