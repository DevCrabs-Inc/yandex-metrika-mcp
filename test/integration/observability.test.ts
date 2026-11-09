import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../src/container.ts";
import {
  COUNTER,
  connectClient,
  fakeFetch,
  tempDir,
  testContainer,
  yandexApi,
} from "../helpers.ts";

// Logs carry sizes and the client identity so limits can be tuned from real use,
// but never labels or counter IDs (06). The Yandex API sees which MCP client is used.

const logLines: string[] = [];
const fetch = fakeFetch(yandexApi(3, (i) => `Secret campaign ${i}`));
let container: Container;
let client: Client;
let dir: ReturnType<typeof tempDir>;
let connectionId: string;

beforeAll(async () => {
  dir = tempDir();
  container = await testContainer(dir.path, { overrides: { fetch }, logLines });
  const saved = await container.connections.save(
    { access_token: "token-aaaaaaaaaaaaaaaa", refresh_token: null, expires_at: null },
    { alias: null, kind: "token", reconnectId: null, validate: true },
  );
  connectionId = saved.connectionId;
  client = await connectClient(container);
});

afterAll(async () => {
  await client.close();
  await container.close();
  dir.remove();
});

const toolCalls = () =>
  logLines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((e) => e["msg"] === "tool call");

describe("tool call logs and User-Agent", () => {
  it("logs response size, rows and truncation without labels or counter IDs", async () => {
    await client.callTool({
      name: "metrika_run_report",
      arguments: {
        connection_id: connectionId,
        counter_id: String(COUNTER.id),
        metrics: ["ym:s:visits"],
        dimensions: ["ym:s:lastSignUTMSource"],
        limit: 2,
      },
    });
    const entry = toolCalls().find((e) => e["tool"] === "metrika_run_report");
    expect(entry).toMatchObject({
      status: "ok",
      rows_returned: 2,
      truncated: true,
      client_name: "test-client",
      client_version: "1.0.0",
    });
    expect(entry?.["response_bytes"]).toBeGreaterThan(entry?.["text_bytes"] as number);
    const raw = logLines.join("");
    expect(raw).not.toContain("Secret campaign");
    expect(raw).not.toContain(String(COUNTER.id));
  });

  it("names the MCP client in the User-Agent sent to Yandex", async () => {
    const last = fetch.requests.at(-1);
    expect(last?.headers.get("user-agent")).toBe(
      "yandex-metrika-mcp/0.0.0-test (test-client/1.0.0)",
    );
  });

  it("logs the client on errors too", async () => {
    await client.callTool({
      name: "metrika_run_report",
      arguments: { connection_id: "conn_missing", counter_id: "1" },
    });
    const entry = toolCalls().find((e) => e["status"] === "error");
    expect(entry).toMatchObject({ error_code: "AUTH_REQUIRED", client_name: "test-client" });
  });
});
