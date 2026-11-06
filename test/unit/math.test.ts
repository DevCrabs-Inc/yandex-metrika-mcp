import { describe, expect, it } from "vitest";
import { missingRowValue, sumIfAdditive } from "../../src/domain/aggregation.ts";
import { findMetric } from "../../src/domain/catalog.ts";
import { computeDelta } from "../../src/domain/delta.ts";

const percent = { unit: "percent" } as const;
const count = { unit: "count" } as const;
const metric = (id: string) => {
  const m = findMetric(id, new Map([["3001", "Order"]]));
  if (!m) throw new Error(`unknown metric ${id}`);
  return m;
};

describe("deltas (D-07, T06)", () => {
  it("reports percentage points and relative change for rates", () => {
    expect(computeDelta(2, 3, percent)).toMatchObject({ delta_abs: 1, delta_pp: 1, delta_pct: 50 });
  });

  it("has no relative change for a zero baseline", () => {
    expect(computeDelta(0, 5, count)).toMatchObject({
      delta_abs: 5,
      delta_pct: null,
      reason: "zero_baseline",
    });
    expect(computeDelta(0, 0, count)).toMatchObject({
      delta_abs: 0,
      delta_pct: null,
      reason: "zero_baseline",
    });
  });

  it("keeps unknown values unknown instead of turning them into 0 or Infinity", () => {
    expect(computeDelta(null, 5, count)).toMatchObject({
      delta_abs: null,
      delta_pct: null,
      reason: "unknown_value",
    });
  });

  it("removes floating point noise", () => {
    expect(computeDelta(0.1, 0.3, count).delta_abs).toBe(0.2);
  });

  it("does not report percentage points for counts", () => {
    expect(computeDelta(1000, 1200, count)).toMatchObject({
      delta_abs: 200,
      delta_pct: 20,
      delta_pp: null,
    });
  });
});

describe("aggregation semantics (D-04, T07)", () => {
  it("sums additive metrics only", () => {
    expect(sumIfAdditive(metric("ym:s:visits"), [1, 2, 3])).toBe(6);
    expect(sumIfAdditive(metric("ym:s:users"), [1, 2, 3])).toBeNull();
    expect(sumIfAdditive(metric("ym:s:bounceRate"), [10, 20])).toBeNull();
    expect(sumIfAdditive(metric("ym:s:pageDepth"), [2, 3])).toBeNull();
    expect(sumIfAdditive(metric("ym:s:visits"), [1, null])).toBeNull();
  });

  it("distinguishes goal reaches from target visits (T08)", () => {
    expect(metric("ym:s:goal3001reaches").description).toMatch(/not the number of leads/);
    expect(metric("ym:s:goal3001visits").aggregation).toBe("additive");
    expect(metric("ym:s:goal3001conversionRate").unit).toBe("percent");
    expect(findMetric("ym:s:goal9999visits", new Map())).toBeNull();
  });
});

describe("segments missing from one period (D-07, T09)", () => {
  const visits = metric("ym:s:visits");
  it("is unknown when the fetched rows are only a top-N", () => {
    expect(
      missingRowValue(visits, { rowsComplete: false, containsSensitiveData: false }).value,
    ).toBeNull();
  });
  it("is unknown when privacy suppression is possible", () => {
    expect(
      missingRowValue(visits, { rowsComplete: true, containsSensitiveData: null }).value,
    ).toBeNull();
  });
  it("is a confirmed zero only for complete additive counts", () => {
    expect(missingRowValue(visits, { rowsComplete: true, containsSensitiveData: false })).toEqual({
      value: 0,
      reason: "confirmed_zero",
    });
    expect(
      missingRowValue(metric("ym:s:bounceRate"), {
        rowsComplete: true,
        containsSensitiveData: false,
      }).value,
    ).toBeNull();
  });
});
