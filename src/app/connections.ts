import { DomainError } from "../domain/errors.ts";
import type { MetrikaSource } from "./ports.ts";

export interface Connection {
  readonly id: string;
  readonly alias: string;
  readonly source: MetrikaSource;
  /** Server-side allowlist on top of Yandex permissions; null means all accessible counters. */
  readonly allowedCounters: ReadonlySet<string> | null;
}

export class ConnectionRegistry {
  private readonly _connections: ReadonlyMap<string, Connection>;

  constructor(connections: readonly Connection[]) {
    this._connections = new Map(connections.map((c) => [c.id, c]));
  }

  list(): readonly Connection[] {
    return [...this._connections.values()];
  }

  /** Every analytic call names its connection explicitly; there is no implicit default. */
  get(connectionId: string): Connection {
    const connection = this._connections.get(connectionId);
    if (!connection) {
      throw new DomainError("AUTH_REQUIRED", `No connection with id ${connectionId}.`, {
        nextAction: "Call metrika_status to see available connection IDs.",
      });
    }
    return connection;
  }
}
