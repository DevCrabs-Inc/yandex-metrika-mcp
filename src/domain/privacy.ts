import { createHash } from "node:crypto";

export const MAX_LABEL_LENGTH = 300;

export interface SafeLabel {
  readonly name: string | null;
  readonly redacted: boolean;
  readonly truncated: boolean;
  /** Control or invisible characters were removed or replaced. */
  readonly sanitized: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
// Invisible characters that can hide text from a person or smuggle instructions to a
// model: soft hyphen, bidi marks, overrides and isolates, zero-width characters, word
// joiners, BOM, interlinear annotations and Unicode tag characters. ZWJ (U+200D) and
// variation selectors stay because emoji sequences need them.
const INVISIBLE =
  /[\u00ad\u061c\u180e\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}]/gu;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Prepares an external label (URL, UTM, title) for the model. Labels are data,
 * not instructions; safe mode drops URL query strings and fragments (D-09).
 * Empty or null labels are kept as null, never removed.
 */
export function safeLabel(value: string | null | undefined): SafeLabel {
  if (value === null || value === undefined || value === "") {
    return { name: null, redacted: false, truncated: false, sanitized: false };
  }
  let name = value.toWellFormed().replace(CONTROL, " ").replace(INVISIBLE, "");
  const sanitized = name !== value;
  let redacted = false;
  if (URL_LIKE.test(name)) {
    try {
      const url = new URL(name);
      const stripped = `${url.protocol}//${url.host}${url.pathname}`;
      redacted = url.search !== "" || url.hash !== "" || url.username !== "" || url.password !== "";
      name = stripped;
    } catch {
      name = "[unparseable URL]";
      redacted = true;
    }
  }
  const truncated = name.length > MAX_LABEL_LENGTH;
  if (truncated) name = `${cutAt(name, MAX_LABEL_LENGTH - 1)}…`;
  return { name, redacted, truncated, sanitized };
}

/** Cuts to at most `length` UTF-16 units without leaving half of a surrogate pair. */
function cutAt(text: string, length: number): string {
  const last = text.charCodeAt(length - 1);
  const splitsPair = last >= 0xd800 && last <= 0xdbff;
  return text.slice(0, splitsPair ? length - 1 : length);
}

/** Stable row identity from dimension IDs and raw values, computed before redaction. */
export function rowKey(
  dimensions: readonly { readonly id: string | null; readonly name: string | null }[],
): string {
  const canonical = JSON.stringify(dimensions.map((d) => [d.id, d.name]));
  return `r_${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}

const CLIENT_TOKEN = /[^A-Za-z0-9._@+-]+/g;
const MAX_CLIENT_TOKEN = 64;

const clientToken = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const token = value.replace(CLIENT_TOKEN, "_").slice(0, MAX_CLIENT_TOKEN);
  return token === "" || token === "_" ? null : token;
};

/**
 * The MCP client's self-reported name and version, reduced to characters that are
 * safe in a log line and a User-Agent comment. Missing or empty values give null.
 */
export function safeClientInfo(raw: unknown): { name: string; version: string } | null {
  if (raw === null || typeof raw !== "object") return null;
  const info = raw as { name?: unknown; version?: unknown };
  const name = clientToken(info.name);
  if (name === null) return null;
  return { name, version: clientToken(info.version) ?? "unknown" };
}
