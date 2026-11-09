import { randomBytes } from "node:crypto";
import { CatalogService } from "./app/catalog-service.ts";
import { clientIdentity } from "./app/common.ts";
import { ComparisonService } from "./app/comparison-service.ts";
import { ConnectionService } from "./app/connection-service.ts";
import { CounterService } from "./app/counter-service.ts";
import { ArtifactService } from "./app/export/artifact-service.ts";
import { type ExportLimits, ExportService } from "./app/export/export-service.ts";
import type { ExportFiles } from "./app/export/types.ts";
import {
  type ClientIdentity,
  type Clock,
  realSleep,
  type SecretStore,
  type Sleep,
  systemClock,
  type TokenProvider,
} from "./app/ports.ts";
import { ReportService } from "./app/report-service.ts";
import type { LoginFlow } from "./app/status-service.ts";
import { TimeseriesService } from "./app/timeseries-service.ts";
import type { AppConfig } from "./config/load.ts";
import { DemoSource } from "./demo/source.ts";
import { BrowserLogin } from "./infra/auth/login-flow.ts";
import { refreshTokenSet } from "./infra/auth/oauth.ts";
import { ManagedFiles } from "./infra/files/managed-files.ts";
import type { FetchLike } from "./infra/http.ts";
import { createLogger, type Logger } from "./infra/log/logger.ts";
import { dataPaths, ensureDataDirs } from "./infra/paths.ts";
import { openSecretStore } from "./infra/secrets/stores.ts";
import { SqliteStore } from "./infra/storage/sqlite-store.ts";
import { YandexClient } from "./infra/yandex/client.ts";
import { QuotaScheduler } from "./infra/yandex/quota.ts";
import { YandexSource } from "./infra/yandex/source.ts";

export { DEMO_CONNECTION_ID, ENV_CONNECTION_ID } from "./app/connection-service.ts";

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface Container {
  readonly config: AppConfig;
  readonly version: string;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly connections: ConnectionService;
  readonly reports: ReportService;
  readonly comparisons: ComparisonService;
  readonly timeseries: TimeseriesService;
  readonly counters: CounterService;
  readonly catalog: CatalogService;
  readonly exports: ExportService;
  readonly artifacts: ArtifactService;
  readonly login: LoginFlow | null;
  readonly browserLogin: BrowserLogin | null;
  readonly secretStoreKind: () => Promise<string>;
  readonly clientIdentity: ClientIdentity;
  close(): Promise<void>;
}

export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  readonly logger?: Logger;
  readonly cursorKey?: Uint8Array;
  readonly fetch?: FetchLike;
  readonly secrets?: SecretStore;
  readonly files?: ExportFiles;
  readonly exportLimits?: ExportLimits;
}

/** Composition root: the only place that wires concrete implementations together. */
export async function createContainer(
  config: AppConfig,
  version: string,
  overrides: ContainerOverrides = {},
): Promise<Container> {
  const clock = overrides.clock ?? systemClock;
  const sleep = overrides.sleep ?? realSleep;
  const logger = overrides.logger ?? createLogger(config.logLevel);
  const fetchImpl: FetchLike = overrides.fetch ?? ((input, init) => fetch(input, init));
  // Per-process key: cursors are valid only within one server run.
  const cursorKey = overrides.cursorKey ?? randomBytes(32);
  const paths = dataPaths(config.dataDir);
  ensureDataDirs(paths);
  const store = await SqliteStore.open(paths.database);

  let secretsPromise: Promise<SecretStore> | null = null;
  const secrets = (): Promise<SecretStore> => {
    if (overrides.secrets) return Promise.resolve(overrides.secrets);
    secretsPromise ??= openSecretStore(config.secretStore, paths.secretsFile).catch(
      (error: unknown) => {
        secretsPromise = null;
        throw error;
      },
    );
    return secretsPromise;
  };

  const quota = new QuotaScheduler(clock, sleep);
  const identity = clientIdentity();
  const userAgent = () => {
    const client = identity.current();
    const base = `yandex-metrika-mcp/${version}`;
    return client === null ? base : `${base} (${client.name}/${client.version})`;
  };
  const makeSource = (connectionId: string, tokens: TokenProvider) =>
    new YandexSource(
      new YandexClient({
        fetch: fetchImpl,
        tokens,
        quota,
        quotaOwner: connectionId,
        clock,
        sleep,
        logger,
        userAgent,
      }),
      clock,
      { lang: config.apiLang },
    );

  const clientId = config.clientId;
  const connections = new ConnectionService({
    store,
    secrets,
    clock,
    makeSource,
    demoSource: config.demoEnabled ? new DemoSource(clock) : null,
    envToken: config.envToken
      ? { token: config.envToken, allowedCounters: config.envAllowedCounters }
      : null,
    oauth: clientId
      ? {
          refresh: (refreshToken) =>
            refreshTokenSet(fetchImpl, { clientId, refreshToken }, clock.now()),
        }
      : null,
  });
  const files = overrides.files ?? new ManagedFiles(paths.jobs, paths.artifacts);
  const exports = new ExportService({
    connections,
    jobs: store,
    files,
    clock,
    sleep,
    privacy: config.privacy,
    autoResume: config.autoResume,
    ...(overrides.exportLimits ? { limits: overrides.exportLimits } : {}),
    log: (message, fields) => logger.error(message, fields),
  });
  connections.onDisconnect((id) => exports.cancelForConnection(id));
  const browserLogin = clientId
    ? new BrowserLogin({
        clientId,
        ports: config.redirectPorts,
        fetch: fetchImpl,
        clock,
        logger,
        connections,
      })
    : null;
  await exports.startup();
  const cleanup = setInterval(() => {
    exports.cleanup().catch((error: unknown) => logger.warn("cleanup failed", { error }));
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref();

  return {
    config,
    version,
    logger,
    clientIdentity: identity,
    clock,
    connections,
    reports: new ReportService({ connections, clock, cursorKey }),
    comparisons: new ComparisonService({ connections, clock }),
    timeseries: new TimeseriesService({ connections, clock }),
    counters: new CounterService({ connections, clock, cursorKey }),
    catalog: new CatalogService(),
    exports,
    artifacts: new ArtifactService({ connections, jobs: store, files, exports, clock, cursorKey }),
    login: browserLogin,
    browserLogin,
    secretStoreKind: async () => {
      try {
        return (await secrets()).kind;
      } catch {
        return "unavailable";
      }
    },
    close: async () => {
      clearInterval(cleanup);
      await exports.stop();
      await browserLogin?.server.close();
      store.close();
    },
  };
}
