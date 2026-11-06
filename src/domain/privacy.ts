import { createHash } from "node:crypto";

export const MAX_LABEL_LENGTH = 300;

export interface SafeLabel {
  readonly name: string | null;
  readonly redacted: boolean;
  readonly truncated: boolean;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Prepares an external label (URL, UTM, title) for the model. Labels are data,
 * not instructions; safe mode drops URL query strings and fragments (D-09).
 * Empty or null labels are kept as null, never removed.
 */
export function safeLabel(value: string | null | undefined): SafeLabel {
  if (value === null || value === undefined || value === "") {
    return { name: null, redacted: false, truncated: false };
  }
  let name = value.replace(CONTROL, " ");
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
  if (truncated) name = `${name.slice(0, MAX_LABEL_LENGTH - 1)}…`;
  return { name, redacted, truncated };
}

/** Stable row identity from dimension IDs and raw values, computed before redaction. */
export function rowKey(
  dimensions: readonly { readonly id: string | null; readonly name: string | null }[],
): string {
  const canonical = JSON.stringify(dimensions.map((d) => [d.id, d.name]));
  return `r_${createHash("sha256").update(canonical).digest("hex").slice(0, 16)}`;
}
