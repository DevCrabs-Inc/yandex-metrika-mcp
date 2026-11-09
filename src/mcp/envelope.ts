import type { CallToolResult } from "@modelcontextprotocol/server";
import { jsonBytes, newRequestId } from "../app/common.ts";
import type { ClientInfo } from "../app/ports.ts";
import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { ErrorOutput } from "../domain/contract/meta.ts";
import { DomainError } from "../domain/errors.ts";
import type { Logger } from "../infra/log/logger.ts";
import { renderError } from "./render.ts";

function errorDetails(error: DomainError): ErrorOutput["error"]["details"] {
  const details = {
    ...error.details,
    ...(error.field === null ? {} : { field: error.field }),
    ...(error.candidates.length === 0 ? {} : { candidates: [...error.candidates] }),
    ...(error.upstreamMessage === null ? {} : { upstream_message: error.upstreamMessage }),
  };
  // zod infers the catchall as an index signature that also covers `candidates`,
  // which no value can satisfy; the runtime shape matches errorOutput.
  return Object.keys(details).length === 0
    ? undefined
    : (details as ErrorOutput["error"]["details"]);
}

export function toErrorOutput(error: unknown): ErrorOutput {
  const known = error instanceof DomainError;
  const details = known ? errorDetails(error) : undefined;
  return {
    schema_version: SCHEMA_VERSION,
    kind: "error",
    status: "error",
    request_id: newRequestId(),
    error: known
      ? {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          retry_at: error.retryAt,
          next_action: error.nextAction,
          ...(details === undefined ? {} : { details }),
        }
      : {
          code: "INTERNAL_ERROR",
          message: "Unexpected server error. Details were written to the server log (stderr).",
          retryable: false,
          retry_at: null,
          next_action: "Run `yandex-metrika-mcp doctor` and report the issue with the request_id.",
        },
  };
}

/**
 * Replaces lone UTF-16 surrogates in every string. Some clients reject the whole
 * message, and drop the transport, when a result contains half of a surrogate pair.
 */
export function wellFormedDeep<T>(value: T): T {
  if (typeof value === "string") return value.toWellFormed() as T;
  if (Array.isArray(value)) return value.map(wellFormedDeep) as T;
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k.toWellFormed(), wellFormedDeep(v)]),
    ) as T;
  }
  return value;
}

/**
 * Runs a tool body and maps the outcome onto the MCP result envelope: domain
 * failures become `isError` results with a typed code, never protocol errors.
 */
/**
 * Size and shape facts for the log line, so the response budget and preview size can
 * be tuned from real use. Never labels, counter IDs or values (06).
 */
function resultFields(output: Record<string, unknown>, text: string): Record<string, unknown> {
  const data = output["data"] as { rows?: unknown } | undefined;
  const quality = output["quality"] as
    | { truncated?: unknown; current?: { truncated?: unknown } }
    | undefined;
  const truncated = quality?.truncated ?? quality?.current?.truncated;
  return {
    response_bytes: jsonBytes(output) + Buffer.byteLength(text, "utf8"),
    text_bytes: Buffer.byteLength(text, "utf8"),
    ...(Array.isArray(data?.rows) ? { rows_returned: data.rows.length } : {}),
    ...(typeof truncated === "boolean" ? { truncated } : {}),
  };
}

const clientFields = (client: ClientInfo | null): Record<string, string> =>
  client === null ? {} : { client_name: client.name, client_version: client.version };

export async function runTool<T extends Record<string, unknown>>(
  tool: string,
  logger: Logger,
  body: () => Promise<T> | T,
  render: (output: T) => string,
  client: ClientInfo | null = null,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const output = wellFormedDeep(await body());
    const text = render(output).toWellFormed();
    logger.info("tool call", {
      tool,
      status: "ok",
      latency_ms: Math.round(performance.now() - started),
      ...resultFields(output, text),
      ...clientFields(client),
    });
    return { content: [{ type: "text", text }], structuredContent: output };
  } catch (error) {
    const output = toErrorOutput(error);
    const fields = {
      tool,
      status: "error",
      error_code: output.error.code,
      request_id: output.request_id,
      latency_ms: Math.round(performance.now() - started),
      ...clientFields(client),
    };
    if (error instanceof DomainError) {
      logger.info("tool call", fields);
    } else {
      logger.error("tool call failed", {
        ...fields,
        error,
        stack: error instanceof Error ? error.stack : undefined,
      });
    }
    return {
      content: [{ type: "text", text: renderError(output) }],
      structuredContent: output,
      isError: true,
    };
  }
}
