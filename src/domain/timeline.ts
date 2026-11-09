import {
  addDays,
  daysInclusive,
  endOfMonth,
  type IsoDate,
  isoWeekday,
  parseIsoDate,
  startOfIsoWeek,
  startOfMonth,
  toEpochDay,
} from "./dates.ts";
import { invalidQuery } from "./errors.ts";
import type { ResolvedPeriod } from "./periods.ts";
import { schemaChanged } from "./upstream.ts";

export const TIME_GROUPS = ["day", "week", "month"] as const;
export type TimeGroup = (typeof TIME_GROUPS)[number];

export interface Bucket {
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** False when the bucket includes today. */
  readonly complete: boolean;
  /** True when the period clips the bucket (shorter than a full week or month). */
  readonly partial: boolean;
}

function isPartial(start: IsoDate, end: IsoDate, group: TimeGroup): boolean {
  if (group === "week") return daysInclusive(start, end) < 7;
  if (group === "month") return start !== startOfMonth(start) || end !== endOfMonth(start);
  return false;
}

/**
 * The bytime API returns values per bucket without bucket labels, so the axis
 * is rebuilt from the calendar (D-08). Weeks are only accepted when they start
 * on a Monday: then calendar weeks and 7-day chunks from date1 coincide, so the
 * labels cannot silently shift.
 */
export function assertGroupable(period: ResolvedPeriod, group: TimeGroup): void {
  if (group === "week" && isoWeekday(period.start) !== 1) {
    const monday = startOfIsoWeek(period.start);
    throw invalidQuery(
      `group='week' needs a period that starts on a Monday; ${period.start} is not.`,
      `Start the period on ${monday} or ${addDays(monday, 7)}, or use group='day'.`,
    );
  }
}

export function calendarBuckets(
  period: ResolvedPeriod,
  group: TimeGroup,
  today: IsoDate,
): Bucket[] {
  const buckets: Bucket[] = [];
  let cursor = period.start;
  while (toEpochDay(cursor) <= toEpochDay(period.end)) {
    const natural =
      group === "day"
        ? cursor
        : group === "week"
          ? addDays(startOfIsoWeek(cursor), 6)
          : endOfMonth(cursor);
    const end = toEpochDay(natural) > toEpochDay(period.end) ? period.end : natural;
    buckets.push({
      start: cursor,
      end,
      complete: toEpochDay(end) < toEpochDay(today),
      partial: isPartial(cursor, end, group),
    });
    cursor = addDays(end, 1);
  }
  return buckets;
}

/** Validates an explicit upstream time axis: ordered, contiguous and inside the period. */
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
    if (start !== expectedStart)
      throw schemaChanged(`time intervals are not contiguous at ${rawStart}`);
    buckets.push({
      start,
      end,
      complete: toEpochDay(end) < toEpochDay(today),
      partial: isPartial(start, end, group),
    });
    expectedStart = addDays(end, 1);
  }
  if (buckets.length > 0 && addDays(expectedStart, -1) !== period.end) {
    throw schemaChanged("time intervals do not cover the requested period");
  }
  return buckets;
}
