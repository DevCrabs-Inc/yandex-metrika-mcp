import type { IsoDate } from "../domain/dates.ts";
import type { FilterCondition } from "../domain/filters.ts";

export interface CounterInfo {
  readonly id: string;
  readonly name: string;
  readonly site: string;
  /** IANA time zone from counter settings; null when the API did not provide one. */
  readonly time_zone: string | null;
  readonly status: string;
  readonly permission: "own" | "edit" | "view" | "unknown";
}

export interface GoalInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

export interface DataRequest {
  readonly counterId: string;
  readonly date1: IsoDate;
  readonly date2: IsoDate;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly FilterCondition[];
  readonly sort: readonly string[];
  readonly limit: number;
  /** 1-based, as in the Reporting API. */
  readonly offset: number;
  /** "full" asks the API for unsampled data; null leaves the API default. */
  readonly accuracy: "full" | null;
}

export interface ByTimeRequest {
  readonly counterId: string;
  readonly date1: IsoDate;
  readonly date2: IsoDate;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly FilterCondition[];
  readonly group: "day" | "week" | "month";
  readonly topKeys: number;
  readonly accuracy: "full" | null;
}

export type { CacheMode } from "../domain/contract/common.ts";

import type { CacheMode } from "../domain/contract/common.ts";

export interface FetchOptions {
  /** default: fresh cache only; refresh: bypass cache; allow_stale: old data if the API fails. */
  readonly cache?: CacheMode;
  /** How old a cached response may be for this request. */
  readonly maxAgeSeconds?: number;
  readonly priority?: "interactive" | "background";
  readonly signal?: AbortSignal;
}

export interface SourceResponse {
  readonly body: unknown;
  /** When the data was actually fetched from the API (not when it was served). */
  readonly fetchedAt: Date;
  readonly cacheHit: boolean;
  /** Served from cache past its freshness limit because the API failed (allow_stale). */
  readonly stale: boolean;
}

/**
 * Read-only access to one Yandex account (or the synthetic demo). Report
 * methods return raw upstream JSON; callers validate it.
 */
export interface MetrikaSource {
  readonly kind: "demo" | "yandex";
  readonly adapterVersion: string;
  listCounters(options?: FetchOptions): Promise<readonly CounterInfo[]>;
  /** Throws ACCESS_DENIED when the counter is not accessible. */
  getCounter(counterId: string, options?: FetchOptions): Promise<CounterInfo>;
  listGoals(counterId: string, options?: FetchOptions): Promise<readonly GoalInfo[]>;
  getData(request: DataRequest, options?: FetchOptions): Promise<SourceResponse>;
  getByTime(request: ByTimeRequest, options?: FetchOptions): Promise<SourceResponse>;
}

/** Name and version of the connected MCP client: for logs and the User-Agent, never for decisions. */
export interface ClientInfo {
  readonly name: string;
  readonly version: string;
}

export interface ClientIdentity {
  current(): ClientInfo | null;
  observe(info: ClientInfo | null): void;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/** Supplies the OAuth token for one connection and handles its expiry. */
export interface TokenProvider {
  accessToken(): Promise<string>;
  /** Tries one refresh after a 401; resolves false when signing in again is the only option. */
  refresh(): Promise<boolean>;
  /** Marks the connection as needing a new sign-in. */
  markExpired(): Promise<void>;
}

/** OS-backed (or explicitly chosen file) storage for tokens. Values never leave this process. */
export interface SecretStore {
  readonly kind: "keychain" | "file" | "memory";
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}
