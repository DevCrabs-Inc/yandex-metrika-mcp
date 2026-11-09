import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Clock } from "../../app/ports.ts";
import { DomainError } from "../../domain/errors.ts";
import type { Logger } from "../log/logger.ts";
import { authorizeUrl, createPkce, OAuthError, oauthMessage, randomToken } from "./oauth.ts";
import { connectPage, donePage, errorPage, selectPage } from "./pages.ts";

export const ATTEMPT_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

export type AttemptStatus = "pending" | "authorized" | "completed" | "failed" | "expired";

export interface LoginAttempt {
  readonly handle: string;
  readonly state: string;
  readonly verifier: string;
  readonly challenge: string;
  readonly csrf: string;
  readonly alias: string | null;
  readonly reconnectId: string | null;
  readonly expiresAt: number;
  status: AttemptStatus;
  connectionId: string | null;
  counters: { id: string; name: string; site: string }[];
  error: string | null;
  stateUsed: boolean;
}

export interface LoopbackHandlers {
  /** Exchanges the code, stores the token and creates the connection. */
  onCode(
    attempt: LoginAttempt,
    code: string,
  ): Promise<{
    connectionId: string;
    counters: { id: string; name: string; site: string }[];
  }>;
  onSelect(attempt: LoginAttempt, counterIds: readonly string[]): Promise<void>;
}

export interface LoopbackOptions {
  readonly clientId: string;
  /** Ports registered as http://127.0.0.1:<port>/callback in the Yandex OAuth app. */
  readonly ports: readonly number[];
  readonly clock: Clock;
  readonly logger: Logger;
  readonly handlers: LoopbackHandlers;
}

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on the
  // counter form POST, which the cross-site check must then reject. Cross-origin
  // requests (to Yandex) still get no referrer.
  "Referrer-Policy": "same-origin",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

/**
 * Local sign-in server bound to 127.0.0.1 only. It serves the explanation
 * page, the OAuth callback and the counter selection; it is not an API.
 */
export class LoopbackAuthServer {
  private readonly _options: LoopbackOptions;
  private readonly _attempts = new Map<string, LoginAttempt>();
  private _server: Server | null = null;
  private _port: number | null = null;

  constructor(options: LoopbackOptions) {
    this._options = options;
  }

  get redirectUri(): string | null {
    return this._port === null ? null : `http://127.0.0.1:${this._port}/callback`;
  }

  /** Creates a one-time sign-in attempt and returns the local link for the user. */
  async start(
    alias: string | null,
    reconnectId: string | null,
  ): Promise<{ url: string; expiresAt: Date; handle: string }> {
    await this._listen();
    this._expire();
    const pkce = createPkce();
    const attempt: LoginAttempt = {
      handle: randomToken(18),
      state: randomToken(24),
      verifier: pkce.verifier,
      challenge: pkce.challenge,
      csrf: randomToken(18),
      alias,
      reconnectId,
      expiresAt: this._options.clock.now().getTime() + ATTEMPT_TTL_MS,
      status: "pending",
      connectionId: null,
      counters: [],
      error: null,
      stateUsed: false,
    };
    this._attempts.set(attempt.handle, attempt);
    return {
      url: `http://127.0.0.1:${this._port}/connect/${attempt.handle}`,
      expiresAt: new Date(attempt.expiresAt),
      handle: attempt.handle,
    };
  }

  attempt(handle: string): LoginAttempt | null {
    this._expire();
    return this._attempts.get(handle) ?? null;
  }

  attempts(): LoginAttempt[] {
    this._expire();
    return [...this._attempts.values()];
  }

  /** The URL to open on Yandex for an attempt (also used by the CLI manual flow). */
  authorizeUrlFor(attempt: LoginAttempt): string {
    const redirectUri =
      this.redirectUri ?? `http://127.0.0.1:${this._options.ports[0] ?? 0}/callback`;
    return authorizeUrl({
      clientId: this._options.clientId,
      redirectUri,
      state: attempt.state,
      challenge: attempt.challenge,
      forceConfirm: true,
    });
  }

  async close(): Promise<void> {
    const server = this._server;
    this._server = null;
    this._port = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private _expire(): void {
    const now = this._options.clock.now().getTime();
    for (const attempt of this._attempts.values()) {
      if (
        now > attempt.expiresAt &&
        (attempt.status === "pending" || attempt.status === "authorized")
      ) {
        attempt.status = "expired";
      }
      if (now > attempt.expiresAt + ATTEMPT_TTL_MS) this._attempts.delete(attempt.handle);
    }
  }

  private async _listen(): Promise<void> {
    if (this._server) return;
    for (const port of this._options.ports) {
      const server = createServer((req, res) => {
        this._handle(req, res).catch((error: unknown) => {
          this._options.logger.error("auth page failed", { error });
          this._send(res, 500, errorPage("Внутренняя ошибка. Internal error."));
        });
      });
      const ok = await new Promise<boolean>((resolve) => {
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => resolve(true));
      });
      if (ok) {
        server.unref();
        this._server = server;
        this._port = (server.address() as AddressInfo).port;
        return;
      }
    }
    throw new DomainError(
      "AUTH_NOT_CONFIGURED",
      `Browser sign-in cannot start: local ports ${this._options.ports.join(", ")} are all in use.`,
      {
        nextAction:
          "Close the program that uses these ports and try again, set YM_MCP_OAUTH_PORTS to ports registered as redirect URIs of the OAuth app, or run `yandex-metrika-mcp auth import-token`.",
      },
    );
  }

