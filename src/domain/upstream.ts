import { z } from "zod";
import { DomainError } from "./errors.ts";

/**
 * Shapes of Reporting API responses (`/stat/v1/data`, `/stat/v1/data/bytime`).
 * Unknown optional fields are allowed; broken critical fields fail closed with
 * UPSTREAM_SCHEMA_CHANGED (D-05).
 */

const dimensionValue = z.looseObject({
  name: z.string().nullable().optional(),
  id: z.union([z.string(), z.number()]).nullable().optional(),
});

// Integers beyond 2^53 arrive as exact digit strings (see parseJsonPreservingIntegers).
const metricValue = z.union([z.number(), z.string().regex(/^-?\d+$/)]).nullable();
export type UpstreamValue = number | string | null;

const qualityFields = {
  total_rows: z.number().int().nonnegative(),
  total_rows_rounded: z.boolean().optional(),
  sampled: z.unknown().optional(),
  sample_share: z.unknown().optional(),
  sample_size: z.unknown().optional(),
  sample_space: z.unknown().optional(),
  data_lag: z.number().nonnegative().optional(),
  contains_sensitive_data: z.boolean().optional(),
  query: z.looseObject({ attribution: z.string().optional() }).optional(),
};

export const upstreamDataSchema = z.looseObject({
  data: z.array(
    z.looseObject({ dimensions: z.array(dimensionValue), metrics: z.array(metricValue) }),
  ),
  totals: z.array(metricValue),
  ...qualityFields,
});
export type UpstreamData = z.infer<typeof upstreamDataSchema>;

export const upstreamByTimeSchema = z.looseObject({
  data: z.array(
    z.looseObject({
      dimensions: z.array(dimensionValue),
      metrics: z.array(z.array(metricValue)),
    }),
  ),
  totals: z.array(z.array(metricValue)),
  // Not part of the documented response; used when present.
  time_intervals: z.array(z.tuple([z.string(), z.string()])).optional(),
  ...qualityFields,
});
export type UpstreamByTime = z.infer<typeof upstreamByTimeSchema>;

export function schemaChanged(message: string): DomainError {
  return new DomainError(
    "UPSTREAM_SCHEMA_CHANGED",
    `Unexpected Yandex Metrika response: ${message}`,
    {
      nextAction:
        "Report this as an issue with the server version; the API contract may have changed.",
    },
  );
}

function parse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw schemaChanged(
      `${label} ${first ? `${first.path.join(".")}: ${first.message}` : "is invalid"}`,
    );
  }
  return result.data;
}

/** Validates shape and the arity invariants that zod cannot express. */
export function parseUpstreamData(
  value: unknown,
  metricCount: number,
  dimensionCount: number,
): UpstreamData {
  const data = parse(upstreamDataSchema, value, "report");
  if (data.totals.length !== metricCount) {
    throw schemaChanged(`totals has ${data.totals.length} values, expected ${metricCount}`);
  }
  for (const row of data.data) {
    if (row.metrics.length !== metricCount) {
      throw schemaChanged(`a row has ${row.metrics.length} metric values, expected ${metricCount}`);
    }
    if (dimensionCount > 0 && row.dimensions.length !== dimensionCount) {
      throw schemaChanged(
        `a row has ${row.dimensions.length} dimensions, expected ${dimensionCount}`,
      );
    }
  }
  return data;
}

export function parseUpstreamByTime(
  value: unknown,
  metricCount: number,
  dimensionCount: number,
  expectedBuckets: number,
): UpstreamByTime {
  const data = parse(upstreamByTimeSchema, value, "bytime report");
  const buckets = data.time_intervals?.length ?? expectedBuckets;
  const checkSeries = (series: readonly (readonly UpstreamValue[])[], what: string): void => {
    if (series.length !== metricCount) {
      throw schemaChanged(`${what} has ${series.length} metric series, expected ${metricCount}`);
    }
    for (const values of series) {
      if (values.length !== buckets) {
        throw schemaChanged(`${what} series has ${values.length} points, expected ${buckets}`);
      }
    }
  };
  checkSeries(data.totals, "totals");
  for (const row of data.data) {
    checkSeries(row.metrics, "a row");
    if (dimensionCount > 0 && row.dimensions.length !== dimensionCount) {
      throw schemaChanged(
        `a row has ${row.dimensions.length} dimensions, expected ${dimensionCount}`,
      );
    }
  }
  return data;
}

interface QualityFields {
  readonly total_rows: number;
  readonly total_rows_rounded?: boolean | undefined;
  readonly sampled?: unknown;
  readonly sample_share?: unknown;
  readonly sample_size?: unknown;
  readonly sample_space?: unknown;
  readonly data_lag?: number | undefined;
  readonly contains_sensitive_data?: boolean | undefined;
  readonly query?: { readonly attribution?: string | undefined } | undefined;
}

const qualityOf = (d: QualityFields): QualityFields => ({
  total_rows: d.total_rows,
  total_rows_rounded: d.total_rows_rounded,
  sampled: d.sampled,
  sample_share: d.sample_share,
  sample_size: d.sample_size,
  sample_space: d.sample_space,
  data_lag: d.data_lag,
  contains_sensitive_data: d.contains_sensitive_data,
  query: d.query,
});

export interface NumericRow {
  readonly dimensions: UpstreamData["data"][number]["dimensions"];
  readonly metrics: (number | null)[];
}

/** Report data with exact digit strings converted to numbers, for interactive answers. */
export interface NumericData extends QualityFields {
  readonly data: NumericRow[];
  readonly totals: (number | null)[];
}

export interface NumericSeriesRow {
  readonly dimensions: UpstreamByTime["data"][number]["dimensions"];
  readonly metrics: (number | null)[][];
}

export interface NumericByTime extends QualityFields {
  readonly data: NumericSeriesRow[];
  readonly totals: (number | null)[][];
  readonly time_intervals?: [string, string][] | undefined;
}

interface Flag {
  approximated: boolean;
}

const toNumber = (value: UpstreamValue, flag: Flag): number | null => {
  if (typeof value !== "string") return value;
  flag.approximated = true;
  return Number(value);
};

export function numericData(data: UpstreamData): { data: NumericData; approximated: boolean } {
  const flag: Flag = { approximated: false };
  const converted: NumericData = {
    ...qualityOf(data),
    data: data.data.map((row) => ({
      dimensions: row.dimensions,
      metrics: row.metrics.map((v) => toNumber(v, flag)),
    })),
    totals: data.totals.map((v) => toNumber(v, flag)),
  };
  return { data: converted, approximated: flag.approximated };
}

export function numericByTime(data: UpstreamByTime): {
  data: NumericByTime;
  approximated: boolean;
} {
  const flag: Flag = { approximated: false };
  const series = (values: readonly (readonly UpstreamValue[])[]) =>
    values.map((s) => s.map((v) => toNumber(v, flag)));
  const converted: NumericByTime = {
    ...qualityOf(data),
    time_intervals: data.time_intervals,
    data: data.data.map((row) => ({ dimensions: row.dimensions, metrics: series(row.metrics) })),
    totals: series(data.totals),
  };
  return { data: converted, approximated: flag.approximated };
}

export const precisionWarning = {
  code: "PRECISION_LIMIT",
  severity: "warning" as const,
  message: "Some values exceed 2^53 and are shown approximately; JSON exports keep them exact.",
  affected_fields: [] as string[],
};
