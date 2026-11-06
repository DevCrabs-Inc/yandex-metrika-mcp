import { missingRowValue } from "../domain/aggregation.ts";
import type { MetricDefinition } from "../domain/catalog.ts";
import { DEFAULT_PAGE_LIMIT, SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { ComparisonInput, ComparisonOutput } from "../domain/contract/comparison.ts";
import { computeDelta } from "../domain/delta.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import {
  buildQuality,
  type DimensionCell,
  dimensionColumns,
  metricColumns,
  normalizeDimensions,
  type Quality,
  qualityWarnings,
} from "../domain/normalize.ts";
import { comparisonWarnings, type ResolvedPeriod, resolveComparison } from "../domain/periods.ts";
import { enforceAccuracy, readSampling, type SamplingReading } from "../domain/quality.ts";
import { parseUpstreamData } from "../domain/upstream.ts";
import type { Warning } from "../domain/warnings.ts";
import { demoWarning, newRequestId, provenance } from "./common.ts";
import type { Connection, ConnectionRegistry } from "./connections.ts";
import type { Clock } from "./ports.ts";
import {
  type CounterContext,
  loadCounterContext,
  type PlannedFields,
  planFields,
  planSort,
  toComparisonSpec,
  upstreamAccuracy,
} from "./query-planner.ts";

/** Segment rows fetched per period to build the union of keys. */
export const COMPARISON_FETCH_ROWS = 100;
const SMALL_VOLUME_VISITS = 100;

interface PeriodData {
  readonly period: ResolvedPeriod;
  readonly totals: readonly (number | null)[];
  readonly rows: ReadonlyMap<
    string,
    { cells: readonly DimensionCell[]; values: readonly (number | null)[] }
  >;
  readonly order: readonly string[];
  readonly quality: Quality;
  readonly sampling: SamplingReading;
  readonly warnings: readonly Warning[];
  readonly labelsRedacted: boolean;
  readonly attribution: string | null;
}

export interface ComparisonServiceDeps {
  readonly connections: ConnectionRegistry;
  readonly clock: Clock;
}

export class ComparisonService {
  private readonly _deps: ComparisonServiceDeps;

  constructor(deps: ComparisonServiceDeps) {
    this._deps = deps;
  }

  async run(input: ComparisonInput): Promise<ComparisonOutput> {
    const { connections, clock } = this._deps;
    const connection = connections.get(input.connection_id);
    const ctx = await loadCounterContext(connection, input.counter_id, clock);
    const cmp = resolveComparison(toComparisonSpec(input.periods), ctx);
    const fields = planFields(input, ctx.goalNames);
    const sort = planSort(undefined, fields);

    // Sequential on purpose: both requests share the same per-user quota.
    const baseline = await this._fetch(connection, ctx, fields, sort, cmp.baseline);
    const current = await this._fetch(connection, ctx, fields, sort, cmp.current);
    const fetchedAt = clock.now();

    const metrics = fields.metrics;
    const totals = Object.fromEntries(
      metrics.map((m, i) => [
        m.id,
        computeDelta(baseline.totals[i] ?? null, current.totals[i] ?? null, m),
      ]),
    );

    const keys = [...new Set([...current.order, ...baseline.order])];
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;
    const rows = keys.slice(0, limit).map((key) => {
      const b = baseline.rows.get(key);
      const c = current.rows.get(key);
      const cells = c?.cells ?? b?.cells ?? [];
      const values = metrics.map((m, i) => {
        const side = (row: typeof b, data: PeriodData) => {
          if (row) return { value: row.values[i] ?? null, missing: false };
          const fallback = missingRowValue(m, {
            rowsComplete: data.quality.rows_complete,
            containsSensitiveData: data.quality.contains_sensitive_data,
          });
          return { value: fallback.value, missing: fallback.value === null };
        };
        const bv = side(b, baseline);
        const cv = side(c, current);
        const delta = computeDelta(bv.value, cv.value, m);
        return bv.missing || cv.missing
          ? { ...delta, reason: "not_in_fetched_rows" as const }
          : delta;
      });
      return { key, dimensions: [...cells], values };
    });

    const hasDimensions = fields.dimensions.length > 0;
    const unionComplete = baseline.quality.rows_complete && current.quality.rows_complete;
    const warnings: Warning[] = [
      ...demoWarning(connection),
      ...comparisonWarnings(cmp, ctx),
      ...baseline.warnings.map((w) => ({ ...w, message: `Baseline: ${w.message}` })),
      ...current.warnings.map((w) => ({ ...w, message: `Current: ${w.message}` })),
      ...qualityWarnings(current.quality, {
        metrics,
        hasDimensions,
        labelsRedacted: baseline.labelsRedacted || current.labelsRedacted,
      }).filter((w) => w.code === "NON_ADDITIVE_METRICS" || w.code === "LABELS_REDACTED"),
      ...this._extraWarnings(
        metrics,
        baseline,
        current,
        hasDimensions && !unionComplete,
        keys.length,
        rows.length,
      ),
    ];
    const allZero = (data: PeriodData) => data.totals.every((v) => v === 0);
    const status =
      allZero(baseline) && allZero(current)
        ? "empty"
        : hasDimensions && !unionComplete
          ? "partial"
          : "success";

    return {
      schema_version: SCHEMA_VERSION,
      kind: "comparison",
      status,
      request_id: newRequestId(),
      query: {
        connection_id: connection.id,
        counter: { id: ctx.counter.id, name: ctx.counter.name, site: ctx.counter.site },
        baseline: cmp.baseline,
        current: cmp.current,
        comparison_preset: cmp.preset,
        metrics: metrics.map((m) => m.id),
        dimensions: fields.dimensions.map((d) => d.id),
        filters: fields.filters.map((f) => ({ ...f, values: [...f.values] })),
        attribution: current.attribution ?? baseline.attribution,
        accuracy_requested: fields.accuracy,
        preset: fields.preset,
      },
      data: {
        columns: {
          dimensions: dimensionColumns(fields.dimensions),
          metrics: metricColumns(metrics),
        },
        totals,
        rows,
      },
      quality: { baseline: baseline.quality, current: current.quality },
      provenance: provenance(
        connection,
        "stat/v1/data x2",
        fetchedAt,
        fingerprint({
          connection: connection.id,
          counter: ctx.counter.id,
          baseline: [cmp.baseline.start, cmp.baseline.end],
          current: [cmp.current.start, cmp.current.end],
          time_zone: ctx.timeZone,
          metrics: metrics.map((m) => m.id),
          dimensions: fields.dimensions.map((d) => d.id),
          filters: fields.filters,
          accuracy: fields.accuracy,
        }),
      ),
      warnings,
    };
  }

