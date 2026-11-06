import { z } from "zod";
import {
  columnsOutput,
  connectionIdInput,
  counterIdInput,
  counterRefOutput,
  dimensionCellOutput,
  fieldsInput,
  filterOutput,
  periodInput,
  provenanceOutput,
  qualityOutput,
  resolvedPeriodOutput,
  warningOutput,
} from "./common.ts";

export const TIME_GROUPS = ["day", "week", "month"] as const;
export type TimeGroup = (typeof TIME_GROUPS)[number];
export const MAX_TOP_KEYS = 10;
export const DEFAULT_TOP_KEYS = 5;
export const MAX_TIMESERIES_DIMENSIONS = 2;

export const timeseriesInput = z.object({
  connection_id: connectionIdInput,
  counter_id: counterIdInput,
  period: periodInput.optional(),
  group: z.enum(TIME_GROUPS).optional().describe("Bucket size, default day."),
  ...fieldsInput,
  top_keys: z
    .number()
    .int()
    .min(1)
    .max(MAX_TOP_KEYS)
    .optional()
    .describe(
      `With dimensions: number of segment series (largest first), default ${DEFAULT_TOP_KEYS}.`,
    ),
});
export type TimeseriesInput = z.infer<typeof timeseriesInput>;

const seriesValues = z.array(z.array(z.number().nullable()));

export const timeseriesOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("timeseries"),
  status: z.enum(["success", "empty"]),
  request_id: z.string(),
  query: z.object({
    connection_id: z.string(),
    counter: counterRefOutput,
    period: resolvedPeriodOutput,
    group: z.enum(TIME_GROUPS),
    metrics: z.array(z.string()),
    dimensions: z.array(z.string()),
    filters: z.array(filterOutput),
    attribution: z.string().nullable(),
    accuracy_requested: z.enum(["strict", "balanced"]),
    preset: z.object({ id: z.string(), version: z.number().int() }).nullable(),
    top_keys: z.number().int().nullable(),
  }),
  data: z.object({
    columns: columnsOutput,
    buckets: z.array(
      z.object({
        start: z.string(),
        end: z.string(),
        complete: z.boolean().describe("False if the bucket includes today."),
        partial: z
          .boolean()
          .describe("True if the period clips the bucket (shorter than a full week/month)."),
      }),
    ),
    totals: seriesValues.describe("Per metric, one value per bucket, over all data."),
    period_totals: z
      .record(z.string(), z.number().nullable())
      .describe(
        "Whole-period totals; null where buckets cannot be summed (users, rates, averages).",
      ),
    series: z
      .array(
        z.object({
          key: z.string(),
          dimensions: z.array(dimensionCellOutput),
          values: seriesValues,
        }),
      )
      .describe("Top segment series; their sum is not the total."),
  }),
  quality: qualityOutput,
  provenance: provenanceOutput,
  warnings: z.array(warningOutput),
});
export type TimeseriesOutput = z.infer<typeof timeseriesOutput>;
