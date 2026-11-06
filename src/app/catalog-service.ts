import { CATALOG_VERSION, DIMENSIONS, METRICS } from "../domain/catalog.ts";
import { SCHEMA_VERSION } from "../domain/contract/common.ts";
import type { CatalogOutput } from "../domain/contract/meta.ts";
import { COMPARISON_PRESETS, PERIOD_PRESETS } from "../domain/periods.ts";
import { PRESETS } from "../domain/presets.ts";

type Item = CatalogOutput["items"][number];

const PERIOD_DESCRIPTIONS: Record<string, string> = {
  today: "Today so far (incomplete, marked as such).",
  yesterday: "The previous calendar day.",
  last_7_complete_days: "Seven full days ending yesterday. Default for reports.",
  last_28_complete_days: "28 full days ending yesterday. Default for time series.",
  last_complete_iso_week: "The previous Monday–Sunday week.",
  last_complete_month: "The previous calendar month.",
  last_two_complete_iso_weeks:
    "Comparison: previous ISO week vs the week before. Default for comparisons.",
  last_7_complete_days_vs_previous_7: "Comparison: last 7 complete days vs the 7 days before.",
  last_two_complete_months: "Comparison: previous calendar month vs the month before.",
};

function items(kind: CatalogOutput["catalog_kind"]): Item[] {
  switch (kind) {
    case "presets":
      return PRESETS.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description,
        details: {
          version: p.version,
          metrics: [...p.metrics],
          dimensions: [...p.dimensions],
          goal_ids: p.goals,
        },
      }));
    case "metrics":
      return [
        ...METRICS.map((m) => ({
          id: m.id,
          title: m.label,
          description: m.description,
          details: { unit: m.unit, aggregation: m.aggregation },
        })),
        {
          id: "ym:s:goal<ID>reaches | visits | conversionRate | users",
          title: "Goal metrics",
          description:
            "Per-goal metrics; replace <ID> with a goal ID from metrika_describe_counter. reaches counts completions (not leads); visits counts target visits.",
          details: { unit: "count | percent", aggregation: "additive | rate | non_additive" },
        },
      ];
    case "dimensions":
      return DIMENSIONS.map((d) => ({
        id: d.id,
        title: d.label,
        description: d.description,
        details: { sensitive: d.sensitive },
      }));
    case "periods":
      return [...PERIOD_PRESETS, ...COMPARISON_PRESETS].map((id) => ({
        id,
        title: id,
        description: PERIOD_DESCRIPTIONS[id] ?? "",
        details: {
          use_with: (COMPARISON_PRESETS as readonly string[]).includes(id)
            ? "metrika_compare_periods periods.preset"
            : "period.preset",
        },
      }));
  }
}

export class CatalogService {
  get(input: {
    readonly kind: CatalogOutput["catalog_kind"];
    readonly search?: string | undefined;
  }): CatalogOutput {
    const search = input.search?.trim().toLowerCase() ?? "";
    const matched = items(input.kind).filter(
      (item) =>
        search === "" ||
        item.id.toLowerCase().includes(search) ||
        item.title.toLowerCase().includes(search) ||
        item.description.toLowerCase().includes(search),
    );
    return {
      schema_version: SCHEMA_VERSION,
      kind: "catalog",
      catalog_kind: input.kind,
      catalog_version: CATALOG_VERSION,
      items: matched,
      notes: [
        "Dates are always interpreted in the counter time zone.",
        "No robot filter or attribution change is applied implicitly; filters are always explicit.",
      ],
    };
  }
}
