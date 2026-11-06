import type { CallToolResult } from "@modelcontextprotocol/server";
import { newRequestId } from "../app/common.ts";
import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { ErrorOutput } from "../domain/contract/meta.ts";
import { DomainError } from "../domain/errors.ts";
import type { Logger } from "../infra/log/logger.ts";
import { renderError } from "./render.ts";

export function toErrorOutput(error: unknown): ErrorOutput {
  const known = error instanceof DomainError;
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
 * Runs a tool body and maps the outcome onto the MCP result envelope: domain
 * failures become `isError` results with a typed code, never protocol errors.
 */
export async function runTool<T extends Record<string, unknown>>(
  tool: string,
  logger: Logger,
  body: () => Promise<T> | T,
  render: (output: T) => string,
): Promise<CallToolResult> {
  const started = performance.now();
  try {
    const output = await body();
    logger.info("tool call", {
      tool,
      status: "ok",
      latency_ms: Math.round(performance.now() - started),
    });
    return { content: [{ type: "text", text: render(output) }], structuredContent: output };
  } catch (error) {
    const output = toErrorOutput(error);
    const fields = {
      tool,
      status: "error",
      error_code: output.error.code,
      request_id: output.request_id,
      latency_ms: Math.round(performance.now() - started),
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
