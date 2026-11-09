import { createHash, randomBytes } from "node:crypto";
import { SCHEMA_VERSION } from "../../domain/contract/common.ts";
import type { ExportInput, JobOutput } from "../../domain/contract/jobs.ts";
import { DomainError, invalidQuery } from "../../domain/errors.ts";
import { fingerprint } from "../../domain/fingerprint.ts";
import { resolvePeriod } from "../../domain/periods.ts";
import { rowKey, safeLabel } from "../../domain/privacy.ts";
import { enforceAccuracy, readSampling } from "../../domain/quality.ts";
import { parseUpstreamData } from "../../domain/upstream.ts";
import type { Warning } from "../../domain/warnings.ts";
import type { ConnectionResolver } from "../connections.ts";
import type { Clock, Sleep } from "../ports.ts";
import {
  loadCounterContext,
  planFields,
  planSort,
  toPeriodSpec,
  upstreamAccuracy,
} from "../query-planner.ts";
import {
  ACTIVE_JOB_STATES,
  type ArtifactRecord,
  type JobRecord,
  type JobStore,
  type PartRecord,
} from "../stores.ts";
import {
  csvHeader,
  csvRow,
  fileName,
  JSON_FOOTER,
  jsonHeader,
  jsonRow,
  mediaType,
} from "./format.ts";
import type { ExportFiles, ExportSpec, PartRow } from "./types.ts";

export interface ExportLimits {
  readonly pageSize: number;
  readonly minPageSize: number;
  readonly maxExportBytes: number;
  readonly maxManagedBytes: number;
  readonly minFreeBytes: number;
  readonly artifactTtlMs: number;
  readonly jobRetentionMs: number;
  readonly leaseMs: number;
}

export const DEFAULT_EXPORT_LIMITS: ExportLimits = {
  pageSize: 5000,
  minPageSize: 500,
  maxExportBytes: 1024 ** 3,
  maxManagedBytes: 2 * 1024 ** 3,
  minFreeBytes: 200 * 1024 ** 2,
  artifactTtlMs: 7 * 24 * 3600 * 1000,
  jobRetentionMs: 7 * 24 * 3600 * 1000,
  leaseMs: 90_000,
};

export interface ExportServiceDeps {
  readonly connections: ConnectionResolver;
  readonly jobs: JobStore;
  readonly files: ExportFiles;
  readonly clock: Clock;
  readonly sleep: Sleep;
  readonly privacy: "safe" | "full";
  readonly autoResume: boolean;
  readonly limits?: ExportLimits;
  readonly log: (message: string, fields: Record<string, unknown>) => void;
}

const newId = (prefix: string): string =>
  `${prefix}_${randomBytes(10).toString("base64url").replace(/[-_]/g, "0").toLowerCase().slice(0, 14)}`;

const notFound = (): DomainError =>
  new DomainError("JOB_NOT_FOUND", "No such export job for this connection.", {
    nextAction: "Check the job_id and connection_id, or start a new export.",
  });

const RESUMABLE: ReadonlySet<string> = new Set([
  "interrupted",
  "partial",
  "failed",
  "waiting_quota",
]);
const RETRYABLE_FAILURES: ReadonlySet<string> = new Set([
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_TIMEOUT",
  "QUOTA_EXCEEDED",
  "UPSTREAM_SCHEMA_CHANGED",
]);

interface FirstPage {
  readonly sampled: boolean | null;
  readonly sample_share: number | null;
  readonly totals: Record<string, number | string | null>;
  readonly first_fetch: string;
}

class Drift extends Error {}

/**
 * Durable aggregate exports (EXP-01, EXP-02). Each page is committed as a part
 * with a checksum; the final file is assembled from parts and published with
 * an atomic rename. A process exit leaves the job "interrupted" and resumable.
 */
