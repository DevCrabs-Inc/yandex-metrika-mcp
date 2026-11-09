import type { EXPORT_FORMATS } from "../../domain/contract/jobs.ts";
import type { FilterCondition } from "../../domain/filters.ts";
import type { ResolvedPeriod } from "../../domain/periods.ts";
import type { Accuracy } from "../../domain/quality.ts";

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportColumn {
  readonly id: string;
  readonly label: string;
}

export interface ExportMetricColumn extends ExportColumn {
  readonly unit: string;
  readonly aggregation: string;
}

/** Everything needed to run, resume and describe an export. Stored with the job. */
export interface ExportSpec {
  readonly v: 1;
  readonly counter: { readonly id: string; readonly name: string; readonly site: string };
  readonly period: ResolvedPeriod;
  readonly metrics: readonly ExportMetricColumn[];
  readonly dimensions: readonly ExportColumn[];
  readonly filters: readonly FilterCondition[];
  readonly sort: readonly string[];
  readonly accuracy: Accuracy;
  readonly preset: { readonly id: string; readonly version: number } | null;
  readonly format: ExportFormat;
  readonly privacy: "safe" | "full";
}

/** One stored row: raw dimension values and exact metric values (digit strings kept). */
export interface PartRow {
  readonly k: string;
  readonly d: readonly (readonly [string | null, string | null])[];
  readonly v: readonly (number | string | null)[];
}

export interface WriteSink {
  write(chunk: string): Promise<void>;
}

export interface ArtifactWriteResult {
  readonly relPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly absolutePath: string;
}

/** Managed storage for job parts and artifacts; paths are generated, never taken from tools. */
export interface ExportFiles {
  writePart(
    jobId: string,
    partNo: number,
    content: string,
  ): Promise<{ bytes: number; sha256: string }>;
  readPart(jobId: string, partNo: number): Promise<string>;
  deleteJobFiles(jobId: string): Promise<void>;
  createArtifact(
    artifactId: string,
    fileName: string,
    writeData: (sink: WriteSink) => Promise<void>,
    manifest: (data: { bytes: number; sha256: string }) => string,
  ): Promise<ArtifactWriteResult>;
  absolutePath(relPath: string): string;
  readChunk(
    relPath: string,
    offset: number,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; size: number }>;
  deleteArtifact(relPath: string): Promise<void>;
  /** Free space on the volume, or null when unknown. */
  freeBytes(): number | null;
}
