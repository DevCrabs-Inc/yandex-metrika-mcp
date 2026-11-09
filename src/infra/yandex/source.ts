import { z } from "zod";
import type {
  ByTimeRequest,
  Clock,
  CounterInfo,
  DataRequest,
  FetchOptions,
  GoalInfo,
  MetrikaSource,
  SourceResponse,
} from "../../app/ports.ts";
import { DomainError } from "../../domain/errors.ts";
import { compileFilters } from "../../domain/filters.ts";
import { schemaChanged } from "../../domain/upstream.ts";
import type { YandexClient } from "./client.ts";

/** Upper bound of top_keys documented for /stat/v1/data/bytime. */
export const BYTIME_MAX_TOP_KEYS = 30;
const INTERACTIVE_BUDGET_MS = 60_000;
const BACKGROUND_BUDGET_MS = 10 * 60_000;
const COUNTERS_PER_PAGE = 1000;

// Management responses are parsed loosely: only the fields we use are required.
const counterSchema = z.looseObject({
  id: z.union([z.number(), z.string()]),
  name: z.string().nullish(),
  site: z.string().nullish(),
  site2: z.looseObject({ site: z.string().nullish() }).nullish(),
  time_zone_name: z.string().nullish(),
  status: z.string().nullish(),
  permission: z.string().nullish(),
});
const countersSchema = z.looseObject({
  counters: z.array(counterSchema),
  rows: z.number().optional(),
});
const counterEnvelope = z.looseObject({ counter: counterSchema });
const goalsSchema = z.looseObject({
  goals: z.array(
    z.looseObject({
      id: z.union([z.number(), z.string()]),
      name: z.string().nullish(),
      type: z.string().nullish(),
    }),
  ),
});

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw schemaChanged(`${what} has an unexpected shape`);
  return result.data;
}

function toCounter(c: z.infer<typeof counterSchema>): CounterInfo {
  const permission = c.permission;
  return {
    id: String(c.id),
    name: c.name ?? "",
    site: c.site ?? c.site2?.site ?? "",
    time_zone: c.time_zone_name ?? null,
    status: c.status ?? "unknown",
    permission:
      permission === "own" || permission === "edit" || permission === "view"
        ? permission
        : "unknown",
  };
}

export interface YandexSourceOptions {
  /** Label language for the Reporting API `lang` parameter. */
  readonly lang: "ru" | "en";
}

export class YandexSource implements MetrikaSource {
  readonly kind = "yandex";
  readonly adapterVersion = "yandex-1";
  private readonly _client: YandexClient;
  private readonly _clock: Clock;
  private readonly _options: YandexSourceOptions;

  constructor(client: YandexClient, clock: Clock, options: YandexSourceOptions) {
    this._client = client;
    this._clock = clock;
    this._options = options;
  }

  async listCounters(options?: FetchOptions): Promise<readonly CounterInfo[]> {
    const body = await this._client.get(
      { name: "counters" },
      new URLSearchParams({ per_page: String(COUNTERS_PER_PAGE) }),
      this._requestOptions(options),
    );
    return parse(countersSchema, body, "counter list").counters.map(toCounter);
  }

  async getCounter(counterId: string, options?: FetchOptions): Promise<CounterInfo> {
    const body = await this._client.get(
      { name: "counter", counterId },
      new URLSearchParams(),
      this._requestOptions(options),
    );
    const counter = toCounter(parse(counterEnvelope, body, "counter").counter);
    if (counter.id !== counterId) throw schemaChanged("counter response is for a different ID");
    return counter;
  }

  async listGoals(counterId: string, options?: FetchOptions): Promise<readonly GoalInfo[]> {
    const body = await this._client.get(
      { name: "goals", counterId },
      new URLSearchParams(),
      this._requestOptions(options),
    );
    return parse(goalsSchema, body, "goal list").goals.map((g) => ({
      id: String(g.id),
      name: g.name ?? "",
      type: g.type ?? "unknown",
    }));
  }

  async getData(request: DataRequest, options?: FetchOptions): Promise<SourceResponse> {
    const params = this._common(request);
    params.set("limit", String(request.limit));
    params.set("offset", String(request.offset));
    if (request.sort.length > 0) params.set("sort", request.sort.join(","));
    const body = await this._client.get({ name: "data" }, params, this._requestOptions(options));
    return { body, fetchedAt: this._clock.now(), cacheHit: false, stale: false };
  }

  async getByTime(request: ByTimeRequest, options?: FetchOptions): Promise<SourceResponse> {
    if (request.topKeys > BYTIME_MAX_TOP_KEYS) {
      throw new DomainError("INVALID_QUERY", `top_keys is limited to ${BYTIME_MAX_TOP_KEYS}.`);
    }
    const params = this._common(request);
    params.set("group", request.group);
    params.set("top_keys", String(request.topKeys));
    const body = await this._client.get({ name: "bytime" }, params, this._requestOptions(options));
    return { body, fetchedAt: this._clock.now(), cacheHit: false, stale: false };
  }

  private _common(request: DataRequest | ByTimeRequest): URLSearchParams {
    const params = new URLSearchParams({
      ids: request.counterId,
      date1: request.date1,
      date2: request.date2,
      metrics: request.metrics.join(","),
      lang: this._options.lang,
    });
    if (request.dimensions.length > 0) params.set("dimensions", request.dimensions.join(","));
    const filters = compileFilters(request.filters);
    if (filters !== null) params.set("filters", filters);
    if (request.accuracy !== null) params.set("accuracy", request.accuracy);
    return params;
  }

  private _requestOptions(options: FetchOptions | undefined) {
    const priority = options?.priority ?? "interactive";
    return {
      priority,
      budgetMs: priority === "background" ? BACKGROUND_BUDGET_MS : INTERACTIVE_BUDGET_MS,
      ...(options?.signal ? { signal: options.signal } : {}),
    };
  }
}
