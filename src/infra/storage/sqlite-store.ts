import { copyFileSync, existsSync } from "node:fs";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type {
  ArtifactRecord,
  ConnectionPatch,
  ConnectionRecord,
  ConnectionStore,
  JobPatch,
  JobRecord,
  JobState,
  JobStore,
  PartRecord,
} from "../../app/stores.ts";

export const DB_SCHEMA_VERSION = 1;

const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE connections (
      id TEXT PRIMARY KEY,
      alias TEXT NOT NULL,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      generation INTEGER NOT NULL,
      allowed_counters TEXT,
      token_expires_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      idempotency_key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      spec TEXT NOT NULL,
      state TEXT NOT NULL,
      stage TEXT NOT NULL,
      rows_total INTEGER,
      rows_total_rounded INTEGER NOT NULL DEFAULT 0,
      rows_received INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0,
      bytes_written INTEGER NOT NULL DEFAULT 0,
      sampling TEXT,
      drift_restarts INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      retry_at TEXT,
      artifact_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      expires_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_expires_at TEXT,
      UNIQUE (connection_id, idempotency_key)
    );
    CREATE TABLE job_parts (
      job_id TEXT NOT NULL,
      part_no INTEGER NOT NULL,
      row_offset INTEGER NOT NULL,
      rows INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      rows_hash TEXT NOT NULL,
      PRIMARY KEY (job_id, part_no)
    );
    CREATE TABLE artifacts (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      connection_id TEXT NOT NULL,
      generation INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      file_name TEXT NOT NULL,
      rel_path TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      rows INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      manifest TEXT NOT NULL
    );
  `,
};

export class DatabaseTooNewError extends Error {
  override readonly name = "DatabaseTooNewError";
}

type Row = Record<string, SQLInputValue>;

const toConnection = (r: Row): ConnectionRecord => ({
  id: String(r["id"]),
  alias: String(r["alias"]),
  kind: r["kind"] === "token" ? "token" : "oauth",
  state: r["state"] as ConnectionRecord["state"],
  generation: Number(r["generation"]),
  allowed_counters:
    r["allowed_counters"] === null ? null : (JSON.parse(String(r["allowed_counters"])) as string[]),
  token_expires_at: r["token_expires_at"] === null ? null : String(r["token_expires_at"]),
  created_at: String(r["created_at"]),
  updated_at: String(r["updated_at"]),
});

const nullableString = (v: SQLInputValue | undefined): string | null =>
  v === null || v === undefined ? null : String(v);
const nullableNumber = (v: SQLInputValue | undefined): number | null =>
  v === null || v === undefined ? null : Number(v);

const toJob = (r: Row): JobRecord => ({
  id: String(r["id"]),
  connection_id: String(r["connection_id"]),
  generation: Number(r["generation"]),
  idempotency_key: String(r["idempotency_key"]),
  fingerprint: String(r["fingerprint"]),
  spec: String(r["spec"]),
  state: r["state"] as JobState,
  stage: String(r["stage"]),
  rows_total: nullableNumber(r["rows_total"]),
  rows_total_rounded: Number(r["rows_total_rounded"]) === 1,
  rows_received: Number(r["rows_received"]),
  rows_written: Number(r["rows_written"]),
  bytes_written: Number(r["bytes_written"]),
  sampling: nullableString(r["sampling"]),
  drift_restarts: Number(r["drift_restarts"]),
  error_code: nullableString(r["error_code"]),
  error_message: nullableString(r["error_message"]),
  retry_at: nullableString(r["retry_at"]),
  artifact_id: nullableString(r["artifact_id"]),
  created_at: String(r["created_at"]),
  updated_at: String(r["updated_at"]),
  finished_at: nullableString(r["finished_at"]),
  expires_at: String(r["expires_at"]),
  lease_owner: nullableString(r["lease_owner"]),
  lease_expires_at: nullableString(r["lease_expires_at"]),
});

const toPart = (r: Row): PartRecord => ({
  job_id: String(r["job_id"]),
  part_no: Number(r["part_no"]),
  row_offset: Number(r["row_offset"]),
  rows: Number(r["rows"]),
  bytes: Number(r["bytes"]),
  sha256: String(r["sha256"]),
  rows_hash: String(r["rows_hash"]),
});

const toArtifact = (r: Row): ArtifactRecord => ({
  id: String(r["id"]),
  job_id: String(r["job_id"]),
  connection_id: String(r["connection_id"]),
  generation: Number(r["generation"]),
  media_type: String(r["media_type"]),
  file_name: String(r["file_name"]),
  rel_path: String(r["rel_path"]),
  size_bytes: Number(r["size_bytes"]),
  sha256: String(r["sha256"]),
  rows: Number(r["rows"]),
  created_at: String(r["created_at"]),
  expires_at: String(r["expires_at"]),
  manifest: String(r["manifest"]),
});

function sqlValue(value: unknown): SQLInputValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string" || typeof value === "bigint")
    return value;
  return JSON.stringify(value);
}

const COLUMN = /^[a-z_][a-z0-9_]*$/;

/** All durable state in one SQLite file (WAL mode, safe for several local server processes). */
export class SqliteStore implements ConnectionStore, JobStore {
  private readonly _db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this._db = db;
  }

  static async open(file: string): Promise<SqliteStore> {
    const { DatabaseSync } = await import("node:sqlite");
    const existed = existsSync(file);
    const db = new DatabaseSync(file);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    const store = new SqliteStore(db);
    store._migrate(existed ? file : null);
    return store;
  }

  close(): void {
    this._db.close();
  }

  private _migrate(existingFile: string | null): void {
    this._db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const row = this._db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
      | Row
      | undefined;
    const current = row ? Number(row["value"]) : 0;
    if (current > DB_SCHEMA_VERSION) {
      throw new DatabaseTooNewError(
        `The state database was created by a newer version (schema ${current}). Upgrade yandex-metrika-mcp or restore a backup.`,
      );
    }
    if (current === DB_SCHEMA_VERSION) return;
    if (existingFile !== null && current > 0)
      copyFileSync(existingFile, `${existingFile}.backup-v${current}`);
    this._db.exec("BEGIN IMMEDIATE");
    try {
      for (let v = current + 1; v <= DB_SCHEMA_VERSION; v++) {
        const sql = MIGRATIONS[v];
        if (sql) this._db.exec(sql);
      }
      this._db
        .prepare(
          "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(String(DB_SCHEMA_VERSION));
      this._db.exec("COMMIT");
    } catch (error) {
      this._db.exec("ROLLBACK");
      throw error;
    }
  }

  private _update(table: string, id: string, patch: Record<string, unknown>): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    for (const [column] of entries)
      if (!COLUMN.test(column)) throw new Error(`Bad column ${column}`);
    const set = entries.map(([column]) => `${column} = ?`).join(", ");
    this._db
      .prepare(`UPDATE ${table} SET ${set} WHERE id = ?`)
      .run(...entries.map(([, v]) => sqlValue(v)), id);
  }

  private _insert(table: string, record: Record<string, unknown>): void {
    const columns = Object.keys(record);
    for (const column of columns) if (!COLUMN.test(column)) throw new Error(`Bad column ${column}`);
    this._db
      .prepare(
        `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
      )
      .run(...columns.map((c) => sqlValue(record[c])));
  }

  // ---------- connections ----------

  listConnections(): ConnectionRecord[] {
    return (this._db.prepare("SELECT * FROM connections ORDER BY created_at").all() as Row[]).map(
      toConnection,
    );
  }

  getConnection(id: string): ConnectionRecord | null {
    const row = this._db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as
      | Row
      | undefined;
    return row ? toConnection(row) : null;
  }

  insertConnection(record: ConnectionRecord): void {
    this._insert("connections", { ...record, allowed_counters: record.allowed_counters });
  }

  updateConnection(id: string, patch: ConnectionPatch, now: Date): void {
    this._update("connections", id, { ...patch, updated_at: now.toISOString() });
  }

  // ---------- jobs ----------

  insertJob(job: JobRecord): void {
    this._insert("jobs", { ...job });
  }

  getJob(id: string): JobRecord | null {
    const row = this._db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    return row ? toJob(row) : null;
  }

  findJobByKey(connectionId: string, idempotencyKey: string): JobRecord | null {
    const row = this._db
      .prepare("SELECT * FROM jobs WHERE connection_id = ? AND idempotency_key = ?")
      .get(connectionId, idempotencyKey) as Row | undefined;
    return row ? toJob(row) : null;
  }

  updateJob(id: string, patch: JobPatch): void {
    this._update("jobs", id, { ...patch });
  }

  listJobs(
    filter: { readonly connectionId?: string; readonly states?: readonly JobState[] } = {},
  ): JobRecord[] {
    const where: string[] = [];
    const args: SQLInputValue[] = [];
    if (filter.connectionId !== undefined) {
      where.push("connection_id = ?");
      args.push(filter.connectionId);
    }
    if (filter.states !== undefined && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      args.push(...filter.states);
    }
    const sql = `SELECT * FROM jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at DESC`;
    return (this._db.prepare(sql).all(...args) as Row[]).map(toJob);
  }

  acquireLease(id: string, owner: string, until: Date, now: Date): boolean {
    const result = this._db
      .prepare(
        "UPDATE jobs SET lease_owner = ?, lease_expires_at = ? WHERE id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at < ?)",
      )
      .run(owner, until.toISOString(), id, owner, now.toISOString());
    return Number(result.changes) === 1;
  }

  releaseLease(id: string, owner: string): void {
    this._db
      .prepare(
        "UPDATE jobs SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?",
      )
      .run(id, owner);
  }

  insertPart(part: PartRecord): void {
    this._insert("job_parts", { ...part });
  }

  listParts(jobId: string): PartRecord[] {
    return (
      this._db
        .prepare("SELECT * FROM job_parts WHERE job_id = ? ORDER BY part_no")
        .all(jobId) as Row[]
    ).map(toPart);
  }

  deleteParts(jobId: string): void {
    this._db.prepare("DELETE FROM job_parts WHERE job_id = ?").run(jobId);
  }

  deleteJob(id: string): void {
    this.deleteParts(id);
    this._db.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }

  // ---------- artifacts ----------

  insertArtifact(artifact: ArtifactRecord): void {
    this._insert("artifacts", { ...artifact });
  }

  getArtifact(id: string): ArtifactRecord | null {
    const row = this._db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as Row | undefined;
    return row ? toArtifact(row) : null;
  }

  listArtifacts(filter: { readonly connectionId?: string } = {}): ArtifactRecord[] {
    const rows =
      filter.connectionId === undefined
        ? this._db.prepare("SELECT * FROM artifacts ORDER BY created_at DESC").all()
        : this._db
            .prepare("SELECT * FROM artifacts WHERE connection_id = ? ORDER BY created_at DESC")
            .all(filter.connectionId);
    return (rows as Row[]).map(toArtifact);
  }

  deleteArtifact(id: string): void {
    this._db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
  }
}
