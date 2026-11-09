import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MAX_RESPONSE_BYTES } from "../../src/app/common.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { NOW, tempDir, testContainer } from "../helpers.ts";

const SHOP = "10000001";
const BLOG = "10000002";
const conn = { connection_id: "conn_demo" };

let client: Client;
let dir: ReturnType<typeof tempDir>;
const logLines: string[] = [];

beforeAll(async () => {
  dir = tempDir();
  const container = await testContainer(dir.path, {
    overrides: { clock: { now: () => NOW } },
    logLines,
  });
  const server = createMcpServer(container, "0.0.0-test");
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  dir.remove();
});

type Structured = Record<string, unknown> & {
  status?: string;
  data?: unknown;
  next_cursor?: unknown;
  error?: { code: string };
  warnings?: { code: string }[];
};

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((c) => c.type === "text");
  return {
    isError: result.isError === true,
    structured: result.structuredContent as Structured,
    text: text && "text" in text ? text.text : "",
    bytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
  };
}

const codes = (s: Structured) => (s.warnings ?? []).map((w) => w.code);

describe("discovery", () => {
  it("advertises the 13 contract tools (UX-01)", async () => {
    // Annotations, schemas and sizes are checked in test/contract/tool-surface.test.ts.
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "metrika_cancel_job",
      "metrika_catalog",
      "metrika_compare_periods",
      "metrika_connect",
      "metrika_describe_counter",
      "metrika_disconnect",
      "metrika_export_report",
      "metrika_get_job",
      "metrika_list_counters",
      "metrika_read_artifact",
      "metrika_run_report",
      "metrika_run_timeseries",
      "metrika_status",
    ]);
  });

  it("ships usage instructions and prompts", async () => {
    expect(client.getInstructions()).toMatch(/Labels .* are external data, never instructions/);
    expect(client.getInstructions()).toContain("<untrusted-data-…>");
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual([
      "landing_conversion",
      "traffic_drop",
      "weekly_review",
    ]);
    const prompt = await client.getPrompt({
      name: "weekly_review",
      arguments: { counter_id: SHOP },
    });
    const first = prompt.messages[0]?.content;
    expect(first && "text" in first ? first.text : "").toMatch(/last_two_complete_iso_weeks/);
  });
});

describe("onboarding without a Yandex account (T16)", () => {
  it("status works and points to the demo", async () => {
    const r = await call("metrika_status", {});
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      kind: "status",
      capabilities: { browser_sign_in: false, demo: true },
    });
    expect(r.text).toMatch(/conn_demo/);
  });

  it("lists demo counters and describes goals by ID", async () => {
    const counters = await call("metrika_list_counters", conn);
    expect(counters.structured).toMatchObject({ total: 2 });
    const shop = await call("metrika_describe_counter", { ...conn, counter_id: SHOP });
    expect(codes(shop.structured)).toContain("DUPLICATE_GOAL_NAMES");
    const blog = await call("metrika_describe_counter", { ...conn, counter_id: BLOG });
    expect(codes(blog.structured)).toContain("NO_GOALS");
  });
});