export class ExportService {
  private readonly _deps: ExportServiceDeps;
  private readonly _limits: ExportLimits;
  private readonly _workerId = `w_${process.pid}_${randomBytes(4).toString("hex")}`;
  private readonly _running = new Map<string, AbortController>();
  private readonly _timers = new Set<NodeJS.Timeout>();

  constructor(deps: ExportServiceDeps) {
    this._deps = deps;
    this._limits = deps.limits ?? DEFAULT_EXPORT_LIMITS;
  }

  /** Marks jobs abandoned by a previous process as interrupted, then cleans expired files. */
  async startup(): Promise<void> {
    const now = this._deps.clock.now();
    for (const job of this._deps.jobs.listJobs({ states: ACTIVE_JOB_STATES })) {
      const leaseAlive =
        job.lease_expires_at !== null && Date.parse(job.lease_expires_at) > now.getTime();
      if (leaseAlive && job.lease_owner !== this._workerId) continue;
      this._update(job.id, {
        state: "interrupted",
        stage: "interrupted",
        lease_owner: null,
        lease_expires_at: null,
      });
      if (this._deps.autoResume) this._schedule(job.id, 0);
    }
    await this.cleanup();
  }

  async create(input: ExportInput): Promise<JobOutput> {
    if (input.resume_job_id !== undefined) {
      const extra = Object.keys(input).filter(
        (k) => k !== "connection_id" && k !== "resume_job_id",
      );
      if (extra.length > 0) {
        throw invalidQuery(
          `resume_job_id cannot be combined with ${extra.join(", ")}; the job keeps its original conditions.`,
        );
      }
      return this.resume(input.connection_id, input.resume_job_id);
    }
    if (input.counter_id === undefined)
      throw invalidQuery("counter_id is required for a new export.");
    if (input.idempotency_key === undefined) {
      throw invalidQuery(
        "idempotency_key is required for a new export.",
        "Pass any unique string, e.g. a UUID.",
      );
    }
    const { connections, clock, jobs } = this._deps;
    const connection = connections.get(input.connection_id);
    const ctx = await loadCounterContext(connection, input.counter_id, clock);
    const period = resolvePeriodFor(input, ctx);
    const fields = planFields(input, ctx.goalNames);
    const sort = planSort(input.sort, fields);
    const spec: ExportSpec = {
      v: 1,
      counter: { id: ctx.counter.id, name: ctx.counter.name, site: ctx.counter.site },
      period,
      metrics: fields.metrics.map((m) => ({
        id: m.id,
        label: m.label,
        unit: m.unit,
        aggregation: m.aggregation,
      })),
      dimensions: fields.dimensions.map((d) => ({ id: d.id, label: d.label })),
      filters: fields.filters,
      sort,
      accuracy: fields.accuracy,
      preset: fields.preset,
      format: input.format ?? "csv",
      privacy: this._deps.privacy,
    };
    const jobFingerprint = fingerprint({ connection: connection.id, spec });
    const existing = jobs.findJobByKey(connection.id, input.idempotency_key);
    if (existing) {
      if (existing.fingerprint !== jobFingerprint) {
        throw new DomainError(
          "IDEMPOTENCY_CONFLICT",
          "This idempotency_key was already used with different conditions.",
          {
            nextAction: "Use a new idempotency_key, or repeat the original request.",
          },
        );
      }
      return this.view(existing);
    }
    const now = clock.now().toISOString();
    const job: JobRecord = {
      id: newId("job"),
      connection_id: connection.id,
      generation: connection.generation,
      idempotency_key: input.idempotency_key,
      fingerprint: jobFingerprint,
      spec: JSON.stringify(spec),
      state: "queued",
      stage: "queued",
      rows_total: null,
      rows_total_rounded: false,
      rows_received: 0,
      rows_written: 0,
      bytes_written: 0,
      sampling: null,
      drift_restarts: 0,
      error_code: null,
      error_message: null,
      retry_at: null,
      artifact_id: null,
      created_at: now,
      updated_at: now,
      finished_at: null,
      expires_at: new Date(clock.now().getTime() + this._limits.jobRetentionMs).toISOString(),
      lease_owner: null,
      lease_expires_at: null,
    };
    jobs.insertJob(job);
    this._schedule(job.id, 0);
    return this.view(job);
  }

