export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class HttpTimeoutError extends Error {
  override readonly name = "HttpTimeoutError";
}

export class HttpNetworkError extends Error {
  override readonly name = "HttpNetworkError";
}

export class HttpBodyTooLargeError extends Error {
  override readonly name = "HttpBodyTooLargeError";
}

export interface HttpRequest {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly timeoutMs: number;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpBodyTooLargeError(`Response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * One HTTP exchange with a hard deadline, a response size cap and no
 * redirects, so credentials are never forwarded to another host.
 */
export async function httpRequest(
  fetchImpl: FetchLike,
  request: HttpRequest,
): Promise<HttpResponse> {
  const timeout = AbortSignal.timeout(request.timeoutMs);
  const signal = request.signal ? AbortSignal.any([timeout, request.signal]) : timeout;
  try {
    const init: RequestInit = {
      method: request.method,
      headers: request.headers,
      redirect: "error",
      signal,
      ...(request.body === undefined ? {} : { body: request.body }),
    };
    const response = await fetchImpl(request.url, init);
    const text = await readCapped(response, request.maxBytes);
    return { status: response.status, headers: response.headers, text };
  } catch (error) {
    if (request.signal?.aborted) throw request.signal.reason;
    if (timeout.aborted)
      throw new HttpTimeoutError(`Request timed out after ${request.timeoutMs} ms`);
    if (error instanceof HttpBodyTooLargeError) throw error;
    throw new HttpNetworkError(error instanceof Error ? error.name : "network error");
  }
}

type ReviverWithSource = (key: string, value: unknown, context?: { source?: string }) => unknown;

/**
 * Parses JSON keeping integers beyond 2^53 exact as digit strings (T27).
 * Relies on JSON.parse source text access, available in Node 22.
 */
export function parseJsonPreservingIntegers(text: string): unknown {
  const reviver: ReviverWithSource = (_key, value, context) => {
    if (
      typeof value === "number" &&
      Number.isInteger(value) &&
      !Number.isSafeInteger(value) &&
      context?.source !== undefined &&
      /^-?\d+$/.test(context.source)
    ) {
      return context.source;
    }
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

/** Parses a Retry-After header (seconds or HTTP date) into epoch milliseconds. */
export function retryAfterMs(header: string | null, now: Date): number | null {
  if (header === null || header.trim() === "") return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return now.getTime() + seconds * 1000;
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : date;
}
