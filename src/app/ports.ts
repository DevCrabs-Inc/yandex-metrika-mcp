import type { IsoDate } from "../domain/dates.ts";
import type { FilterCondition } from "../domain/filters.ts";

export interface CounterInfo {
  readonly id: string;
  readonly name: string;
  readonly site: string;
  /** IANA time zone from counter settings; null when the API did not provide one. */
  readonly time_zone: string | null;
  readonly status: string;
  readonly permission: "own" | "edit" | "view" | "unknown";
}

export interface GoalInfo {
  readonly id: string;
  readonly name: string;
  readonly type: string;
}

/** Reporting API `accuracy` parameter. */
export type UpstreamAccuracy = "full" | "medium";

export interface DataRequest {
  readonly counterId: string;
  readonly date1: IsoDate;
  readonly date2: IsoDate;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly FilterCondition[];
  readonly sort: readonly string[];
  readonly limit: number;
  /** 1-based, as in the Reporting API. */
  readonly offset: number;
  readonly accuracy: UpstreamAccuracy;
}

export interface ByTimeRequest {
  readonly counterId: string;
  readonly date1: IsoDate;
  readonly date2: IsoDate;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly FilterCondition[];
  readonly group: "day" | "week" | "month";
  readonly topKeys: number;
  readonly accuracy: UpstreamAccuracy;
}

/**
 * Read-only access to one Yandex account (or the synthetic demo). Report
 * methods return raw upstream JSON; callers validate it.
 */
export interface MetrikaSource {
  readonly kind: "demo" | "yandex";
  readonly adapterVersion: string;
  listCounters(): Promise<readonly CounterInfo[]>;
  /** Throws ACCESS_DENIED when the counter is not accessible. */
  getCounter(counterId: string): Promise<CounterInfo>;
  listGoals(counterId: string): Promise<readonly GoalInfo[]>;
  getData(request: DataRequest): Promise<unknown>;
  getByTime(request: ByTimeRequest): Promise<unknown>;
}

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
