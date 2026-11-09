import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_EXPORT_LIMITS } from "../../src/app/export/export-service.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { ManagedFiles } from "../../src/infra/files/managed-files.ts";
import { DatabaseTooNewError, SqliteStore } from "../../src/infra/storage/sqlite-store.ts";
import {
  COUNTER,
  type FakeHandler,
  fakeFetch,
  json,
  tempDir,
  testContainer,
  yandexApi,
} from "../helpers.ts";

const COUNTER_ID = String(COUNTER.id);
const LIMITS = { ...DEFAULT_EXPORT_LIMITS, pageSize: 5, minPageSize: 1 };
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function setup(handler: FakeHandler = yandexApi(), limits = LIMITS) {
  const dir = tempDir();
  const fetch = fakeFetch(handler);
  // The test clock is frozen, so keep the number of pages below the per-second quota.
  const c = await testContainer(dir.path, { overrides: { fetch, exportLimits: limits } });
  cleanup.push(async () => {
    await c.close();
    dir.remove();
  });
  const { connectionId } = await c.connections.save(
    { access_token: "token-aaaaaaaaaaaaaaaa", refresh_token: null, expires_at: null },
    { alias: null, kind: "token", reconnectId: null, validate: true },
  );
  return { c, fetch, connectionId, dir };
}

const base = (connectionId: string, key = "key-0000001") => ({
  connection_id: connectionId,
  counter_id: COUNTER_ID,
  metrics: ["ym:s:visits"],
  dimensions: ["ym:s:lastSignTrafficSource"],
  idempotency_key: key,
});

