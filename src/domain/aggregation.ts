import type { MetricDefinition } from "./catalog.ts";
import { clean } from "./delta.ts";

/** Rows of a disjoint grouping may be summed only for additive metrics (D-04). */
export function isSummable(metric: Pick<MetricDefinition, "aggregation">): boolean {
  return metric.aggregation === "additive";
}

/**
 * Sums bucket or row values when that is mathematically valid. Returns null for
 * non-additive metrics, or when any value is unknown.
 */
export function sumIfAdditive(
  metric: Pick<MetricDefinition, "aggregation">,
  values: readonly (number | null)[],
): number | null {
  if (!isSummable(metric)) return null;
  let total = 0;
  for (const value of values) {
    if (value === null) return null;
    total += value;
  }
  return clean(total);
}

export type MissingReason = "confirmed_zero" | "not_in_fetched_rows";

export interface MissingRowValue {
  readonly value: 0 | null;
  readonly reason: MissingReason;
}

/**
 * Value to use when a segment exists in one period but not in the other (D-07).
 * A missing row means zero only when the fetched set is known to be complete,
 * the metric is an additive count and nothing was suppressed.
 */
export function missingRowValue(
  metric: Pick<MetricDefinition, "aggregation">,
  context: { readonly rowsComplete: boolean; readonly containsSensitiveData: boolean | null },
): MissingRowValue {
  if (context.rowsComplete && context.containsSensitiveData === false && isSummable(metric)) {
    return { value: 0, reason: "confirmed_zero" };
  }
  return { value: null, reason: "not_in_fetched_rows" };
}
