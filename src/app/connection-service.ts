import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.ts";
import { CachedSource } from "./cached-source.ts";
import { type Connection, type ConnectionResolver, unknownConnection } from "./connections.ts";
import type { Clock, CounterInfo, MetrikaSource, SecretStore, TokenProvider } from "./ports.ts";
import type { ConnectionRecord, ConnectionStore, ConnectionKind as StoredKind } from "./stores.ts";

export const DEMO_CONNECTION_ID = "conn_demo";
export const ENV_CONNECTION_ID = "conn_env";

export interface StoredTokens {
  readonly access_token: string;
  readonly refresh_token: string | null;
  readonly expires_at: string | null;
}

/** OAuth operations implemented by infra (token endpoint, refresh). */
export interface OAuthClient {
  refresh(refreshToken: string): Promise<StoredTokens>;
}

export interface ConnectionServiceDeps {
  readonly store: ConnectionStore;
  /** Opened lazily: a missing OS keychain must not break startup. */
  readonly secrets: () => Promise<SecretStore>;
  readonly clock: Clock;
  readonly makeSource: (connectionId: string, tokens: TokenProvider) => MetrikaSource;
  readonly demoSource: MetrikaSource | null;
  readonly envToken: {
    readonly token: string;
    readonly allowedCounters: readonly string[] | null;
  } | null;
  readonly oauth: OAuthClient | null;
}

export type DisconnectHook = (connectionId: string) => Promise<number>;

const secretKey = (id: string, generation: number): string => `connection:${id}:g${generation}`;

export const newConnectionId = (): string =>
  `conn_${randomBytes(8).toString("base64url").replace(/[-_]/g, "x").toLowerCase().slice(0, 10)}`;

/**
 * Owns connections: stored records, their tokens and the per-generation data
 * sources. Disconnect bumps the generation so stale workers and caches cannot
 * reuse old credentials or data.
 */
export class ConnectionService implements ConnectionResolver {
  private readonly _deps: ConnectionServiceDeps;
  private readonly _sources = new Map<string, CachedSource>();
  private readonly _refreshing = new Map<string, Promise<boolean>>();
  private readonly _disconnectHooks: DisconnectHook[] = [];
  private readonly _static: Connection[];

  constructor(deps: ConnectionServiceDeps) {
    this._deps = deps;
    this._static = [];
    if (deps.demoSource) {
      this._static.push({
        id: DEMO_CONNECTION_ID,
        alias: "Demo (synthetic data)",
        kind: "demo",
        generation: 0,
        source: deps.demoSource,
        allowedCounters: null,
      });
    }
    if (deps.envToken) {
      const token = deps.envToken.token;
      const provider: TokenProvider = {
        accessToken: async () => token,
        refresh: async () => false,
        markExpired: async () => undefined,
      };
      this._static.push({
        id: ENV_CONNECTION_ID,
        alias: "Token from YANDEX_METRIKA_TOKEN",
        kind: "env",
        generation: 0,
        source: new CachedSource(deps.makeSource(ENV_CONNECTION_ID, provider), deps.clock),
        allowedCounters: deps.envToken.allowedCounters
          ? new Set(deps.envToken.allowedCounters)
          : null,
      });
    }
  }

  onDisconnect(hook: DisconnectHook): void {
    this._disconnectHooks.push(hook);
  }

  /** Stored connections including those that need a new sign-in. */
  records(): ConnectionRecord[] {
    return this._deps.store.listConnections().filter((r) => r.state !== "disconnected");
  }

  staticConnections(): readonly Connection[] {
    return this._static;
  }

  list(): readonly Connection[] {
    const stored = this._deps.store
      .listConnections()
      .filter((r) => r.state === "active")
      .map((r) => this._connection(r));
    return [...this._static, ...stored];
  }

  get(connectionId: string): Connection {
    const fixed = this._static.find((c) => c.id === connectionId);
    if (fixed) return fixed;
    const record = this._deps.store.getConnection(connectionId);
    if (!record || record.state === "disconnected") throw unknownConnection(connectionId);
    if (record.state === "needs_reconnect") {
      throw new DomainError(
        "AUTH_EXPIRED",
        `Connection ${connectionId} needs a new Yandex sign-in.`,
        {
          nextAction: `Call metrika_connect with connection_id='${connectionId}' to sign in again.`,
        },
      );
    }
    return this._connection(record);
  }

  /** Validates a token against the API, then stores it as a new (or renewed) connection. */
  async save(
    tokens: StoredTokens,
    options: {
      readonly alias: string | null;
      readonly kind: StoredKind;
      readonly reconnectId: string | null;
      readonly validate: boolean;
    },
  ): Promise<{ connectionId: string; counters: readonly CounterInfo[] }> {
    const { clock, store } = this._deps;
    let counters: readonly CounterInfo[] = [];
    if (options.validate) {
      const probe = this._deps.makeSource("probe", {
        accessToken: async () => tokens.access_token,
        refresh: async () => false,
        markExpired: async () => undefined,
      });
      counters = await probe.listCounters();
    }
    const secrets = await this._secrets();
    const now = clock.now();
    const existing = options.reconnectId ? store.getConnection(options.reconnectId) : null;
    if (options.reconnectId && (!existing || existing.state === "disconnected")) {
      throw unknownConnection(options.reconnectId);
    }
    if (existing) {
      const generation = existing.generation + 1;
      await secrets.set(secretKey(existing.id, generation), JSON.stringify(tokens));
      store.updateConnection(
        existing.id,
        {
          state: "active",
          generation,
          token_expires_at: tokens.expires_at,
          ...(options.alias ? { alias: options.alias } : {}),
        },
        now,
      );
      await secrets.delete(secretKey(existing.id, existing.generation));
      this._drop(existing.id);
      return { connectionId: existing.id, counters };
    }
    const id = newConnectionId();
    await secrets.set(secretKey(id, 1), JSON.stringify(tokens));
    store.insertConnection({
      id,
      alias: options.alias ?? `Yandex account ${store.listConnections().length + 1}`,
      kind: options.kind,
      state: "active",
      generation: 1,
      allowed_counters: null,
      token_expires_at: tokens.expires_at,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
    });
    return { connectionId: id, counters };
  }