describe("exports (EXP-01, EXP-02)", () => {
  it("pages with 1-based offsets and publishes a verified file with a manifest (T11)", async () => {
    const { c, fetch, connectionId } = await setup();
    const job = await c.exports.create(base(connectionId));
    expect(job.state).toBe("queued");
    const done = await c.exports.settle(job.job_id);
    expect(done?.state).toBe("completed");
    const offsets = fetch.requests
      .filter((r) => r.url.pathname === "/stat/v1/data" && r.url.searchParams.get("limit") === "5")
      .map((r) => r.url.searchParams.get("offset"));
    expect(offsets).toEqual(["1", "6", "11"]);
    const view = c.exports.get(connectionId, job.job_id);
    const artifact = view.artifacts[0];
    expect(artifact?.rows).toBe(12);
    const file = readFileSync(artifact?.file_path ?? "");
    expect(createHash("sha256").update(file).digest("hex")).toBe(artifact?.sha256);
    const lines = file.toString("utf8").trim().split("\r\n");
    expect(lines[0]).toBe("ym:s:lastSignTrafficSource,ym:s:lastSignTrafficSource:id,ym:s:visits");
    expect(lines).toHaveLength(13);
    expect(new Set(lines.slice(1)).size).toBe(12);
    const manifest = JSON.parse(
      readFileSync(join(dirname(artifact?.file_path ?? ""), "manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({
      rows: 12,
      quality: { complete: true, rows_total: 12, sampled: false },
    });
  });

  it("returns the same job for a repeated key and rejects a reused key with other conditions (T28)", async () => {
    const { c, connectionId } = await setup();
    const first = await c.exports.create(base(connectionId));
    const again = await c.exports.create(base(connectionId));
    expect(again.job_id).toBe(first.job_id);
    const conflict = await c.exports
      .create({ ...base(connectionId), metrics: ["ym:s:pageviews"] })
      .catch((e: DomainError) => e);
    expect(conflict).toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await c.exports.settle(first.job_id);
  });

  it("restarts once on drift between pages, then reports partial instead of guessing (T12)", async () => {
    const api = yandexApi();
    let calls = 0;
    const { c, connectionId } = await setup(async (r) => {
      if (r.url.pathname !== "/stat/v1/data" || r.url.searchParams.get("limit") !== "5")
        return api(r);
      calls += 1;
      const body = (await (await api(r)).json()) as Record<string, unknown>;
      return json({ ...body, total_rows: calls % 2 === 0 ? 13 : 12 });
    });
    const job = await c.exports.create(base(connectionId));
    const done = await c.exports.settle(job.job_id);
    expect(done?.state).toBe("partial");
    expect(done?.drift_restarts).toBe(1);
    expect(c.exports.get(connectionId, job.job_id).artifacts).toHaveLength(0);
  });

  it("stops on a repeated page instead of de-duplicating silently", async () => {
    const api = yandexApi();
    const { c, connectionId } = await setup((r) => {
      if (r.url.pathname === "/stat/v1/data" && r.url.searchParams.get("limit") === "5") {
        r.url.searchParams.set("offset", "1");
      }
      return api(r);
    });
    const job = await c.exports.create(base(connectionId));
    const done = await c.exports.settle(job.job_id);
    expect(done).toMatchObject({ state: "failed", error_code: "UPSTREAM_SCHEMA_CHANGED" });
  });

  it("treats an early empty page as a failure, not completion", async () => {
    const api = yandexApi();
    const { c, connectionId } = await setup(async (r) => {
      const response = await api(r);
      if (r.url.pathname === "/stat/v1/data" && r.url.searchParams.get("offset") === "6") {
        const body = (await response.json()) as Record<string, unknown>;
        return json({ ...body, data: [] });
      }
      return response;
    });
    const job = await c.exports.create(base(connectionId));
    expect((await c.exports.settle(job.job_id))?.state).toBe("failed");
  });

  it("is interrupted by an outage and resumes from the checkpoint without duplicates (T24, T28)", async () => {
    const api = yandexApi();
    let outage = true;
    const { c, fetch, connectionId } = await setup((r) => {
      if (outage && r.url.searchParams.get("offset") === "6")
        return json({ message: "backend" }, 503);
      return api(r);
    });
    const job = await c.exports.create(base(connectionId));
    const interrupted = await c.exports.settle(job.job_id);
    expect(interrupted).toMatchObject({ state: "interrupted", rows_received: 5 });
    expect(c.exports.get(connectionId, job.job_id).next_action).toMatch(/resume_job_id/);
    outage = false;
    const firstPageCalls = fetch.requests.filter(
      (r) => r.url.searchParams.get("offset") === "1",
    ).length;
    await c.exports.create({ connection_id: connectionId, resume_job_id: job.job_id });
    const done = await c.exports.settle(job.job_id);
    expect(done?.state).toBe("completed");
    expect(fetch.requests.filter((r) => r.url.searchParams.get("offset") === "1").length).toBe(
      firstPageCalls,
    );
    const artifact = c.exports.get(connectionId, job.job_id).artifacts[0];
    const lines = readFileSync(artifact?.file_path ?? "", "utf8")
      .trim()
      .split("\r\n")
      .slice(1);
    expect(new Set(lines).size).toBe(12);
  });

  it("rejects mixing resume with new conditions", async () => {
    const { c, connectionId } = await setup();
    await expect(
      c.exports.create({
        connection_id: connectionId,
        resume_job_id: "job_abcdefgh",
        metrics: ["ym:s:visits"],
      }),
    ).rejects.toMatchObject({ code: "INVALID_QUERY" });
  });

  it("cancels idempotently and removes temporary parts (T29)", async () => {
    const { c, connectionId, dir } = await setup();
    const job = await c.exports.create(base(connectionId));
    await c.exports.cancel(connectionId, job.job_id);
    const again = await c.exports.cancel(connectionId, job.job_id);
    expect(again.state).toBe("cancelled");
    await c.exports.settle(job.job_id);
    expect(existsSync(join(dir.path, "jobs", job.job_id))).toBe(false);
  });

  it("disconnect cancels running exports (T22)", async () => {
    const { c, connectionId } = await setup();
    const job = await c.exports.create(base(connectionId));
    const result = await c.connections.disconnect(connectionId);
    expect(result.jobsCancelled).toBe(1);
    const final = await c.exports.settle(job.job_id);
    expect(final?.state).toBe("cancelled");
  });

  it("never shows another connection's job or file (T21)", async () => {
    const { c, connectionId } = await setup();
    const other = await c.connections.save(
      { access_token: "token-bbbbbbbbbbbbbbbb", refresh_token: null, expires_at: null },
      { alias: null, kind: "token", reconnectId: null, validate: false },
    );
    const job = await c.exports.create(base(connectionId));
    await c.exports.settle(job.job_id);
    expect(() => c.exports.get(other.connectionId, job.job_id)).toThrow(/No such export job/);
    const artifactId = c.exports.get(connectionId, job.job_id).artifacts[0]?.artifact_id ?? "";
    await expect(
      c.artifacts.read({ connection_id: other.connectionId, artifact_id: artifactId }),
    ).rejects.toMatchObject({
      code: "ARTIFACT_NOT_FOUND",
    });
  });

  it("reads files in line-aligned chunks that reassemble exactly", async () => {
    const { c, connectionId } = await setup(
      yandexApi(300, (i) => `Источник №${i} — длинное название`),
      {
        ...LIMITS,
        pageSize: 100,
      },
    );
    const job = await c.exports.create({ ...base(connectionId), format: "json" });
    await c.exports.settle(job.job_id, 60_000);
    const artifact = c.exports.get(connectionId, job.job_id).artifacts[0];
    let cursor: string | undefined;
    let text = "";
    for (let i = 0; i < 100; i++) {
      const chunk = await c.artifacts.read({
        connection_id: connectionId,
        artifact_id: artifact?.artifact_id ?? "",
        max_bytes: 4096,
        ...(cursor ? { cursor } : {}),
      });
      text += chunk.text;
      if (chunk.eof) break;
      cursor = chunk.next_cursor ?? undefined;
    }
    expect(text).toBe(readFileSync(artifact?.file_path ?? "", "utf8"));
    expect(JSON.parse(text).rows).toHaveLength(300);
  });

  it("guards spreadsheet formulas in Excel-safe CSV and keeps big integers exact in JSON (T27)", async () => {
    const api = yandexApi(3, (i) =>
      i === 0 ? '=HYPERLINK("http://evil.example","x")' : `Source ${i}`,
    );
    const { c, connectionId } = await setup(async (r) => {
      const response = await api(r);
      if (r.url.pathname !== "/stat/v1/data") return response;
      const text = (await response.text()).replace(
        /"totals":\[1000\]/,
        '"totals":[12345678901234567890]',
      );
      return new Response(text, { status: 200 });
    });
    const csv = await c.exports.create({
      ...base(connectionId, "key-csv-001"),
      format: "csv_excel_safe",
    });
    await c.exports.settle(csv.job_id);
    const csvFile = readFileSync(
      c.exports.get(connectionId, csv.job_id).artifacts[0]?.file_path ?? "",
      "utf8",
    );
    expect(csvFile.startsWith("﻿")).toBe(true);
    expect(csvFile).toMatch(/"'=HYPERLINK\(""http:\/\/evil.example"",""x""\)"/);
    const js = await c.exports.create({ ...base(connectionId, "key-json-01"), format: "json" });
    await c.exports.settle(js.job_id);
    const jsonFile = readFileSync(
      c.exports.get(connectionId, js.job_id).artifacts[0]?.file_path ?? "",
      "utf8",
    );
    expect(jsonFile).toMatch(/"ym:s:visits":"12345678901234567890"/);
  });

  it("marks jobs abandoned by a crashed process as interrupted on startup (T28)", async () => {
    const { c, connectionId, dir } = await setup();
    const job = await c.exports.create(base(connectionId));
    await c.exports.settle(job.job_id);
    const store = await SqliteStore.open(join(dir.path, "state.sqlite"));
    store.updateJob(job.job_id, {
      state: "running",
      lease_owner: "w_dead",
      lease_expires_at: "2000-01-01T00:00:00.000Z",
    });
    store.close();
    await c.exports.startup();
    expect(c.exports.get(connectionId, job.job_id).state).toBe("interrupted");
  });
});

describe("managed storage safety (T30, T31)", () => {
  it("never resolves paths outside the managed directory", () => {
    const dir = tempDir();
    cleanup.push(async () => dir.remove());
    const files = new ManagedFiles(join(dir.path, "jobs"), join(dir.path, "artifacts"));
    for (const bad of [
      "../secrets.json/x",
      "art_abcdefgh/../../x",
      "art_abcdefgh/..",
      "/etc/passwd",
      "art_ABC/x",
    ]) {
      expect(() => files.absolutePath(bad)).toThrow(DomainError);
    }
  });

  it("refuses to open a database written by a newer version", async () => {
    const dir = tempDir();
    cleanup.push(async () => dir.remove());
    const file = join(dir.path, "state.sqlite");
    const store = await SqliteStore.open(file);
    store.close();
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file);
    db.prepare("UPDATE meta SET value = '99' WHERE key = 'schema_version'").run();
    db.close();
    await expect(SqliteStore.open(file)).rejects.toBeInstanceOf(DatabaseTooNewError);
  });
});
