import { z } from "zod";
import { LOG_LEVELS } from "../infra/log/logger.ts";

const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const envSchema = z.object({
  YM_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  YM_MCP_DEMO: booleanFlag.default(true),
});

export interface AppConfig {
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly demoEnabled: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** Reads optional settings; a missing value never blocks startup, an invalid one does. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse({
    YM_MCP_LOG_LEVEL: env["YM_MCP_LOG_LEVEL"] || undefined,
    YM_MCP_DEMO: env["YM_MCP_DEMO"]?.toLowerCase() || undefined,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(
      `Invalid configuration: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown error"}`,
    );
  }
  return { logLevel: parsed.data.YM_MCP_LOG_LEVEL, demoEnabled: parsed.data.YM_MCP_DEMO };
}
