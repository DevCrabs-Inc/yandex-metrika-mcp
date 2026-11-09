import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statfsSync } from "node:fs";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import type { ArtifactWriteResult, ExportFiles, WriteSink } from "../../app/export/types.ts";
import { DomainError } from "../../domain/errors.ts";

const SAFE_ID = /^[a-z0-9_]{6,64}$/;
const SAFE_FILE = /^[A-Za-z0-9._-]{1,200}$/;

function assertId(id: string): void {
  if (!SAFE_ID.test(id)) throw new DomainError("ARTIFACT_NOT_FOUND", "Unknown artifact or job.");
}

/**
 * Files under the managed data directory only. IDs are validated before they
 * become path segments, results are checked to stay inside the root, and
 * symlinks are refused (T30).
 */
export class ManagedFiles implements ExportFiles {
  private readonly _jobs: string;
  private readonly _artifacts: string;

  constructor(jobsDir: string, artifactsDir: string) {
    this._jobs = resolve(jobsDir);
    this._artifacts = resolve(artifactsDir);
    mkdirSync(this._jobs, { recursive: true, mode: 0o700 });
    mkdirSync(this._artifacts, { recursive: true, mode: 0o700 });
  }

  private _inside(root: string, target: string): string {
    const full = resolve(root, target);
    const rel = relative(root, full);
    if (
      rel === "" ||
      rel.startsWith("..") ||
      rel.includes(`..${sep}`) ||
      resolve(root, rel) !== full
    ) {
      throw new DomainError("ARTIFACT_NOT_FOUND", "Unknown artifact.");
    }
    let current = root;
    for (const segment of rel.split(sep)) {
      current = join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink())
          throw new DomainError("ARTIFACT_NOT_FOUND", "Unknown artifact.");
      } catch (error) {
        if (error instanceof DomainError) throw error;
      }
    }
    return full;
  }

  private _partFile(jobId: string, partNo: number): string {
    assertId(jobId);
    if (!Number.isSafeInteger(partNo) || partNo < 1) throw new Error("Bad part number");
    return this._inside(this._jobs, join(jobId, `part-${String(partNo).padStart(5, "0")}.ndjson`));
  }

  async writePart(
    jobId: string,
    partNo: number,
    content: string,
  ): Promise<{ bytes: number; sha256: string }> {
    const file = this._partFile(jobId, partNo);
    await mkdir(join(this._jobs, jobId), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    const handle = await open(tmp, "w", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, file);
    return {
      bytes: Buffer.byteLength(content, "utf8"),
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  }

  async readPart(jobId: string, partNo: number): Promise<string> {
    return readFile(this._partFile(jobId, partNo), "utf8");
  }

  async deleteJobFiles(jobId: string): Promise<void> {
    assertId(jobId);
    await rm(this._inside(this._jobs, jobId), { recursive: true, force: true });
  }

  async createArtifact(
    artifactId: string,
    fileName: string,
    writeData: (sink: WriteSink) => Promise<void>,
    manifest: (data: { bytes: number; sha256: string }) => string,
  ): Promise<ArtifactWriteResult> {
    assertId(artifactId);
    if (!SAFE_FILE.test(fileName)) throw new Error("Bad file name");
    const tmpDir = this._inside(this._artifacts, `.tmp-${artifactId}`);
    const finalDir = this._inside(this._artifacts, artifactId);
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const hash = createHash("sha256");
    let bytes = 0;
    const handle = await open(join(tmpDir, fileName), "w", 0o600);
    try {
      await writeData({
        write: async (chunk) => {
          const buffer = Buffer.from(chunk, "utf8");
          hash.update(buffer);
          bytes += buffer.length;
          await handle.write(buffer);
        },
      });
      await handle.sync();
    } finally {
      await handle.close();
    }
    const sha256 = hash.digest("hex");
    await writeFile(join(tmpDir, "manifest.json"), manifest({ bytes, sha256 }), { mode: 0o600 });
    // Publishing is a rename: a reader never sees a half-written file (EXP-01).
    await rename(tmpDir, finalDir);
    return {
      relPath: `${artifactId}/${fileName}`,
      bytes,
      sha256,
      absolutePath: join(finalDir, fileName),
    };
  }

  absolutePath(relPath: string): string {
    const [id, file, extra] = relPath.split("/");
    if (!id || !file || extra !== undefined)
      throw new DomainError("ARTIFACT_NOT_FOUND", "Unknown artifact.");
    assertId(id);
    if (!SAFE_FILE.test(file)) throw new DomainError("ARTIFACT_NOT_FOUND", "Unknown artifact.");
    return this._inside(this._artifacts, join(id, file));
  }

  async readChunk(
    relPath: string,
    offset: number,
    maxBytes: number,
  ): Promise<{ bytes: Buffer; size: number }> {
    const file = this.absolutePath(relPath);
    let handle: Awaited<ReturnType<typeof open>>;
    try {
      handle = await open(file, "r");
    } catch {
      throw new DomainError("ARTIFACT_EXPIRED", "The export file is no longer available.", {
        nextAction: "Run metrika_export_report again.",
      });
    }
    try {
      const { size } = await handle.stat();
      const length = Math.max(0, Math.min(maxBytes, size - offset));
      const buffer = Buffer.alloc(length);
      if (length > 0) await handle.read(buffer, 0, length, offset);
      return { bytes: buffer, size };
    } finally {
      await handle.close();
    }
  }

  async deleteArtifact(relPath: string): Promise<void> {
    const [id] = relPath.split("/");
    if (!id) return;
    assertId(id);
    await rm(this._inside(this._artifacts, id), { recursive: true, force: true });
  }

  freeBytes(): number | null {
    try {
      const stats = statfsSync(this._artifacts);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      return null;
    }
  }
}
