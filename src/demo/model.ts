import type { CounterInfo, GoalInfo } from "../app/ports.ts";

/** A value of one dimension, shaped like the Reporting API `{id, name}`. */
export interface DimValue {
  readonly id: string | null;
  readonly name: string | null;
}

interface Traits {
  readonly weight: number;
  readonly bounce: number;
  readonly depth: number;
  readonly duration: number;
  readonly conversion: number;
}

interface SourceSpec extends Traits {
  readonly value: DimValue;
  readonly engines: readonly (DimValue & { readonly weight: number })[];
  readonly utm: {
    readonly source: string;
    readonly medium: string;
    readonly campaign: string;
  } | null;
}

interface PageSpec extends Traits {
  readonly path: string;
}

interface DeviceSpec extends Traits {
  readonly value: DimValue;
}

interface GeoSpec {
  readonly weight: number;
  readonly country: DimValue;
  readonly city: DimValue;
}

export interface DemoCounter {
  readonly info: CounterInfo;
  readonly goals: readonly GoalInfo[];
  /** Base conversion probability per goal, before cell multipliers. */
  readonly goalRates: readonly number[];
  readonly baseDailyVisits: number;
  readonly seed: number;
  /** Periods longer than this are answered as sampled data (to demonstrate strict mode). */
  readonly sampledAboveDays: number | null;
}

/** One combination of all modelled attributes; the unit the generator works with. */
export interface Cell {
  readonly index: number;
  readonly weight: number;
  readonly bounce: number;
  readonly depth: number;
  readonly duration: number;
  readonly conversion: number;
  readonly dims: Readonly<Record<string, DimValue>>;
}

const t = (
  weight: number,
  bounce: number,
  depth: number,
  duration: number,
  conversion: number,
): Traits => ({
  weight,
  bounce,
  depth,
  duration,
  conversion,
});

const SOURCES: readonly SourceSpec[] = [
  {
    value: { id: "organic", name: "Search engine traffic" },
    ...t(0.42, 0.18, 3.1, 170, 1.1),
    engines: [
      { id: "yandex", name: "Yandex", weight: 0.68 },
      { id: "google", name: "Google", weight: 0.32 },
    ],
    utm: null,
  },
  {
    value: { id: "direct", name: "Direct traffic" },
    ...t(0.21, 0.24, 2.6, 150, 1.3),
    engines: [{ id: null, name: null, weight: 1 }],
    utm: null,
  },
  {
    value: { id: "ad", name: "Ad traffic" },
    ...t(0.16, 0.31, 2.1, 95, 0.9),
    engines: [{ id: "yandex_direct", name: "Yandex Direct", weight: 1 }],
    utm: { source: "yandex", medium: "cpc", campaign: "autumn_sale" },
  },
  {
    value: { id: "referral", name: "Link traffic" },
    ...t(0.09, 0.22, 2.8, 140, 1),
    engines: [
      { id: "coffee-blog.example.test", name: "coffee-blog.example.test", weight: 0.6 },
      { id: "maps.example.test", name: "maps.example.test", weight: 0.4 },
    ],
    utm: null,
  },
  {
    value: { id: "social", name: "Social network traffic" },
    ...t(0.08, 0.36, 1.8, 80, 0.6),
    engines: [
      { id: "vkontakte", name: "VKontakte", weight: 0.55 },
      { id: "telegram", name: "Telegram", weight: 0.45 },
    ],
    utm: { source: "vk", medium: "social", campaign: "autumn_sale" },
  },
  {
    value: { id: "internal", name: "Internal traffic" },
    ...t(0.04, 0.12, 3.6, 210, 1.4),
    engines: [{ id: null, name: null, weight: 1 }],
    utm: null,
  },
];

const PAGES: readonly PageSpec[] = [
  { path: "/", ...t(0.34, 1, 1, 1, 1) },
  { path: "/menu", ...t(0.2, 0.8, 1.2, 1.1, 1.3) },
  { path: "/delivery", ...t(0.15, 0.9, 1.1, 1, 1.6) },
  { path: "/blog/how-to-brew-v60", ...t(0.13, 1.4, 0.8, 1.5, 0.3) },
  { path: "/promo/autumn", ...t(0.1, 1.2, 0.9, 0.8, 1.2) },
  { path: "/contacts", ...t(0.08, 0.7, 1.3, 0.7, 0.8) },
];

