import type { Clock, Sleep } from "../../app/ports.ts";
import { DomainError } from "../../domain/errors.ts";

/**
 * Product limits, deliberately below the documented Yandex quotas (3 parallel
 * requests and 200 /stat/v1/data calls per 5 minutes per user, 30 requests
 * per second per IP).
 */
export interface QuotaLimits {
  readonly maxConcurrent: number;
  readonly statWindowMs: number;
  readonly statMaxInWindow: number;
  readonly perSecond: number;
}

export const DEFAULT_QUOTA_LIMITS: QuotaLimits = {
  maxConcurrent: 2,
  statWindowMs: 5 * 60 * 1000,
  statMaxInWindow: 180,
  perSecond: 10,
};

interface OwnerState {
  active: number;
  statStarts: number[];
}

export interface AcquireOptions {
  /** Counts against the /stat/v1/data budget. */
  readonly stat: boolean;
  /** Background work leaves one slot free for interactive calls. */
  readonly priority: "interactive" | "background";
  /** Epoch ms after which waiting is pointless for the caller. */
  readonly deadline: number;
  readonly signal?: AbortSignal;
}

const POLL_MS = 100;

/**
 * Shared queue per quota owner (one Yandex account). It never retries on its
 * own; it only delays dispatch or reports when a slot will be free.
 */
export class QuotaScheduler {
  private readonly _limits: QuotaLimits;
  private readonly _clock: Clock;
  private readonly _sleep: Sleep;
  private readonly _owners = new Map<string, OwnerState>();
  private _recent: number[] = [];

  constructor(clock: Clock, sleep: Sleep, limits: QuotaLimits = DEFAULT_QUOTA_LIMITS) {
    this._clock = clock;
    this._sleep = sleep;
    this._limits = limits;
  }

  /** Waits for a slot and returns its release function. */
  async acquire(owner: string, options: AcquireOptions): Promise<() => void> {
    const state = this._owner(owner);
    for (;;) {
      const now = this._clock.now().getTime();
      const readyAt = this._readyAt(state, options, now);
      if (readyAt <= now) {
        state.active += 1;
        if (options.stat) state.statStarts.push(now);
        this._recent.push(now);
        let released = false;
        return () => {
          if (released) return;
          released = true;
          state.active -= 1;
        };
      }
      if (readyAt > options.deadline) {
        throw new DomainError(
          "QUOTA_EXCEEDED",
          "The request budget for this Yandex account is used up for now.",
          {
            retryAt: new Date(Math.max(readyAt, now + 1000)).toISOString(),
            nextAction:
              "Wait until retry_at, or narrow the request. Exports continue automatically.",
          },
        );
      }
      await this._sleep(Math.min(POLL_MS, Math.max(1, readyAt - now)), options.signal);
    }
  }

  /** Earliest time a request may start; `now` means immediately. */
  private _readyAt(state: OwnerState, options: AcquireOptions, now: number): number {
    const limits = this._limits;
    this._recent = this._recent.filter((t) => t > now - 1000);
    state.statStarts = state.statStarts.filter((t) => t > now - limits.statWindowMs);
    let readyAt = now;
    const slots =
      options.priority === "background" ? limits.maxConcurrent - 1 : limits.maxConcurrent;
    if (state.active >= Math.max(1, slots)) readyAt = now + POLL_MS;
    if (options.stat && state.statStarts.length >= limits.statMaxInWindow) {
      readyAt = Math.max(readyAt, (state.statStarts[0] ?? now) + limits.statWindowMs);
    }
    if (this._recent.length >= limits.perSecond) {
      readyAt = Math.max(readyAt, (this._recent[0] ?? now) + 1000);
    }
    return readyAt;
  }

  private _owner(owner: string): OwnerState {
    let state = this._owners.get(owner);
    if (!state) {
      state = { active: 0, statStarts: [] };
      this._owners.set(owner, state);
    }
    return state;
  }
}
