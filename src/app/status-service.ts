import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { StatusOutput } from "../domain/contract/meta.ts";
import type { ConnectionRegistry } from "./connections.ts";

export interface StatusServiceDeps {
  readonly connections: ConnectionRegistry;
  readonly serverName: string;
  readonly serverVersion: string;
  readonly tools: readonly string[];
  readonly prompts: readonly string[];
}

export class StatusService {
  private readonly _deps: StatusServiceDeps;

  constructor(deps: StatusServiceDeps) {
    this._deps = deps;
  }

  get(input: { readonly connection_id?: string | undefined }): StatusOutput {
    const { connections } = this._deps;
    const all = connections.list();
    const selected =
      input.connection_id === undefined ? all : [connections.get(input.connection_id)];
    const hasDemo = all.some((c) => c.source.kind === "demo");
    const hasReal = all.some((c) => c.source.kind === "yandex");
    const nextActions: string[] = [];
    if (!hasReal) {
      nextActions.push(
        "Yandex sign-in is not available in this preview build yet, so no real account is connected.",
      );
    }
    if (hasDemo) {
      nextActions.push(
        "Explore with synthetic data: metrika_list_counters(connection_id='conn_demo'), then metrika_describe_counter, then metrika_run_report or metrika_compare_periods.",
      );
    }
    return {
      schema_version: SCHEMA_VERSION,
      kind: "status",
      server: { name: this._deps.serverName, version: this._deps.serverVersion },
      capabilities: {
        tools: [...this._deps.tools],
        prompts: [...this._deps.prompts],
        yandex_sign_in: false,
        demo: hasDemo,
        read_only: true,
      },
      connections: selected.map((c) => ({
        connection_id: c.id,
        alias: c.alias,
        kind: c.source.kind,
        state: "ready",
      })),
      next_actions: nextActions,
      notes: [
        "Read-only: this server cannot change counters, goals or access rights.",
        "Report data you request is sent to your AI client and its model provider.",
      ],
    };
  }
}
