import type { Clock, Sleep, TokenProvider } from "../../app/ports.ts";
import { DomainError } from "../../domain/errors.ts";
import { safeLabel } from "../../domain/privacy.ts";
import {
  type FetchLike,
  HttpBodyTooLargeError,
  HttpNetworkError,
  HttpTimeoutError,
  httpRequest,
  parseJsonPreservingIntegers,
  retryAfterMs,
} from "../http.ts";
import type { Logger } from "../log/logger.ts";
import type { QuotaScheduler } from "./quota.ts";

export const API_BASE = "https://api-metrika.yandex.net";

/** The only API routes this server can call. There is no generic request method. */
export type Route =
  | { readonly name: "counters" }
  | { readonly name: "counter"; readonly counterId: string }
  | { readonly name: "goals"; readonly counterId: string }
  | { readonly name: "data" }
  | { readonly name: "bytime" };

const COUNTER_ID = /^\d{1,12}$/;

export function routePath(route: Route): string {
  switch (route.name) {
    case "counters":
      return "/management/v1/counters";
    case "data":
      return "/stat/v1/data";
    case "bytime":
      return "/stat/v1/data/bytime";
    case "counter":
    case "goals": {
      if (!COUNTER_ID.test(route.counterId))
        throw new DomainError("INVALID_QUERY", "Invalid counter ID.");
      const base = `/management/v1/counter/${route.counterId}`;
      return route.name === "goals" ? `${base}/goals` : base;
    }
  }
}

export interface YandexClientDeps {
  readonly fetch: FetchLike;
  readonly tokens: TokenProvider;
  readonly quota: QuotaScheduler;
  readonly quotaOwner: string;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly logger: Logger;
  readonly userAgent: string;
}

export interface RequestOptions {
  readonly priority: "interactive" | "background";
  /** Total time budget for the call including retries. */
  readonly budgetMs: number;
  readonly signal?: AbortSignal;
}

const MAX_RETRIES = 3;
const ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const LONG_TOKEN = /[A-Za-z0-9_-]{32,}/g;

/** Extracts a short, safe description from an error body without echoing secrets. */
export function safeUpstreamMessage(text: string): { type: string | null; message: string | null } {
  try {
    const body = JSON.parse(text) as {
      message?: unknown;
      errors?: { error_type?: unknown; message?: unknown }[];
    };
    const first = Array.isArray(body.errors) ? body.errors[0] : undefined;
    const type = typeof first?.error_type === "string" ? first.error_type : null;
    const raw =
      typeof first?.message === "string"
        ? first.message
        : typeof body.message === "string"
          ? body.message
          : null;
    const message =
      raw === null ? null : (safeLabel(raw.replace(LONG_TOKEN, "[redacted]")).name ?? null);
    return { type: type === null ? null : (safeLabel(type).name ?? null), message };
  } catch {
    return { type: null, message: null };
  }
}

const nextUtcMidnight = (now: Date): number =>
  Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);

/**
 * Read-only Yandex Metrika HTTP client: official host, `Authorization: OAuth`
 * header, bounded retries for safe reads and typed errors.
 */
export class YandexClient {
  private readonly _deps: YandexClientDeps;

  constructor(deps: YandexClientDeps) {
    this._deps = deps;
  }

