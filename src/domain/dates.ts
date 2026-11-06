import { DomainError } from "./errors.ts";

declare const isoDateBrand: unique symbol;

/** A calendar date `YYYY-MM-DD` without a time zone. */
export type IsoDate = string & { readonly [isoDateBrand]: true };

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;
const MIN_YEAR = 1970;
const MAX_YEAR = 9999;

export function parseIsoDate(value: string): IsoDate | null {
  const match = ISO_DATE.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < MIN_YEAR || year > MAX_YEAR) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return value as IsoDate;
}

export function isoDate(value: string): IsoDate {
  const parsed = parseIsoDate(value);
  if (parsed === null) throw new RangeError(`Not a valid calendar date: ${value}`);
  return parsed;
}

function toUtcDate(date: IsoDate): Date {
  return new Date(`${date}T00:00:00Z`);
}

function fromUtcDate(date: Date): IsoDate {
  return date.toISOString().slice(0, 10) as IsoDate;
}

export function toEpochDay(date: IsoDate): number {
  return toUtcDate(date).getTime() / DAY_MS;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcDate(new Date(toUtcDate(date).getTime() + days * DAY_MS));
}

/** Number of calendar days in the inclusive range [start, end]. */
export function daysInclusive(start: IsoDate, end: IsoDate): number {
  return toEpochDay(end) - toEpochDay(start) + 1;
}

/** ISO weekday: Monday = 1 … Sunday = 7. */
export function isoWeekday(date: IsoDate): number {
  return ((toUtcDate(date).getUTCDay() + 6) % 7) + 1;
}

export function startOfIsoWeek(date: IsoDate): IsoDate {
  return addDays(date, 1 - isoWeekday(date));
}

export function startOfMonth(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01` as IsoDate;
}

export function addMonths(monthStart: IsoDate, months: number): IsoDate {
  const d = toUtcDate(monthStart);
  return fromUtcDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)));
}

export function endOfMonth(date: IsoDate): IsoDate {
  return addDays(addMonths(startOfMonth(date), 1), -1);
}

/** Same calendar date one year earlier; 29 February maps to 28 February. */
export function minusOneYear(date: IsoDate): IsoDate {
  const year = Number(date.slice(0, 4)) - 1;
  const monthDay = date.slice(5);
  const candidate = parseIsoDate(`${String(year).padStart(4, "0")}-${monthDay}`);
  return candidate ?? isoDate(`${String(year).padStart(4, "0")}-02-28`);
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The calendar date at `now` in the given IANA time zone. */
export function todayIn(timeZone: string, now: Date): IsoDate {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
  } catch {
    throw new DomainError("TIMEZONE_UNKNOWN", `Unknown time zone: ${timeZone}`, {
      nextAction: "Check the counter time zone in Yandex Metrika settings.",
    });
  }
  const pick = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return isoDate(`${pick("year")}-${pick("month")}-${pick("day")}`);
}
