import { afterEach, describe, expect, it } from "vitest";
import type { SecretStore } from "../../src/app/ports.ts";
import type { Container } from "../../src/container.ts";
import type { DomainError } from "../../src/domain/errors.ts";
import { MemorySecretStore } from "../../src/infra/secrets/stores.ts";
import {
  COUNTER,
  fakeFetch,
  fixedClock,
  json,
  tempDir,
  testContainer,
  yandexApi,
} from "../helpers.ts";

const COUNTER_ID = String(COUNTER.id);
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

async function setup(handler = yandexApi(), secrets: SecretStore = new MemorySecretStore()) {
  const dir = tempDir();
  const fetch = fakeFetch(handler);
  const clock = fixedClock();
  const c = await testContainer(dir.path, { overrides: { fetch, secrets, clock } });
  cleanup.push(async () => {
    await c.close();
    dir.remove();
  });
  return { c, fetch, clock, secrets };
}

const importToken = (c: Container, token = "token-aaaaaaaaaaaaaaaa", alias: string | null = null) =>
  c.connections.save(
    { access_token: token, refresh_token: null, expires_at: null },
    { alias, kind: "token", reconnectId: null, validate: true },
  );

const errorOf = async (p: Promise<unknown>) =>
  p.then(() => null).catch((e: unknown) => e as DomainError);

