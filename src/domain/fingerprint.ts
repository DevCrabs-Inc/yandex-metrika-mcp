import { createHash } from "node:crypto";

type Canonical = null | boolean | number | string | Canonical[] | { [key: string]: Canonical };

function canonicalize(value: unknown): Canonical {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Cannot fingerprint a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object") {
    const out: { [key: string]: Canonical } = {};
    for (const key of Object.keys(value).sort()) {
      const item = (value as Record<string, unknown>)[key];
      if (item !== undefined) out[key] = canonicalize(item);
    }
    return out;
  }
  throw new TypeError(`Cannot fingerprint a value of type ${typeof value}`);
}

/** Deterministic hash of normalized query conditions; must never include secrets. */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  return `fp_${createHash("sha256").update(json).digest("hex").slice(0, 32)}`;
}
