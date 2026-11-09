import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.ts";
import { MemorySecretStore } from "../../src/infra/secrets/stores.ts";
import { fakeFetch, json, tempDir, testContainer, yandexApi } from "../helpers.ts";

const CLIENT_ID = "abcdef0123456789abcdef0123456789";
let cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(
  url: string,
  options: { method?: string; body?: string; host?: string; origin?: string } = {},
): Promise<Reply> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers: {
          Host: options.host ?? target.host,
          ...(options.origin ? { Origin: options.origin } : {}),
          ...(options.body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

async function setup() {
  const dir = tempDir();
  const api = yandexApi();
  const fetch = fakeFetch((r) => {
    if (r.url.origin === "https://oauth.yandex.ru") {
      const body = new URLSearchParams(r.body ?? "");
      if (body.get("code") === "good-code" && body.get("code_verifier")) {
        return json({
          access_token: "oauth-access-token-xyz",
          refresh_token: "r1",
          expires_in: 31536000,
          token_type: "bearer",
        });
      }
      return json({ error: "invalid_grant", error_description: "bad code" }, 400);
    }
    return api(r);
  });
  const secrets = new MemorySecretStore();
  const c = await testContainer(dir.path, {
    config: { clientId: CLIENT_ID, redirectPorts: [0] },
    overrides: { fetch, secrets, clock: { now: () => new Date() } },
  });
  cleanup.push(async () => {
    await c.close();
    dir.remove();
  });
  if (!c.login || !c.browserLogin) throw new Error("login not configured");
  const started = await c.login.start("Client A", null);
  const base = new URL(started.url).origin;
  const handle = new URL(started.url).pathname.split("/")[2] ?? "";
  return { c, fetch, secrets, started, base, handle };
}

describe("browser sign-in (UX-02, T17)", () => {
  it("runs consent → PKCE exchange → counter selection without exposing secrets", async () => {
    const { c, fetch, base, handle, started } = await setup();
    expect(started.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect\//);

    const page = await http(started.url);
    expect(page.status).toBe(200);
    expect(page.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    expect(page.body).toMatch(/metrika:read/);

    const start = await http(`${base}/start/${handle}`);
    expect(start.status).toBe(302);
    const authorize = new URL(String(start.headers["location"]));
    expect(authorize.origin + authorize.pathname).toBe("https://oauth.yandex.ru/authorize");
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorize.searchParams.get("scope")).toBe("metrika:read");
    const state = authorize.searchParams.get("state") ?? "";

    const callback = await http(`${base}/callback?state=${state}&code=good-code`);
    expect(callback.status).toBe(303);
    expect(callback.headers["location"]).toBe(`/select/${handle}`);
    const tokenCall = fetch.requests.find((r) => r.url.origin === "https://oauth.yandex.ru");
    const sent = new URLSearchParams(tokenCall?.body ?? "");
    expect(sent.get("code_verifier")).toBeTruthy();
    expect(sent.has("client_secret")).toBe(false);

    const replay = await http(`${base}/callback?state=${state}&code=good-code`);
    expect(replay.status).toBe(400);

    const select = await http(`${base}/select/${handle}`);
    const csrf = /name="csrf" value="([^"]+)"/.exec(select.body)?.[1] ?? "";
    expect(csrf).not.toBe("");
    const forged = await http(`${base}/select/${handle}`, {
      method: "POST",
      body: "csrf=wrong&counter=12345678",
    });
    expect(forged.status).toBe(403);
    const crossSite = await http(`${base}/select/${handle}`, {
      method: "POST",
      body: `csrf=${csrf}&counter=12345678`,
      origin: "https://evil.example",
    });
    expect(crossSite.status).toBe(403);
    const done = await http(`${base}/select/${handle}`, {
      method: "POST",
      body: `csrf=${csrf}&counter=12345678`,
    });
    expect(done.status).toBe(200);

    const record = c.connections.records()[0];
    expect(record).toMatchObject({ kind: "oauth", alias: "Client A", state: "active" });
    expect(JSON.stringify(record)).not.toMatch(/oauth-access-token/);
  });

  it("rejects wrong state, denied consent and foreign hosts", async () => {
    const { base, handle, c } = await setup();
    expect((await http(`${base}/callback?state=forged&code=good-code`)).status).toBe(400);
    expect((await http(`${base}/connect/${handle}`, { host: "evil.example" })).status).toBe(421);
    const start = await http(`${base}/start/${handle}`);
    const state = new URL(String(start.headers["location"])).searchParams.get("state");
    const denied = await http(`${base}/callback?state=${state}&error=access_denied`);
    expect(denied.status).toBe(303);
    const page = await http(`${base}/connect/${handle}`);
    expect(page.body).toMatch(/Access was not granted/);
    expect(c.connections.records()).toHaveLength(0);
  });

  it("an invalid or expired code fails safely", async () => {
    const { base, handle, c } = await setup();
    const start = await http(`${base}/start/${handle}`);
    const state = new URL(String(start.headers["location"])).searchParams.get("state");
    await http(`${base}/callback?state=${state}&code=bad-code`);
    const page = await http(`${base}/connect/${handle}`);
    expect(page.body).toMatch(/invalid, expired or was already used/);
    expect(c.connections.records()).toHaveLength(0);
  });
});

describe("busy sign-in ports", () => {
  it("returns a typed error with a next action instead of an internal error", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as AddressInfo).port;
    const dir = tempDir();
    const c = await testContainer(dir.path, {
      config: { clientId: CLIENT_ID, redirectPorts: [port] },
      overrides: { fetch: fakeFetch(yandexApi()), secrets: new MemorySecretStore() },
    });
    cleanup.push(async () => {
      await c.close();
      blocker.close();
      dir.remove();
    });
    const error = await c.login?.start(null, null).then(
      () => null,
      (e: unknown) => e as DomainError,
    );
    expect(error).toBeInstanceOf(DomainError);
    expect(error?.code).toBe("AUTH_NOT_CONFIGURED");
    expect(error?.nextAction).toMatch(/YM_MCP_OAUTH_PORTS/);
  });
});

describe("sign-in pages", () => {
  it("escape every dynamic value", async () => {
    const { connectPage, selectPage } = await import("../../src/infra/auth/pages.ts");
    const html = connectPage("/start/x", '<script>alert("x")</script>');
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
    const select = selectPage("/select/x", "c", [
      { id: "1", name: '"><img src=x onerror=1>', site: "s" },
    ]);
    expect(select).not.toContain("<img");
  });
});
