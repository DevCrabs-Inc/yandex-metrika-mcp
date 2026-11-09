import { DomainError } from "../domain/errors.ts";
import type {
  ByTimeRequest,
  Clock,
  CounterInfo,
  DataRequest,
  FetchOptions,
  GoalInfo,
  MetrikaSource,
  SourceResponse,
} from "./ports.ts";

/** Counter settings, goals and the counter list. */
export const METADATA_TTL_SECONDS = 10 * 60;
/** Reports over complete days; requests that include today use a much shorter TTL. */
export const CLOSED_REPORT_TTL_SECONDS = 15 * 60;
export const OPEN_REPORT_TTL_SECONDS = 60;
const MAX_ENTRIES = 300;

interface Entry {
  readonly value: unknown;
  readonly fetchedAt: Date;
}

const STALE_OK: ReadonlySet<string> = new Set([
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "QUOTA_EXCEEDED",
]);

/**
 * In-memory cache in front of one connection generation. A new generation
 * (reconnect or disconnect) gets a new instance, so cached data never crosses
 * connections. Nothing is written to disk.
 */
export class CachedSource implements MetrikaSource {
  readonly kind: MetrikaSource["kind"];
  readonly adapterVersion: string;
  private readonly _inner: MetrikaSource;
  private readonly _clock: Clock;
  private readonly _entries = new Map<string, Entry>();

  constructor(inner: MetrikaSource, clock: Clock) {
    this._inner = inner;
    this._clock = clock;
    this.kind = inner.kind;
    this.adapterVersion = inner.adapterVersion;
  }

  clear(): void {
    this._entries.clear();
  }

  async listCounters(options?: FetchOptions): Promise<readonly CounterInfo[]> {
    return (
      await this._cached("counters", METADATA_TTL_SECONDS, options, async () => ({
        value: await this._inner.listCounters(options),
        fetchedAt: this._clock.now(),
      }))
    ).value as readonly CounterInfo[];
  }

  async getCounter(counterId: string, options?: FetchOptions): Promise<CounterInfo> {
    return (
      await this._cached(`counter:${counterId}`, METADATA_TTL_SECONDS, options, async () => ({
        value: await this._inner.getCounter(counterId, options),
        fetchedAt: this._clock.now(),
      }))
    ).value as CounterInfo;
  }

  async listGoals(counterId: string, options?: FetchOptions): Promise<readonly GoalInfo[]> {
    return (
      await this._cached(`goals:${counterId}`, METADATA_TTL_SECONDS, options, async () => ({
        value: await this._inner.listGoals(counterId, options),
        fetchedAt: this._clock.now(),
      }))
    ).value as readonly GoalInfo[];
  }

  getData(request: DataRequest, options?: FetchOptions): Promise<SourceResponse> {
    return this._report(`data:${JSON.stringify(request)}`, options, () =>
      this._inner.getData(request, options),
    );
  }

  getByTime(request: ByTimeRequest, options?: FetchOptions): Promise<SourceResponse> {
    return this._report(`bytime:${JSON.stringify(request)}`, options, () =>
      this._inner.getByTime(request, options),
    );
  }

  private async _report(
    key: string,
    options: FetchOptions | undefined,
    load: () => Promise<SourceResponse>,
  ): Promise<SourceResponse> {
    const ttl = options?.maxAgeSeconds ?? OPEN_REPORT_TTL_SECONDS;
    const result = await this._cached(key, ttl, options, async () => {
      const response = await load();
      return { value: response.body, fetchedAt: response.fetchedAt };
    });
    return {
      body: result.value,
      fetchedAt: result.fetchedAt,
      cacheHit: result.hit,
      stale: result.stale,
    };
  }

  private async _cached(
    key: string,
    ttlSeconds: number,
    options: FetchOptions | undefined,
    load: () => Promise<Entry>,
  ): Promise<Entry & { hit: boolean; stale: boolean }> {
    const mode = options?.cache ?? "default";
    const existing = this._entries.get(key);
    const age = existing
      ? (this._clock.now().getTime() - existing.fetchedAt.getTime()) / 1000
      : Infinity;
    if (existing && mode !== "refresh" && age <= ttlSeconds) {
      return { ...existing, hit: true, stale: false };
    }
    try {
      const entry = await load();
      this._remember(key, entry);
      return { ...entry, hit: false, stale: false };
    } catch (error) {
      if (
        mode === "allow_stale" &&
        existing &&
        error instanceof DomainError &&
        STALE_OK.has(error.code)
      ) {
        return { ...existing, hit: true, stale: true };
      }
      throw error;
    }
  }

  private _remember(key: string, entry: Entry): void {
    this._entries.delete(key);
    this._entries.set(key, entry);
    while (this._entries.size > MAX_ENTRIES) {
      const oldest = this._entries.keys().next().value;
      if (oldest === undefined) break;
      this._entries.delete(oldest);
    }
  }
}
