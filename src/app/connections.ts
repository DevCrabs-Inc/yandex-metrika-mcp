import { DomainError } from "../domain/errors.ts";
import { type Candidate, suggest } from "../domain/suggest.ts";
import type { MetrikaSource } from "./ports.ts";

export type ConnectionKind = "demo" | "env" | "oauth" | "token";

export interface Connection {
  readonly id: string;
  readonly alias: string;
  readonly kind: ConnectionKind;
  /** Changes on reconnect or disconnect; caches and jobs are bound to it. */
  readonly generation: number;
  readonly source: MetrikaSource;
  /** Server-side allowlist on top of Yandex permissions; null means all accessible counters. */
  readonly allowedCounters: ReadonlySet<string> | null;
}

/** Resolves connection IDs. Every analytic call names its connection explicitly. */
export interface ConnectionResolver {
  list(): readonly Connection[];
  get(connectionId: string): Connection;
}

export function unknownConnection(
  connectionId: string,
  known: readonly Pick<Connection, "id" | "alias">[] = [],
): DomainError {
  const candidates: Candidate[] = suggest(
    connectionId,
    known.map((c) => ({ id: c.id, label: c.alias })),
  );
  return new DomainError("AUTH_REQUIRED", `No active connection with id ${connectionId}.`, {
    field: "connection_id",
    candidates,
    nextAction: "Call metrika_status to see connection IDs, or metrika_connect to sign in.",
  });
}

/** Candidates come from this connection's own allowlist, never from other accounts. */
export function counterNotAllowed(
  connection: Pick<Connection, "id" | "allowedCounters">,
  counterId: string,
): DomainError {
  const allowed = [...(connection.allowedCounters ?? [])].sort();
  return new DomainError(
    "COUNTER_NOT_ALLOWED",
    `Counter ${counterId} is not in the allowlist of connection ${connection.id}.`,
    {
      field: "counter_id",
      candidates: suggest(
        counterId,
        allowed.map((id) => ({ id, label: null })),
      ),
      nextAction: "Call metrika_list_counters to see allowed counters.",
    },
  );
}

export class StaticConnections implements ConnectionResolver {
  private readonly _connections: ReadonlyMap<string, Connection>;

  constructor(connections: readonly Connection[]) {
    this._connections = new Map(connections.map((c) => [c.id, c]));
  }

  list(): readonly Connection[] {
    return [...this._connections.values()];
  }

  get(connectionId: string): Connection {
    const connection = this._connections.get(connectionId);
    if (!connection) throw unknownConnection(connectionId, this.list());
    return connection;
  }
}
