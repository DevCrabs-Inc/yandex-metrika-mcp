import type { McpServer, ToolAnnotations } from "@modelcontextprotocol/server";
import type { StatusService } from "../app/status-service.ts";
import type { Container } from "../container.ts";
import { comparisonInput, comparisonOutput } from "../domain/contract/comparison.ts";
import {
  catalogInput,
  catalogOutput,
  describeCounterInput,
  describeCounterOutput,
  listCountersInput,
  listCountersOutput,
  statusInput,
  statusOutput,
} from "../domain/contract/meta.ts";
import { reportInput, reportOutput } from "../domain/contract/report.ts";
import { timeseriesInput, timeseriesOutput } from "../domain/contract/timeseries.ts";
import { runTool } from "./envelope.ts";
import {
  renderCatalog,
  renderComparison,
  renderCounter,
  renderCounters,
  renderReport,
  renderStatus,
  renderTimeseries,
} from "./render.ts";

export const TOOL_NAMES = [
  "metrika_status",
  "metrika_catalog",
  "metrika_list_counters",
  "metrika_describe_counter",
  "metrika_run_report",
  "metrika_compare_periods",
  "metrika_run_timeseries",
] as const;

const localRead: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};
const remoteRead: ToolAnnotations = { ...localRead, openWorldHint: true };

export function registerTools(
  server: McpServer,
  container: Container,
  status: StatusService,
): void {
  const { logger } = container;

  server.registerTool(
    "metrika_status",
    {
      title: "Yandex Metrika: status",
      description:
        "Start here. Shows the server version, available connections (connection_id values), capabilities and the next step. Works before any Yandex sign-in.",
      inputSchema: statusInput,
      outputSchema: statusOutput,
      annotations: { ...localRead, title: "Status" },
    },
    (input) => runTool("metrika_status", logger, () => status.get(input), renderStatus),
  );

  server.registerTool(
    "metrika_catalog",
    {
      title: "Yandex Metrika: catalog",
      description:
        "Lists what reports can use: kind='presets' (ready-made reports), 'metrics' (with unit and aggregation rules, e.g. users must never be summed), 'dimensions' or 'periods' (period presets). No API call.",
      inputSchema: catalogInput,
      outputSchema: catalogOutput,
      annotations: { ...localRead, title: "Catalog" },
    },
    (input) =>
      runTool("metrika_catalog", logger, () => container.catalog.get(input), renderCatalog),
  );

  server.registerTool(
    "metrika_list_counters",
    {
      title: "Yandex Metrika: list counters",
      description:
        "Lists Yandex Metrika (Яндекс Метрика) counters, i.e. tracked websites, available through a connection: ID, name, site, time zone and access level. Pass the ID as counter_id to other tools.",
      inputSchema: listCountersInput,
      outputSchema: listCountersOutput,
      annotations: { ...remoteRead, title: "List counters" },
    },
    (input) =>
      runTool(
        "metrika_list_counters",
        logger,
        () => container.counters.list(input),
        renderCounters,
      ),
  );

  server.registerTool(
    "metrika_describe_counter",
    {
      title: "Yandex Metrika: describe counter",
      description:
        "Counter settings (time zone, status, access) and its goals with IDs. Call before goal reports. Goal names can repeat, so always refer to goals by ID.",
      inputSchema: describeCounterInput,
      outputSchema: describeCounterOutput,
      annotations: { ...remoteRead, title: "Describe counter" },
    },
    (input) =>
      runTool(
        "metrika_describe_counter",
        logger,
        () => container.counters.describe(input),
        renderCounter,
      ),
  );

  server.registerTool(
    "metrika_run_report",
    {
      title: "Yandex Metrika: run report",
      description:
        "Runs a report for one period: a preset (overview, acquisition, landing_pages, devices, geography, goals) or explicit metrics/dimensions, with filters, sorting and paging. Returns API totals, rows, data quality (sampling, completeness) and provenance. Defaults: last 7 complete days in the counter time zone; accuracy strict, which refuses sampled data instead of presenting it as exact.",
      inputSchema: reportInput,
      outputSchema: reportOutput,
      annotations: { ...remoteRead, title: "Run report" },
    },
    (input) =>
      runTool("metrika_run_report", logger, () => container.reports.run(input), renderReport),
  );

  server.registerTool(
    "metrika_compare_periods",
    {
      title: "Yandex Metrika: compare periods",
      description:
        "Compares two periods under identical conditions (same counter, metrics, filters, time zone): baseline, current, absolute and percent change, plus percentage points for rates; a zero baseline gives a null percent. Optional dimensions compare segments. Default: the last two complete ISO weeks (Mon–Sun). Use for 'what changed week over week'.",
      inputSchema: comparisonInput,
      outputSchema: comparisonOutput,
      annotations: { ...remoteRead, title: "Compare periods" },
    },
    (input) =>
      runTool(
        "metrika_compare_periods",
        logger,
        () => container.comparisons.run(input),
        renderComparison,
      ),
  );

  server.registerTool(
    "metrika_run_timeseries",
    {
      title: "Yandex Metrika: time series",
      description:
        "Metric dynamics in day, week or month buckets with exact boundaries in the counter time zone. Flags buckets that include today or are clipped by the period. Optional dimensions return top-N segment series. Default: last 28 complete days by day.",
      inputSchema: timeseriesInput,
      outputSchema: timeseriesOutput,
      annotations: { ...remoteRead, title: "Time series" },
    },
    (input) =>
      runTool(
        "metrika_run_timeseries",
        logger,
        () => container.timeseries.run(input),
        renderTimeseries,
      ),
  );
}
