import { describe, expect, it } from "vitest";
import { isoDate, parseIsoDate, todayIn } from "../../src/domain/dates.ts";
import { DomainError } from "../../src/domain/errors.ts";
import {
  comparisonWarnings,
  type PeriodContext,
  resolveComparison,
  resolvePeriod,
} from "../../src/domain/periods.ts";

const ctx = (today: string, timeZone = "Europe/Moscow"): PeriodContext => ({
  timeZone,
  today: isoDate(today),
});

describe("calendar dates", () => {
  it("validates real calendar dates including leap days", () => {
    expect(parseIsoDate("2028-02-29")).toBe("2028-02-29");
    expect(parseIsoDate("2027-02-29")).toBeNull();
    expect(parseIsoDate("2026-13-01")).toBeNull();
    expect(parseIsoDate("2026-1-01")).toBeNull();
  });

  it("computes today in the counter time zone, not the machine zone (T05)", () => {
    const now = new Date("2026-11-06T20:30:00Z");
    expect(todayIn("Europe/Moscow", now)).toBe("2026-11-06");
    expect(todayIn("Asia/Vladivostok", now)).toBe("2026-11-07");
    expect(todayIn("America/Los_Angeles", now)).toBe("2026-11-06");
  });

  it("refuses an unknown time zone instead of guessing (T05)", () => {
    expect(() => todayIn("Mars/Olympus", new Date())).toThrowError(DomainError);
  });
});

describe("period presets (T04)", () => {
  it("last_7_complete_days excludes today", () => {
    const p = resolvePeriod({ preset: "last_7_complete_days" }, ctx("2026-10-29"));
    expect([p.start, p.end, p.days, p.complete]).toEqual(["2026-10-22", "2026-10-28", 7, true]);
  });

  it("last_complete_iso_week is Monday–Sunday", () => {
    const p = resolvePeriod({ preset: "last_complete_iso_week" }, ctx("2026-10-29"));
    expect([p.start, p.end]).toEqual(["2026-10-19", "2026-10-25"]);
  });

  it("handles the year boundary", () => {
    const week = resolvePeriod({ preset: "last_complete_iso_week" }, ctx("2027-01-01"));
    expect([week.start, week.end]).toEqual(["2026-12-21", "2026-12-27"]);
    const month = resolvePeriod({ preset: "last_complete_month" }, ctx("2027-01-15"));
    expect([month.start, month.end, month.days]).toEqual(["2026-12-01", "2026-12-31", 31]);
  });

  it("handles February in leap and normal years", () => {
    const leap = resolvePeriod({ preset: "last_complete_month" }, ctx("2028-03-01"));
    expect([leap.start, leap.end, leap.days]).toEqual(["2028-02-01", "2028-02-29", 29]);
    const normal = resolvePeriod({ preset: "last_complete_month" }, ctx("2027-03-10"));
    expect(normal.days).toBe(28);
  });

  it("marks today as incomplete", () => {
    const p = resolvePeriod({ preset: "today" }, ctx("2026-11-06"));
    expect(p.complete).toBe(false);
  });
});

describe("explicit periods", () => {
  it("accepts inclusive ranges that end today and flags them incomplete", () => {
    const p = resolvePeriod({ start: "2026-11-01", end: "2026-11-06" }, ctx("2026-11-06"));
    expect(p.days).toBe(6);
    expect(p.complete).toBe(false);
  });

  it("rejects invalid, reversed and future ranges", () => {
    const c = ctx("2026-11-06");
    expect(() => resolvePeriod({ start: "2026-02-30", end: "2026-03-01" }, c)).toThrow(/calendar/);
    expect(() => resolvePeriod({ start: "2026-11-05", end: "2026-11-01" }, c)).toThrow(/after/);
    expect(() => resolvePeriod({ start: "2026-11-01", end: "2026-11-07" }, c)).toThrow(/future/);
  });
});

describe("comparisons", () => {
  it("last_two_complete_iso_weeks compares adjacent Monday–Sunday weeks", () => {
    const cmp = resolveComparison({ preset: "last_two_complete_iso_weeks" }, ctx("2026-10-29"));
    expect([cmp.current.start, cmp.current.end]).toEqual(["2026-10-19", "2026-10-25"]);
    expect([cmp.baseline.start, cmp.baseline.end]).toEqual(["2026-10-12", "2026-10-18"]);
  });

  it("previous_period has the same length directly before the current period", () => {
    const cmp = resolveComparison(
      { current: { start: "2026-03-01", end: "2026-03-10" }, baseline: "previous_period" },
      ctx("2026-11-06"),
    );
    expect([cmp.baseline.start, cmp.baseline.end, cmp.baseline.days]).toEqual([
      "2026-02-19",
      "2026-02-28",
      10,
    ]);
  });

  it("same_period_last_year maps 29 February to 28 February", () => {
    const cmp = resolveComparison(
      { current: { start: "2028-02-29", end: "2028-02-29" }, baseline: "same_period_last_year" },
      ctx("2028-03-05"),
    );
    expect(cmp.baseline.start).toBe("2027-02-28");
  });

  it("warns about unequal, overlapping and incomplete periods (T10)", () => {
    const c = ctx("2026-11-06");
    const cmp = resolveComparison(
      {
        current: { start: "2026-11-01", end: "2026-11-06" },
        baseline: { start: "2026-10-01", end: "2026-11-02" },
      },
      c,
    );
    const codes = comparisonWarnings(cmp, c).map((w) => w.code);
    expect(codes).toEqual(
      expect.arrayContaining(["UNEQUAL_PERIODS", "PERIODS_OVERLAP", "PERIOD_INCOMPLETE"]),
    );
  });
});
