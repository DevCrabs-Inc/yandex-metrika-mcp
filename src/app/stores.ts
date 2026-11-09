/** Durable local state. Records never contain tokens; those live in SecretStore. */

export type ConnectionKind = "oauth" | "token";
export type ConnectionState = "active" | "needs_reconnect" | "disconnected";

export interface ConnectionRecord {
  readonly id: string;
  readonly alias: string;
  readonly kind: ConnectionKind;
  readonly state: ConnectionState;
  /** Bumped on reconnect and disconnect so stale workers and caches cannot resurrect data. */
  readonly generation: number;
  readonly allowed_counters: readonly string[] | null;
  readonly token_expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export type ConnectionPatch = Partial<
  Pick<ConnectionRecord, "alias" | "state" | "generation" | "allowed_counters" | "token_expires_at">
>;

export interface ConnectionStore {
  listConnections(): ConnectionRecord[];
  getConnection(id: string): ConnectionRecord | null;
  insertConnection(record: ConnectionRecord): void;
  updateConnection(id: string, patch: ConnectionPatch, now: Date): void;
}

export const JOB_STATES = [
  "queued",
  "running",
  "waiting_quota",
  "interrupted",
  "partial",
  "failed",
  "cancelled",
  "completed",
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const ACTIVE_JOB_STATES: readonly JobState[] = ["queued", "running", "waiting_quota"];

export interface JobRecord {
  readonly id: string;
  readonly connection_id: string;
  readonly generation: number;
  readonly idempotency_key: string;
  readonly fingerprint: string;
  /** Serialized ExportSpec: everything needed to rerun or resume the export. */
  readonly spec: string;
  readonly state: JobState;
  readonly stage: string;
  readonly rows_total: number | null;
  readonly rows_total_rounded: boolean;
  readonly rows_received: number;
  readonly rows_written: number;
  readonly bytes_written: number;
  /** Sampling seen on the first page, to detect changes between pages. */
  readonly sampling: string | null;
  readonly drift_restarts: number;
  readonly error_code: string | null;
  readonly error_message: string | null;
  readonly retry_at: string | null;
  readonly artifact_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly finished_at: string | null;
  readonly expires_at: string;
  readonly lease_owner: string | null;
  readonly lease_expires_at: string | null;
}

export type JobPatch = Partial<
  Omit<
    JobRecord,
    | "id"
    | "connection_id"
    | "generation"
    | "idempotency_key"
    | "fingerprint"
    | "spec"
    | "created_at"
  >
>;

export interface PartRecord {
  readonly job_id: string;
  readonly part_no: number;
  /** Zero-based index of the first row in the part. */
  readonly row_offset: number;
  readonly rows: number;
  readonly bytes: number;
  readonly sha256: string;
  /** Hash of the row identities, to detect an API repeating the same page. */
  readonly rows_hash: string;
}

export interface ArtifactRecord {
  readonly id: string;
  readonly job_id: string;
  readonly connection_id: string;
  readonly generation: number;
  readonly media_type: string;
  readonly file_name: string;
  /** Path relative to the managed artifacts directory. */
  readonly rel_path: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly rows: number;
  readonly created_at: string;
  readonly expires_at: string;
  readonly manifest: string;
}

export interface JobStore {
  insertJob(job: JobRecord): void;
  getJob(id: string): JobRecord | null;
  findJobByKey(connectionId: string, idempotencyKey: string): JobRecord | null;
  updateJob(id: string, patch: JobPatch): void;
  listJobs(filter?: {
    readonly connectionId?: string;
    readonly states?: readonly JobState[];
  }): JobRecord[];
  /** Takes or renews the lease; false when another live worker holds it. */
  acquireLease(id: string, owner: string, until: Date, now: Date): boolean;
  releaseLease(id: string, owner: string): void;
  insertPart(part: PartRecord): void;
  listParts(jobId: string): PartRecord[];
  deleteParts(jobId: string): void;
  insertArtifact(artifact: ArtifactRecord): void;
  getArtifact(id: string): ArtifactRecord | null;
  listArtifacts(filter?: { readonly connectionId?: string }): ArtifactRecord[];
  deleteArtifact(id: string): void;
  deleteJob(id: string): void;
}
