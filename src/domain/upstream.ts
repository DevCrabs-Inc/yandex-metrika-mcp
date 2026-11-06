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

const metricValue = z.number().nullable();

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
  time_intervals: z.array(z.tuple([z.string(), z.string()])),
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
    if (row.dimensions.length !== dimensionCount) {
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
): UpstreamByTime {
  const data = parse(upstreamByTimeSchema, value, "bytime report");
  const buckets = data.time_intervals.length;
  const checkSeries = (series: readonly (readonly (number | null)[])[], what: string): void => {
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
    if (row.dimensions.length !== dimensionCount) {
      throw schemaChanged(
        `a row has ${row.dimensions.length} dimensions, expected ${dimensionCount}`,
      );
    }
  }
  return data;
}
