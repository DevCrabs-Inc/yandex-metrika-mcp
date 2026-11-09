import { z } from "zod";
import { LOG_LEVELS } from "../infra/log/logger.ts";
import { defaultDataDir } from "../infra/paths.ts";
import { DEFAULT_CLIENT_ID, DEFAULT_REDIRECT_PORTS } from "./oauth-app.ts";

const booleanFlag = z
  .enum(["true", "false", "1", "0", "yes", "no"])
  .transform((v) => v === "true" || v === "1" || v === "yes");

const ports = z
  .string()
  .regex(/^\d{2,5}(,\d{2,5})*$/, "comma-separated ports")
  .transform((v) => v.split(",").map(Number));

const counterList = z
  .string()
  .regex(/^\d{1,12}(,\d{1,12})*$/, "comma-separated counter IDs")
  .transform((v) => v.split(","));

const envSchema = z.object({
  YM_MCP_LOG_LEVEL: z.enum(LOG_LEVELS).default("info"),
  YM_MCP_DEMO: booleanFlag.default(true),
  YM_MCP_DATA_DIR: z.string().min(1).optional(),
  YM_MCP_SECRET_STORE: z.enum(["auto", "keychain", "file"]).default("auto"),
  YM_MCP_CLIENT_ID: z
    .string()
    .regex(/^[A-Za-z0-9]{16,64}$/, "a Yandex OAuth client ID")
    .optional(),
  YM_MCP_OAUTH_PORTS: ports.optional(),
  YANDEX_METRIKA_TOKEN: z.string().min(10).optional(),
  YM_MCP_ALLOWED_COUNTERS: counterList.optional(),
  YM_MCP_API_LANG: z.enum(["ru", "en"]).default("ru"),
  YM_MCP_PRIVACY: z.enum(["safe", "full"]).default("safe"),
  YM_MCP_AUTO_RESUME: booleanFlag.default(false),
});

export interface AppConfig {
  readonly logLevel: (typeof LOG_LEVELS)[number];
  readonly demoEnabled: boolean;
  readonly dataDir: string;
  readonly secretStore: "auto" | "keychain" | "file";
  readonly clientId: string | null;
  readonly redirectPorts: readonly number[];
  readonly envToken: string | null;
  readonly envAllowedCounters: readonly string[] | null;
  readonly apiLang: "ru" | "en";
  readonly privacy: "safe" | "full";
  readonly autoResume: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

const KEYS = Object.keys(envSchema.shape) as (keyof typeof envSchema.shape)[];
const LOWERCASE = new Set(["YM_MCP_DEMO", "YM_MCP_AUTO_RESUME"]);

/** Reads optional settings; a missing value never blocks startup, an invalid one does. */
export function loadConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AppConfig {
  const raw: Record<string, string | undefined> = {};
  for (const key of KEYS) {
    const value = env[key]?.trim();
    raw[key] = value ? (LOWERCASE.has(key) ? value.toLowerCase() : value) : undefined;
  }
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    // Never echo values: YANDEX_METRIKA_TOKEN is one of them.
    throw new ConfigError(
      `Invalid configuration: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unknown error"}`,
    );
  }
  const c = parsed.data;
  return {
    logLevel: c.YM_MCP_LOG_LEVEL,
    demoEnabled: c.YM_MCP_DEMO,
    dataDir: c.YM_MCP_DATA_DIR ?? defaultDataDir(env),
    secretStore: c.YM_MCP_SECRET_STORE,
    clientId: c.YM_MCP_CLIENT_ID ?? DEFAULT_CLIENT_ID,
    redirectPorts: c.YM_MCP_OAUTH_PORTS ?? DEFAULT_REDIRECT_PORTS,
    envToken: c.YANDEX_METRIKA_TOKEN ?? null,
    envAllowedCounters: c.YM_MCP_ALLOWED_COUNTERS ?? null,
    apiLang: c.YM_MCP_API_LANG,
    privacy: c.YM_MCP_PRIVACY,
    autoResume: c.YM_MCP_AUTO_RESUME,
  };
}
