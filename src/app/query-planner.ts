import {
  type DimensionDefinition,
  findDimension,
  findMetric,
  isGoalMetricId,
  type MetricDefinition,
} from "../domain/catalog.ts";
import { type IsoDate, isValidTimeZone, todayIn } from "../domain/dates.ts";
import { DomainError, invalidQuery } from "../domain/errors.ts";
import { type FilterCondition, type FilterOperator, validateFilters } from "../domain/filters.ts";
import type {
  BaselineSpec,
  ComparisonPreset,
  ComparisonSpec,
  PeriodPreset,
  PeriodSpec,
} from "../domain/periods.ts";
import { expandPreset, MAX_DIMENSIONS, MAX_METRICS, type ReportPreset } from "../domain/presets.ts";
import type { Accuracy } from "../domain/quality.ts";
import type { Connection } from "./connections.ts";
import type { Clock, CounterInfo, GoalInfo } from "./ports.ts";

export interface CounterContext {
  readonly counter: CounterInfo;
  readonly goals: readonly GoalInfo[];
  readonly goalNames: ReadonlyMap<string, string>;
  readonly timeZone: string;
  readonly today: IsoDate;
}

export async function loadCounterContext(
  connection: Connection,
  counterId: string,
  clock: Clock,
): Promise<CounterContext> {
  if (connection.allowedCounters !== null && !connection.allowedCounters.has(counterId)) {
    throw new DomainError(
      "COUNTER_NOT_ALLOWED",
      `Counter ${counterId} is not in the allowlist of connection ${connection.id}.`,
      { nextAction: "Call metrika_list_counters to see allowed counters." },
    );
  }
  const counter = await connection.source.getCounter(counterId);
  if (counter.time_zone === null || !isValidTimeZone(counter.time_zone)) {
    throw new DomainError(
      "TIMEZONE_UNKNOWN",
      `The time zone of counter ${counterId} is unknown, so calendar periods cannot be computed safely.`,
      { nextAction: "Set the counter time zone in Yandex Metrika settings and try again." },
    );
  }
  const goals = await connection.source.listGoals(counterId);
  return {
    counter,
    goals,
    goalNames: new Map(goals.map((g) => [g.id, g.name])),
    timeZone: counter.time_zone,
    today: todayIn(counter.time_zone, clock.now()),
  };
}

export interface PeriodInputShape {
  readonly preset?: PeriodPreset | undefined;
  readonly start?: string | undefined;
  readonly end?: string | undefined;
}

export function toPeriodSpec(
  input: PeriodInputShape | undefined,
  fallback: PeriodPreset,
  label = "period",
): PeriodSpec {
  if (input === undefined) return { preset: fallback };
  const hasRange = input.start !== undefined || input.end !== undefined;
  if (input.preset !== undefined && hasRange) {
    throw invalidQuery(`${label}: use either preset or start/end, not both.`);
  }
  if (input.preset !== undefined) return { preset: input.preset };
  if (input.start !== undefined && input.end !== undefined) {
    return { start: input.start, end: input.end };
  }
  if (hasRange) throw invalidQuery(`${label}: both start and end are required.`);
  return { preset: fallback };
}

export interface ComparisonInputShape {
  readonly preset?: ComparisonPreset | undefined;
  readonly current?: PeriodInputShape | undefined;
  readonly baseline?: PeriodInputShape | "previous_period" | "same_period_last_year" | undefined;
}

export function toComparisonSpec(input: ComparisonInputShape | undefined): ComparisonSpec {
  if (input === undefined) return { preset: "last_two_complete_iso_weeks" };
  const custom = input.current !== undefined || input.baseline !== undefined;
  if (input.preset !== undefined && custom) {
    throw invalidQuery("periods: use either preset or current/baseline, not both.");
  }
  if (input.preset !== undefined) return { preset: input.preset };
  if (input.current === undefined) {
    if (custom) throw invalidQuery("periods.current is required when baseline is given.");
    return { preset: "last_two_complete_iso_weeks" };
  }
  const current = toPeriodSpec(input.current, "last_7_complete_days", "periods.current");
  const baseline: BaselineSpec =
    input.baseline === undefined
      ? "previous_period"
      : typeof input.baseline === "string"
        ? input.baseline
        : toPeriodSpec(input.baseline, "last_7_complete_days", "periods.baseline");
  return { current, baseline };
}

export interface FieldsInputShape {
  readonly preset?: ReportPreset | undefined;
  readonly metrics?: readonly string[] | undefined;
  readonly dimensions?: readonly string[] | undefined;
  readonly goal_ids?: readonly string[] | undefined;
  readonly filters?:
    | readonly {
        readonly dimension: string;
        readonly op: FilterOperator;
        readonly values: readonly string[];
      }[]
    | undefined;
  readonly accuracy?: Accuracy | undefined;
}

