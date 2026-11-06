import type { MetricDefinition } from "./catalog.ts";

export type DeltaReason = "zero_baseline" | "unknown_value" | null;

export interface Delta {
  readonly baseline: number | null;
  readonly current: number | null;
  readonly delta_abs: number | null;
  /** Relative change in percent of the baseline. */
  readonly delta_pct: number | null;
  /** Change in percentage points; only for percent metrics. */
  readonly delta_pp: number | null;
  readonly reason: DeltaReason;
}

/** Removes binary floating point noise (0.30000000000000004) without losing real precision. */
export function clean(value: number): number {
  return Number(value.toPrecision(15));
}

/**
 * Period-over-period change (D-07). Unknown inputs stay unknown; a zero
 * baseline has no relative change.
 */
export function computeDelta(
  baseline: number | null,
  current: number | null,
  metric: Pick<MetricDefinition, "unit">,
): Delta {
  if (baseline === null || current === null) {
    return {
      baseline,
      current,
      delta_abs: null,
      delta_pct: null,
      delta_pp: null,
      reason: "unknown_value",
    };
  }
  const deltaAbs = clean(current - baseline);
  const deltaPp = metric.unit === "percent" ? deltaAbs : null;
  if (baseline === 0) {
    return {
      baseline,
      current,
      delta_abs: deltaAbs,
      delta_pct: null,
      delta_pp: deltaPp,
      reason: "zero_baseline",
    };
  }
  return {
    baseline,
    current,
    delta_abs: deltaAbs,
    delta_pct: clean(((current - baseline) / Math.abs(baseline)) * 100),
    delta_pp: deltaPp,
    reason: null,
  };
}
