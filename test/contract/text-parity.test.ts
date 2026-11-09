import type { Client } from "@modelcontextprotocol/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Container } from "../../src/container.ts";
import {
  COUNTER,
  connectClient,
  fakeFetch,
  json,
  tempDir,
  testContainer,
  yandexApi,
} from "../helpers.ts";

// Many clients pass only the text block to the model. The text is a short summary,
// never the full JSON (04), but it must carry every fact needed to state a result
// honestly: counter, exact dates and time zone, filters, quality, totals, what was
// cut and how to get more, and the warnings (T26).

type Query = {
  counter: { id: string; name: string };
  filters: { dimension: string; op: string; values: string[] }[];
};
type Period = { start: string; end: string; time_zone: string };
type Structured = Record<string, unknown> & {
  query: Query & { period?: Period; current?: Period; baseline?: Period };
  warnings: { code: string; message: string }[];
  next_cursor?: string | null;
};

const SHOP = "10000001";
const FILTER = { dimension: "ym:s:deviceCategory", op: "neq", values: ["tv"] };

let demo: { client: Client; container: Container; dir: ReturnType<typeof tempDir> };
let live: {
  client: Client;
  container: Container;
  dir: ReturnType<typeof tempDir>;
  connectionId: string;
};

beforeAll(async () => {
  const demoDir = tempDir();
  const demoContainer = await testContainer(demoDir.path);
  demo = { client: await connectClient(demoContainer), container: demoContainer, dir: demoDir };

  // A live connection whose API does not report sampling at all.
  const liveDir = tempDir();
  const api = yandexApi(3);
  const fetch = fakeFetch(async (request) => {
    const response = await api(request);
    if (request.url.pathname !== "/stat/v1/data") return response;
    const body = (await response.json()) as Record<string, unknown>;
    const { sampled: _sampled, sample_share: _share, ...rest } = body;
    return json(rest);
  });
  const liveContainer = await testContainer(liveDir.path, { overrides: { fetch } });
  const saved = await liveContainer.connections.save(
    { access_token: "token-aaaaaaaaaaaaaaaa", refresh_token: null, expires_at: null },
    { alias: null, kind: "token", reconnectId: null, validate: true },
  );
  live = {
    client: await connectClient(liveContainer),
    container: liveContainer,
    dir: liveDir,
    connectionId: saved.connectionId,
  };
});

afterAll(async () => {
  for (const env of [demo, live]) {
    await env.client.close();
    await env.container.close();
    env.dir.remove();
  }
});

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result.content)).toBeFalsy();
  const text = result.content?.find((c) => c.type === "text");
  return {
    text: text && "text" in text ? text.text : "",
    structured: result.structuredContent as Structured,
  };
}

function expectCoreFacts(text: string, s: Structured): void {
  expect(text).toContain(`counter ${s.query.counter.id}`);
  expect(text).toContain(s.query.counter.name);
  for (const period of [s.query.period, s.query.current, s.query.baseline]) {
    if (!period) continue;
    expect(text).toContain(`${period.start} – ${period.end}`);
    expect(text).toContain(period.time_zone);
  }
  for (const f of s.query.filters) {
    expect(text).toContain(`${f.dimension} ${f.op} ${f.values.join(", ")}`);
  }
  expect(text).toMatch(/Quality: /);
  for (const w of s.warnings.filter((w) => w.code !== "DEMO_DATA")) {
    expect(text).toContain(`${w.code}: `);
  }
}

describe("text summaries carry the facts of the structured result", () => {
  it("report: filters, totals, the cut reason and how to page", async () => {
    const r = await call(demo.client, "metrika_run_report", {
      connection_id: "conn_demo",
      counter_id: SHOP,
      preset: "acquisition",
      filters: [FILTER],
      limit: 2,
    });
    expectCoreFacts(r.text, r.structured);
    expect(r.text).toMatch(/^Totals: /m);
    expect(r.structured.next_cursor).toBeTruthy();
    expect(r.text).toContain("Rows were cut: page limit");
    expect(r.text).toContain("cursor=next_cursor");
  });

  it("report: says that sampling is unknown when the API is silent", async () => {
    const r = await call(live.client, "metrika_run_report", {
      connection_id: live.connectionId,
      counter_id: String(COUNTER.id),
      accuracy: "balanced",
    });
    expectCoreFacts(r.text, r.structured);
    expect(r.text).toContain("sampling unknown");
  });

  it("comparison: both periods, filters and segments beyond the preview", async () => {
    const r = await call(demo.client, "metrika_compare_periods", {
      connection_id: "conn_demo",
      counter_id: SHOP,
      metrics: ["ym:s:visits"],
      dimensions: ["ym:s:regionCity", "ym:s:deviceCategory"],
      filters: [FILTER],
      limit: 15,
    });
    expectCoreFacts(r.text, r.structured);
    const rows = (r.structured["data"] as { rows: unknown[] }).rows.length;
    expect(rows).toBeGreaterThan(10);
    expect(r.text).toContain(`(${rows - 10} more segments in structured content)`);
  });

  it("time series: filters, period totals and top-N segment cut", async () => {
    const r = await call(demo.client, "metrika_run_timeseries", {
      connection_id: "conn_demo",
      counter_id: SHOP,
      metrics: ["ym:s:visits"],
      dimensions: ["ym:s:regionCity"],
      filters: [FILTER],
      top_keys: 1,
    });
    expectCoreFacts(r.text, r.structured);
    expect(r.text).toContain("period total");
    expect(r.text).toContain("Rows were cut: only the top segments");
  });

  it("never repeats the full structured JSON in the text (04)", async () => {
    const r = await call(demo.client, "metrika_run_report", {
      connection_id: "conn_demo",
      counter_id: SHOP,
      preset: "acquisition",
    });
    expect(r.text).not.toContain(JSON.stringify(r.structured).slice(0, 200));
    expect(Buffer.byteLength(r.text)).toBeLessThan(Buffer.byteLength(JSON.stringify(r.structured)));
  });
});
