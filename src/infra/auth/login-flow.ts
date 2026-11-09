import type { ConnectionService } from "../../app/connection-service.ts";
import type { Clock } from "../../app/ports.ts";
import type { LoginFlow } from "../../app/status-service.ts";
import type { FetchLike } from "../http.ts";
import type { Logger } from "../log/logger.ts";
import { type LoginAttempt, LoopbackAuthServer } from "./loopback.ts";
import { exchangeCode } from "./oauth.ts";

export interface BrowserLoginOptions {
  readonly clientId: string;
  readonly ports: readonly number[];
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly connections: ConnectionService;
}

/** Browser sign-in: one-time local page → Yandex consent → PKCE exchange → counter selection. */
export class BrowserLogin implements LoginFlow {
  readonly server: LoopbackAuthServer;
  private readonly _options: BrowserLoginOptions;

  constructor(options: BrowserLoginOptions) {
    this._options = options;
    this.server = new LoopbackAuthServer({
      clientId: options.clientId,
      ports: options.ports,
      clock: options.clock,
      logger: options.logger,
      handlers: {
        onCode: (attempt, code) => this.complete(attempt, code),
        onSelect: async (attempt, ids) => {
          if (!attempt.connectionId) return;
          const all = ids.length === attempt.counters.length;
          options.connections.setAllowlist(attempt.connectionId, all ? null : ids);
        },
      },
    });
  }

  async start(
    alias: string | null,
    reconnectId: string | null,
  ): Promise<{ url: string; expiresAt: Date }> {
    const { url, expiresAt } = await this.server.start(alias, reconnectId);
    return { url, expiresAt };
  }

  pending(): { status: string; expiresAt: Date; connectionId: string | null }[] {
    return this.server
      .attempts()
      .filter((a) => a.status !== "expired")
      .map((a) => ({
        status: a.status,
        expiresAt: new Date(a.expiresAt),
        connectionId: a.connectionId,
      }));
  }

  /** Exchanges a code for tokens and stores the connection; also used by the CLI manual flow. */
  async complete(attempt: LoginAttempt, code: string) {
    const { fetch, clock, clientId, connections } = this._options;
    const tokens = await exchangeCode(
      fetch,
      { clientId, code, verifier: attempt.verifier },
      clock.now(),
    );
    const saved = await connections.save(tokens, {
      alias: attempt.alias,
      kind: "oauth",
      reconnectId: attempt.reconnectId,
      validate: true,
    });
    return {
      connectionId: saved.connectionId,
      counters: saved.counters.map((c) => ({ id: c.id, name: c.name, site: c.site })),
    };
  }
}
