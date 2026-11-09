import { randomUUID } from "node:crypto";
import { CATALOG_VERSION } from "../domain/catalog.ts";
import type { Warning } from "../domain/warnings.ts";
import { CLOSED_REPORT_TTL_SECONDS, OPEN_REPORT_TTL_SECONDS } from "./cached-source.ts";
import type { Connection } from "./connections.ts";
import type { CacheMode, FetchOptions, SourceResponse } from "./ports.ts";

export const MAX_RESPONSE_BYTES = 48 * 1024;
/** Space kept for the short text summary that accompanies structured content. */
export const TEXT_RESERVE_BYTES = 8 * 1024;
export const STRUCTURED_BUDGET_BYTES = MAX_RESPONSE_BYTES - TEXT_RESERVE_BYTES;

export const newRequestId = (): string => `req_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

export const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

export interface Provenance {
  readonly source: "demo" | "yandex";
  readonly source_method: string;
  readonly fetched_at: string;
  readonly cache: { readonly hit: boolean; readonly age_seconds: number };
  readonly query_fingerprint: string;
  readonly adapter_version: string;
  readonly catalog_version: string;
}

export interface FetchInfo {
  readonly fetchedAt: Date;
  readonly cacheHit: boolean;
}

export function provenance(
  connection: Connection,
  sourceMethod: string,
  fetch: FetchInfo,
  queryFingerprint: string,
  now: Date,
): Provenance {
  return {
    source: connection.source.kind,
    source_method: sourceMethod,
    fetched_at: fetch.fetchedAt.toISOString(),
    cache: {
      hit: fetch.cacheHit,
      age_seconds: Math.max(0, Math.round((now.getTime() - fetch.fetchedAt.getTime()) / 1000)),
    },
    query_fingerprint: queryFingerprint,
    adapter_version: connection.source.adapterVersion,
    catalog_version: CATALOG_VERSION,
  };
}

/** Cache policy for a report request: complete periods may be reused longer. */
export function reportFetchOptions(
  periodComplete: boolean,
  cache: CacheMode | undefined,
): FetchOptions {
  return {
    cache: cache ?? "default",
    maxAgeSeconds: periodComplete ? CLOSED_REPORT_TTL_SECONDS : OPEN_REPORT_TTL_SECONDS,
  };
}

export function staleWarnings(responses: readonly SourceResponse[], now: Date): Warning[] {
  const stale = responses.filter((r) => r.stale);
  if (stale.length === 0) return [];
  const oldest = Math.min(...stale.map((r) => r.fetchedAt.getTime()));
  return [
    {
      code: "STALE_DATA",
      severity: "warning",
      message: `Yandex Metrika is unavailable; showing cached data fetched ${Math.round((now.getTime() - oldest) / 60000)} min ago (cache='allow_stale').`,
      affected_fields: [],
    },
  ];
}

export function demoWarning(connection: Connection): Warning[] {
  if (connection.source.kind !== "demo") return [];
  return [
    {
      code: "DEMO_DATA",
      severity: "warning",
      message: "Synthetic demo data. It does not describe any real website.",
      affected_fields: [],
    },
  ];
}
