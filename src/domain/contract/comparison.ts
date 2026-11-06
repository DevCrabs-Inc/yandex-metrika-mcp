import { z } from "zod";
import {
  columnsOutput,
  comparisonPeriodsInput,
  connectionIdInput,
  counterIdInput,
  counterRefOutput,
  DEFAULT_PAGE_LIMIT,
  dimensionCellOutput,
  fieldsInput,
  filterOutput,
  MAX_PAGE_LIMIT,
  provenanceOutput,
  qualityOutput,
  resolvedPeriodOutput,
  warningOutput,
} from "./common.ts";

export const comparisonInput = z.object({
  connection_id: connectionIdInput,
  counter_id: counterIdInput,
  periods: comparisonPeriodsInput.optional(),
  ...fieldsInput,
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Segment rows to return, default ${DEFAULT_PAGE_LIMIT}.`),
});
export type ComparisonInput = z.infer<typeof comparisonInput>;

export const deltaOutput = z.object({
  baseline: z.number().nullable(),
  current: z.number().nullable(),
  delta_abs: z.number().nullable(),
  delta_pct: z.number().nullable(),
  delta_pp: z.number().nullable().describe("Percentage points, only for percent metrics."),
  reason: z
    .enum(["zero_baseline", "unknown_value", "not_in_fetched_rows"])
    .nullable()
    .describe("Why a value or relative change is null."),
});

export const comparisonOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("comparison"),
  status: z.enum(["success", "partial", "empty"]),
  request_id: z.string(),
  query: z.object({
    connection_id: z.string(),
    counter: counterRefOutput,
    baseline: resolvedPeriodOutput,
    current: resolvedPeriodOutput,
    comparison_preset: z.string().nullable(),
    metrics: z.array(z.string()),
    dimensions: z.array(z.string()),
    filters: z.array(filterOutput),
    attribution: z.string().nullable(),
    accuracy_requested: z.enum(["strict", "balanced"]),
    preset: z.object({ id: z.string(), version: z.number().int() }).nullable(),
  }),
  data: z.object({
    columns: columnsOutput,
    totals: z.record(z.string(), deltaOutput),
    rows: z.array(
      z.object({
        key: z.string(),
        dimensions: z.array(dimensionCellOutput),
        values: z.array(deltaOutput),
      }),
    ),
  }),
  quality: z.object({ baseline: qualityOutput, current: qualityOutput }),
  provenance: provenanceOutput,
  warnings: z.array(warningOutput),
});
export type ComparisonOutput = z.infer<typeof comparisonOutput>;
