import {
  addDays,
  addMonths,
  daysInclusive,
  type IsoDate,
  minusOneYear,
  parseIsoDate,
  startOfIsoWeek,
  startOfMonth,
  toEpochDay,
} from "./dates.ts";
import { invalidQuery } from "./errors.ts";
import type { Warning } from "./warnings.ts";

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_complete_days",
  "last_28_complete_days",
  "last_complete_iso_week",
  "last_complete_month",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export const COMPARISON_PRESETS = [
  "last_two_complete_iso_weeks",
  "last_7_complete_days_vs_previous_7",
  "last_two_complete_months",
] as const;
export type ComparisonPreset = (typeof COMPARISON_PRESETS)[number];

export type PeriodSpec =
  | { readonly preset: PeriodPreset }
  | { readonly start: string; readonly end: string };

export type BaselineSpec = PeriodSpec | "previous_period" | "same_period_last_year";

export type ComparisonSpec =
  | { readonly preset: ComparisonPreset }
  | { readonly current: PeriodSpec; readonly baseline: BaselineSpec };

export interface ResolvedPeriod {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly time_zone: string;
  readonly days: number;
  /** True when the whole period ended before "today" in the counter time zone. */
  readonly complete: boolean;
  readonly preset: PeriodPreset | null;
}

export interface PeriodContext {
  readonly timeZone: string;
  /** "Today" in the counter time zone. */
  readonly today: IsoDate;
}

function make(
  start: IsoDate,
  end: IsoDate,
  ctx: PeriodContext,
  preset: PeriodPreset | null,
): ResolvedPeriod {
  return {
    start,
    end,
    time_zone: ctx.timeZone,
    days: daysInclusive(start, end),
    complete: toEpochDay(end) < toEpochDay(ctx.today),
    preset,
  };
}

function resolvePreset(preset: PeriodPreset, ctx: PeriodContext): ResolvedPeriod {
  const yesterday = addDays(ctx.today, -1);
  switch (preset) {
    case "today":
      return make(ctx.today, ctx.today, ctx, preset);
    case "yesterday":
      return make(yesterday, yesterday, ctx, preset);
    case "last_7_complete_days":
      return make(addDays(yesterday, -6), yesterday, ctx, preset);
    case "last_28_complete_days":
      return make(addDays(yesterday, -27), yesterday, ctx, preset);
    case "last_complete_iso_week": {
      const thisWeek = startOfIsoWeek(ctx.today);
      return make(addDays(thisWeek, -7), addDays(thisWeek, -1), ctx, preset);
    }
    case "last_complete_month": {
      const thisMonth = startOfMonth(ctx.today);
      return make(addMonths(thisMonth, -1), addDays(thisMonth, -1), ctx, preset);
    }
  }
}

export function resolvePeriod(spec: PeriodSpec, ctx: PeriodContext): ResolvedPeriod {
  if ("preset" in spec) return resolvePreset(spec.preset, ctx);
  const start = parseIsoDate(spec.start);
  const end = parseIsoDate(spec.end);
  if (start === null || end === null) {
    throw invalidQuery("period.start and period.end must be valid calendar dates (YYYY-MM-DD).");
  }
  if (toEpochDay(start) > toEpochDay(end)) {
    throw invalidQuery("period.start must not be after period.end.");
  }
  if (toEpochDay(end) > toEpochDay(ctx.today)) {
    throw invalidQuery(
      `period.end ${end} is in the future for the counter time zone ${ctx.timeZone} (today is ${ctx.today}).`,
      "Use a period that ends today or earlier.",
    );
  }
  return make(start, end, ctx, null);
}

function shiftBack(period: ResolvedPeriod, ctx: PeriodContext): ResolvedPeriod {
  const end = addDays(period.start, -1);
  return make(addDays(end, 1 - period.days), end, ctx, null);
}

export interface ResolvedComparison {
  readonly baseline: ResolvedPeriod;
  readonly current: ResolvedPeriod;
  readonly preset: ComparisonPreset | null;
}

export function resolveComparison(spec: ComparisonSpec, ctx: PeriodContext): ResolvedComparison {
  if ("preset" in spec) {
    switch (spec.preset) {
      case "last_two_complete_iso_weeks": {
        const current = resolvePreset("last_complete_iso_week", ctx);
        return { current, baseline: shiftBack(current, ctx), preset: spec.preset };
      }
      case "last_7_complete_days_vs_previous_7": {
        const current = resolvePreset("last_7_complete_days", ctx);
        return { current, baseline: shiftBack(current, ctx), preset: spec.preset };
      }
      case "last_two_complete_months": {
        const current = resolvePreset("last_complete_month", ctx);
        const baselineStart = addMonths(current.start, -1);
        return {
          current,
          baseline: make(baselineStart, addDays(current.start, -1), ctx, null),
          preset: spec.preset,
        };
      }
    }
  }
  const current = resolvePeriod(spec.current, ctx);
  if (spec.baseline === "previous_period") {
    return { current, baseline: shiftBack(current, ctx), preset: null };
  }
  if (spec.baseline === "same_period_last_year") {
    return {
      current,
      baseline: make(minusOneYear(current.start), minusOneYear(current.end), ctx, null),
      preset: null,
    };
  }
  return { current, baseline: resolvePeriod(spec.baseline, ctx), preset: null };
}

export function periodWarnings(
  period: ResolvedPeriod,
  label: string,
  ctx: PeriodContext,
): Warning[] {
  if (period.complete) return [];
  return [
    {
      code: "PERIOD_INCOMPLETE",
      severity: "warning",
      message: `${label} includes ${ctx.today} (today in ${ctx.timeZone}); today's data is still accumulating.`,
      affected_fields: [],
    },
  ];
}

export function comparisonWarnings(cmp: ResolvedComparison, ctx: PeriodContext): Warning[] {
  const warnings: Warning[] = [
    ...periodWarnings(cmp.baseline, "Baseline period", ctx),
    ...periodWarnings(cmp.current, "Current period", ctx),
  ];
  if (cmp.baseline.days !== cmp.current.days) {
    warnings.push({
      code: "UNEQUAL_PERIODS",
      severity: "warning",
      message: `Periods have different lengths (${cmp.baseline.days} vs ${cmp.current.days} days); totals are not directly comparable. Consider per-day values.`,
      affected_fields: [],
    });
  }
  const overlap =
    toEpochDay(cmp.baseline.start) <= toEpochDay(cmp.current.end) &&
    toEpochDay(cmp.current.start) <= toEpochDay(cmp.baseline.end);
  if (overlap) {
    warnings.push({
      code: "PERIODS_OVERLAP",
      severity: "warning",
      message: "Baseline and current periods overlap.",
      affected_fields: [],
    });
  }
  return warnings;
}
