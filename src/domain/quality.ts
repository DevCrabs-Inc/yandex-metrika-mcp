import { DomainError } from "./errors.ts";
import type { Warning } from "./warnings.ts";

export const ACCURACY_MODES = ["strict", "balanced"] as const;
export type Accuracy = (typeof ACCURACY_MODES)[number];

/**
 * Sampling as reported by the API. `null` means "the API did not say": it is
 * never treated as "not sampled" (D-01).
 */
export interface SamplingInfo {
  readonly sampled: boolean | null;
  readonly sample_share: number | null;
  readonly sample_size: number | null;
  readonly sample_space: number | null;
}

export interface SamplingReading extends SamplingInfo {
  readonly contradictions: readonly string[];
}

export interface RawSamplingFields {
  readonly sampled?: unknown;
  readonly sample_share?: unknown;
  readonly sample_size?: unknown;
  readonly sample_space?: unknown;
}

const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** Reads only the documented fields (`sampled`, `sample_*`); look-alike fields are ignored. */
export function readSampling(raw: RawSamplingFields): SamplingReading {
  const sampled = typeof raw.sampled === "boolean" ? raw.sampled : null;
  const share = finiteOrNull(raw.sample_share);
  const sampleShare = share !== null && share > 0 && share <= 1 ? share : null;
  const sampleSize = finiteOrNull(raw.sample_size);
  const sampleSpace = finiteOrNull(raw.sample_space);
  const contradictions: string[] = [];
  if (share !== null && sampleShare === null) {
    contradictions.push(`sample_share=${share} is outside (0, 1]`);
  }
  if (sampled === false && sampleShare !== null && sampleShare < 1) {
    contradictions.push(`sampled=false but sample_share=${sampleShare}`);
  }
  if (sampled === true && sampleShare === 1) {
    contradictions.push("sampled=true but sample_share=1");
  }
  if (
    sampled === false &&
    sampleSize !== null &&
    sampleSpace !== null &&
    sampleSize < sampleSpace
  ) {
    contradictions.push(
      `sampled=false but sample_size ${sampleSize} < sample_space ${sampleSpace}`,
    );
  }
  return {
    sampled,
    sample_share: sampleShare,
    sample_size: sampleSize,
    sample_space: sampleSpace,
    contradictions,
  };
}

function strictFailureReason(reading: SamplingReading): string {
  if (reading.sampled === true) {
    const share = reading.sample_share === null ? "" : ` (sample_share=${reading.sample_share})`;
    return `the API returned sampled data${share}`;
  }
  if (reading.sampled === null) return "the API did not report whether the data is sampled";
  return `sampling metadata is contradictory: ${reading.contradictions.join("; ")}`;
}

function balancedWarnings(reading: SamplingReading): Warning[] {
  const warnings: Warning[] = [];
  if (reading.sampled === true) {
    const share =
      reading.sample_share === null
        ? " (share not reported)"
        : ` of ${(reading.sample_share * 100).toFixed(1)}% of visits`;
    warnings.push({
      code: "SAMPLED_DATA",
      severity: "warning",
      message: `Values are estimated from a sample${share}. Small segments may be unreliable.`,
      affected_fields: [],
    });
  } else if (reading.sampled === null) {
    warnings.push({
      code: "SAMPLING_UNKNOWN",
      severity: "warning",
      message: "The API did not report sampling; do not present these numbers as exact.",
      affected_fields: [],
    });
  }
  if (reading.contradictions.length > 0) {
    warnings.push({
      code: "SAMPLING_CONTRADICTORY",
      severity: "warning",
      message: `Sampling metadata is contradictory: ${reading.contradictions.join("; ")}.`,
      affected_fields: [],
    });
  }
  return warnings;
}

/**
 * Applies the accuracy policy. Strict accepts only an explicit `sampled=false`
 * without contradictions and never silently downgrades to balanced.
 */
export function enforceAccuracy(reading: SamplingReading, accuracy: Accuracy): Warning[] {
  if (accuracy === "balanced") return balancedWarnings(reading);
  if (reading.sampled === false && reading.contradictions.length === 0) return [];
  throw new DomainError(
    "QUALITY_REQUIREMENT_NOT_MET",
    `Strict accuracy cannot be guaranteed: ${strictFailureReason(reading)}.`,
    {
      nextAction:
        "Shorten the period or reduce segmentation; or repeat with accuracy='balanced' to accept sampled data with an explicit warning.",
      details: { sampled: reading.sampled, sample_share: reading.sample_share },
    },
  );
}

export function samplingSummary(info: SamplingInfo): string {
  if (info.sampled === false) return "not sampled (API sampled=false)";
  if (info.sampled === true) {
    return info.sample_share === null
      ? "SAMPLED (share not reported)"
      : `SAMPLED (${(info.sample_share * 100).toFixed(1)}% of visits)`;
  }
  return "sampling unknown (not reported by API)";
}
