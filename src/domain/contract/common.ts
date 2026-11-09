import { z } from "zod";
import { FILTER_OPERATORS, MAX_FILTER_VALUES, MAX_FILTERS } from "../filters.ts";
import { COMPARISON_PRESETS, PERIOD_PRESETS } from "../periods.ts";
import { MAX_DIMENSIONS, MAX_GOALS_PER_QUERY, MAX_METRICS, REPORT_PRESETS } from "../presets.ts";
import { ACCURACY_MODES } from "../quality.ts";

export const SCHEMA_VERSION = "1.0";
export const CACHE_MODES = ["default", "refresh", "allow_stale"] as const;
export type CacheMode = (typeof CACHE_MODES)[number];
export const MAX_PAGE_LIMIT = 200;
export const DEFAULT_PAGE_LIMIT = 20;

// ---------- inputs ----------

export const connectionIdInput = z
  .string()
  .min(1)
  .max(64)
  .describe("Connection ID from metrika_status (e.g. conn_demo).");

// IDs are strings in the contract; numbers are coerced because many clients send them unquoted.
export const counterIdInput = z.coerce
  .string()
  .regex(/^\d{1,12}$/, "counter_id must be a numeric string")
  .describe("Counter ID as a string, from metrika_list_counters.");

export const periodInput = z
  .object({
    preset: z.enum(PERIOD_PRESETS).optional(),
    start: z.string().optional().describe("YYYY-MM-DD, inclusive."),
    end: z.string().optional().describe("YYYY-MM-DD, inclusive."),
  })
  .describe(
    "Either {preset} or {start, end}. Dates are in the counter time zone. Default: last_7_complete_days.",
  );

export const filterInput = z.object({
  dimension: z.string().describe("Dimension ID from metrika_catalog."),
  op: z.enum(FILTER_OPERATORS),
  values: z.array(z.string()).min(1).max(MAX_FILTER_VALUES),
});

export const fieldsInput = {
  preset: z
    .enum(REPORT_PRESETS)
    .optional()
    .describe("Ready-made report. Mutually exclusive with metrics/dimensions."),
  metrics: z
    .array(z.string())
    .min(1)
    .max(MAX_METRICS)
    .optional()
    .describe("Metric IDs (e.g. ym:s:visits, ym:s:goal<ID>visits) when no preset is used."),
  dimensions: z.array(z.string()).max(MAX_DIMENSIONS).optional().describe("Dimension IDs."),
  goal_ids: z
    .array(z.coerce.string().regex(/^\d{1,12}$/))
    .max(MAX_GOALS_PER_QUERY)
    .optional()
    .describe("Goal IDs (not names) from metrika_describe_counter; adds goal columns to a preset."),
  filters: z
    .array(filterInput)
    .max(MAX_FILTERS)
    .optional()
    .describe("Conditions combined with AND."),
  cache: z
    .enum(CACHE_MODES)
    .optional()
    .describe(
      "default: reuse fresh cached results; refresh: always ask the API; allow_stale: fall back to older cached data if the API is down.",
    ),
  accuracy: z
    .enum(ACCURACY_MODES)
    .optional()
    .describe(
      "strict (default): fail instead of returning sampled data. balanced: accept sampling with a warning.",
    ),
};

export const comparisonPeriodsInput = z
  .object({
    preset: z.enum(COMPARISON_PRESETS).optional(),
    current: periodInput.optional(),
    baseline: z
      .union([z.enum(["previous_period", "same_period_last_year"]), periodInput])
      .optional(),
  })
  .describe(
    "Either {preset} or {current, baseline}. Default: last_two_complete_iso_weeks (Mon–Sun).",
  );

// ---------- outputs ----------

export const warningOutput = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning"]),
  message: z.string(),
  affected_fields: z.array(z.string()),
});

export const resolvedPeriodOutput = z.object({
  start: z.string(),
  end: z.string(),
  time_zone: z.string(),
  days: z.number().int(),
  complete: z.boolean(),
  preset: z.string().nullable(),
});

export const dimensionColumnOutput = z.object({
  id: z.string(),
  label: z.string(),
  sensitive: z.boolean(),
});

export const metricColumnOutput = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.enum(["count", "percent", "seconds", "pages"]),
  aggregation: z.enum(["additive", "non_additive", "rate", "average"]),
});

export const columnsOutput = z.object({
  dimensions: z.array(dimensionColumnOutput),
  metrics: z.array(metricColumnOutput),
});

export const dimensionCellOutput = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  redacted: z.boolean().optional(),
  truncated: z.boolean().optional(),
});

export const qualityOutput = z.object({
  sampled: z.boolean().nullable(),
  sample_share: z.number().nullable(),
  sample_size: z.number().nullable(),
  sample_space: z.number().nullable(),
  total_rows: z.number().int(),
  total_rows_rounded: z.boolean(),
  rows_complete: z.boolean(),
  truncated: z.boolean(),
  truncation_reason: z.enum(["page_limit", "byte_budget", "top_n"]).nullable(),
  period_complete: z.boolean(),
  data_lag_seconds: z.number().nullable(),
  contains_sensitive_data: z.boolean().nullable(),
});

export const provenanceOutput = z.object({
  source: z.enum(["demo", "yandex"]),
  source_method: z.string(),
  fetched_at: z.string(),
  cache: z.object({ hit: z.boolean(), age_seconds: z.number() }),
  query_fingerprint: z.string(),
  adapter_version: z.string(),
  catalog_version: z.string(),
});

export const filterOutput = z.object({
  dimension: z.string(),
  op: z.enum(FILTER_OPERATORS),
  values: z.array(z.string()),
});

export const counterRefOutput = z.object({
  id: z.string(),
  name: z.string(),
  site: z.string(),
});
