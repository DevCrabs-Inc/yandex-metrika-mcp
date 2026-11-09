import { SCHEMA_VERSION } from "../../domain/contract/common.ts";
import {
  DEFAULT_ARTIFACT_CHUNK,
  MAX_ARTIFACT_CHUNK,
  type ReadArtifactOutput,
} from "../../domain/contract/jobs.ts";
import { decodeCursor, encodeCursor } from "../../domain/cursor.ts";
import { DomainError } from "../../domain/errors.ts";
import type { ConnectionResolver } from "../connections.ts";
import type { Clock } from "../ports.ts";
import type { ArtifactRecord, JobStore } from "../stores.ts";
import type { ExportService } from "./export-service.ts";
import type { ExportFiles } from "./types.ts";

const RESOURCE_MAX_BYTES = 1024 * 1024;

const notFound = (): DomainError =>
  new DomainError("ARTIFACT_NOT_FOUND", "No such export file for this connection.", {
    nextAction: "Check artifact_id with metrika_get_job.",
  });

const utf8Length = (lead: number): number =>
  lead < 0x80 ? 1 : lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;

/** Cuts a chunk at the last line break so rows and UTF-8 characters are never split. */
export function cutChunk(bytes: Buffer, eof: boolean): Buffer {
  if (eof || bytes.length === 0) return bytes;
  const newline = bytes.lastIndexOf(0x0a);
  if (newline >= 0) return bytes.subarray(0, newline + 1);
  // No line break: drop only an incomplete trailing character.
  let start = bytes.length - 1;
  while (start > 0 && ((bytes[start] ?? 0) & 0xc0) === 0x80) start -= 1;
  const complete = start + utf8Length(bytes[start] ?? 0) <= bytes.length;
  return complete ? bytes : bytes.subarray(0, start);
}

export interface ArtifactServiceDeps {
  readonly connections: ConnectionResolver;
  readonly jobs: JobStore;
  readonly files: ExportFiles;
  readonly exports: ExportService;
  readonly clock: Clock;
  readonly cursorKey: Uint8Array;
}

export class ArtifactService {
  private readonly _deps: ArtifactServiceDeps;

  constructor(deps: ArtifactServiceDeps) {
    this._deps = deps;
  }

  private _artifact(connectionId: string, artifactId: string): ArtifactRecord {
    const connection = this._deps.connections.get(connectionId);
    const artifact = this._deps.jobs.getArtifact(artifactId);
    if (!artifact || artifact.connection_id !== connection.id) throw notFound();
    if (Date.parse(artifact.expires_at) <= this._deps.clock.now().getTime()) {
      throw new DomainError("ARTIFACT_EXPIRED", "The export file has expired and was removed.", {
        nextAction: "Run metrika_export_report again.",
      });
    }
    return artifact;
  }

  async read(input: {
    readonly connection_id: string;
    readonly artifact_id: string;
    readonly cursor?: string | undefined;
    readonly max_bytes?: number | undefined;
  }): Promise<ReadArtifactOutput> {
    const { clock, cursorKey, files, exports } = this._deps;
    const artifact = this._artifact(input.connection_id, input.artifact_id);
    const binding = { fingerprint: `artifact:${artifact.id}`, connectionId: input.connection_id };
    const offset =
      input.cursor === undefined ? 0 : decodeCursor(input.cursor, binding, cursorKey, clock.now());
    const max = Math.min(input.max_bytes ?? DEFAULT_ARTIFACT_CHUNK, MAX_ARTIFACT_CHUNK);
    const { bytes, size } = await files.readChunk(artifact.rel_path, offset, max);
    const eof = offset + bytes.length >= size;
    const chunk = cutChunk(bytes, eof);
    const next = offset + chunk.length;
    const done = next >= size;
    return {
      schema_version: SCHEMA_VERSION,
      kind: "artifact_chunk",
      artifact: {
        ...exports.artifactView(artifact),
        job_id: artifact.job_id,
        format: artifact.file_name.split(".").at(-1) ?? "",
      },
      offset,
      length: chunk.length,
      eof: done,
      text: chunk.toString("utf8"),
      next_cursor: done ? null : encodeCursor(binding, next, cursorKey, clock.now()),
    };
  }

  /** Artifacts of active connections, for resources/list. */
  listResources(): { uri: string; name: string; mimeType: string; size: number }[] {
    const active = new Set(this._deps.connections.list().map((c) => c.id));
    const now = this._deps.clock.now().getTime();
    return this._deps.jobs
      .listArtifacts()
      .filter((a) => active.has(a.connection_id) && Date.parse(a.expires_at) > now)
      .map((a) => ({
        uri: `metrika://artifacts/${a.id}`,
        name: a.file_name,
        mimeType: a.media_type,
        size: a.size_bytes,
      }));
  }

  /** resources/read repeats the same authorization as the tools: the owning connection must be active. */
  async resource(artifactId: string): Promise<{ text: string; mimeType: string }> {
    const artifact = this._deps.jobs.getArtifact(artifactId);
    if (!artifact) throw notFound();
    const owner = this._deps.connections.list().find((c) => c.id === artifact.connection_id);
    if (!owner) throw notFound();
    this._artifact(owner.id, artifactId);
    const { bytes, size } = await this._deps.files.readChunk(
      artifact.rel_path,
      0,
      RESOURCE_MAX_BYTES,
    );
    const eof = bytes.length >= size;
    const text = cutChunk(bytes, eof).toString("utf8");
    return {
      text: eof
        ? text
        : `${text}\n[truncated: first ${Buffer.byteLength(text)} of ${size} bytes; use metrika_read_artifact for the rest]\n`,
      mimeType: artifact.media_type,
    };
  }
}
