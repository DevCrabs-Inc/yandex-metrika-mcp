import { describe, expect, it, vi } from "vitest";
import type { TokenProvider } from "../../src/app/ports.ts";
import { DomainError } from "../../src/domain/errors.ts";
import { createLogger } from "../../src/infra/log/logger.ts";
import { routePath, YandexClient } from "../../src/infra/yandex/client.ts";
import { QuotaScheduler } from "../../src/infra/yandex/quota.ts";
import { fakeFetch, fixedClock, instantSleep, json } from "../helpers.ts";

const tokens = (overrides: Partial<TokenProvider> = {}): TokenProvider & { expired: boolean } => {
  const provider = {
    expired: false,
    accessToken: async () => "test-access-token-1234567890",
    refresh: async () => false,
    markExpired: async () => {
      provider.expired = true;
    },
    ...overrides,
  };
  return provider;
};

function client(handler: Parameters<typeof fakeFetch>[0], provider = tokens()) {
  const clock = fixedClock();
  const fetch = fakeFetch(handler);
  const sleep = vi.fn(async (ms: number) => {
    clock.advance(ms);
    await instantSleep(0);
  });
  const c = new YandexClient({
    fetch,
    tokens: provider,
    quota: new QuotaScheduler(clock, sleep),
    quotaOwner: "conn_a",
    clock,
    sleep,
    logger: createLogger("error", () => undefined),
    userAgent: "yandex-metrika-mcp/test",
  });
  const get = () =>
    c.get({ name: "data" }, new URLSearchParams({ ids: "1" }), {
      priority: "interactive",
      budgetMs: 60_000,
    });
  return { c, fetch, get, sleep, provider };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    return error instanceof DomainError ? error : error;
  }
  return null;
};