  resume(connectionId: string, jobId: string): JobOutput {
    const job = this._owned(connectionId, jobId);
    if (
      job.state === "completed" ||
      job.state === "queued" ||
      job.state === "running" ||
      this._running.has(job.id)
    ) {
      return this.view(job);
    }
    const resumable =
      RESUMABLE.has(job.state) &&
      (job.state !== "failed" || RETRYABLE_FAILURES.has(job.error_code ?? ""));
    if (!resumable) {
      throw invalidQuery(
        `Job ${job.id} is ${job.state} and cannot be resumed.`,
        "Start a new export with a new idempotency_key.",
      );
    }
    this._deps.connections.get(connectionId);
    this._update(job.id, {
      state: "queued",
      stage: "queued",
      error_code: null,
      error_message: null,
      retry_at: null,
    });
    this._schedule(job.id, 0);
    return this.view(this._owned(connectionId, jobId));
  }

  get(connectionId: string, jobId: string): JobOutput {
    return this.view(this._owned(connectionId, jobId));
  }

  async cancel(connectionId: string, jobId: string): Promise<JobOutput> {
    const job = this._owned(connectionId, jobId);
    await this._cancel(job);
    return this.view(this._owned(connectionId, jobId));
  }

  /** Disconnect hook: stops every active job of the connection. */
  async cancelForConnection(connectionId: string): Promise<number> {
    let count = 0;
    for (const job of this._deps.jobs.listJobs({ connectionId })) {
      if (job.state === "completed" || job.state === "cancelled") continue;
      await this._cancel(job);
      count += 1;
    }
    return count;
  }

  jobsSummary(): Record<string, number> {
    const summary: Record<string, number> = {};
    for (const job of this._deps.jobs.listJobs())
      summary[job.state] = (summary[job.state] ?? 0) + 1;
    return summary;
  }

  listJobs(connectionId?: string): JobOutput[] {
    return this._deps.jobs
      .listJobs(connectionId === undefined ? {} : { connectionId })
      .map((job) => this.view(job));
  }

  /** Deletes expired artifacts and finished jobs past retention. Active parts are never touched. */
  async cleanup(): Promise<void> {
    const { jobs, files, clock } = this._deps;
    const now = clock.now().getTime();
    for (const artifact of jobs.listArtifacts()) {
      if (Date.parse(artifact.expires_at) <= now) {
        await files.deleteArtifact(artifact.rel_path);
        jobs.deleteArtifact(artifact.id);
      }
    }
    for (const job of jobs.listJobs()) {
      if (ACTIVE_JOB_STATES.includes(job.state) || this._running.has(job.id)) continue;
      if (Date.parse(job.expires_at) <= now) {
        await files.deleteJobFiles(job.id);
        jobs.deleteJob(job.id);
      }
    }
  }

  async stop(): Promise<void> {
    for (const timer of this._timers) clearTimeout(timer);
    this._timers.clear();
    for (const controller of this._running.values()) controller.abort(new Error("server stopping"));
  }

