export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogFields = Readonly<Record<string, unknown>>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

const SECRET_KEY = /token|secret|authorization|password|cookie|code_verifier|^code$/i;
const SECRET_VALUE = /\b(OAuth|Bearer)\s+[\w.-]+/gi;
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/gi;

function redact(value: unknown, key = ""): unknown {
  if (SECRET_KEY.test(key)) return "[redacted]";
  if (typeof value === "string") {
    return value.replace(SECRET_VALUE, "$1 [redacted]").replace(URL_QUERY, "$1?[redacted]");
  }
  if (value instanceof Error) return { name: value.name, message: redact(value.message) };
  if (Array.isArray(value)) return value.map((v) => redact(v));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  }
  return value;
}

/**
 * JSON-lines logger on stderr. stdout belongs to the MCP protocol and must
 * never receive diagnostics.
 */
export function createLogger(
  level: LogLevel,
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (lvl: LogLevel, message: string, fields: LogFields = {}) => {
    if (LOG_LEVELS.indexOf(lvl) < threshold) return;
    const entry = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact(message),
      ...(redact(fields) as object),
    };
    write(`${JSON.stringify(entry)}\n`);
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}