  async get(route: Route, params: URLSearchParams, options: RequestOptions): Promise<unknown> {
    const { clock, quota, quotaOwner, sleep, logger } = this._deps;
    const path = routePath(route);
    const url = `${API_BASE}${path}${params.size > 0 ? `?${params.toString()}` : ""}`;
    const deadline = clock.now().getTime() + options.budgetMs;
    const stat = route.name === "data" || route.name === "bytime";
    let refreshed = false;
    let lastError: DomainError | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const remaining = deadline - clock.now().getTime();
      if (remaining <= 0) break;
      const release = await quota.acquire(quotaOwner, {
        stat,
        priority: options.priority,
        deadline,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      const started = clock.now().getTime();
      let status = 0;
      try {
        const response = await httpRequest(this._deps.fetch, {
          method: "GET",
          url,
          headers: {
            Authorization: `OAuth ${await this._deps.tokens.accessToken()}`,
            Accept: "application/json",
            "User-Agent": this._deps.userAgent,
          },
          timeoutMs: Math.min(ATTEMPT_TIMEOUT_MS, remaining),
          maxBytes: MAX_RESPONSE_BYTES,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        status = response.status;
        if (status >= 200 && status < 300) {
          try {
            return parseJsonPreservingIntegers(response.text);
          } catch {
            throw new DomainError(
              "UPSTREAM_SCHEMA_CHANGED",
              "Yandex Metrika returned invalid JSON.",
            );
          }
        }
        const detail = safeUpstreamMessage(response.text);
        if (status === 401) {
          if (!refreshed && (await this._deps.tokens.refresh())) {
            refreshed = true;
            continue;
          }
          await this._deps.tokens.markExpired();
          throw new DomainError(
            "AUTH_EXPIRED",
            "The Yandex sign-in for this connection is no longer valid.",
            {
              nextAction:
                "Call metrika_connect to sign in again, or re-import the token with the CLI.",
            },
          );
        }
        if (status === 403 || status === 404) {
          throw new DomainError(
            "ACCESS_DENIED",
            "This Yandex account has no access to the requested counter (or it does not exist).",
            { nextAction: "Call metrika_list_counters, or ask the counter owner for view access." },
          );
        }
        if (status === 400) {
          throw new DomainError(
            "INVALID_QUERY",
            `Yandex Metrika rejected the request${detail.message ? `: ${detail.message}` : "."}`,
            { nextAction: "Check metrics, dimensions and filters with metrika_catalog." },
          );
        }
        if (status === 429) {
          const now = clock.now();
          const daily = /day|daily|сут/i.test(detail.message ?? "");
          const retryAt =
            retryAfterMs(response.headers.get("retry-after"), now) ??
            (daily ? nextUtcMidnight(now) : now.getTime() + 60_000);
          lastError = new DomainError("QUOTA_EXCEEDED", "Yandex Metrika quota exceeded.", {
            retryAt: new Date(retryAt).toISOString(),
            nextAction: daily
              ? "The daily quota resets at 00:00 UTC."
              : "Wait until retry_at; exports resume automatically.",
          });
          if (retryAt > deadline || attempt === MAX_RETRIES) throw lastError;
          await sleep(Math.max(0, retryAt - now.getTime()), options.signal);
          continue;
        }
        lastError = new DomainError(
          "UPSTREAM_UNAVAILABLE",
          `Yandex Metrika returned HTTP ${status}.`,
          {
            nextAction: "Try again later; cached data can be requested with cache='allow_stale'.",
          },
        );
        if (status < 500) throw lastError;
      } catch (error) {
        if (error instanceof DomainError) {
          if (error.code !== "UPSTREAM_UNAVAILABLE" || status < 500) throw error;
        } else if (error instanceof HttpTimeoutError) {
          lastError = new DomainError("UPSTREAM_TIMEOUT", "Yandex Metrika did not answer in time.");
        } else if (error instanceof HttpNetworkError) {
          lastError = new DomainError("UPSTREAM_UNAVAILABLE", "Could not reach Yandex Metrika.", {
            nextAction: "Check the internet connection, then try again.",
          });
        } else if (error instanceof HttpBodyTooLargeError) {
          throw new DomainError(
            "RESULT_LIMIT_REACHED",
            "The API response is too large; narrow the request.",
          );
        } else {
          throw error;
        }
      } finally {
        release();
        logger.debug("yandex request", {
          route: route.name,
          status,
          attempt,
          latency_ms: clock.now().getTime() - started,
        });
      }
      const backoff = Math.min(8000, 500 * 2 ** attempt) * (0.5 + Math.random());
      if (clock.now().getTime() + backoff >= deadline) break;
      await sleep(backoff, options.signal);
    }
    throw (
      lastError ?? new DomainError("UPSTREAM_TIMEOUT", "Yandex Metrika did not answer in time.")
    );
  }
}
