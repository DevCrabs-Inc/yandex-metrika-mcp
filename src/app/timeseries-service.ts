import { sumIfAdditive } from "../domain/aggregation.ts";
import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import {
  DEFAULT_TOP_KEYS,
  MAX_TIMESERIES_DIMENSIONS,
  type TimeGroup,
  type TimeseriesInput,
  type TimeseriesOutput,
} from "../domain/contract/timeseries.ts";
import {
  addDays,
  daysInclusive,
  endOfMonth,
  type IsoDate,
  parseIsoDate,
  startOfMonth,
  toEpochDay,
} from "../domain/dates.ts";
import { invalidQuery } from "../domain/errors.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import {
  buildQuality,
  dimensionColumns,
  metricColumns,
  normalizeDimensions,
  qualityWarnings,
} from "../domain/normalize.ts";
import { periodWarnings, type ResolvedPeriod, resolvePeriod } from "../domain/periods.ts";
import { enforceAccuracy, readSampling } from "../domain/quality.ts";
import { parseUpstreamByTime, schemaChanged } from "../domain/upstream.ts";
import type { Warning } from "../domain/warnings.ts";
import { demoWarning, newRequestId, provenance } from "./common.ts";
import type { ConnectionRegistry } from "./connections.ts";
import type { Clock } from "./ports.ts";
import { loadCounterContext, planFields, toPeriodSpec, upstreamAccuracy } from "./query-planner.ts";

export const MAX_BUCKETS = 400;

export interface Bucket {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly complete: boolean;
  readonly partial: boolean;
}

function approximateBuckets(period: ResolvedPeriod, group: TimeGroup): number {
  if (group === "day") return period.days;
  if (group === "week") return Math.ceil(period.days / 7) + 1;
  const months =
    (Number(period.end.slice(0, 4)) - Number(period.start.slice(0, 4))) * 12 +
    Number(period.end.slice(5, 7)) -
    Number(period.start.slice(5, 7)) +
    1;
  return months;
}

/**
 * Uses the upstream time axis (D-08) after checking that it is ordered,
 * contiguous and inside the requested period.
 */
export function bucketsFromIntervals(
  intervals: readonly (readonly [string, string])[],
  period: ResolvedPeriod,
  group: TimeGroup,
  today: IsoDate,
): Bucket[] {
  const buckets: Bucket[] = [];
  let expectedStart: IsoDate = period.start;
  for (const [rawStart, rawEnd] of intervals) {
    const start = parseIsoDate(rawStart.slice(0, 10));
    const end = parseIsoDate(rawEnd.slice(0, 10));
    if (start === null || end === null || toEpochDay(start) > toEpochDay(end)) {
      throw schemaChanged(`invalid time interval [${rawStart}, ${rawEnd}]`);
    }
    if (start !== expectedStart) {
      throw schemaChanged(`time intervals are not contiguous at ${rawStart}`);
    }
    const days = daysInclusive(start, end);
    const partial =
      group === "week"
        ? days < 7
        : group === "month"
          ? start !== startOfMonth(start) || end !== endOfMonth(start)
          : false;
    buckets.push({ start, end, complete: toEpochDay(end) < toEpochDay(today), partial });
    expectedStart = addDays(end, 1);
  }
  if (buckets.length > 0 && addDays(expectedStart, -1) !== period.end) {
    throw schemaChanged("time intervals do not cover the requested period");
  }
  return buckets;
}

export interface TimeseriesServiceDeps {
  readonly connections: ConnectionRegistry;
  readonly clock: Clock;
}

export class TimeseriesService {
  private readonly _deps: TimeseriesServiceDeps;

  constructor(deps: TimeseriesServiceDeps) {
    this._deps = deps;
  }