  /** Restricts a connection to some counters; an empty or null list means all accessible counters. */
  setAllowlist(connectionId: string, counterIds: readonly string[] | null): void {
    const record = this._deps.store.getConnection(connectionId);
    if (!record || record.state === "disconnected") throw unknownConnection(connectionId);
    const allowed = counterIds && counterIds.length > 0 ? [...new Set(counterIds)] : null;
    this._deps.store.updateConnection(
      connectionId,
      { allowed_counters: allowed },
      this._deps.clock.now(),
    );
    this._drop(connectionId);
  }

  async disconnect(
    connectionId: string,
  ): Promise<{ jobsCancelled: number; tokenDeleted: boolean }> {
    if (this._static.some((c) => c.id === connectionId)) {
      throw new DomainError(
        "INVALID_QUERY",
        `${connectionId} is configured by the environment and cannot be disconnected here.`,
      );
    }
    const record = this._deps.store.getConnection(connectionId);
    if (!record || record.state === "disconnected") throw unknownConnection(connectionId);
    // Block the connection first so running exports cannot fetch more pages.
    this._deps.store.updateConnection(
      connectionId,
      { state: "disconnected", generation: record.generation + 1 },
      this._deps.clock.now(),
    );
    this._drop(connectionId);
    let jobsCancelled = 0;
    for (const hook of this._disconnectHooks) jobsCancelled += await hook(connectionId);
    let tokenDeleted = false;
    try {
      await (await this._secrets()).delete(secretKey(connectionId, record.generation));
      tokenDeleted = true;
    } catch {
      tokenDeleted = false;
    }
    return { jobsCancelled, tokenDeleted };
  }

  private async _secrets(): Promise<SecretStore> {
    try {
      return await this._deps.secrets();
    } catch (error) {
      throw new DomainError(
        "AUTH_NOT_CONFIGURED",
        error instanceof Error ? error.message : "No secure storage for tokens is available.",
        {
          nextAction:
            "Use YANDEX_METRIKA_TOKEN, or set YM_MCP_SECRET_STORE=file to accept an unencrypted token file readable only by your user.",
        },
      );
    }
  }

  private _drop(connectionId: string): void {
    for (const key of [...this._sources.keys()]) {
      if (key.startsWith(`${connectionId}:`)) {
        this._sources.get(key)?.clear();
        this._sources.delete(key);
      }
    }
  }

  private _connection(record: ConnectionRecord): Connection {
    const key = `${record.id}:${record.generation}`;
    let source = this._sources.get(key);
    if (!source) {
      source = new CachedSource(
        this._deps.makeSource(record.id, this._tokens(record)),
        this._deps.clock,
      );
      this._sources.set(key, source);
    }
    return {
      id: record.id,
      alias: record.alias,
      kind: record.kind,
      generation: record.generation,
      source,
      allowedCounters: record.allowed_counters ? new Set(record.allowed_counters) : null,
    };
  }

  private _tokens(record: ConnectionRecord): TokenProvider {
    const key = secretKey(record.id, record.generation);
    const read = async (): Promise<StoredTokens> => {
      const current = this._deps.store.getConnection(record.id);
      if (!current || current.generation !== record.generation || current.state !== "active") {
        throw unknownConnection(record.id);
      }
      const raw = await (await this._secrets()).get(key);
      if (raw === null) {
        throw new DomainError(
          "AUTH_EXPIRED",
          `The token of ${record.id} is missing from secure storage.`,
          {
            nextAction: `Call metrika_connect with connection_id='${record.id}' to sign in again.`,
          },
        );
      }
      return JSON.parse(raw) as StoredTokens;
    };
    return {
      accessToken: async () => (await read()).access_token,
      refresh: () => {
        const running = this._refreshing.get(key);
        if (running) return running;
        const attempt = (async () => {
          const oauth = this._deps.oauth;
          const tokens = await read();
          if (!oauth || tokens.refresh_token === null) return false;
          try {
            const next = await oauth.refresh(tokens.refresh_token);
            await (await this._secrets()).set(key, JSON.stringify(next));
            this._deps.store.updateConnection(
              record.id,
              { token_expires_at: next.expires_at },
              this._deps.clock.now(),
            );
            return true;
          } catch {
            return false;
          }
        })().finally(() => this._refreshing.delete(key));
        this._refreshing.set(key, attempt);
        return attempt;
      },
      markExpired: async () => {
        this._deps.store.updateConnection(
          record.id,
          { state: "needs_reconnect" },
          this._deps.clock.now(),
        );
        this._drop(record.id);
      },
    };
  }
}
