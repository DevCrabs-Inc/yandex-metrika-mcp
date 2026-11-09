import { DEFAULT_PAGE_LIMIT, SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { ReportInput, ReportOutput } from "../domain/contract/report.ts";
import { decodeCursor, encodeCursor } from "../domain/cursor.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import {
  buildQuality,
  dimensionColumns,
  metricColumns,
  normalizeDimensions,
  qualityWarnings,
  type TruncationReason,
  totalsRecord,
} from "../domain/normalize.ts";
import { periodWarnings, resolvePeriod } from "../domain/periods.ts";
import { enforceAccuracy, readSampling } from "../domain/quality.ts";
import {
  numericData,
  parseUpstreamData,
  precisionWarning,
  schemaChanged,
} from "../domain/upstream.ts";
import {
  demoWarning,
  jsonBytes,
  newRequestId,
  provenance,
  reportFetchOptions,
  STRUCTURED_BUDGET_BYTES,
  staleWarnings,
} from "./common.ts";
import type { ConnectionResolver } from "./connections.ts";
import type { Clock } from "./ports.ts";
import {
  loadCounterContext,
  planFields,
  planSort,
  toPeriodSpec,
  upstreamAccuracy,
} from "./query-planner.ts";

export interface ReportServiceDeps {
  readonly connections: ConnectionResolver;
  readonly clock: Clock;
  readonly cursorKey: Uint8Array;
}

export class ReportService {
  private readonly _deps: ReportServiceDeps;

  constructor(deps: ReportServiceDeps) {
    this._deps = deps;
  }

  async run(input: ReportInput): Promise<ReportOutput> {
    const { connections, clock, cursorKey } = this._deps;
    const connection = connections.get(input.connection_id);
    const ctx = await loadCounterContext(connection, input.counter_id, clock);
    const period = resolvePeriod(toPeriodSpec(input.period, "last_7_complete_days"), ctx);
    const fields = planFields(input, ctx.goalNames);
    const sort = planSort(input.sort, fields);
    const hasDimensions = fields.dimensions.length > 0;
    const queryFingerprint = fingerprint({
      connection: connection.id,
      counter: ctx.counter.id,
      start: period.start,
      end: period.end,
      time_zone: period.time_zone,
      metrics: fields.metrics.map((m) => m.id),
      dimensions: fields.dimensions.map((d) => d.id),
      filters: fields.filters,
      sort,
      accuracy: fields.accuracy,
    });
    const binding = { fingerprint: queryFingerprint, connectionId: connection.id };
    const offset =
      input.cursor === undefined ? 0 : decodeCursor(input.cursor, binding, cursorKey, clock.now());
    const limit = input.limit ?? DEFAULT_PAGE_LIMIT;

    const raw = await connection.source.getData(
      {
        counterId: ctx.counter.id,
        date1: period.start,
        date2: period.end,
        metrics: fields.metrics.map((m) => m.id),
        dimensions: fields.dimensions.map((d) => d.id),
        filters: fields.filters,
        sort,
        limit,
        offset: offset + 1,
        accuracy: upstreamAccuracy(fields.accuracy),
      },
      reportFetchOptions(period.complete, input.cache),
    );
    const exact = parseUpstreamData(raw.body, fields.metrics.length, fields.dimensions.length);
    const { data: upstream, approximated } = numericData(exact);
    const sampling = readSampling(upstream);
    const samplingWarnings = enforceAccuracy(sampling, fields.accuracy);

    const upstreamRows = hasDimensions ? upstream.data : [];
    if (upstreamRows.length > limit) {
      throw schemaChanged(`the API returned ${upstreamRows.length} rows for limit ${limit}`);
    }
    if (hasDimensions && upstreamRows.length === 0 && offset < upstream.total_rows) {
      throw schemaChanged("an empty page was returned although more rows were expected");
    }
    const normalized = upstreamRows.map((row) => ({
      dims: normalizeDimensions(row.dimensions),
      values: row.metrics,
    }));
    const labelsRedacted = normalized.some((r) => r.dims.redacted);
    const labelsSanitized = normalized.some((r) => r.dims.sanitized);
    const totals = totalsRecord(fields.metrics, upstream.totals);

    const build = (rowCount: number, truncationReason: TruncationReason | null): ReportOutput => {
      const rows = normalized.slice(0, rowCount);
      const nextOffset = offset + rows.length;
      const moreRows = hasDimensions && rows.length > 0 && nextOffset < upstream.total_rows;
      const quality = buildQuality(upstream, sampling, {
        rowsComplete: !hasDimensions || (!moreRows && !upstream.total_rows_rounded && offset === 0),
        truncationReason: moreRows ? (truncationReason ?? "page_limit") : truncationReason,
        periodComplete: period.complete,
      });
      const empty = hasDimensions
        ? upstream.total_rows === 0
        : upstream.totals.every((value) => value === 0);
      return {
        schema_version: SCHEMA_VERSION,
        kind: "report",
        status: empty ? "empty" : "success",
        request_id: newRequestId(),
        query: {
          connection_id: connection.id,
          counter: { id: ctx.counter.id, name: ctx.counter.name, site: ctx.counter.site },
          period,
          metrics: fields.metrics.map((m) => m.id),
          dimensions: fields.dimensions.map((d) => d.id),
          filters: fields.filters.map((f) => ({ ...f, values: [...f.values] })),
          sort,
          attribution: upstream.query?.attribution ?? null,
          accuracy_requested: fields.accuracy,
          preset: fields.preset,
        },
        data: {
          columns: {
            dimensions: dimensionColumns(fields.dimensions),
            metrics: metricColumns(fields.metrics),
          },
          rows: rows.map((r) => ({
            key: r.dims.key,
            dimensions: [...r.dims.cells],
            values: [...r.values],
          })),
          first_row: offset + 1,
          totals,
        },
        quality,
        provenance: provenance(connection, "stat/v1/data", raw, queryFingerprint, clock.now()),
        warnings: [
          ...demoWarning(connection),
          ...periodWarnings(period, "The period", ctx),
          ...staleWarnings([raw], clock.now()),
          ...(approximated ? [precisionWarning] : []),
          ...samplingWarnings,
          ...qualityWarnings(quality, {
            metrics: fields.metrics,
            hasDimensions,
            labelsRedacted,
            labelsSanitized,
          }),
        ],
        next_cursor: moreRows ? encodeCursor(binding, nextOffset, cursorKey, clock.now()) : null,
      };
    };

    let output = build(normalized.length, null);
    let rowCount = normalized.length;
    while (jsonBytes(output) > STRUCTURED_BUDGET_BYTES && rowCount > 1) {
      rowCount = Math.max(1, Math.floor(rowCount * 0.8));
      output = build(rowCount, "byte_budget");
    }
    return output;
  }
}