export interface PlannedFields {
  readonly metrics: readonly MetricDefinition[];
  readonly dimensions: readonly DimensionDefinition[];
  readonly filters: readonly FilterCondition[];
  readonly preset: { readonly id: ReportPreset; readonly version: number } | null;
  readonly accuracy: Accuracy;
}

const unique = <T>(items: readonly T[]): T[] => [...new Set(items)];

interface FieldIds {
  readonly metricIds: readonly string[];
  readonly dimensionIds: readonly string[];
  readonly preset: PlannedFields["preset"];
}

function validateGoalIds(goalIds: readonly string[], goalNames: ReadonlyMap<string, string>): void {
  for (const goalId of goalIds) {
    if (!goalNames.has(goalId)) {
      throw invalidQuery(
        `Goal ${goalId} does not exist on this counter.`,
        "Call metrika_describe_counter to list goal IDs.",
      );
    }
  }
}

function selectFieldIds(input: FieldsInputShape, goalIds: readonly string[]): FieldIds {
  const explicit = input.metrics !== undefined || input.dimensions !== undefined;
  if (input.preset !== undefined && explicit) {
    throw invalidQuery("Use either preset or metrics/dimensions, not both.");
  }
  if (!explicit) {
    const expanded = expandPreset(input.preset ?? "overview", goalIds);
    return {
      metricIds: expanded.metrics,
      dimensionIds: expanded.dimensions,
      preset: expanded.preset,
    };
  }
  if (goalIds.length > 0) {
    throw invalidQuery(
      "goal_ids work with presets only; with explicit metrics use ym:s:goal<ID>visits style IDs.",
    );
  }
  if (input.metrics === undefined || input.metrics.length === 0) {
    throw invalidQuery("metrics are required when no preset is used.");
  }
  return {
    metricIds: unique(input.metrics),
    dimensionIds: unique(input.dimensions ?? []),
    preset: null,
  };
}

function resolveMetric(id: string, goalNames: ReadonlyMap<string, string>): MetricDefinition {
  const metric = findMetric(id, goalNames);
  if (metric !== null) return metric;
  if (isGoalMetricId(id)) {
    throw invalidQuery(
      `Metric ${id} refers to a goal that does not exist on this counter.`,
      "Call metrika_describe_counter to list goal IDs.",
    );
  }
  throw invalidQuery(
    `Unknown metric: ${id}.`,
    "Call metrika_catalog with kind='metrics' to list supported metrics.",
  );
}

function resolveDimension(id: string): DimensionDefinition {
  const dimension = findDimension(id);
  if (dimension !== null) return dimension;
  throw invalidQuery(
    `Unknown dimension: ${id}.`,
    "Call metrika_catalog with kind='dimensions' to list supported dimensions.",
  );
}

export function planFields(
  input: FieldsInputShape,
  goalNames: ReadonlyMap<string, string>,
  maxDimensions = MAX_DIMENSIONS,
): PlannedFields {
  const goalIds = unique(input.goal_ids ?? []);
  validateGoalIds(goalIds, goalNames);
  const { metricIds, dimensionIds, preset } = selectFieldIds(input, goalIds);
  if (metricIds.length > MAX_METRICS) throw invalidQuery(`At most ${MAX_METRICS} metrics.`);
  if (dimensionIds.length > maxDimensions) {
    throw invalidQuery(`At most ${maxDimensions} dimensions for this tool.`);
  }
  return {
    metrics: metricIds.map((id) => resolveMetric(id, goalNames)),
    dimensions: dimensionIds.map(resolveDimension),
    filters: validateFilters(input.filters ?? []),
    preset,
    accuracy: input.accuracy ?? "strict",
  };
}

/** Validated sort with dimension tie-breakers, so pagination order is stable. */
export function planSort(
  requested: readonly string[] | undefined,
  fields: Pick<PlannedFields, "metrics" | "dimensions">,
): string[] {
  const allowed = new Set([
    ...fields.metrics.map((m) => m.id),
    ...fields.dimensions.map((d) => d.id),
  ]);
  if (fields.dimensions.length === 0) {
    if (requested !== undefined && requested.length > 0) {
      throw invalidQuery("sort applies only to reports with dimensions.");
    }
    return [];
  }
  const firstMetric = fields.metrics[0]?.id ?? "";
  const sort =
    requested !== undefined && requested.length > 0 ? [...requested] : [`-${firstMetric}`];
  for (const item of sort) {
    const field = item.startsWith("-") ? item.slice(1) : item;
    if (!allowed.has(field)) {
      throw invalidQuery(
        `Cannot sort by ${field}: it is not among the selected metrics or dimensions.`,
      );
    }
  }
  const used = new Set(sort.map((s) => (s.startsWith("-") ? s.slice(1) : s)));
  for (const dimension of fields.dimensions) {
    if (!used.has(dimension.id)) sort.push(dimension.id);
  }
  return sort;
}

/** Strict asks for unsampled data; balanced leaves the API default sample size. */
export const upstreamAccuracy = (accuracy: Accuracy): "full" | null =>
  accuracy === "strict" ? "full" : null;