  /** Waits until a job leaves the queue (used by tests and the CLI). */
  async settle(jobId: string, timeoutMs = 30_000): Promise<JobRecord | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const job = this._deps.jobs.getJob(jobId);
      if (!job || (!ACTIVE_JOB_STATES.includes(job.state) && !this._running.has(jobId))) return job;
      if (Date.now() > deadline) return job;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  view(job: JobRecord): JobOutput {
    const spec = JSON.parse(job.spec) as ExportSpec;
    const artifact = job.artifact_id ? this._deps.jobs.getArtifact(job.artifact_id) : null;
    const parts = this._deps.jobs.listParts(job.id).length;
    const exactTotal = job.rows_total !== null && !job.rows_total_rounded && job.rows_total > 0;
    const warnings: Warning[] = [];
    if (job.state === "completed" && spec.privacy === "safe" && spec.dimensions.length > 0) {
      warnings.push({
        code: "LABELS_REDACTED",
        severity: "info",
        message: "URL query strings and fragments were removed from labels (safe privacy mode).",
        affected_fields: [],
      });
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "job",
      job_id: job.id,
      connection_id: job.connection_id,
      state: job.state,
      stage: job.stage,
      format: spec.format,
      created_at: job.created_at,
      updated_at: job.updated_at,
      finished_at: job.finished_at,
      query: {
        counter: spec.counter,
        period: spec.period,
        metrics: spec.metrics.map((m) => m.id),
        dimensions: spec.dimensions.map((d) => d.id),
        filters: spec.filters.map((f) => ({ ...f, values: [...f.values] })),
        sort: [...spec.sort],
        accuracy_requested: spec.accuracy,
        preset: spec.preset,
      },
      progress: {
        rows_received: job.rows_received,
        rows_written: job.rows_written,
        rows_total: job.rows_total,
        rows_total_rounded: job.rows_total_rounded,
        bytes_written: job.bytes_written,
        parts,
        percent: exactTotal
          ? Math.min(100, Math.round((job.rows_received / (job.rows_total ?? 1)) * 1000) / 10)
          : null,
      },
      error: job.error_code
        ? {
            code: job.error_code as NonNullable<JobOutput["error"]>["code"],
            message: job.error_message ?? "",
            retryable: RETRYABLE_FAILURES.has(job.error_code),
            retry_at: job.retry_at,
          }
        : null,
      artifacts: artifact ? [this.artifactView(artifact)] : [],
      next_action: nextAction(job),
      warnings,
    };
  }

  artifactView(artifact: ArtifactRecord) {
    return {
      artifact_id: artifact.id,
      uri: `metrika://artifacts/${artifact.id}`,
      file_path: this._deps.files.absolutePath(artifact.rel_path),
      media_type: artifact.media_type,
      size_bytes: artifact.size_bytes,
      sha256: artifact.sha256,
      rows: artifact.rows,
      expires_at: artifact.expires_at,
    };
  }

  // ---------- internals ----------

  private _owned(connectionId: string, jobId: string): JobRecord {
    const job = this._deps.jobs.getJob(jobId);
    // Same answer for "missing" and "someone else's": never reveal other jobs (T21).
    if (!job || job.connection_id !== connectionId) throw notFound();
    return job;
  }

  private _update(id: string, patch: Parameters<JobStore["updateJob"]>[1]): void {
    this._deps.jobs.updateJob(id, { ...patch, updated_at: this._deps.clock.now().toISOString() });
  }

  private async _cancel(job: JobRecord): Promise<void> {
    if (job.state === "completed" || job.state === "cancelled") return;
    this._running.get(job.id)?.abort(new Error("cancelled"));
    this._update(job.id, {
      state: "cancelled",
      stage: "cancelled",
      finished_at: this._deps.clock.now().toISOString(),
    });
    if (!this._running.has(job.id)) {
      this._deps.jobs.deleteParts(job.id);
      await this._deps.files.deleteJobFiles(job.id);
    }
  }

  private _schedule(jobId: string, delayMs: number): void {
    const timer = setTimeout(() => {
      this._timers.delete(timer);
      this._run(jobId).catch((error: unknown) =>
        this._deps.log("export worker crashed", { job_id: jobId, error }),
      );
    }, delayMs);
    timer.unref();
    this._timers.add(timer);
  }