  private _send(
    res: ServerResponse,
    status: number,
    html: string,
    extra: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extra,
    });
    res.end(html);
  }

  private _redirect(res: ServerResponse, location: string, status = 303): void {
    res.writeHead(status, { Location: location, ...SECURITY_HEADERS });
    res.end();
  }

  private async _handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this._port}` && host !== `localhost:${this._port}`) {
      return this._send(res, 421, errorPage("Неверный адрес. Wrong host."));
    }
    this._expire();
    const url = new URL(req.url ?? "/", `http://${host}`);
    const [, route, handle] = url.pathname.split("/");
    if (req.method === "GET" && route === "callback") return this._callback(url, res);
    const attempt = handle ? this._attempts.get(handle) : undefined;
    if (!attempt)
      return this._send(
        res,
        404,
        errorPage("Ссылка устарела или не найдена. The link has expired."),
      );
    if (attempt.status === "expired")
      return this._send(res, 410, errorPage("Время на вход истекло. The sign-in expired."));

    if (req.method === "GET" && route === "connect" && attempt.status === "pending") {
      return this._send(res, 200, connectPage(`/start/${attempt.handle}`, attempt.alias));
    }
    if (req.method === "GET" && route === "start" && attempt.status === "pending") {
      return this._redirect(res, this.authorizeUrlFor(attempt), 302);
    }
    if (req.method === "GET" && route === "select" && attempt.status === "authorized") {
      return this._send(
        res,
        200,
        selectPage(`/select/${attempt.handle}`, attempt.csrf, attempt.counters),
      );
    }
    if (req.method === "POST" && route === "select" && attempt.status === "authorized") {
      return this._select(req, res, attempt);
    }
    if (attempt.status === "completed" && attempt.connectionId) {
      return this._send(res, 200, donePage(attempt.connectionId, null));
    }
    if (attempt.status === "failed")
      return this._send(res, 400, errorPage(attempt.error ?? oauthMessage("")));
    return this._send(res, 404, errorPage("Страница не найдена. Not found."));
  }

  private async _callback(url: URL, res: ServerResponse): Promise<void> {
    const state = url.searchParams.get("state") ?? "";
    const attempt = [...this._attempts.values()].find((a) => a.state === state);
    if (!attempt || attempt.stateUsed || attempt.status !== "pending") {
      return this._send(
        res,
        400,
        errorPage("Ответ Яндекса не относится к текущему входу или уже использован."),
      );
    }
    attempt.stateUsed = true;
    const error = url.searchParams.get("error");
    const code = url.searchParams.get("code");
    if (error || !code) {
      attempt.status = "failed";
      attempt.error = oauthMessage(error ?? "");
      return this._redirect(res, `/connect/${attempt.handle}`);
    }
    try {
      const result = await this._options.handlers.onCode(attempt, code);
      attempt.connectionId = result.connectionId;
      attempt.counters = result.counters;
      attempt.status = "authorized";
      // Redirect drops the code from the address bar.
      return this._redirect(res, `/select/${attempt.handle}`);
    } catch (e) {
      attempt.status = "failed";
      attempt.error =
        e instanceof OAuthError
          ? e.message
          : "Не удалось завершить вход. Could not complete sign-in.";
      this._options.logger.warn("sign-in failed", {
        code: e instanceof OAuthError ? e.code : "internal",
      });
      return this._redirect(res, `/connect/${attempt.handle}`);
    }
  }

  private async _select(
    req: IncomingMessage,
    res: ServerResponse,
    attempt: LoginAttempt,
  ): Promise<void> {
    if (!isSameOriginPost(req, this._port)) {
      return this._send(
        res,
        403,
        errorPage("Запрос с чужого сайта отклонён. Cross-site request rejected."),
      );
    }
    const body = await readBody(req);
    if (body === null)
      return this._send(res, 413, errorPage("Слишком большой запрос. Request too large."));
    const form = new URLSearchParams(body);
    if (form.get("csrf") !== attempt.csrf) {
      return this._send(res, 403, errorPage("Форма устарела. The form has expired."));
    }
    const allowed = new Set(attempt.counters.map((c) => c.id));
    const chosen = form.getAll("counter").filter((id) => allowed.has(id));
    await this._options.handlers.onSelect(attempt, chosen);
    attempt.status = "completed";
    return this._send(res, 200, donePage(attempt.connectionId ?? "", chosen.length));
  }
}

/**
 * Accepts the counter form only from our own page. Browsers send our origin, or
 * `Origin: null` with `Sec-Fetch-Site: same-origin` under a strict referrer policy;
 * clients without either header are not browsers and still need the CSRF token.
 */
function isSameOriginPost(req: IncomingMessage, port: number | null): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`) return true;
  return origin === "null" && req.headers["sec-fetch-site"] === "same-origin";
}

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