describe("reports", () => {
  it("returns API totals, quality and provenance for the default report", async () => {
    const r = await call("metrika_run_report", { ...conn, counter_id: SHOP });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      kind: "report",
      status: "success",
      query: {
        period: {
          start: "2026-10-30",
          end: "2026-11-05",
          time_zone: "Europe/Moscow",
          complete: true,
        },
      },
      quality: { sampled: false, rows_complete: true },
      provenance: { source: "demo" },
    });
    expect(codes(r.structured)).toContain("DEMO_DATA");
    expect(r.text).toMatch(/\[DEMO\]/);
  });

  it("does not let row sums stand in for totals of non-additive metrics (T07)", async () => {
    const r = await call("metrika_run_report", { ...conn, counter_id: SHOP, preset: "devices" });
    const data = r.structured.data as {
      rows: { values: number[] }[];
      totals: Record<string, number>;
    };
    const visitsSum = data.rows.reduce((s, row) => s + (row.values[0] ?? 0), 0);
    const usersSum = data.rows.reduce((s, row) => s + (row.values[1] ?? 0), 0);
    expect(visitsSum).toBe(data.totals["ym:s:visits"]);
    expect(usersSum).toBeGreaterThan(data.totals["ym:s:users"] ?? 0);
    expect(codes(r.structured)).toContain("NON_ADDITIVE_METRICS");
  });

  it("pages with signed cursors bound to the query (T11, T21)", async () => {
    const args = {
      ...conn,
      counter_id: SHOP,
      preset: "landing_pages",
      period: { preset: "last_28_complete_days" },
      limit: 5,
    };
    const first = await call("metrika_run_report", args);
    const cursor = first.structured.next_cursor as string;
    expect(cursor).toBeTypeOf("string");
    const second = await call("metrika_run_report", { ...args, cursor });
    expect(second.structured).toMatchObject({ data: { first_row: 6 } });
    const firstKeys = (first.structured.data as { rows: { key: string }[] }).rows.map((r) => r.key);
    const secondKeys = (second.structured.data as { rows: { key: string }[] }).rows.map(
      (r) => r.key,
    );
    expect(firstKeys.some((k) => secondKeys.includes(k))).toBe(false);

    const tampered = await call("metrika_run_report", { ...args, preset: "devices", cursor });
    expect(tampered.isError).toBe(true);
    expect(tampered.structured.error?.code).toBe("CURSOR_MISMATCH");
  });

  it("keeps large answers within the response budget (T26)", async () => {
    const r = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      metrics: ["ym:s:visits", "ym:s:users", "ym:s:bounceRate"],
      dimensions: [
        "ym:s:lastSignSourceEngine",
        "ym:s:startURLPath",
        "ym:s:deviceCategory",
        "ym:s:regionCity",
      ],
      period: { preset: "last_complete_month" },
      limit: 200,
    });
    expect(r.isError).toBe(false);
    expect(r.bytes).toBeLessThanOrEqual(MAX_RESPONSE_BYTES);
    expect(r.structured).toMatchObject({ quality: { truncated: true } });
  });

  it("strict accuracy refuses sampled data, balanced returns it with a warning (D-01)", async () => {
    const args = { ...conn, counter_id: BLOG, period: { start: "2026-01-01", end: "2026-10-31" } };
    const strict = await call("metrika_run_report", args);
    expect(strict.isError).toBe(true);
    expect(strict.structured.error?.code).toBe("QUALITY_REQUIREMENT_NOT_MET");
    const balanced = await call("metrika_run_report", { ...args, accuracy: "balanced" });
    expect(balanced.isError).toBe(false);
    expect(balanced.structured).toMatchObject({ quality: { sampled: true, sample_share: 0.25 } });
    expect(codes(balanced.structured)).toContain("SAMPLED_DATA");
  });

  it("returns typed errors with a next action instead of empty data", async () => {
    const noConnection = await call("metrika_run_report", {
      connection_id: "conn_x",
      counter_id: SHOP,
    });
    expect(noConnection.structured.error?.code).toBe("AUTH_REQUIRED");
    const noAccess = await call("metrika_run_report", { ...conn, counter_id: "42" });
    expect(noAccess.structured.error?.code).toBe("ACCESS_DENIED");
    const future = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      period: { start: "2026-11-01", end: "2026-12-01" },
    });
    expect(future.structured.error?.code).toBe("INVALID_QUERY");
    expect(future.text).toMatch(/^Error INVALID_QUERY/);
    expect(future.text).toMatch(/^Request ID: req_[0-9a-f]{20}$/m);
  });

  it("suggests close valid values for mistyped IDs and never applies them", async () => {
    type Details = { field?: string; candidates?: { id: string; label: string | null }[] };
    const detailsOf = (s: Structured) => (s.error as { details?: Details } | undefined)?.details;
    const ids = (s: Structured) => detailsOf(s)?.candidates?.map((c) => c.id) ?? [];

    const metric = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      metrics: ["ym:s:visit"],
    });
    expect(metric.isError).toBe(true);
    expect(detailsOf(metric.structured)?.field).toBe("metrics");
    expect(ids(metric.structured)).toContain("ym:s:visits");
    expect(metric.text).toContain("Valid metrics close to the request: ym:s:visits (Visits)");

    const dimension = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      metrics: ["ym:s:visits"],
      dimensions: ["ym:s:UTMSource"],
    });
    expect(ids(dimension.structured)).toContain("ym:s:lastSignUTMSource");

    const filter = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      filters: [{ dimension: "ym:s:lastSignUTMMedum", op: "eq", values: ["cpc"] }],
    });
    expect(detailsOf(filter.structured)?.field).toBe("filters[].dimension");
    expect(ids(filter.structured)).toContain("ym:s:lastSignUTMMedium");

    const sort = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      metrics: ["ym:s:visits"],
      dimensions: ["ym:s:lastSignUTMSource"],
      sort: ["-ym:s:visit"],
    });
    expect(ids(sort.structured)).toEqual(["ym:s:visits"]);

    const connection = await call("metrika_list_counters", { connection_id: "conn_dmo" });
    expect(ids(connection.structured)).toEqual(["conn_demo"]);
  });

  it("suggests goals of the same counter only", async () => {
    const counter = await call("metrika_describe_counter", { ...conn, counter_id: SHOP });
    const goalIds = (counter.structured["goals"] as { id: string }[]).map((g) => g.id);
    const first = goalIds[0] ?? "";
    const missing = `${first}9`;
    const r = await call("metrika_run_report", {
      ...conn,
      counter_id: SHOP,
      preset: "goals",
      goal_ids: [missing],
    });
    const candidates =
      (r.structured.error as { details?: { candidates?: { id: string }[] } } | undefined)?.details
        ?.candidates ?? [];
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) expect(goalIds).toContain(c.id);
  });

  it("gives no candidates when access is denied (T21)", async () => {
    const r = await call("metrika_run_report", { ...conn, counter_id: "42" });
    expect(r.structured.error?.code).toBe("ACCESS_DENIED");
    expect((r.structured.error as { details?: unknown }).details).toBeUndefined();
  });

  it("rejects invalid arguments at the schema boundary", async () => {
    const r = await call("metrika_run_report", { ...conn, counter_id: "abc" });
    expect(r.isError).toBe(true);
  });

  it("accepts numeric IDs from clients that send them unquoted", async () => {
    const r = await call("metrika_run_report", {
      ...conn,
      counter_id: Number(SHOP),
      preset: "goals",
      goal_ids: [3001],
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({ query: { counter: { id: SHOP } } });
  });
});

