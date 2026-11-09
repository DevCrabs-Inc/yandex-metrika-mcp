import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { Clock, Sleep } from "../src/app/ports.ts";
import type { AppConfig } from "../src/config/load.ts";
import { type Container, type ContainerOverrides, createContainer } from "../src/container.ts";
import type { FetchLike } from "../src/infra/http.ts";
import { createLogger } from "../src/infra/log/logger.ts";
import { MemorySecretStore } from "../src/infra/secrets/stores.ts";
import { createMcpServer } from "../src/mcp/server.ts";

export const NOW = new Date("2026-11-06T09:00:00Z");

export function tempDir(): { path: string; remove: () => void } {
  const path = mkdtempSync(join(tmpdir(), "ymmcp-test-"));
  return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    logLevel: "error",
    demoEnabled: true,
    dataDir,
    secretStore: "auto",
    clientId: null,
    redirectPorts: [0],
    envToken: null,
    envAllowedCounters: null,
    apiLang: "en",
    privacy: "safe",
    autoResume: false,
    ...overrides,
  };
}

export const fixedClock = (now: Date = NOW): Clock & { advance(ms: number): void } => {
  let current = now.getTime();
  return { now: () => new Date(current), advance: (ms) => (current += ms) };
};

export const instantSleep: Sleep = async (_ms, signal) => {
  if (signal?.aborted) throw signal.reason;
  await new Promise((resolve) => setImmediate(resolve));
};

export async function testContainer(
  dataDir: string,
  options: {
    config?: Partial<AppConfig>;
    overrides?: ContainerOverrides;
    logLines?: string[];
  } = {},
): Promise<Container> {
  return createContainer(testConfig(dataDir, options.config), "0.0.0-test", {
    clock: fixedClock(),
    sleep: instantSleep,
    secrets: new MemorySecretStore(),
    cursorKey: new Uint8Array(32).fill(1),
    logger: createLogger("info", (l) => options.logLines?.push(l)),
    ...options.overrides,
  });
}

/** An MCP client connected in memory to a server built from the given container. */
export async function connectClient(container: Container): Promise<Client> {
  const server = createMcpServer(container, "0.0.0-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly headers: Headers;
  readonly body: string | null;
}

export type FakeHandler = (request: RecordedRequest) => Response | Promise<Response>;

/** A fetch stand-in for api-metrika.yandex.net and oauth.yandex.ru. */
export function fakeFetch(handler: FakeHandler): FetchLike & { requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fn = async (input: string, init: RequestInit) => {
    const request: RecordedRequest = {
      method: init.method ?? "GET",
      url: new URL(input),
      headers: new Headers(init.headers),
      body: typeof init.body === "string" ? init.body : null,
    };
    requests.push(request);
    return handler(request);
  };
  return Object.assign(fn, { requests });
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

export const COUNTER = {
  id: 12345678,
  name: "Shop",
  site: "shop.example.test",
  time_zone_name: "Asia/Yekaterinburg",
  status: "Active",
  permission: "view",
};

/** A small, well-behaved Yandex API: one counter, one goal, a paged report of `rows` segments. */
export function yandexApi(rows = 12, label = (i: number) => `Source ${i}`): FakeHandler {
  return ({ url, headers }) => {
    if (!headers.get("authorization")?.startsWith("OAuth "))
      return json({ message: "no token" }, 401);
    if (url.pathname === "/management/v1/counters") return json({ rows: 1, counters: [COUNTER] });
    if (url.pathname === `/management/v1/counter/${COUNTER.id}`) return json({ counter: COUNTER });
    if (url.pathname === `/management/v1/counter/${COUNTER.id}/goals`) {
      return json({ goals: [{ id: 501, name: "Lead form", type: "form" }] });
    }
    if (url.pathname === "/stat/v1/data") {
      const metrics = (url.searchParams.get("metrics") ?? "").split(",").length;
      const values = (base: number) => Array.from({ length: metrics }, (_, j) => base - j);
      const limit = Number(url.searchParams.get("limit"));
      const offset = Number(url.searchParams.get("offset"));
      const hasDims = url.searchParams.has("dimensions");
      const data = Array.from({ length: rows }, (_, i) => ({
        dimensions: [{ id: `src${i}`, name: label(i) }],
        metrics: values(100 - i),
      }));
      return json({
        data: hasDims
          ? data.slice(offset - 1, offset - 1 + limit)
          : [{ dimensions: [], metrics: values(1000) }],
        totals: values(1000),
        total_rows: hasDims ? rows : 1,
        total_rows_rounded: false,
        sampled: false,
        sample_share: 1,
        contains_sensitive_data: false,
      });
    }
    return json({ message: "not found" }, 404);
  };
}
