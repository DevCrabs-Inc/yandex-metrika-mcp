export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_EXPIRED",
  "AUTH_NOT_CONFIGURED",
  "ACCESS_DENIED",
  "COUNTER_NOT_ALLOWED",
  "INVALID_QUERY",
  "UNSUPPORTED_COMBINATION",
  "QUALITY_REQUIREMENT_NOT_MET",
  "TIMEZONE_UNKNOWN",
  "QUOTA_EXCEEDED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "UPSTREAM_SCHEMA_CHANGED",
  "RESULT_LIMIT_REACHED",
  "CURSOR_EXPIRED",
  "CURSOR_MISMATCH",
  "JOB_NOT_FOUND",
  "ARTIFACT_NOT_FOUND",
  "ARTIFACT_EXPIRED",
  "STORAGE_LIMIT",
  "IDEMPOTENCY_CONFLICT",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const RETRYABLE: ReadonlySet<ErrorCode> = new Set([
  "QUOTA_EXCEEDED",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
]);

export type ErrorDetailValue = string | number | boolean | null;

export interface DomainErrorOptions {
  readonly nextAction?: string;
  readonly retryAt?: string;
  readonly details?: Readonly<Record<string, ErrorDetailValue>>;
  readonly cause?: unknown;
}

/**
 * An expected, user-explainable failure. Messages must be safe to show to the
 * model: no tokens, request headers or raw upstream bodies.
 */
export class DomainError extends Error {
  override readonly name = "DomainError";
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly retryAt: string | null;
  readonly nextAction: string | null;
  readonly details: Readonly<Record<string, ErrorDetailValue>>;

  constructor(code: ErrorCode, message: string, options: DomainErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    this.retryable = RETRYABLE.has(code);
    this.retryAt = options.retryAt ?? null;
    this.nextAction = options.nextAction ?? null;
    this.details = options.details ?? {};
  }
}

export const invalidQuery = (message: string, nextAction?: string): DomainError =>
  new DomainError("INVALID_QUERY", message, nextAction === undefined ? {} : { nextAction });