  private async _fetch(
    connection: Connection,
    ctx: CounterContext,
    fields: PlannedFields,
    sort: readonly string[],
    period: ResolvedPeriod,
  ): Promise<PeriodData> {
    const hasDimensions = fields.dimensions.length > 0;
    const raw = await connection.source.getData({
      counterId: ctx.counter.id,
      date1: period.start,
      date2: period.end,
      metrics: fields.metrics.map((m) => m.id),
      dimensions: fields.dimensions.map((d) => d.id),
      filters: fields.filters,
      sort,
      limit: COMPARISON_FETCH_ROWS,
      offset: 1,
      accuracy: upstreamAccuracy(fields.accuracy),
    });
    const upstream = parseUpstreamData(raw, fields.metrics.length, fields.dimensions.length);
    const sampling = readSampling(upstream);
    const warnings = enforceAccuracy(sampling, fields.accuracy);
    const rows = new Map<
      string,
      { cells: readonly DimensionCell[]; values: readonly (number | null)[] }
    >();
    let labelsRedacted = false;
    if (hasDimensions) {
      for (const row of upstream.data) {
        const dims = normalizeDimensions(row.dimensions);
        labelsRedacted ||= dims.redacted;
        rows.set(dims.key, { cells: dims.cells, values: row.metrics });
      }
    }
    const complete =
      !hasDimensions || (!upstream.total_rows_rounded && rows.size >= upstream.total_rows);
    return {
      period,
      totals: upstream.totals,
      rows,
      order: [...rows.keys()],
      quality: buildQuality(upstream, sampling, {
        rowsComplete: complete,
        truncationReason: complete ? null : "top_n",
        periodComplete: period.complete,
      }),
      sampling,
      warnings,
      labelsRedacted,
      attribution: upstream.query?.attribution ?? null,
    };
  }

  private _extraWarnings(
    metrics: readonly MetricDefinition[],
    baseline: PeriodData,
    current: PeriodData,
    topNOnly: boolean,
    segments: number,
    returned: number,
  ): Warning[] {
    const warnings: Warning[] = [];
    if (topNOnly) {
      warnings.push({
        code: "TOP_N_COMPARISON",
        severity: "warning",
        message: `Segments were compared within the top ${COMPARISON_FETCH_ROWS} rows of each period. A segment missing from one side is unknown, not zero. Totals are exact API totals.`,
        affected_fields: [],
      });
    }
    if (returned < segments) {
      warnings.push({
        code: "ROWS_LIMITED",
        severity: "info",
        message: `Showing ${returned} of ${segments} compared segments; raise limit (max 200) to see more.`,
        affected_fields: [],
      });
    }
    const bs = baseline.sampling.sample_share;
    const cs = current.sampling.sample_share;
    if (bs !== null && cs !== null && bs !== cs) {
      warnings.push({
        code: "SAMPLE_SHARE_DIFFERS",
        severity: "warning",
        message: `Periods use different sample shares (${bs} vs ${cs}); small changes may be noise.`,
        affected_fields: [],
      });
    }
    const visitsIndex = metrics.findIndex((m) => m.id === "ym:s:visits");
    if (visitsIndex >= 0) {
      const b = baseline.totals[visitsIndex];
      const c = current.totals[visitsIndex];
      if (typeof b === "number" && typeof c === "number" && Math.max(b, c) < SMALL_VOLUME_VISITS) {
        warnings.push({
          code: "SMALL_VOLUME",
          severity: "warning",
          message: `Fewer than ${SMALL_VOLUME_VISITS} visits per period: percentage changes are not evidence of a stable trend.`,
          affected_fields: ["ym:s:visits"],
        });
      }
    }
    return warnings;
  }
}
