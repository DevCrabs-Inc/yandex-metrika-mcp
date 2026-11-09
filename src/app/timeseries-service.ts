import { sumIfAdditive } from "../domain/aggregation.ts";
import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import {
  DEFAULT_TOP_KEYS,
  MAX_TIMESERIES_DIMENSIONS,
  type TimeseriesInput,
  type TimeseriesOutput,
} from "../domain/contract/timeseries.ts";
import { invalidQuery } from "../domain/errors.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import {
  buildQuality,
  dimensionColumns,
  metricColumns,
  normalizeDimensions,
  qualityWarnings,
} from "../domain/normalize.ts";
import { periodWarnings, resolvePeriod } from "../domain/periods.ts";
import { enforceAccuracy, readSampling } from "../domain/quality.ts";
import {
  assertGroupable,
  bucketsFromIntervals,
  calendarBuckets,
  type TimeGroup,
} from "../domain/timeline.ts";
import { numericByTime, parseUpstreamByTime, precisionWarning } from "../domain/upstream.ts";
import type { Warning } from "../domain/warnings.ts";
import {
  demoWarning,
  newRequestId,
  provenance,
  reportFetchOptions,
  staleWarnings,
} from "./common.ts";
import type { ConnectionResolver } from "./connections.ts";
import type { Clock } from "./ports.ts";
import { loadCounterContext, planFields, toPeriodSpec, upstreamAccuracy } from "./query-planner.ts";

export const MAX_BUCKETS = 400;

export interface TimeseriesServiceDeps {
  readonly connections: ConnectionResolver;
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
    assertGroupable(period, group);
    const expected = calendarBuckets(period, group, ctx.today);
    if (expected.length > MAX_BUCKETS) {
      throw invalidQuery(
        `Too many ${group} buckets (${expected.length}, max ${MAX_BUCKETS}).`,
        "Use group='week' or group='month', or a shorter period.",
      );
    }
    const fields = planFields(input, ctx.goalNames, MAX_TIMESERIES_DIMENSIONS);
    const hasDimensions = fields.dimensions.length > 0;
    if (!hasDimensions && input.top_keys !== undefined) {
      throw invalidQuery("top_keys applies only with dimensions.");
    }
    const topKeys = hasDimensions ? (input.top_keys ?? DEFAULT_TOP_KEYS) : null;

    const raw = await connection.source.getByTime(
      {
        counterId: ctx.counter.id,
        date1: period.start,
        date2: period.end,
        metrics: fields.metrics.map((m) => m.id),
        dimensions: fields.dimensions.map((d) => d.id),
        filters: fields.filters,
        group,
        topKeys: topKeys ?? 1,
        accuracy: upstreamAccuracy(fields.accuracy),
      },
      reportFetchOptions(period.complete, input.cache),
    );
    const { data: upstream, approximated } = numericByTime(
      parseUpstreamByTime(
        raw.body,
        fields.metrics.length,
        fields.dimensions.length,
        expected.length,
      ),
    );
    const sampling = readSampling(upstream);
    const samplingWarnings = enforceAccuracy(sampling, fields.accuracy);
    const fromApi = upstream.time_intervals !== undefined;
    const buckets = fromApi
      ? bucketsFromIntervals(upstream.time_intervals ?? [], period, group, ctx.today)
      : expected;

    const series = hasDimensions
      ? upstream.data.map((row) => ({
          dims: normalizeDimensions(row.dimensions),
          values: row.metrics,
        }))
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
      ...staleWarnings([raw], clock.now()),
      ...(approximated ? [precisionWarning] : []),
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
        attribution: null,
        accuracy_requested: fields.accuracy,
        preset: fields.preset,
        top_keys: topKeys,
      },
      data: {
        columns: {
          dimensions: dimensionColumns(fields.dimensions),
          metrics: metricColumns(fields.metrics),
        },
        axis_source: fromApi ? "api" : "calendar",
        buckets,
        totals: upstream.totals,
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
        raw,
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
        clock.now(),
      ),
      warnings,
    };
  }
}
