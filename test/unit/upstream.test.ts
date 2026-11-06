import { describe, expect, it } from "vitest";
import { bucketsFromIntervals } from "../../src/app/timeseries-service.ts";
import { isoDate } from "../../src/domain/dates.ts";
import { normalizeDimensions } from "../../src/domain/normalize.ts";
import { resolvePeriod } from "../../src/domain/periods.ts";
import { parseUpstreamByTime, parseUpstreamData } from "../../src/domain/upstream.ts";

const page = (overrides: Record<string, unknown> = {}) => ({
  data: [{ dimensions: [{ id: "organic", name: "Search engine traffic" }], metrics: [10, 5] }],
  totals: [10, 5],
  total_rows: 1,
  sampled: false,
  ...overrides,
});

describe("upstream schema checks (D-05, T14)", () => {
  it("accepts unknown optional fields", () => {
    expect(() => parseUpstreamData(page({ some_new_field: { a: 1 } }), 2, 1)).not.toThrow();
  });

  it("fails closed when a numeric array is missing", () => {
    const { totals: _totals, ...withoutTotals } = page();
    expect(() => parseUpstreamData(withoutTotals, 2, 1)).toThrow(/UPSTREAM|Unexpected/);
  });

  it("fails closed when arities do not match the request", () => {
    expect(() => parseUpstreamData(page(), 3, 1)).toThrow(/expected 3/);
    expect(() =>
      parseUpstreamData(page({ data: [{ dimensions: [], metrics: [1, 2] }] }), 2, 1),
    ).toThrow(/dimensions/);
  });

  it("checks that bytime series match the time axis", () => {
    const bytime = {
      data: [],
      totals: [[1, 2, 3]],
      time_intervals: [
        ["2026-10-01", "2026-10-01"],
        ["2026-10-02", "2026-10-02"],
      ],
      total_rows: 0,
    };
    expect(() => parseUpstreamByTime(bytime, 1, 0)).toThrow(/points, expected 2/);
  });
});

describe("labels (D-05, D-09, T15)", () => {
  it("keeps empty labels as null instead of dropping the row", () => {
    const dims = normalizeDimensions([{ id: null, name: null }]);
    expect(dims.cells).toEqual([{ id: null, name: null }]);
    expect(dims.key).toMatch(/^r_[0-9a-f]{16}$/);
  });

  it("strips URL query strings but keeps distinct rows distinct", () => {
    const a = normalizeDimensions([{ name: "https://shop.test/p?utm_source=x&email=a@b.c" }]);
    const b = normalizeDimensions([{ name: "https://shop.test/p?utm_source=y" }]);
    expect(a.cells[0]).toMatchObject({ name: "https://shop.test/p", redacted: true });
    expect(a.key).not.toBe(b.key);
  });

  it("removes control characters and truncates huge labels", () => {
    const dims = normalizeDimensions([{ name: `line1\nline2\u2028${"x".repeat(500)}` }]);
    const cell = dims.cells[0];
    expect(cell?.name).not.toMatch(/[\n\u2028]/);
    expect(cell?.name?.length).toBeLessThanOrEqual(300);
    expect(cell?.truncated).toBe(true);
  });
});

describe("time buckets (D-08, T13)", () => {
  const ctx = { timeZone: "Europe/Moscow", today: isoDate("2026-11-06") };

  it("uses real month lengths and flags clipped and incomplete buckets", () => {
    const period = resolvePeriod({ start: "2026-01-15", end: "2026-03-31" }, ctx);
    const buckets = bucketsFromIntervals(
      [
        ["2026-01-15", "2026-01-31"],
        ["2026-02-01", "2026-02-28"],
        ["2026-03-01", "2026-03-31"],
      ],
      period,
      "month",
      ctx.today,
    );
    expect(buckets.map((b) => b.partial)).toEqual([true, false, false]);
    expect(buckets.every((b) => b.complete)).toBe(true);
  });

  it("marks a week that contains today as incomplete", () => {
    const period = resolvePeriod({ start: "2026-10-26", end: "2026-11-06" }, ctx);
    const buckets = bucketsFromIntervals(
      [
        ["2026-10-26", "2026-11-01"],
        ["2026-11-02", "2026-11-06"],
      ],
      period,
      "week",
      ctx.today,
    );
    expect(buckets).toEqual([
      { start: "2026-10-26", end: "2026-11-01", complete: true, partial: false },
      { start: "2026-11-02", end: "2026-11-06", complete: false, partial: true },
    ]);
  });

  it("rejects gaps in the upstream time axis", () => {
    const period = resolvePeriod({ start: "2026-10-01", end: "2026-10-03" }, ctx);
    expect(() =>
      bucketsFromIntervals(
        [
          ["2026-10-01", "2026-10-01"],
          ["2026-10-03", "2026-10-03"],
        ],
        period,
        "day",
        ctx.today,
      ),
    ).toThrow(/contiguous/);
  });
});
