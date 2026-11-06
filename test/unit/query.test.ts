import { describe, expect, it } from "vitest";
import {
  planFields,
  planSort,
  toComparisonSpec,
  toPeriodSpec,
} from "../../src/app/query-planner.ts";
import { decodeCursor, encodeCursor } from "../../src/domain/cursor.ts";
import { compileFilters, validateFilters } from "../../src/domain/filters.ts";
import { fingerprint } from "../../src/domain/fingerprint.ts";

const goals = new Map([
  ["3001", "Order form submitted"],
  ["3003", "Order form submitted"],
]);

describe("field planning", () => {
  it("defaults to the overview preset with strict accuracy", () => {
    const plan = planFields({}, goals);
    expect(plan.preset).toEqual({ id: "overview", version: 1 });
    expect(plan.accuracy).toBe("strict");
    expect(plan.dimensions).toHaveLength(0);
  });

  it("rejects preset together with explicit fields", () => {
    expect(() => planFields({ preset: "devices", metrics: ["ym:s:visits"] }, goals)).toThrow(
      /either/,
    );
  });

  it("adds goal columns by ID and rejects unknown goals", () => {
    const plan = planFields({ preset: "goals", goal_ids: ["3001"] }, goals);
    expect(plan.metrics.map((m) => m.id)).toEqual([
      "ym:s:visits",
      "ym:s:goal3001reaches",
      "ym:s:goal3001visits",
      "ym:s:goal3001conversionRate",
    ]);
    expect(() => planFields({ preset: "goals", goal_ids: ["42"] }, goals)).toThrow(
      /does not exist/,
    );
    expect(() => planFields({ preset: "goals" }, goals)).toThrow(/requires goal_ids/);
  });

  it("rejects unknown metrics and dimensions with a catalog hint", () => {
    expect(() => planFields({ metrics: ["ym:s:nope"] }, goals)).toThrow(/Unknown metric/);
    expect(() =>
      planFields({ metrics: ["ym:s:visits"], dimensions: ["ym:s:nope"] }, goals),
    ).toThrow(/Unknown dimension/);
  });

  it("adds dimension tie-breakers for stable paging and validates sort fields", () => {
    const plan = planFields({ preset: "acquisition" }, goals);
    expect(planSort(undefined, plan)).toEqual([
      "-ym:s:visits",
      "ym:s:lastSignTrafficSource",
      "ym:s:lastSignSourceEngine",
    ]);
    expect(() => planSort(["-ym:s:pageviews"], plan)).toThrow(/Cannot sort/);
  });
});

describe("period specs", () => {
  it("requires preset xor start+end", () => {
    expect(toPeriodSpec(undefined, "last_7_complete_days")).toEqual({
      preset: "last_7_complete_days",
    });
    expect(() => toPeriodSpec({ preset: "today", start: "2026-01-01" }, "today")).toThrow(
      /not both/,
    );
    expect(() => toPeriodSpec({ start: "2026-01-01" }, "today")).toThrow(/both start and end/);
  });

  it("defaults comparisons to the last two complete ISO weeks", () => {
    expect(toComparisonSpec(undefined)).toEqual({ preset: "last_two_complete_iso_weeks" });
    expect(toComparisonSpec({ current: { preset: "yesterday" } })).toEqual({
      current: { preset: "yesterday" },
      baseline: "previous_period",
    });
  });
});

describe("filters", () => {
  it("escapes values and only accepts allowlisted dimensions", () => {
    const filters = validateFilters([
      { dimension: "ym:s:startURLPath", op: "contains", values: ["it's\\"] },
      { dimension: "ym:s:deviceCategory", op: "in", values: ["mobile", "tablet"] },
    ]);
    expect(compileFilters(filters)).toBe(
      "ym:s:startURLPath=@'it\\'s\\\\' AND ym:s:deviceCategory=.('mobile','tablet')",
    );
    expect(() =>
      validateFilters([{ dimension: "ym:s:x') OR (1", op: "eq", values: ["a"] }]),
    ).toThrow(/Unknown filter dimension/);
    expect(() =>
      validateFilters([{ dimension: "ym:s:deviceCategory", op: "eq", values: ["a", "b"] }]),
    ).toThrow(/exactly one/);
  });
});

describe("cursors", () => {
  const key = new Uint8Array(32).fill(7);
  const now = new Date("2026-11-06T12:00:00Z");
  const binding = { fingerprint: fingerprint({ q: 1 }), connectionId: "conn_a" };

  it("round-trips an offset", () => {
    expect(decodeCursor(encodeCursor(binding, 40, key, now), binding, key, now)).toBe(40);
  });

  it("rejects cursors of another query, connection or key (T21)", () => {
    const cursor = encodeCursor(binding, 40, key, now);
    expect(() =>
      decodeCursor(cursor, { ...binding, fingerprint: fingerprint({ q: 2 }) }, key, now),
    ).toThrow(/does not belong/);
    expect(() => decodeCursor(cursor, { ...binding, connectionId: "conn_b" }, key, now)).toThrow(
      /does not belong/,
    );
    expect(() => decodeCursor(cursor, binding, new Uint8Array(32), now)).toThrow(/does not belong/);
    expect(() => decodeCursor(`${cursor}x`, binding, key, now)).toThrow(/does not belong/);
  });

  it("expires", () => {
    const cursor = encodeCursor(binding, 40, key, now);
    expect(() => decodeCursor(cursor, binding, key, new Date(now.getTime() + 31 * 60_000))).toThrow(
      /expired/,
    );
  });

  it("fingerprints are independent of key order", () => {
    expect(fingerprint({ a: 1, b: [1, 2] })).toBe(fingerprint({ b: [1, 2], a: 1 }));
    expect(fingerprint({ a: 1 })).not.toBe(fingerprint({ a: 2 }));
  });
});
