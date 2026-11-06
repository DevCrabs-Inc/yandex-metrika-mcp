import { describe, expect, it } from "vitest";
import { DomainError } from "../../src/domain/errors.ts";
import { enforceAccuracy, readSampling } from "../../src/domain/quality.ts";

const strictError = (raw: Parameters<typeof readSampling>[0]) => {
  try {
    enforceAccuracy(readSampling(raw), "strict");
  } catch (error) {
    return error;
  }
  return null;
};

describe("sampling (D-01)", () => {
  it("reads `sampled`, not look-alike fields (T01)", () => {
    const reading = readSampling({
      sampled: true,
      sample_share: 0.1,
      contains_sampled_data: false,
    } as never);
    expect(reading.sampled).toBe(true);
  });

  it("treats a missing `sampled` as unknown, never as false (T02)", () => {
    expect(readSampling({}).sampled).toBeNull();
    expect(strictError({})).toBeInstanceOf(DomainError);
  });

  it("strict refuses sampled data even when full accuracy was requested (T03)", () => {
    const error = strictError({ sampled: true, sample_share: 0.25 });
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("QUALITY_REQUIREMENT_NOT_MET");
  });

  it("strict refuses contradictory metadata (T02)", () => {
    const reading = readSampling({ sampled: false, sample_share: 0.4 });
    expect(reading.contradictions).toHaveLength(1);
    expect(strictError({ sampled: false, sample_share: 0.4 })).toBeInstanceOf(DomainError);
  });

  it("strict accepts an explicit, consistent sampled=false", () => {
    expect(enforceAccuracy(readSampling({ sampled: false, sample_share: 1 }), "strict")).toEqual(
      [],
    );
  });

  it("balanced accepts sampling but always warns", () => {
    const codes = (raw: Parameters<typeof readSampling>[0]) =>
      enforceAccuracy(readSampling(raw), "balanced").map((w) => w.code);
    expect(codes({ sampled: true, sample_share: 0.1 })).toEqual(["SAMPLED_DATA"]);
    expect(codes({})).toEqual(["SAMPLING_UNKNOWN"]);
    expect(codes({ sampled: false, sample_share: 2 })).toEqual(["SAMPLING_CONTRADICTORY"]);
  });
});