  private async _run(jobId: string): Promise<void> {
    if (this._running.has(jobId)) return;
    const { jobs, clock } = this._deps;
    const controller = new AbortController();
    this._running.set(jobId, controller);
    const leaseUntil = () => new Date(clock.now().getTime() + this._limits.leaseMs);
    if (!jobs.acquireLease(jobId, this._workerId, leaseUntil(), clock.now())) {
      this._running.delete(jobId);
      return;
    }
    const heartbeat = setInterval(
      () => jobs.acquireLease(jobId, this._workerId, leaseUntil(), clock.now()),
      this._limits.leaseMs / 3,
    );
    heartbeat.unref();
    try {
      const job = jobs.getJob(jobId);
      if (!job || !(job.state === "queued" || job.state === "waiting_quota")) return;
      await this._execute(job, controller.signal);
    } catch (error) {
      this._fail(jobId, error, controller.signal);
    } finally {
      clearInterval(heartbeat);
      jobs.releaseLease(jobId, this._workerId);
      this._running.delete(jobId);
      const final = jobs.getJob(jobId);
      if (final?.state === "cancelled") {
        jobs.deleteParts(jobId);
        await this._deps.files.deleteJobFiles(jobId);
      }
    }
  }

  private _fail(jobId: string, error: unknown, signal: AbortSignal): void {
    const job = this._deps.jobs.getJob(jobId);
    if (!job || job.state === "cancelled") return;
    if (signal.aborted) {
      this._update(jobId, { state: "interrupted", stage: "interrupted" });
      return;
    }
    if (error instanceof DomainError && error.code === "QUOTA_EXCEEDED" && error.retryAt) {
      this._update(jobId, {
        state: "waiting_quota",
        stage: "waiting_quota",
        retry_at: error.retryAt,
        error_code: error.code,
        error_message: error.message,
      });
      this._schedule(
        jobId,
        Math.max(1000, Date.parse(error.retryAt) - this._deps.clock.now().getTime()),
      );
      return;
    }
    const code = error instanceof DomainError ? error.code : "INTERNAL_ERROR";
    const message =
      error instanceof DomainError
        ? error.message
        : "Unexpected export failure; see the server log.";
    const transient = code === "UPSTREAM_UNAVAILABLE" || code === "UPSTREAM_TIMEOUT";
    if (!(error instanceof DomainError)) this._deps.log("export failed", { job_id: jobId, error });
    this._update(jobId, {
      state: transient ? "interrupted" : "failed",
      stage: transient ? "interrupted" : "failed",
      error_code: code,
      error_message: message,
      finished_at: transient ? null : this._deps.clock.now().toISOString(),
    });
  }

  private _checkStorage(job: JobRecord): void {
    const { jobs, files } = this._deps;
    if (job.bytes_written > this._limits.maxExportBytes) {
      throw new DomainError(
        "STORAGE_LIMIT",
        "The export exceeds the per-export size limit (1 GiB).",
        {
          nextAction: "Narrow the period or the dimensions, or split the export.",
        },
      );
    }
    const managed =
      jobs.listArtifacts().reduce((sum, a) => sum + a.size_bytes, 0) +
      jobs.listJobs({ states: ACTIVE_JOB_STATES }).reduce((sum, j) => sum + j.bytes_written, 0);
    if (managed > this._limits.maxManagedBytes) {
      throw new DomainError("STORAGE_LIMIT", "Managed export storage is full (2 GiB).", {
        nextAction:
          "Delete old exports with `yandex-metrika-mcp jobs clean` or wait for them to expire.",
      });
    }
    const free = files.freeBytes();
    if (free !== null && free < this._limits.minFreeBytes) {
      throw new DomainError("STORAGE_LIMIT", "Not enough free disk space for the export.");
    }
  }

