import { DomainError } from "../domain/errors.ts";
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

export function unknownConnection(connectionId: string): DomainError {
  return new DomainError("AUTH_REQUIRED", `No active connection with id ${connectionId}.`, {
    nextAction: "Call metrika_status to see connection IDs, or metrika_connect to sign in.",
  });
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
    if (!connection) throw unknownConnection(connectionId);
    return connection;
  }
}
