import type { DimensionDefinition, MetricDefinition } from "./catalog.ts";
import { rowKey, safeLabel } from "./privacy.ts";
import type { SamplingInfo } from "./quality.ts";
import type { Warning } from "./warnings.ts";

export interface DimensionCell {
  readonly id: string | null;
  readonly name: string | null;
  readonly redacted?: true;
  readonly truncated?: true;
}

export interface UpstreamDimensionValue {
  readonly id?: string | number | null | undefined;
  readonly name?: string | null | undefined;
}

export interface NormalizedDimensions {
  readonly key: string;
  readonly cells: readonly DimensionCell[];
  readonly redacted: boolean;
  /** Some label lost control or invisible characters. */
  readonly sanitized: boolean;
}

export function normalizeDimensions(
  values: readonly UpstreamDimensionValue[],
): NormalizedDimensions {
  const raw = values.map((v) => ({
    id: v.id === null || v.id === undefined ? null : String(v.id),
    name: v.name ?? null,
  }));
  let redacted = false;
  let sanitized = false;
  const cells = raw.map((value): DimensionCell => {
    const name = safeLabel(value.name);
    const id = safeLabel(value.id);
    const cellRedacted = name.redacted || id.redacted;
    const cellTruncated = name.truncated || id.truncated;
    redacted ||= cellRedacted;
    sanitized ||= name.sanitized || id.sanitized;
    return {
      id: id.name,
      name: name.name,
      ...(cellRedacted ? { redacted: true as const } : {}),
      ...(cellTruncated ? { truncated: true as const } : {}),
    };
  });
  return { key: rowKey(raw), cells, redacted, sanitized };
}

export function metricColumns(metrics: readonly MetricDefinition[]) {
  return metrics.map((m) => ({
    id: m.id,
    label: m.label,
    unit: m.unit,
    aggregation: m.aggregation,
  }));
}

export function dimensionColumns(dimensions: readonly DimensionDefinition[]) {
  return dimensions.map((d) => ({ id: d.id, label: d.label, sensitive: d.sensitive }));
}

export function totalsRecord(
  metrics: readonly MetricDefinition[],
  totals: readonly (number | null)[],
): Record<string, number | null> {
  return Object.fromEntries(metrics.map((m, i) => [m.id, totals[i] ?? null]));
}

export type TruncationReason = "page_limit" | "byte_budget" | "top_n";

export interface Quality extends SamplingInfo {
  readonly total_rows: number;
  readonly total_rows_rounded: boolean;
  readonly rows_complete: boolean;
  readonly truncated: boolean;
  readonly truncation_reason: TruncationReason | null;
  readonly period_complete: boolean;
  readonly data_lag_seconds: number | null;
  readonly contains_sensitive_data: boolean | null;
}

export interface UpstreamQualityFields {
  readonly total_rows: number;
  readonly total_rows_rounded?: boolean | undefined;
  readonly data_lag?: number | undefined;
  readonly contains_sensitive_data?: boolean | undefined;
}

export function buildQuality(
  upstream: UpstreamQualityFields,
  sampling: SamplingInfo,
  options: {
    readonly rowsComplete: boolean;
    readonly truncationReason: TruncationReason | null;
    readonly periodComplete: boolean;
  },
): Quality {
  return {
    sampled: sampling.sampled,
    sample_share: sampling.sample_share,
    sample_size: sampling.sample_size,
    sample_space: sampling.sample_space,
    total_rows: upstream.total_rows,
    total_rows_rounded: upstream.total_rows_rounded ?? false,
    rows_complete: options.rowsComplete,
    truncated: options.truncationReason !== null,
    truncation_reason: options.truncationReason,
    period_complete: options.periodComplete,
    data_lag_seconds: upstream.data_lag ?? null,
    contains_sensitive_data: upstream.contains_sensitive_data ?? null,
  };
}

/** Warnings derived from upstream quality metadata and the chosen fields. */
export function qualityWarnings(
  quality: Quality,
  context: {
    readonly metrics: readonly MetricDefinition[];
    readonly hasDimensions: boolean;
    readonly labelsRedacted: boolean;
    readonly labelsSanitized?: boolean;
  },
): Warning[] {
  const warnings: Warning[] = [];
  if (quality.total_rows_rounded) {
    warnings.push({
      code: "TOTAL_ROWS_ROUNDED",
      severity: "info",
      message:
        "The API reports an approximate row count; completeness cannot be proven by counting rows.",
      affected_fields: [],
    });
  }
  if (quality.data_lag_seconds !== null && quality.data_lag_seconds > 0) {
    warnings.push({
      code: "DATA_LAG",
      severity: "info",
      message: `The API reports a processing lag of ${quality.data_lag_seconds} s; recent visits may be missing.`,
      affected_fields: [],
    });
  }
  if (quality.contains_sensitive_data === true) {
    warnings.push({
      code: "PRIVACY_SUPPRESSION",
      severity: "warning",
      message: "The API hid some values for privacy; hidden values are not zeros.",
      affected_fields: [],
    });
  }
  if (context.labelsRedacted) {
    warnings.push({
      code: "LABELS_REDACTED",
      severity: "info",
      message: "Query strings and fragments were removed from URL labels (safe privacy mode).",
      affected_fields: [],
    });
  }
  if (context.labelsSanitized) {
    warnings.push({
      code: "LABELS_SANITIZED",
      severity: "info",
      message:
        "Control or invisible characters were removed from labels; such characters can hide text or instructions.",
      affected_fields: [],
    });
  }
  const nonAdditive = context.metrics.filter((m) => m.aggregation !== "additive");
  if (context.hasDimensions && nonAdditive.length > 0) {
    warnings.push({
      code: "NON_ADDITIVE_METRICS",
      severity: "info",
      message: "Do not sum or average these metrics across rows; use the totals instead.",
      affected_fields: nonAdditive.map((m) => m.id),
    });
  }
  return warnings;
}
