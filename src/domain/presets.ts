import { goalMetricId } from "./catalog.ts";
import { invalidQuery } from "./errors.ts";

export const REPORT_PRESETS = [
  "overview",
  "acquisition",
  "landing_pages",
  "devices",
  "geography",
  "goals",
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const MAX_METRICS = 20;
export const MAX_DIMENSIONS = 10;
export const MAX_GOALS_PER_QUERY = 6;

export interface PresetDefinition {
  readonly id: ReportPreset;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  /** goal_ids: forbidden, optional (adds goal columns) or required. */
  readonly goals: "none" | "optional" | "required";
}

const TRAFFIC = [
  "ym:s:visits",
  "ym:s:users",
  "ym:s:pageviews",
  "ym:s:bounceRate",
  "ym:s:pageDepth",
  "ym:s:avgVisitDurationSeconds",
] as const;
const SEGMENT = [
  "ym:s:visits",
  "ym:s:users",
  "ym:s:bounceRate",
  "ym:s:pageDepth",
  "ym:s:avgVisitDurationSeconds",
] as const;

export const PRESETS: readonly PresetDefinition[] = [
  {
    id: "overview",
    version: 1,
    title: "Traffic overview",
    description: "Site totals: visits, users, pageviews, bounce rate, depth, duration.",
    metrics: TRAFFIC,
    dimensions: [],
    goals: "optional",
  },
  {
    id: "acquisition",
    version: 1,
    title: "Traffic sources",
    description: "Visits by traffic source and source detail (search engine, ad system, site).",
    metrics: SEGMENT,
    dimensions: ["ym:s:lastSignTrafficSource", "ym:s:lastSignSourceEngine"],
    goals: "optional",
  },
  {
    id: "landing_pages",
    version: 1,
    title: "Landing pages",
    description: "Visits by landing page (domain + path, query string removed by the API).",
    metrics: SEGMENT,
    dimensions: ["ym:s:startURLDomain", "ym:s:startURLPath"],
    goals: "optional",
  },
  {
    id: "devices",
    version: 1,
    title: "Devices",
    description: "Visits by device category.",
    metrics: SEGMENT,
    dimensions: ["ym:s:deviceCategory"],
    goals: "optional",
  },
  {
    id: "geography",
    version: 1,
    title: "Geography",
    description: "Visits by country and city.",
    metrics: SEGMENT,
    dimensions: ["ym:s:regionCountry", "ym:s:regionCity"],
    goals: "optional",
  },
  {
    id: "goals",
    version: 1,
    title: "Goals",
    description:
      "Reaches, target visits and conversion rate for selected goal IDs (get IDs from metrika_describe_counter).",
    metrics: ["ym:s:visits"],
    dimensions: [],
    goals: "required",
  },
];

const PRESET_INDEX = new Map(PRESETS.map((p) => [p.id, p]));

export function getPreset(id: ReportPreset): PresetDefinition {
  const preset = PRESET_INDEX.get(id);
  if (!preset) throw invalidQuery(`Unknown preset: ${id}`);
  return preset;
}

export interface ExpandedPreset {
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly preset: { readonly id: ReportPreset; readonly version: number };
}

/** Expands a preset into concrete field IDs. Goal IDs must already be validated. */
export function expandPreset(id: ReportPreset, goalIds: readonly string[]): ExpandedPreset {
  const preset = getPreset(id);
  if (preset.goals === "none" && goalIds.length > 0) {
    throw invalidQuery(`Preset ${id} does not accept goal_ids.`);
  }
  if (preset.goals === "required" && goalIds.length === 0) {
    throw invalidQuery(
      `Preset ${id} requires goal_ids.`,
      "Call metrika_describe_counter to list goal IDs, then pass them as goal_ids.",
    );
  }
  if (goalIds.length > MAX_GOALS_PER_QUERY) {
    throw invalidQuery(`At most ${MAX_GOALS_PER_QUERY} goal_ids per query.`);
  }
  const goalMetrics =
    preset.id === "goals"
      ? goalIds.flatMap((g) => [
          goalMetricId(g, "reaches"),
          goalMetricId(g, "visits"),
          goalMetricId(g, "conversionRate"),
        ])
      : goalIds.flatMap((g) => [goalMetricId(g, "visits"), goalMetricId(g, "conversionRate")]);
  const metrics = [...preset.metrics, ...goalMetrics].slice(0, MAX_METRICS);
  return {
    metrics,
    dimensions: preset.dimensions,
    preset: { id: preset.id, version: preset.version },
  };
}
