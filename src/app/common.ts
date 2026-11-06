import { randomUUID } from "node:crypto";
import { CATALOG_VERSION } from "../domain/catalog.ts";
import type { Warning } from "../domain/warnings.ts";
import type { Connection } from "./connections.ts";

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

export function provenance(
  connection: Connection,
  sourceMethod: string,
  fetchedAt: Date,
  queryFingerprint: string,
): Provenance {
  return {
    source: connection.source.kind,
    source_method: sourceMethod,
    fetched_at: fetchedAt.toISOString(),
    cache: { hit: false, age_seconds: 0 },
    query_fingerprint: queryFingerprint,
    adapter_version: connection.source.adapterVersion,
    catalog_version: CATALOG_VERSION,
  };
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