  private async _execute(initial: JobRecord, signal: AbortSignal): Promise<void> {
    const { connections, jobs } = this._deps;
    const spec = JSON.parse(initial.spec) as ExportSpec;
    const connection = connections.get(initial.connection_id);
    if (connection.generation !== initial.generation) {
      throw new DomainError(
        "AUTH_REQUIRED",
        "The connection was signed in again; start a new export.",
      );
    }
    this._update(initial.id, {
      state: "running",
      stage: "fetching",
      retry_at: null,
      error_code: null,
      error_message: null,
    });
    let pageSize = this._limits.pageSize;
    for (;;) {
      try {
        await this._fetchPages(initial.id, spec, signal, pageSize);
        break;
      } catch (error) {
        if (error instanceof Drift) {
          const job = jobs.getJob(initial.id);
          if (!job || job.drift_restarts >= 1) {
            this._update(initial.id, {
              state: "partial",
              stage: "partial",
              error_code: "UPSTREAM_SCHEMA_CHANGED",
              error_message: `Data changed between pages twice (${error.message}); the export is incomplete.`,
            });
            return;
          }
          jobs.deleteParts(initial.id);
          await this._deps.files.deleteJobFiles(initial.id);
          this._update(initial.id, {
            drift_restarts: job.drift_restarts + 1,
            rows_total: null,
            rows_received: 0,
            rows_written: 0,
            bytes_written: 0,
            sampling: null,
            stage: "restarting",
          });
          continue;
        }
        if (
          error instanceof DomainError &&
          error.code === "RESULT_LIMIT_REACHED" &&
          pageSize > this._limits.minPageSize
        ) {
          pageSize = Math.max(this._limits.minPageSize, Math.floor(pageSize / 2));
          continue;
        }
        throw error;
      }
    }
    if (signal.aborted) return;
    const job = jobs.getJob(initial.id);
    if (!job || job.state === "cancelled") return;
    if (
      !job.rows_total_rounded &&
      job.rows_total !== null &&
      job.rows_received !== job.rows_total
    ) {
      this._update(job.id, {
        state: "partial",
        stage: "partial",
        error_code: "UPSTREAM_SCHEMA_CHANGED",
        error_message: `Received ${job.rows_received} of ${job.rows_total} rows.`,
      });
      return;
    }
    await this._assemble(job, spec, signal);
  }