describe("connections (ACC-01)", () => {
  it("imports a token, validates it and serves live reports with provenance", async () => {
    const { c, fetch } = await setup();
    const { connectionId, counters } = await importToken(c);
    expect(counters.map((x) => x.id)).toEqual([COUNTER_ID]);
    const report = await c.reports.run({ connection_id: connectionId, counter_id: COUNTER_ID });
    expect(report.provenance).toMatchObject({ source: "yandex", cache: { hit: false } });
    expect(report.query.period).toMatchObject({
      time_zone: "Asia/Yekaterinburg",
      end: "2026-11-05",
    });
    const dataCall = fetch.requests.find((r) => r.url.pathname === "/stat/v1/data");
    expect(dataCall?.url.searchParams.get("accuracy")).toBe("full");
    expect(dataCall?.url.searchParams.get("ids")).toBe(COUNTER_ID);
  });

  it("stores tokens only in the secret store, never in the database records", async () => {
    const { c, secrets } = await setup();
    const { connectionId } = await importToken(c, "secret-token-zzzzzzzzzz");
    expect(JSON.stringify(c.connections.records())).not.toMatch(/secret-token/);
    expect(await secrets.get(`connection:${connectionId}:g1`)).toMatch(/secret-token-zzzzzzzzzz/);
  });

  it("serves repeated reports from cache and bypasses it on refresh (OPS-01)", async () => {
    const { c, fetch, clock } = await setup();
    const { connectionId } = await importToken(c);
    const args = { connection_id: connectionId, counter_id: COUNTER_ID } as const;
    await c.reports.run(args);
    const before = fetch.requests.length;
    clock.advance(30_000);
    const cached = await c.reports.run(args);
    expect(fetch.requests.length).toBe(before);
    expect(cached.provenance.cache).toEqual({ hit: true, age_seconds: 30 });
    await c.reports.run({ ...args, cache: "refresh" });
    expect(fetch.requests.length).toBe(before + 1);
  });

  it("returns stale data only when explicitly allowed and labels it", async () => {
    let down = false;
    const api = yandexApi();
    const { c, clock } = await setup((r) =>
      down && r.url.pathname === "/stat/v1/data" ? json({}, 503) : api(r),
    );
    const { connectionId } = await importToken(c);
    const args = { connection_id: connectionId, counter_id: COUNTER_ID } as const;
    await c.reports.run(args);
    down = true;
    clock.advance(3600_000);
    expect((await errorOf(c.reports.run(args)))?.code).toBe("UPSTREAM_UNAVAILABLE");
    const stale = await c.reports.run({ ...args, cache: "allow_stale" });
    expect(stale.warnings.map((w) => w.code)).toContain("STALE_DATA");
    expect(stale.provenance.fetched_at).toBe("2026-11-06T09:00:00.000Z");
  });

  it("keeps two connections to the same counter isolated (T21)", async () => {
    const { c, fetch } = await setup();
    const a = await importToken(c, "token-aaaaaaaaaaaaaaaa", "A");
    const b = await importToken(c, "token-bbbbbbbbbbbbbbbb", "B");
    await c.reports.run({ connection_id: a.connectionId, counter_id: COUNTER_ID });
    const before = fetch.requests.length;
    await c.reports.run({ connection_id: b.connectionId, counter_id: COUNTER_ID });
    expect(fetch.requests.length).toBeGreaterThan(before);
    const tokensUsed = new Set(fetch.requests.map((r) => r.headers.get("authorization")));
    expect(tokensUsed.size).toBe(2);
  });

  it("enforces the counter allowlist", async () => {
    const { c } = await setup();
    const { connectionId } = await importToken(c);
    c.connections.setAllowlist(connectionId, ["999"]);
    expect(
      (await errorOf(c.reports.run({ connection_id: connectionId, counter_id: COUNTER_ID })))?.code,
    ).toBe("COUNTER_NOT_ALLOWED");
    expect((await c.counters.list({ connection_id: connectionId })).counters).toHaveLength(0);
  });

  it("disconnect deletes the token and blocks the connection", async () => {
    const { c, secrets } = await setup();
    const { connectionId } = await importToken(c);
    const result = await c.connections.disconnect(connectionId);
    expect(result.tokenDeleted).toBe(true);
    expect(await secrets.get(`connection:${connectionId}:g1`)).toBeNull();
    expect(
      (await errorOf(c.reports.run({ connection_id: connectionId, counter_id: COUNTER_ID })))?.code,
    ).toBe("AUTH_REQUIRED");
    expect(c.connections.records()).toHaveLength(0);
  });

  it("an expired token switches the connection to needs_reconnect (T19)", async () => {
    const api = yandexApi();
    let expired = false;
    const { c } = await setup((r) => (expired ? json({ message: "invalid token" }, 401) : api(r)));
    const { connectionId } = await importToken(c);
    expired = true;
    expect(
      (await errorOf(c.reports.run({ connection_id: connectionId, counter_id: COUNTER_ID })))?.code,
    ).toBe("AUTH_EXPIRED");
    expect(c.connections.records()[0]?.state).toBe("needs_reconnect");
    const again = await errorOf(
      c.reports.run({ connection_id: connectionId, counter_id: COUNTER_ID }),
    );
    expect(again?.nextAction).toMatch(/metrika_connect/);
  });

  it("refuses to store a token without a secure store (T18)", async () => {
    const broken: SecretStore = {
      kind: "keychain",
      get: async () => {
        throw new Error("no keychain");
      },
      set: async () => {
        throw new Error("no keychain");
      },
      delete: async () => undefined,
    };
    const dir = tempDir();
    const c = await testContainer(dir.path, {
      overrides: {
        fetch: fakeFetch(yandexApi()),
        // Simulates a failing OS store behind the lazy opener.
        secrets: broken,
      },
    });
    cleanup.push(async () => {
      await c.close();
      dir.remove();
    });
    await expect(importToken(c)).rejects.toThrow();
    expect(c.connections.records()).toHaveLength(0);
  });

  it("supports a token from the environment without storing it", async () => {
    const dir = tempDir();
    const c = await testContainer(dir.path, {
      config: { envToken: "env-token-xxxxxxxxxxxx" },
      overrides: { fetch: fakeFetch(yandexApi()) },
    });
    cleanup.push(async () => {
      await c.close();
      dir.remove();
    });
    const report = await c.reports.run({ connection_id: "conn_env", counter_id: COUNTER_ID });
    expect(report.provenance.source).toBe("yandex");
  });
});
