import { describe, expect, it } from "vitest";
import { dimensionCandidates, metricCandidates } from "../../src/domain/catalog.ts";
import { suggest } from "../../src/domain/suggest.ts";

const ids = (list: { id: string }[]) => list.map((c) => c.id);

describe("suggest", () => {
  const metrics = metricCandidates(new Map([["501", "Lead form"]]));

  it("finds a metric with a typo", () => {
    expect(ids(suggest("ym:s:visitis", metrics))).toContain("ym:s:visits");
  });

  it("matches the meaningful part of an ID regardless of prefix and case", () => {
    expect(ids(suggest("utmsource", dimensionCandidates()))).toContain("ym:s:lastSignUTMSource");
    expect(ids(suggest("YM:S:VISITS", metrics))[0]).toBe("ym:s:visits");
  });

  it("suggests goal metrics of existing goals for a missing goal", () => {
    expect(ids(suggest("ym:s:goal502reaches", metrics))).toContain("ym:s:goal501reaches");
  });

  it("returns a short list whole when nothing is close", () => {
    const options = [
      { id: "conn_a1", label: "A" },
      { id: "conn_b2", label: "B" },
    ];
    expect(suggest("something else entirely", options)).toEqual(options);
  });

  it("returns nothing from a long list when nothing is close", () => {
    expect(suggest("qqqqqqqqqqqq", dimensionCandidates())).toEqual([]);
  });

  it("returns at most five candidates", () => {
    expect(suggest("ym:s:goal", metrics).length).toBeLessThanOrEqual(5);
  });
});