  private async _fetchPages(
    jobId: string,
    spec: ExportSpec,
    signal: AbortSignal,
    pageSize: number,
  ): Promise<void> {
    const { connections, jobs, files } = this._deps;
    for (;;) {
      if (signal.aborted) return;
      const job = jobs.getJob(jobId);
      if (!job || job.state === "cancelled") return;
      const connection = connections.get(job.connection_id);
      if (connection.generation !== job.generation)
        throw new DomainError("AUTH_REQUIRED", "The connection changed during the export.");
      const parts = jobs.listParts(jobId);
      const offset = parts.reduce((sum, p) => sum + p.rows, 0);
      if (job.rows_total !== null && !job.rows_total_rounded && offset >= job.rows_total) return;
      this._checkStorage(job);
      const response = await connection.source.getData(
        {
          counterId: spec.counter.id,
          date1: spec.period.start,
          date2: spec.period.end,
          metrics: spec.metrics.map((m) => m.id),
          dimensions: spec.dimensions.map((d) => d.id),
          filters: spec.filters,
          sort: spec.sort,
          limit: pageSize,
          offset: offset + 1,
          accuracy: upstreamAccuracy(spec.accuracy),
        },
        { cache: "refresh", priority: "background", signal },
      );
      const upstream = parseUpstreamData(
        response.body,
        spec.metrics.length,
        spec.dimensions.length,
      );
      const sampling = readSampling(upstream);
      enforceAccuracy(sampling, spec.accuracy);
      const rounded = upstream.total_rows_rounded ?? false;
      if (job.sampling === null) {
        const first: FirstPage = {
          sampled: sampling.sampled,
          sample_share: sampling.sample_share,
          totals: Object.fromEntries(
            spec.metrics.map((m, i) => [m.id, upstream.totals[i] ?? null]),
          ),
          first_fetch: response.fetchedAt.toISOString(),
        };
        this._update(jobId, {
          rows_total: upstream.total_rows,
          rows_total_rounded: rounded,
          sampling: JSON.stringify(first),
        });
      } else {
        const first = JSON.parse(job.sampling) as FirstPage;
        if (upstream.total_rows !== job.rows_total)
          throw new Drift(`row count ${job.rows_total} → ${upstream.total_rows}`);
        if (first.sampled !== sampling.sampled || first.sample_share !== sampling.sample_share) {
          throw new Drift("sampling changed");
        }
      }
      const rows = spec.dimensions.length > 0 ? upstream.data : [];
      const expectMore = !rounded && offset < upstream.total_rows;
      if (rows.length === 0) {
        if (expectMore && spec.dimensions.length > 0) {
          throw new DomainError(
            "UPSTREAM_SCHEMA_CHANGED",
            "The API returned an empty page before all rows arrived.",
          );
        }
        return;
      }
      if (rows.length > pageSize)
        throw new DomainError(
          "UPSTREAM_SCHEMA_CHANGED",
          "The API returned more rows than requested.",
        );
      const partRows: PartRow[] = rows.map((row) => {
        const raw = row.dimensions.map((d) => ({
          id: d.id === null || d.id === undefined ? null : String(d.id),
          name: d.name ?? null,
        }));
        return { k: rowKey(raw), d: raw.map((d) => [d.id, d.name] as const), v: row.metrics };
      });
      const rowsHash = createHash("sha256")
        .update(partRows.map((r) => r.k).join("\n"))
        .digest("hex");
      if (parts.at(-1)?.rows_hash === rowsHash) {
        throw new DomainError(
          "UPSTREAM_SCHEMA_CHANGED",
          "The API repeated the same page; stopping to avoid duplicates.",
        );
      }
      if (signal.aborted) return;
      const partNo = parts.length + 1;
      const content = `${partRows.map((r) => JSON.stringify(r)).join("\n")}\n`;
      const written = await files.writePart(jobId, partNo, content);
      const part: PartRecord = {
        job_id: jobId,
        part_no: partNo,
        row_offset: offset,
        rows: partRows.length,
        bytes: written.bytes,
        sha256: written.sha256,
        rows_hash: rowsHash,
      };
      jobs.insertPart(part);
      const after = jobs.getJob(jobId);
      this._update(jobId, {
        rows_received: offset + partRows.length,
        bytes_written: (after?.bytes_written ?? 0) + written.bytes,
        stage: "fetching",
      });
      if (rows.length < pageSize) return;
      if (!rounded && offset + rows.length >= upstream.total_rows) return;
    }
  }