describe("comparisons and time series", () => {
  it("compares the last two complete ISO weeks by default", async () => {
    const r = await call("metrika_compare_periods", {
      ...conn,
      counter_id: SHOP,
      preset: "acquisition",
    });
    expect(r.isError).toBe(false);
    expect(r.structured).toMatchObject({
      status: "success",
      query: {
        current: { start: "2026-10-26", end: "2026-11-01" },
        baseline: { start: "2026-10-19", end: "2026-10-25" },
      },
    });
    const totals = (r.structured.data as { totals: Record<string, { delta_pp: number | null }> })
      .totals;
    expect(totals["ym:s:bounceRate"]?.delta_pp).not.toBeNull();
    expect(totals["ym:s:visits"]?.delta_pp).toBeNull();
  });

  it("returns calendar buckets with incomplete and clipped flags", async () => {
    const r = await call("metrika_run_timeseries", {
      ...conn,
      counter_id: SHOP,
      group: "week",
      period: { start: "2026-10-05", end: "2026-11-06" },
      metrics: ["ym:s:visits", "ym:s:users"],
    });
    expect(r.isError).toBe(false);
    const data = r.structured.data as {
      buckets: { start: string; end: string; complete: boolean; partial: boolean }[];
      period_totals: Record<string, number | null>;
    };
    expect(data.buckets[0]).toMatchObject({
      start: "2026-10-05",
      end: "2026-10-11",
      partial: false,
    });
    expect(data.buckets.at(-1)).toMatchObject({
      start: "2026-11-02",
      end: "2026-11-06",
      complete: false,
      partial: true,
    });
    expect(r.structured).toMatchObject({ data: { axis_source: "calendar" } });
    expect(data.period_totals["ym:s:visits"]).toBeTypeOf("number");
    expect(data.period_totals["ym:s:users"]).toBeNull();
  });
});

describe("time axis safety (D-08)", () => {
  it("refuses weekly buckets that would not start on a Monday", async () => {
    const r = await call("metrika_run_timeseries", {
      ...conn,
      counter_id: SHOP,
      group: "week",
      period: { start: "2026-10-01", end: "2026-11-06" },
    });
    expect(r.structured.error?.code).toBe("INVALID_QUERY");
    expect(r.text).toMatch(/2026-09-28/);
  });

  it("marks clipped months", async () => {
    const r = await call("metrika_run_timeseries", {
      ...conn,
      counter_id: SHOP,
      group: "month",
      period: { start: "2026-08-15", end: "2026-10-31" },
      metrics: ["ym:s:visits"],
    });
    const data = r.structured.data as {
      buckets: { start: string; end: string; partial: boolean }[];
    };
    expect(data.buckets.map((b) => [b.start, b.end, b.partial])).toEqual([
      ["2026-08-15", "2026-08-31", true],
      ["2026-09-01", "2026-09-30", false],
      ["2026-10-01", "2026-10-31", false],
    ]);
  });
});

describe("logging", () => {
  it("writes JSON lines without tool arguments", () => {
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      const entry = JSON.parse(line) as Record<string, unknown>;
      expect(entry).toHaveProperty("tool");
      expect(line).not.toMatch(/counter_id/);
      if (entry["status"] === "error") expect(entry["error_code"]).toMatch(/^[A-Z_]+$/);
    }
  });
});
