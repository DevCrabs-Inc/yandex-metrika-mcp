import { z } from "zod";
import { ERROR_CODES } from "../errors.ts";
import { connectionIdInput, counterIdInput, provenanceOutput, warningOutput } from "./common.ts";

export const statusInput = z.object({
  connection_id: connectionIdInput.optional().describe("Limit the status to one connection."),
});

export const connectionOutput = z.object({
  connection_id: z.string(),
  alias: z.string(),
  kind: z.enum(["demo", "env", "oauth", "token"]),
  state: z.enum(["active", "needs_reconnect"]),
  token_expires_at: z.string().nullable(),
  allowed_counters: z
    .array(z.string())
    .nullable()
    .describe("null: every counter the account can see."),
});

export const statusOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("status"),
  server: z.object({ name: z.string(), version: z.string() }),
  capabilities: z.object({
    tools: z.array(z.string()),
    prompts: z.array(z.string()),
    browser_sign_in: z.boolean(),
    demo: z.boolean(),
    exports: z.boolean(),
    read_only: z.literal(true),
  }),
  connections: z.array(connectionOutput),
  pending_sign_ins: z.array(
    z.object({ status: z.string(), expires_at: z.string(), connection_id: z.string().nullable() }),
  ),
  jobs: z.record(z.string(), z.number().int()).describe("Export jobs by state."),
  next_actions: z.array(z.string()),
  notes: z.array(z.string()),
});
export type StatusOutput = z.infer<typeof statusOutput>;

export const CATALOG_KINDS = ["presets", "metrics", "dimensions", "periods"] as const;

export const catalogInput = z.object({
  kind: z.enum(CATALOG_KINDS).describe("What to list."),
  search: z.string().max(100).optional().describe("Case-insensitive substring filter."),
});

export const catalogOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("catalog"),
  catalog_kind: z.enum(CATALOG_KINDS),
  catalog_version: z.string(),
  items: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      details: z.record(
        z.string(),
        z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
      ),
    }),
  ),
  notes: z.array(z.string()),
});
export type CatalogOutput = z.infer<typeof catalogOutput>;

export const listCountersInput = z.object({
  connection_id: connectionIdInput,
  search: z.string().max(100).optional().describe("Substring of counter name, site or ID."),
  cursor: z.string().max(2000).optional(),
});

export const counterOutput = z.object({
  id: z.string(),
  name: z.string(),
  site: z.string(),
  time_zone: z.string().nullable(),
  status: z.string(),
  permission: z.enum(["own", "edit", "view", "unknown"]),
});

export const listCountersOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("counters"),
  connection_id: z.string(),
  counters: z.array(counterOutput),
  total: z.number().int(),
  next_cursor: z.string().nullable(),
  provenance: provenanceOutput,
  warnings: z.array(warningOutput),
});
export type ListCountersOutput = z.infer<typeof listCountersOutput>;

export const describeCounterInput = z.object({
  connection_id: connectionIdInput,
  counter_id: counterIdInput,
});

export const describeCounterOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("counter"),
  connection_id: z.string(),
  counter: counterOutput,
  goals: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      duplicate_name: z.boolean().describe("Another goal has the same name: refer to goals by ID."),
    }),
  ),
  provenance: provenanceOutput,
  warnings: z.array(warningOutput),
});
export type DescribeCounterOutput = z.infer<typeof describeCounterOutput>;

export const errorOutput = z.object({
  schema_version: z.string(),
  kind: z.literal("error"),
  status: z.literal("error"),
  request_id: z.string(),
  error: z.object({
    code: z.enum(ERROR_CODES),
    message: z.string(),
    retryable: z.boolean(),
    retry_at: z.string().nullable(),
    next_action: z.string().nullable(),
  }),
});
export type ErrorOutput = z.infer<typeof errorOutput>;
