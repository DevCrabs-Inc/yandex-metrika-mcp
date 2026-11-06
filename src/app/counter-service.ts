import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { DescribeCounterOutput, ListCountersOutput } from "../domain/contract/meta.ts";
import { decodeCursor, encodeCursor } from "../domain/cursor.ts";
import { isValidTimeZone } from "../domain/dates.ts";
import { DomainError } from "../domain/errors.ts";
import { fingerprint } from "../domain/fingerprint.ts";
import { safeLabel } from "../domain/privacy.ts";
import type { Warning } from "../domain/warnings.ts";
import { demoWarning, provenance } from "./common.ts";
import type { ConnectionRegistry } from "./connections.ts";
import type { Clock, CounterInfo } from "./ports.ts";

export const COUNTERS_PAGE_SIZE = 50;

const safeCounter = (c: CounterInfo): CounterInfo => ({
  ...c,
  name: safeLabel(c.name).name ?? "",
  site: safeLabel(c.site).name ?? "",
});

export interface CounterServiceDeps {
  readonly connections: ConnectionRegistry;
  readonly clock: Clock;
  readonly cursorKey: Uint8Array;
}

export class CounterService {
  private readonly _deps: CounterServiceDeps;

  constructor(deps: CounterServiceDeps) {
    this._deps = deps;
  }

  async list(input: {
    readonly connection_id: string;
    readonly search?: string | undefined;
    readonly cursor?: string | undefined;
  }): Promise<ListCountersOutput> {
    const { connections, clock, cursorKey } = this._deps;
    const connection = connections.get(input.connection_id);
    const search = input.search?.trim().toLowerCase() ?? "";
    const binding = {
      fingerprint: fingerprint({ op: "list_counters", search }),
      connectionId: connection.id,
    };
    const offset =
      input.cursor === undefined ? 0 : decodeCursor(input.cursor, binding, cursorKey, clock.now());
    const all = (await connection.source.listCounters())
      .filter((c) => connection.allowedCounters === null || connection.allowedCounters.has(c.id))
      .filter(
        (c) =>
          search === "" ||
          c.id.includes(search) ||
          c.name.toLowerCase().includes(search) ||
          c.site.toLowerCase().includes(search),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const page = all.slice(offset, offset + COUNTERS_PAGE_SIZE).map(safeCounter);
    const next = offset + page.length;
    const warnings: Warning[] = [...demoWarning(connection)];
    if (all.length === 0) {
      warnings.push({
        code: "NO_COUNTERS",
        severity: "warning",
        message:
          search === ""
            ? "This Yandex account has no accessible counters. Ask the site owner to grant view access."
            : `No counters match "${input.search ?? ""}".`,
        affected_fields: [],
      });
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "counters",
      connection_id: connection.id,
      counters: page,
      total: all.length,
      next_cursor: next < all.length ? encodeCursor(binding, next, cursorKey, clock.now()) : null,
      provenance: provenance(
        connection,
        "management/v1/counters",
        clock.now(),
        binding.fingerprint,
      ),
      warnings,
    };
  }

  async describe(input: {
    readonly connection_id: string;
    readonly counter_id: string;
  }): Promise<DescribeCounterOutput> {
    const { connections, clock } = this._deps;
    const connection = connections.get(input.connection_id);
    if (connection.allowedCounters !== null && !connection.allowedCounters.has(input.counter_id)) {
      throw new DomainError(
        "COUNTER_NOT_ALLOWED",
        `Counter ${input.counter_id} is not in the allowlist of connection ${connection.id}.`,
        { nextAction: "Call metrika_list_counters to see allowed counters." },
      );
    }
    const counter = safeCounter(await connection.source.getCounter(input.counter_id));
    const goals = await connection.source.listGoals(input.counter_id);
    const nameCounts = new Map<string, number>();
    for (const goal of goals) nameCounts.set(goal.name, (nameCounts.get(goal.name) ?? 0) + 1);
    const warnings: Warning[] = [...demoWarning(connection)];
    if (goals.length === 0) {
      warnings.push({
        code: "NO_GOALS",
        severity: "info",
        message: "No goals are configured for this counter. Traffic reports still work.",
        affected_fields: [],
      });
    }
    if ([...nameCounts.values()].some((n) => n > 1)) {
      warnings.push({
        code: "DUPLICATE_GOAL_NAMES",
        severity: "warning",
        message:
          "Several goals share a name. Ask the user which goal ID they mean before reporting.",
        affected_fields: [],
      });
    }
    if (counter.time_zone === null || !isValidTimeZone(counter.time_zone)) {
      warnings.push({
        code: "TIMEZONE_UNKNOWN",
        severity: "warning",
        message: "The counter time zone is unknown; reports for this counter will be refused.",
        affected_fields: [],
      });
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "counter",
      connection_id: connection.id,
      counter,
      goals: goals.map((g) => ({
        id: g.id,
        name: safeLabel(g.name).name ?? "",
        type: g.type,
        duplicate_name: (nameCounts.get(g.name) ?? 0) > 1,
      })),
      provenance: provenance(
        connection,
        "management/v1/counter + goals",
        clock.now(),
        fingerprint({ op: "describe_counter", counter: counter.id }),
      ),
      warnings,
    };
  }
}
