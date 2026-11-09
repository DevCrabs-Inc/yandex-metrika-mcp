import type {
  ByTimeRequest,
  Clock,
  CounterInfo,
  DataRequest,
  GoalInfo,
  MetrikaSource,
  SourceResponse,
} from "../app/ports.ts";
import {
  addDays,
  daysInclusive,
  endOfMonth,
  type IsoDate,
  startOfIsoWeek,
  todayIn,
  toEpochDay,
} from "../domain/dates.ts";
import { DomainError } from "../domain/errors.ts";
import { type FilterCondition, matchesFilter } from "../domain/filters.ts";
import { buildCells, type Cell, DEMO_COUNTERS, type DemoCounter, type DimValue } from "./model.ts";

/**
 * Deterministic synthetic data shaped exactly like Reporting API responses, so
 * the demo exercises the same validation and normalization as live data.
 */

const ACC_BASE = 6; // visits, pageviews, bounces, duration, daily users, daily new users
const ACC_PER_GOAL = 3; // target visits, reaches, daily converted users
const SAMPLE_SHARE = 0.25;

function fmix(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

const noise = (a: number, b: number, c: number): number =>
  fmix(Math.imul(a, 0x9e3779b1) ^ fmix(Math.imul(b, 0x85ebca77) ^ fmix(c))) / 0x1_0000_0000;

/** Rounds to an integer with probability proportional to the fraction, deterministically. */
const stochasticRound = (value: number, u: number): number => {
  const floor = Math.floor(value);
  return floor + (u < value - floor ? 1 : 0);
};

const round4 = (value: number): number => Math.round(value * 10_000) / 10_000;

/** Share of daily users who are distinct over a longer period. */
const uniqueness = (days: number): number => 1 / (1 + 0.12 * Math.log(Math.max(1, days)));
const CROSS_SEGMENT_OVERLAP = 0.96;

type MetricReader = (acc: Float64Array, days: number, isTotal: boolean) => number;

function metricReader(id: string, counter: DemoCounter): MetricReader {
  const ratio =
    (num: number, den: number, scale = 1): MetricReader =>
    (acc) =>
      (acc[den] ?? 0) > 0 ? round4(((acc[num] ?? 0) / (acc[den] ?? 1)) * scale) : 0;
  const users =
    (index: number): MetricReader =>
    (acc, days, isTotal) =>
      Math.round((acc[index] ?? 0) * uniqueness(days) * (isTotal ? CROSS_SEGMENT_OVERLAP : 1));
  switch (id) {
    case "ym:s:visits":
      return (acc) => acc[0] ?? 0;
    case "ym:s:pageviews":
      return (acc) => acc[1] ?? 0;
    case "ym:s:users":
      return users(4);
    case "ym:s:bounceRate":
      return ratio(2, 0, 100);
    case "ym:s:pageDepth":
      return ratio(1, 0);
    case "ym:s:avgVisitDurationSeconds":
      return ratio(3, 0);
    case "ym:s:percentNewVisitors":
      return ratio(5, 4, 100);
  }
  const match = /^ym:s:goal(\d+)(reaches|visits|conversionRate|users)$/.exec(id);
  const goalIndex = counter.goals.findIndex((g) => g.id === match?.[1]);
  if (!match || goalIndex < 0) {
    throw new DomainError("UNSUPPORTED_COMBINATION", `The demo source does not model ${id}.`);
  }
  const base = ACC_BASE + goalIndex * ACC_PER_GOAL;
  switch (match[2]) {
    case "visits":
      return (acc) => acc[base] ?? 0;
    case "reaches":
      return (acc) => acc[base + 1] ?? 0;
    case "conversionRate":
      return ratio(base, 0, 100);
    default:
      return users(base + 2);
  }
}

/** Fills `values` with one cell's synthetic metrics for one day; false when there were no visits. */
function simulateCellDay(
  counter: DemoCounter,
  cell: Cell,
  day: number,
  dayVisits: number,
  values: Float64Array,
): boolean {
  const seed = counter.seed ^ cell.index;
  const expected = dayVisits * cell.weight * (0.5 + noise(seed, day, 1));
  const visits = stochasticRound(expected, noise(seed, day, 2));
  if (visits === 0) return false;
  values.fill(0);
  values[0] = visits;
  values[1] = stochasticRound(visits * cell.depth, noise(seed, day, 3));
  values[2] = stochasticRound(visits * cell.bounce, noise(seed, day, 4));
  values[3] = visits * cell.duration * (0.8 + 0.4 * noise(seed, day, 5));
  const users = Math.max(1, stochasticRound(visits * 0.88, noise(seed, day, 6)));
  values[4] = users;
  values[5] = stochasticRound(users * 0.62, noise(seed, day, 8));
  counter.goalRates.forEach((rate, g) => {
    const base = ACC_BASE + g * ACC_PER_GOAL;
    const conversions = stochasticRound(visits * rate * cell.conversion, noise(seed, day, 10 + g));
    const target = Math.min(visits, conversions);
    values[base] = target;
    values[base + 1] = target + stochasticRound(target * 0.25, noise(seed, day, 20 + g));
    values[base + 2] = Math.min(target, stochasticRound(target * 0.95, noise(seed, day, 30 + g)));
  });
  return true;
}

function addInto(target: Float64Array | undefined, values: Float64Array): void {
  if (!target) return;
  for (let k = 0; k < values.length; k++) target[k] = (target[k] ?? 0) + (values[k] ?? 0);
}

interface SortKey {
  readonly desc: boolean;
  readonly metric: number;
  readonly dimension: number;
}

interface SortableRow {
  readonly dimensions: readonly DimValue[];
  readonly metrics: number[];
}

function compareNames(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a.localeCompare(b);
}

function compareByKey(a: SortableRow, b: SortableRow, key: SortKey): number {
  if (key.metric >= 0) return (a.metrics[key.metric] ?? 0) - (b.metrics[key.metric] ?? 0);
  if (key.dimension >= 0) {
    return compareNames(
      a.dimensions[key.dimension]?.name ?? null,
      b.dimensions[key.dimension]?.name ?? null,
    );
  }
  return 0;
}

interface Group {
  readonly dims: readonly DimValue[];
  readonly acc: Float64Array;
}

export class DemoSource implements MetrikaSource {
  readonly kind = "demo";
  readonly adapterVersion = "demo-1";
  private readonly _clock: Clock;
  private readonly _cells = new Map<string, readonly Cell[]>();

  constructor(clock: Clock) {
    this._clock = clock;
  }

  async listCounters(): Promise<readonly CounterInfo[]> {
    return DEMO_COUNTERS.map((c) => c.info);
  }

  async getCounter(counterId: string): Promise<CounterInfo> {
    return this._counter(counterId).info;
  }

  async listGoals(counterId: string): Promise<readonly GoalInfo[]> {
    return this._counter(counterId).goals;
  }

  async getData(request: DataRequest): Promise<SourceResponse> {
    const counter = this._counter(request.counterId);
    const readers = request.metrics.map((id) => metricReader(id, counter));
    const days = daysInclusive(request.date1, request.date2);
    const { groups, total } = this._aggregate(counter, request, [[request.date1, request.date2]]);
    const read = (acc: Float64Array, isTotal: boolean) => readers.map((r) => r(acc, days, isTotal));
    const totals = read(total[0] ?? new Float64Array(), true);

    if (request.dimensions.length === 0) {
      return this._envelope(counter, request, days, {
        data: [{ dimensions: [], metrics: totals }],
        totals,
        total_rows: 1,
      });
    }
    const rows = [...groups.values()]
      .filter((g) => (g.acc[0] ?? 0) > 0)
      .map((g) => ({ dimensions: g.dims, metrics: read(g.acc, false) }));
    rows.sort(this._comparator(request.sort, request.metrics, request.dimensions));
    return this._envelope(counter, request, days, {
      data: rows.slice(request.offset - 1, request.offset - 1 + request.limit),
      totals,
      total_rows: rows.length,
    });
  }

  async getByTime(request: ByTimeRequest): Promise<SourceResponse> {
    const counter = this._counter(request.counterId);
    const readers = request.metrics.map((id) => metricReader(id, counter));
    const intervals = this._intervals(request.date1, request.date2, request.group);
    const periodDays = daysInclusive(request.date1, request.date2);
    const perBucket = this._aggregate(counter, request, intervals);
    const whole = this._aggregate(counter, request, [[request.date1, request.date2]]);
    const series = (accs: readonly Float64Array[], isTotal: boolean) =>
      readers.map((r) =>
        accs.map((acc, i) => {
          const [start, end] = intervals[i] ?? [request.date1, request.date1];
          return r(acc, daysInclusive(start, end), isTotal);
        }),
      );

    let data: { dimensions: readonly DimValue[]; metrics: number[][] }[] = [];
    let totalRows = 1;
    if (request.dimensions.length > 0) {
      const firstReader = readers[0];
      const ranked = [...whole.groups.entries()]
        .filter(([, g]) => (g.acc[0] ?? 0) > 0)
        .sort(
          ([, a], [, b]) =>
            (firstReader?.(b.acc, periodDays, false) ?? 0) -
            (firstReader?.(a.acc, periodDays, false) ?? 0),
        );
      totalRows = ranked.length;
      data = ranked.slice(0, request.topKeys).map(([key, g]) => ({
        dimensions: g.dims,
        metrics: series(perBucket.groupsByBucket.get(key) ?? [], false),
      }));
    }
    return this._envelope(counter, request, periodDays, {
      data,
      totals: series(perBucket.total, true),
      total_rows: totalRows,
    });
  }

  private _counter(counterId: string): DemoCounter {
    const counter = DEMO_COUNTERS.find((c) => c.info.id === counterId);
    if (!counter) {
      throw new DomainError(
        "ACCESS_DENIED",
        `No access to counter ${counterId} through this connection.`,
        {
          nextAction: "Call metrika_list_counters to see accessible counters.",
        },
      );
    }
    return counter;
  }

  private _cellsFor(counter: DemoCounter): readonly Cell[] {
    let cells = this._cells.get(counter.info.id);
    if (!cells) {
      cells = buildCells(counter.info.site);
      this._cells.set(counter.info.id, cells);
    }
    return cells;
  }

  /** Expected visits for the whole site on a day; today is scaled by the elapsed share of the day. */
  private _dayVisits(counter: DemoCounter, date: IsoDate, today: IsoDate): number {
    const epochDay = toEpochDay(date);
    const weekday = ((epochDay % 7) + 7 + 3) % 7; // 0 = Monday
    const weekly = [1.08, 1.1, 1.06, 1.02, 0.95, 0.82, 0.86][weekday] ?? 1;
    const season = 1 + 0.12 * Math.sin((2 * Math.PI * epochDay) / 365.25);
    const trend = 1 + 0.0004 * (epochDay - 20_454); // ~ +15% per year from 2026-01-01
    const jitter = 0.88 + 0.24 * noise(counter.seed, epochDay, 7);
    const value = counter.baseDailyVisits * weekly * season * Math.max(0.2, trend) * jitter;
    if (date !== today) return value;
    const now = this._clock.now();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: counter.info.time_zone ?? "UTC",
      hour: "numeric",
      minute: "numeric",
      hourCycle: "h23",
    }).formatToParts(now);
    const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
    const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
    return value * ((hour * 60 + minute) / 1440);
  }

  private _aggregate(
    counter: DemoCounter,
    request: {
      readonly dimensions: readonly string[];
      readonly filters: readonly FilterCondition[];
    },
    intervals: readonly (readonly [IsoDate, IsoDate])[],
  ): {
    groups: Map<string, Group>;
    total: Float64Array[];
    groupsByBucket: Map<string, Float64Array[]>;
  } {
    const accSize = ACC_BASE + counter.goals.length * ACC_PER_GOAL;
    const today = todayIn(counter.info.time_zone ?? "UTC", this._clock.now());
    const matches = (cell: Cell) =>
      request.filters.every((f) => {
        const value = cell.dims[f.dimension] ?? { id: null, name: null };
        return matchesFilter(f, value.id) || matchesFilter(f, value.name);
      });
    const cells = this._cellsFor(counter).filter(matches);
    const groups = new Map<string, Group>();
    const groupsByBucket = new Map<string, Float64Array[]>();
    const cellGroupKey = cells.map((cell) => {
      const dims = request.dimensions.map((d) => cell.dims[d] ?? { id: null, name: null });
      const key = JSON.stringify(dims.map((d) => [d.id, d.name]));
      if (!groups.has(key)) {
        groups.set(key, { dims, acc: new Float64Array(accSize) });
        groupsByBucket.set(
          key,
          intervals.map(() => new Float64Array(accSize)),
        );
      }
      return key;
    });
    const total = intervals.map(() => new Float64Array(accSize));
    const values = new Float64Array(accSize);

    intervals.forEach(([start, end], bucket) => {
      for (let day = toEpochDay(start); day <= toEpochDay(end); day++) {
        const date = addDays(start, day - toEpochDay(start));
        const dayVisits = this._dayVisits(counter, date, today);
        cells.forEach((cell, i) => {
          if (!simulateCellDay(counter, cell, day, dayVisits, values)) return;
          const key = cellGroupKey[i] ?? "";
          addInto(groups.get(key)?.acc, values);
          addInto(groupsByBucket.get(key)?.[bucket], values);
          addInto(total[bucket], values);
        });
      }
    });
    return { groups, total, groupsByBucket };
  }

  private _intervals(
    start: IsoDate,
    end: IsoDate,
    group: ByTimeRequest["group"],
  ): (readonly [IsoDate, IsoDate])[] {
    const intervals: (readonly [IsoDate, IsoDate])[] = [];
    let cursor = start;
    while (toEpochDay(cursor) <= toEpochDay(end)) {
      const natural =
        group === "day"
          ? cursor
          : group === "week"
            ? addDays(startOfIsoWeek(cursor), 6)
            : endOfMonth(cursor);
      const bucketEnd = toEpochDay(natural) > toEpochDay(end) ? end : natural;
      intervals.push([cursor, bucketEnd]);
      cursor = addDays(bucketEnd, 1);
    }
    return intervals;
  }

  private _comparator(
    sort: readonly string[],
    metrics: readonly string[],
    dimensions: readonly string[],
  ): (a: SortableRow, b: SortableRow) => number {
    const keys = sort.map((item): SortKey => {
      const desc = item.startsWith("-");
      const field = desc ? item.slice(1) : item;
      return { desc, metric: metrics.indexOf(field), dimension: dimensions.indexOf(field) };
    });
    return (a, b) => {
      for (const key of keys) {
        const diff = compareByKey(a, b, key);
        if (diff !== 0) return key.desc ? -diff : diff;
      }
      return 0;
    };
  }

  private _envelope(
    counter: DemoCounter,
    request: { readonly date2: IsoDate; readonly accuracy: string | null },
    days: number,
    body: Record<string, unknown>,
  ): SourceResponse {
    const today = todayIn(counter.info.time_zone ?? "UTC", this._clock.now());
    const sampled = counter.sampledAboveDays !== null && days > counter.sampledAboveDays;
    const upstream = {
      ...body,
      total_rows_rounded: false,
      sampled,
      sample_share: sampled ? SAMPLE_SHARE : 1,
      data_lag: request.date2 === today ? 300 : 0,
      contains_sensitive_data: false,
      query: { accuracy: request.accuracy ?? "default" },
    };
    return { body: upstream, fetchedAt: this._clock.now(), cacheHit: false, stale: false };
  }
}
