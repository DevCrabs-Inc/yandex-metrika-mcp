import { z } from "zod";
import {
  columnsOutput,
  connectionIdInput,
  counterIdInput,
  counterRefOutput,
  cursorInput,
  DEFAULT_PAGE_LIMIT,
  dimensionCellOutput,
  fieldsInput,
  filterOutput,
  MAX_PAGE_LIMIT,
  periodInput,
  provenanceOutput,
  qualityOutput,
  resolvedPeriodOutput,
  warningOutput,
} from "./common.ts";

export const reportInput = z.strictObject({
  connection_id: connectionIdInput,
  counter_id: counterIdInput,
  period: periodInput.optional(),
  ...fieldsInput,
  sort: z
    .array(z.string())
    .max(5)
    .optional()
    .describe("Field IDs; prefix with '-' for descending. Default: first metric descending."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe(`Rows per page, default ${DEFAULT_PAGE_LIMIT}.`),
  cursor: cursorInput.optional().describe("next_cursor from a previous identical call."),
});
export type ReportInput = z.infer<typeof reportInput>;

export const resolvedQueryOutput = z.object({
  connection_id: z.string(),
  counter: counterRefOutput,
  period: resolvedPeriodOutput,
  metrics: z.array(z.string()),
  dimensions: z.array(z.string()),
  filters: z.array(filterOutput),
  sort: z.array(z.string()),
  attribution: z.string().nullable(),
  accuracy_requested: z.enum(["strict", "balanced"]),
  preset: z.object({ id: z.string(), version: z.number().int() }).nullable(),
});

export const reportRowOutput = z.object({
  key: z.string(),
  dimensions: z.array(dimensionCellOutput),
  values: z.array(z.number().nullable()),
});

export const reportOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("report"),
  status: z.enum(["success", "empty"]),
  request_id: z.string(),
  query: resolvedQueryOutput,
  data: z.object({
    columns: columnsOutput,
    rows: z.array(reportRowOutput),
    first_row: z.number().int().describe("1-based position of the first returned row."),
    totals: z
      .record(z.string(), z.number().nullable())
      .describe("Totals over all rows, from the API (not a sum of returned rows)."),
  }),
  quality: qualityOutput,
  provenance: provenanceOutput,
  warnings: z.array(warningOutput),
  next_cursor: z.string().nullable(),
});
export type ReportOutput = z.infer<typeof reportOutput>;
