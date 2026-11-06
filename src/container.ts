import { randomBytes } from "node:crypto";
import { CatalogService } from "./app/catalog-service.ts";
import { ComparisonService } from "./app/comparison-service.ts";
import { type Connection, ConnectionRegistry } from "./app/connections.ts";
import { CounterService } from "./app/counter-service.ts";
import { type Clock, systemClock } from "./app/ports.ts";
import { ReportService } from "./app/report-service.ts";
import { TimeseriesService } from "./app/timeseries-service.ts";
import type { AppConfig } from "./config/load.ts";
import { DemoSource } from "./demo/source.ts";
import { createLogger, type Logger } from "./infra/log/logger.ts";

export const DEMO_CONNECTION_ID = "conn_demo";

export interface Container {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly clock: Clock;
  readonly connections: ConnectionRegistry;
  readonly reports: ReportService;
  readonly comparisons: ComparisonService;
  readonly timeseries: TimeseriesService;
  readonly counters: CounterService;
  readonly catalog: CatalogService;
}

export interface ContainerOverrides {
  readonly clock?: Clock;
  readonly logger?: Logger;
  readonly cursorKey?: Uint8Array;
}

/** Composition root: the only place that wires concrete implementations together. */
export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const clock = overrides.clock ?? systemClock;
  const logger = overrides.logger ?? createLogger(config.logLevel);
  // Per-process key: cursors are valid only within one server run until durable storage lands.
  const cursorKey = overrides.cursorKey ?? randomBytes(32);
  const connections: Connection[] = [];
  if (config.demoEnabled) {
    connections.push({
      id: DEMO_CONNECTION_ID,
      alias: "Demo (synthetic data)",
      source: new DemoSource(clock),
      allowedCounters: null,
    });
  }
  const registry = new ConnectionRegistry(connections);
  return {
    config,
    logger,
    clock,
    connections: registry,
    reports: new ReportService({ connections: registry, clock, cursorKey }),
    comparisons: new ComparisonService({ connections: registry, clock }),
    timeseries: new TimeseriesService({ connections: registry, clock }),
    counters: new CounterService({ connections: registry, clock, cursorKey }),
    catalog: new CatalogService(),
  };
}
