import { createHmac, timingSafeEqual } from "node:crypto";
import { DomainError } from "./errors.ts";

export const CURSOR_TTL_MS = 30 * 60 * 1000;

interface CursorPayload {
  readonly v: 1;
  /** Query fingerprint the cursor belongs to. */
  readonly fp: string;
  /** Connection the cursor belongs to. */
  readonly conn: string;
  /** Zero-based row offset of the next page. */
  readonly off: number;
  /** Expiry, epoch milliseconds. */
  readonly exp: number;
}

export interface CursorBinding {
  readonly fingerprint: string;
  readonly connectionId: string;
}

const sign = (body: string, key: Uint8Array): string =>
  createHmac("sha256", key).update(body).digest("base64url");

/** Opaque, tamper-proof page cursor bound to one query and one connection. */
export function encodeCursor(
  binding: CursorBinding,
  offset: number,
  key: Uint8Array,
  now: Date,
): string {
  const payload: CursorPayload = {
    v: 1,
    fp: binding.fingerprint,
    conn: binding.connectionId,
    off: offset,
    exp: now.getTime() + CURSOR_TTL_MS,
  };
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(body, key)}`;
}

const mismatch = (): DomainError =>
  new DomainError("CURSOR_MISMATCH", "The cursor does not belong to this query.", {
    nextAction: "Repeat the request without a cursor.",
  });

/** Returns the zero-based offset encoded in a valid cursor. */
export function decodeCursor(
  cursor: string,
  binding: CursorBinding,
  key: Uint8Array,
  now: Date,
): number {
  const [body, signature, extra] = cursor.split(".");
  if (body === undefined || signature === undefined || extra !== undefined) throw mismatch();
  const expected = Buffer.from(sign(body, key));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw mismatch();
  let payload: CursorPayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
  } catch {
    throw mismatch();
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    payload.v !== 1 ||
    payload.fp !== binding.fingerprint ||
    payload.conn !== binding.connectionId ||
    !Number.isSafeInteger(payload.off) ||
    payload.off < 0
  ) {
    throw mismatch();
  }
  if (payload.exp <= now.getTime()) {
    throw new DomainError("CURSOR_EXPIRED", "The cursor has expired.", {
      nextAction: "Repeat the request without a cursor.",
    });
  }
  return payload.off;
}