  private async _assemble(job: JobRecord, spec: ExportSpec, signal: AbortSignal): Promise<void> {
    const { jobs, files, clock } = this._deps;
    this._update(job.id, { stage: "assembling" });
    const parts = jobs.listParts(job.id);
    const first = job.sampling ? (JSON.parse(job.sampling) as FirstPage) : null;
    const artifactId = newId("art");
    const name = fileName(spec, job.id);
    let rowsWritten = 0;
    let redacted = false;
    const label = (value: string | null): string | null => {
      if (spec.privacy === "full" || value === null) return value;
      const safe = safeLabel(value);
      redacted ||= safe.redacted;
      return safe.name;
    };
    const now = clock.now();
    const expiresAt = new Date(now.getTime() + this._limits.artifactTtlMs).toISOString();
    const result = await files.createArtifact(
      artifactId,
      name,
      async (sink) => {
        await sink.write(
          spec.format === "json" ? jsonHeader(spec, first?.totals ?? {}) : csvHeader(spec),
        );
        let firstRow = true;
        for (const part of parts) {
          if (signal.aborted) throw new Error("cancelled");
          const content = await files.readPart(job.id, part.part_no);
          const sha = createHash("sha256").update(content).digest("hex");
          if (sha !== part.sha256) {
            throw new DomainError(
              "UPSTREAM_SCHEMA_CHANGED",
              `Checksum mismatch in stored part ${part.part_no}.`,
            );
          }
          const lines = content.split("\n").filter((line) => line !== "");
          let chunk = "";
          for (const line of lines) {
            const raw = JSON.parse(line) as PartRow;
            const row: PartRow = {
              ...raw,
              d: raw.d.map(([id, n]) => [label(id), label(n)] as const),
            };
            chunk += spec.format === "json" ? jsonRow(row, firstRow) : csvRow(spec, row);
            firstRow = false;
            rowsWritten += 1;
          }
          await sink.write(chunk);
        }
        if (spec.format === "json") await sink.write(JSON_FOOTER);
      },
      (data) =>
        JSON.stringify(
          {
            schema_version: "1.0",
            artifact_id: artifactId,
            job_id: job.id,
            file_name: name,
            media_type: mediaType(spec.format),
            size_bytes: data.bytes,
            sha256: data.sha256,
            rows: rowsWritten,
            created_at: now.toISOString(),
            expires_at: expiresAt,
            query: {
              counter: spec.counter,
              period: spec.period,
              metrics: spec.metrics,
              dimensions: spec.dimensions,
              filters: spec.filters,
              sort: spec.sort,
              accuracy_requested: spec.accuracy,
              preset: spec.preset,
            },
            quality: {
              complete: true,
              rows_total: job.rows_total,
              rows_total_rounded: job.rows_total_rounded,
              sampled: first?.sampled ?? null,
              sample_share: first?.sample_share ?? null,
            },
            fetched_between: [first?.first_fetch ?? null, clock.now().toISOString()],
            transformations: [
              ...(spec.privacy === "safe" && redacted
                ? ["url_query_and_fragment_removed_from_labels"]
                : []),
              ...(spec.format === "csv_excel_safe"
                ? ["utf8_bom", "excel_formula_guard_on_text_cells"]
                : []),
            ],
            integer_policy: "Integers beyond 2^53 are written as exact digit strings.",
          },
          null,
          2,
        ),
    );
    jobs.insertArtifact({
      id: artifactId,
      job_id: job.id,
      connection_id: job.connection_id,
      generation: job.generation,
      media_type: mediaType(spec.format),
      file_name: name,
      rel_path: result.relPath,
      size_bytes: result.bytes,
      sha256: result.sha256,
      rows: rowsWritten,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      manifest: "{}",
    });
    this._update(job.id, {
      state: "completed",
      stage: "completed",
      rows_written: rowsWritten,
      artifact_id: artifactId,
      finished_at: clock.now().toISOString(),
    });
    jobs.deleteParts(job.id);
    await files.deleteJobFiles(job.id);
  }
}

function resolvePeriodFor(input: ExportInput, ctx: Awaited<ReturnType<typeof loadCounterContext>>) {
  return resolvePeriod(toPeriodSpec(input.period, "last_7_complete_days"), ctx);
}

function nextAction(job: JobRecord): string | null {
  switch (job.state) {
    case "queued":
    case "running":
      return "Poll metrika_get_job until the state is completed.";
    case "waiting_quota":
      return `Waiting for the Yandex quota${job.retry_at ? ` until ${job.retry_at}` : ""}; it continues automatically while the server runs.`;
    case "interrupted":
    case "partial":
      return "Call metrika_export_report with resume_job_id to continue from the last saved page.";
    case "failed":
      return RETRYABLE_FAILURES.has(job.error_code ?? "")
        ? "Call metrika_export_report with resume_job_id to retry."
        : "Fix the request and start a new export with a new idempotency_key.";
    case "completed":
      return "Read the file with metrika_read_artifact or open file_path.";
    case "cancelled":
      return null;
  }
}