const DEVICES: readonly DeviceSpec[] = [
  { value: { id: "mobile", name: "Smartphones" }, ...t(0.56, 1.15, 0.85, 0.8, 0.85) },
  { value: { id: "desktop", name: "PCs" }, ...t(0.37, 0.8, 1.25, 1.35, 1.25) },
  { value: { id: "tablet", name: "Tablets" }, ...t(0.07, 1, 1, 1, 1) },
];

const GEO: readonly GeoSpec[] = [
  { weight: 0.38, country: { id: "225", name: "Russia" }, city: { id: "213", name: "Moscow" } },
  {
    weight: 0.19,
    country: { id: "225", name: "Russia" },
    city: { id: "2", name: "Saint Petersburg" },
  },
  { weight: 0.1, country: { id: "225", name: "Russia" }, city: { id: "65", name: "Novosibirsk" } },
  // A city the API could not identify: the label is null and must be kept, not dropped.
  { weight: 0.13, country: { id: "225", name: "Russia" }, city: { id: null, name: null } },
  { weight: 0.11, country: { id: "159", name: "Kazakhstan" }, city: { id: "162", name: "Almaty" } },
  { weight: 0.09, country: { id: "149", name: "Belarus" }, city: { id: "157", name: "Minsk" } },
];

const NOT_SET: DimValue = { id: null, name: null };
const label = (value: string | undefined): DimValue =>
  value === undefined ? NOT_SET : { id: value, name: value };

interface Combination {
  readonly source: SourceSpec;
  readonly engine: SourceSpec["engines"][number];
  readonly page: PageSpec;
  readonly device: DeviceSpec;
  readonly geo: GeoSpec;
}

function combinations(): Combination[] {
  return SOURCES.flatMap((source) =>
    source.engines.flatMap((engine) =>
      PAGES.flatMap((page) =>
        DEVICES.flatMap((device) => GEO.map((geo) => ({ source, engine, page, device, geo }))),
      ),
    ),
  );
}

export function buildCells(site: string): Cell[] {
  const domain = { id: site, name: site };
  return combinations().map(({ source, engine, page, device, geo }, index) => ({
    index,
    weight: source.weight * engine.weight * page.weight * device.weight * geo.weight,
    bounce: Math.min(0.92, source.bounce * page.bounce * device.bounce),
    depth: Math.max(1, source.depth * page.depth * device.depth),
    duration: source.duration * page.duration * device.duration,
    conversion: source.conversion * page.conversion * device.conversion,
    dims: {
      "ym:s:lastSignTrafficSource": source.value,
      "ym:s:lastSignSourceEngine": { id: engine.id, name: engine.name },
      "ym:s:lastSignUTMSource": label(source.utm?.source),
      "ym:s:lastSignUTMMedium": label(source.utm?.medium),
      "ym:s:lastSignUTMCampaign": label(source.utm?.campaign),
      "ym:s:startURLDomain": domain,
      "ym:s:startURLPath": { id: page.path, name: page.path },
      "ym:s:deviceCategory": device.value,
      "ym:s:regionCountry": geo.country,
      "ym:s:regionCity": geo.city,
    },
  }));
}

export const DEMO_COUNTERS: readonly DemoCounter[] = [
  {
    info: {
      id: "10000001",
      name: "Demo Coffee Shop",
      site: "coffee.example.test",
      time_zone: "Europe/Moscow",
      status: "Active",
      permission: "view",
    },
    goals: [
      { id: "3001", name: "Order form submitted", type: "form" },
      { id: "3002", name: "Phone number click", type: "phone" },
      // Same name as 3001 on purpose: goals must be chosen by ID.
      { id: "3003", name: "Order form submitted", type: "url" },
    ],
    goalRates: [0.035, 0.018, 0.012],
    baseDailyVisits: 420,
    seed: 1_000_001,
    sampledAboveDays: null,
  },
  {
    info: {
      id: "10000002",
      name: "Demo Travel Blog",
      site: "travel-blog.example.test",
      time_zone: "Asia/Novosibirsk",
      status: "Active",
      permission: "view",
    },
    goals: [],
    goalRates: [],
    baseDailyVisits: 1800,
    seed: 1_000_002,
    sampledAboveDays: 120,
  },
];
