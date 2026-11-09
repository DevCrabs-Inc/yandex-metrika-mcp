import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { StatusOutput } from "../domain/contract/meta.ts";
import type { Connection } from "./connections.ts";
import type { Clock } from "./ports.ts";
import type { ConnectionRecord } from "./stores.ts";

/** Browser sign-in implemented by infra (local page + OAuth callback). */
export interface LoginFlow {
  start(
    alias: string | null,
    reconnectId: string | null,
  ): Promise<{ url: string; expiresAt: Date }>;
  pending(): { status: string; expiresAt: Date; connectionId: string | null }[];
}

export interface StatusServiceDeps {
  readonly connections: {
    staticConnections(): readonly Connection[];
    records(): ConnectionRecord[];
  };
  readonly login: LoginFlow | null;
  readonly jobs: () => Record<string, number>;
  readonly clock: Clock;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly string[];
  readonly prompts: readonly string[];
}

const EXPIRY_WARNING_MS = 14 * 24 * 3600 * 1000;

export class StatusService {
  private readonly _deps: StatusServiceDeps;

  constructor(deps: StatusServiceDeps) {
    this._deps = deps;
  }

  get(input: { readonly connection_id?: string | undefined }): StatusOutput {
    const { connections, login, clock } = this._deps;
    const fixed = connections.staticConnections().map((c) => ({
      connection_id: c.id,
      alias: c.alias,
      kind: c.kind,
      state: "active" as const,
      token_expires_at: null,
      allowed_counters: c.allowedCounters ? [...c.allowedCounters] : null,
    }));
    const stored = connections.records().map((r) => ({
      connection_id: r.id,
      alias: r.alias,
      kind: r.kind,
      state: r.state === "needs_reconnect" ? ("needs_reconnect" as const) : ("active" as const),
      token_expires_at: r.token_expires_at,
      allowed_counters: r.allowed_counters ? [...r.allowed_counters] : null,
    }));
    const all = [...fixed, ...stored].filter(
      (c) => input.connection_id === undefined || c.connection_id === input.connection_id,
    );
    const jobs = this._deps.jobs();
    const real = [...fixed, ...stored].filter((c) => c.kind !== "demo");
    const now = clock.now().getTime();
    const nextActions: string[] = [];
    const notes: string[] = [
      "Read-only: this server cannot change counters, goals or access rights.",
      "Report data you request is sent to your AI client and its model provider. Tokens never are.",
    ];
    if (real.length === 0) {
      nextActions.push(
        login
          ? "Call metrika_connect and give the user the login_url to sign in with Yandex."
          : "Browser sign-in is not configured (no OAuth client ID). Import a token with `yandex-metrika-mcp auth import-token`, or set YM_MCP_CLIENT_ID.",
      );
    }
    for (const c of stored) {
      if (c.state === "needs_reconnect") {
        nextActions.push(
          `Connection ${c.connection_id} needs a new sign-in: metrika_connect(connection_id='${c.connection_id}').`,
        );
      } else if (
        c.token_expires_at !== null &&
        Date.parse(c.token_expires_at) - now < EXPIRY_WARNING_MS
      ) {
        notes.push(
          `The token of ${c.connection_id} expires at ${c.token_expires_at}; sign in again before then.`,
        );
      }
    }
    if ((jobs["interrupted"] ?? 0) > 0 || (jobs["partial"] ?? 0) > 0) {
      nextActions.push(
        "Some exports were interrupted: list them with metrika_get_job and resume with metrika_export_report(resume_job_id).",
      );
    }
    if (fixed.some((c) => c.kind === "demo")) {
      nextActions.push(
        "Synthetic demo data is available: metrika_list_counters(connection_id='conn_demo').",
      );
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "status",
      server: { name: this._deps.serverName, version: this._deps.serverVersion },
      capabilities: {
        tools: [...this._deps.tools],
        prompts: [...this._deps.prompts],
        browser_sign_in: login !== null,
        demo: fixed.some((c) => c.kind === "demo"),
        exports: true,
        read_only: true,
      },
      connections: all,
      pending_sign_ins: (login?.pending() ?? []).map((p) => ({
        status: p.status,
        expires_at: p.expiresAt.toISOString(),
        connection_id: p.connectionId,
      })),
      jobs,
      next_actions: nextActions,
      notes,
    };
  }
}
