import type { Candidate } from "./suggest.ts";

/**
 * Curated catalog of Reporting API fields this server understands. Field IDs
 * follow the official Yandex Metrika API; semantics drive how totals and
 * deltas may be computed (see docs/spec, D-04).
 */

export const CATALOG_VERSION = "2026.11-static.1";

export type MetricUnit = "count" | "percent" | "seconds" | "pages";

/**
 * - additive: rows of a disjoint grouping sum to the total (visits).
 * - non_additive: rows overlap, never sum them (users).
 * - rate: a percentage with its own numerator/denominator (bounce rate).
 * - average: a weighted mean (page depth, visit duration).
 */
export type MetricAggregation = "additive" | "non_additive" | "rate" | "average";

export interface MetricDefinition {
  readonly id: string;
  readonly label: string;
  readonly unit: MetricUnit;
  readonly aggregation: MetricAggregation;
  readonly description: string;
  readonly goal_id: string | null;
}

export interface DimensionDefinition {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** Values may contain personal data or free text (URLs, phrases). */
  readonly sensitive: boolean;
}

const metric = (
  id: string,
  label: string,
  unit: MetricUnit,
  aggregation: MetricAggregation,
  description: string,
): MetricDefinition => ({ id, label, unit, aggregation, description, goal_id: null });

export const METRICS: readonly MetricDefinition[] = [
  metric("ym:s:visits", "Visits", "count", "additive", "Number of sessions."),
  metric(
    "ym:s:users",
    "Users",
    "count",
    "non_additive",
    "Unique visitors. Never sum across dates or segments.",
  ),
  metric("ym:s:pageviews", "Pageviews", "count", "additive", "Number of page views."),
  metric(
    "ym:s:bounceRate",
    "Bounce rate",
    "percent",
    "rate",
    "Share of visits with one pageview and under 15 seconds.",
  ),
  metric("ym:s:pageDepth", "Page depth", "pages", "average", "Average pageviews per visit."),
  metric(
    "ym:s:avgVisitDurationSeconds",
    "Average visit duration",
    "seconds",
    "average",
    "Mean visit duration in seconds.",
  ),
  metric(
    "ym:s:percentNewVisitors",
    "New visitors share",
    "percent",
    "rate",
    "Share of first-time visitors among all users.",
  ),
];

const dimension = (
  id: string,
  label: string,
  description: string,
  sensitive = false,
): DimensionDefinition => ({ id, label, description, sensitive });

export const DIMENSIONS: readonly DimensionDefinition[] = [
  dimension(
    "ym:s:lastSignTrafficSource",
    "Traffic source",
    "Traffic source of the visit (last significant source attribution).",
  ),
  dimension(
    "ym:s:lastSignSourceEngine",
    "Source detail",
    "Search engine, ad system, social network or referring site.",
  ),
  dimension("ym:s:lastSignUTMSource", "UTM source", "utm_source of the visit.", true),
  dimension("ym:s:lastSignUTMMedium", "UTM medium", "utm_medium of the visit.", true),
  dimension("ym:s:lastSignUTMCampaign", "UTM campaign", "utm_campaign of the visit.", true),
  dimension("ym:s:startURLDomain", "Landing domain", "Domain of the landing page."),
  dimension(
    "ym:s:startURLPath",
    "Landing path",
    "Path of the landing page without query string.",
    true,
  ),
  dimension("ym:s:deviceCategory", "Device category", "Desktop, smartphone, tablet or TV."),
  dimension("ym:s:regionCountry", "Country", "Country of the visitor."),
  dimension("ym:s:regionCity", "City", "City of the visitor."),
];

const GOAL_METRIC = /^ym:s:goal(\d{1,12})(reaches|visits|conversionRate|users)$/;

const GOAL_METRIC_SHAPES = {
  reaches: {
    label: "reaches",
    unit: "count",
    aggregation: "additive",
    description:
      "Goal completions. One visit can complete a goal several times: not the number of leads.",
  },
  visits: {
    label: "target visits",
    unit: "count",
    aggregation: "additive",
    description: "Visits in which the goal was completed at least once.",
  },
  conversionRate: {
    label: "conversion rate",
    unit: "percent",
    aggregation: "rate",
    description: "Target visits divided by all visits, percent.",
  },
  users: {
    label: "converted users",
    unit: "count",
    aggregation: "non_additive",
    description: "Users who completed the goal. Never sum across segments.",
  },
} as const satisfies Record<
  string,
  { label: string; unit: MetricUnit; aggregation: MetricAggregation; description: string }
>;

export type GoalMetricKind = keyof typeof GOAL_METRIC_SHAPES;

export function goalMetricId(goalId: string, kind: GoalMetricKind): string {
  return `ym:s:goal${goalId}${kind}`;
}

const METRIC_INDEX = new Map(METRICS.map((m) => [m.id, m]));

/** Every metric ID valid for a counter with these goals, for "did you mean" hints. */
export function metricCandidates(goalNames: ReadonlyMap<string, string>): Candidate[] {
  const kinds = Object.keys(GOAL_METRIC_SHAPES) as GoalMetricKind[];
  const goalMetrics = [...goalNames.keys()].flatMap((goalId) =>
    kinds.map((kind) => goalMetricId(goalId, kind)),
  );
  return [
    ...METRICS.map((m) => ({ id: m.id, label: m.label })),
    ...goalMetrics.map((id) => ({ id, label: findMetric(id, goalNames)?.label ?? null })),
  ];
}

export const dimensionCandidates = (): Candidate[] =>
  DIMENSIONS.map((d) => ({ id: d.id, label: d.label }));
const DIMENSION_INDEX = new Map(DIMENSIONS.map((d) => [d.id, d]));

/**
 * Resolves a metric ID. Goal metrics are only valid for goal IDs that exist on
 * the counter; `goalNames` maps those IDs to their names.
 */
export function findMetric(
  id: string,
  goalNames: ReadonlyMap<string, string>,
): MetricDefinition | null {
  const known = METRIC_INDEX.get(id);
  if (known) return known;
  const match = GOAL_METRIC.exec(id);
  if (!match) return null;
  const goalId = match[1] ?? "";
  const kind = (match[2] ?? "") as GoalMetricKind;
  const goalName = goalNames.get(goalId);
  if (goalName === undefined) return null;
  const shape = GOAL_METRIC_SHAPES[kind];
  return {
    id,
    label: `Goal ${goalId} (${goalName}): ${shape.label}`,
    unit: shape.unit,
    aggregation: shape.aggregation,
    description: shape.description,
    goal_id: goalId,
  };
}

export function isGoalMetricId(id: string): boolean {
  return GOAL_METRIC.test(id);
}

export function findDimension(id: string): DimensionDefinition | null {
  return DIMENSION_INDEX.get(id) ?? null;
}