describe("Yandex client contract (API-01)", () => {
  it("uses the documented OAuth header on the official host only (E04)", async () => {
    const { fetch, get } = client(() => json({ ok: 1 }));
    await get();
    const request = fetch.requests[0];
    expect(request?.url.origin).toBe("https://api-metrika.yandex.net");
    expect(request?.headers.get("authorization")).toBe("OAuth test-access-token-1234567890");
    expect(request?.headers.get("authorization")).not.toMatch(/Bearer/);
  });

  it("has no route for writes or arbitrary paths (SEC-01, E02)", () => {
    expect(() => routePath({ name: "counter", counterId: "1/../../x" })).toThrow(DomainError);
    expect(routePath({ name: "goals", counterId: "123" })).toBe("/management/v1/counter/123/goals");
  });

  it("keeps integers beyond 2^53 exact (T27)", async () => {
    const { get } = client(
      () => new Response('{"totals":[12345678901234567890,1.5]}', { status: 200 }),
    );
    expect(await get()).toEqual({ totals: ["12345678901234567890", 1.5] });
  });

  it("refreshes once on 401, then asks for a new sign-in (T19)", async () => {
    const refresh = vi.fn(async () => true);
    const { fetch, get, provider } = client(
      () => json({ message: "invalid token" }, 401),
      tokens({ refresh }),
    );
    const error = (await codeOf(get())) as DomainError;
    expect(error.code).toBe("AUTH_EXPIRED");
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch.requests).toHaveLength(2);
    expect(provider.expired).toBe(true);
  });

  it("does not retry 403 (T19)", async () => {
    const { fetch, get } = client(() => json({ message: "Access is denied" }, 403));
    expect(((await codeOf(get())) as DomainError).code).toBe("ACCESS_DENIED");
    expect(fetch.requests).toHaveLength(1);
  });

  it("reports 400 with a safe message and redacts token-like strings", async () => {
    const { get } = client(() =>
      json(
        {
          errors: [
            {
              error_type: "invalid_parameter",
              message: "Wrong metric ym:s:nope token=abcdefghijklmnopqrstuvwxyz0123456789",
            },
          ],
        },
        400,
      ),
    );
    const error = (await codeOf(get())) as DomainError;
    expect(error.code).toBe("INVALID_QUERY");
    expect(error.message).toMatch(/ym:s:nope/);
    expect(error.message).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789/);
  });

  it("waits for a short Retry-After and succeeds", async () => {
    let calls = 0;
    const { get, sleep } = client(() =>
      ++calls === 1 ? json({ message: "quota" }, 429, { "Retry-After": "2" }) : json({ ok: 1 }),
    );
    expect(await get()).toEqual({ ok: 1 });
    expect(sleep).toHaveBeenCalledWith(2000, undefined);
  });

  it("returns retry_at instead of retrying early when Retry-After exceeds the budget (T23)", async () => {
    const { fetch, get } = client(() => json({ message: "quota" }, 429, { "Retry-After": "600" }));
    const error = (await codeOf(get())) as DomainError;
    expect(error.code).toBe("QUOTA_EXCEEDED");
    expect(error.retryAt).toBe("2026-11-06T09:10:00.000Z");
    expect(fetch.requests).toHaveLength(1);
  });

  it("retries 5xx a bounded number of times (T24)", async () => {
    const { fetch, get } = client(() => json({ message: "backend" }, 503));
    expect(((await codeOf(get())) as DomainError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(fetch.requests).toHaveLength(4);
  });

  it("maps network failures to UPSTREAM_UNAVAILABLE after retries", async () => {
    const { fetch, get } = client(() => {
      throw new TypeError("fetch failed");
    });
    expect(((await codeOf(get())) as DomainError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect(fetch.requests.length).toBeGreaterThan(1);
  });

  it("fails closed on invalid JSON (T14)", async () => {
    const { get } = client(() => new Response("<html>", { status: 200 }));
    expect(((await codeOf(get())) as DomainError).code).toBe("UPSTREAM_SCHEMA_CHANGED");
  });
});

describe("quota scheduler (OPS-01)", () => {
  it("limits parallel requests per account", async () => {
    const clock = fixedClock();
    const quota = new QuotaScheduler(clock, instantSleep, {
      maxConcurrent: 2,
      statWindowMs: 300_000,
      statMaxInWindow: 180,
      perSecond: 100,
    });
    const opts = {
      stat: true,
      priority: "interactive" as const,
      deadline: clock.now().getTime() + 50,
    };
    const a = await quota.acquire("u", opts);
    await quota.acquire("u", opts);
    await expect(quota.acquire("u", opts)).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    a();
    await expect(quota.acquire("u", opts)).resolves.toBeTypeOf("function");
    // Another account is not affected.
    await expect(quota.acquire("v", opts)).resolves.toBeTypeOf("function");
  });

  it("enforces the 5-minute /stat budget with a retry time (T23, T25)", async () => {
    const clock = fixedClock();
    const quota = new QuotaScheduler(clock, instantSleep, {
      maxConcurrent: 5,
      statWindowMs: 300_000,
      statMaxInWindow: 2,
      perSecond: 100,
    });
    const opts = {
      stat: true,
      priority: "interactive" as const,
      deadline: clock.now().getTime() + 1000,
    };
    (await quota.acquire("u", opts))();
    (await quota.acquire("u", opts))();
    const error = await quota.acquire("u", opts).catch((e: DomainError) => e);
    expect(error).toMatchObject({ code: "QUOTA_EXCEEDED", retryAt: "2026-11-06T09:05:00.000Z" });
    // Management calls do not consume the /stat budget.
    await expect(quota.acquire("u", { ...opts, stat: false })).resolves.toBeTypeOf("function");
  });

  it("keeps a slot free for interactive calls when exports run", async () => {
    const clock = fixedClock();
    const quota = new QuotaScheduler(clock, instantSleep, {
      maxConcurrent: 2,
      statWindowMs: 300_000,
      statMaxInWindow: 180,
      perSecond: 100,
    });
    const deadline = clock.now().getTime() + 50;
    await quota.acquire("u", { stat: true, priority: "background", deadline });
    await expect(
      quota.acquire("u", { stat: true, priority: "background", deadline }),
    ).rejects.toMatchObject({ code: "QUOTA_EXCEEDED" });
    await expect(
      quota.acquire("u", { stat: true, priority: "interactive", deadline }),
    ).resolves.toBeTypeOf("function");
  });
});