  async run(input: TimeseriesInput): Promise<TimeseriesOutput> {
    const { connections, clock } = this._deps;
    const connection = connections.get(input.connection_id);
    const ctx = await loadCounterContext(connection, input.counter_id, clock);
    const period = resolvePeriod(toPeriodSpec(input.period, "last_28_complete_days"), ctx);
    const group: TimeGroup = input.group ?? "day";
    if (approximateBuckets(period, group) > MAX_BUCKETS) {
      throw invalidQuery(
        `Too many ${group} buckets for ${period.days} days (max ${MAX_BUCKETS}).`,
        "Use group='week' or group='month', or a shorter period.",
      );
    }
    const fields = planFields(input, ctx.goalNames, MAX_TIMESERIES_DIMENSIONS);
    const hasDimensions = fields.dimensions.length > 0;
    if (!hasDimensions && input.top_keys !== undefined) {
      throw invalidQuery("top_keys applies only with dimensions.");
    }
    const topKeys = hasDimensions ? (input.top_keys ?? DEFAULT_TOP_KEYS) : null;

    const raw = await connection.source.getByTime({
      counterId: ctx.counter.id,
      date1: period.start,
      date2: period.end,
      metrics: fields.metrics.map((m) => m.id),
      dimensions: fields.dimensions.map((d) => d.id),
      filters: fields.filters,
      group,
      topKeys: topKeys ?? 1,
      accuracy: upstreamAccuracy(fields.accuracy),
    });
    const fetchedAt = clock.now();
    const upstream = parseUpstreamByTime(raw, fields.metrics.length, fields.dimensions.length);
    const sampling = readSampling(upstream);
    const samplingWarnings = enforceAccuracy(sampling, fields.accuracy);
    const buckets = bucketsFromIntervals(upstream.time_intervals, period, group, ctx.today);

    const series = hasDimensions
      ? upstream.data.map((row) => {
          const dims = normalizeDimensions(row.dimensions);
          return { dims, values: row.metrics.map((values) => [...values]) };
        })
      : [];
    const limitedByTopN = hasDimensions && upstream.total_rows > series.length;
    const quality = buildQuality(upstream, sampling, {
      rowsComplete: !limitedByTopN,
      truncationReason: limitedByTopN ? "top_n" : null,
      periodComplete: period.complete,
    });
    const periodTotals = Object.fromEntries(
      fields.metrics.map((m, i) => [m.id, sumIfAdditive(m, upstream.totals[i] ?? [])]),
    );
    const warnings: Warning[] = [
      ...demoWarning(connection),
      ...periodWarnings(period, "The period", ctx),
      ...samplingWarnings,
      ...qualityWarnings(quality, {
        metrics: fields.metrics,
        hasDimensions,
        labelsRedacted: series.some((s) => s.dims.redacted),
      }),
    ];
    if (buckets.some((b) => b.partial)) {
      warnings.push({
        code: "PARTIAL_BUCKETS",
        severity: "info",
        message: `The period clips the first or last ${group}; compare those buckets with care.`,
        affected_fields: [],
      });
    }
    if (limitedByTopN) {
      warnings.push({
        code: "TOP_N_SERIES",
        severity: "info",
        message: `Showing the top ${series.length} of ${upstream.total_rows} segments; their sum is not the total.`,
        affected_fields: [],
      });
    }
    const empty = upstream.totals.every((values) => values.every((v) => v === 0));

    return {
      schema_version: SCHEMA_VERSION,
      kind: "timeseries",
      status: empty ? "empty" : "success",
      request_id: newRequestId(),
      query: {
        connection_id: connection.id,
        counter: { id: ctx.counter.id, name: ctx.counter.name, site: ctx.counter.site },
        period,
        group,
        metrics: fields.metrics.map((m) => m.id),
        dimensions: fields.dimensions.map((d) => d.id),
        filters: fields.filters.map((f) => ({ ...f, values: [...f.values] })),
        attribution: upstream.query?.attribution ?? null,
        accuracy_requested: fields.accuracy,
        preset: fields.preset,
        top_keys: topKeys,
      },
      data: {
        columns: {
          dimensions: dimensionColumns(fields.dimensions),
          metrics: metricColumns(fields.metrics),
        },
        buckets,
        totals: upstream.totals.map((values) => [...values]),
        period_totals: periodTotals,
        series: series.map((s) => ({
          key: s.dims.key,
          dimensions: [...s.dims.cells],
          values: s.values,
        })),
      },
      quality,
      provenance: provenance(
        connection,
        "stat/v1/data/bytime",
        fetchedAt,
        fingerprint({
          connection: connection.id,
          counter: ctx.counter.id,
          start: period.start,
          end: period.end,
          time_zone: period.time_zone,
          group,
          metrics: fields.metrics.map((m) => m.id),
          dimensions: fields.dimensions.map((d) => d.id),
          filters: fields.filters,
          accuracy: fields.accuracy,
          top_keys: topKeys,
        }),
      ),
      warnings,
    };
  }
}
