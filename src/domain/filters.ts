import { dimensionCandidates, findDimension } from "./catalog.ts";
import { invalidQuery } from "./errors.ts";
import { suggest } from "./suggest.ts";

export const FILTER_OPERATORS = ["eq", "neq", "contains", "not_contains", "in", "not_in"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const MAX_FILTERS = 10;
export const MAX_FILTER_VALUES = 20;
/** The Reporting API allows up to 20 conditions per request after expansion. */
export const MAX_FILTER_ATOMS = 20;
export const MAX_FILTER_VALUE_LENGTH = 1000;

export interface FilterCondition {
  readonly dimension: string;
  readonly op: FilterOperator;
  readonly values: readonly string[];
}

/** Validates typed filter conditions (combined with AND) against the dimension allowlist. */
export function validateFilters(filters: readonly FilterCondition[]): FilterCondition[] {
  if (filters.length > MAX_FILTERS) throw invalidQuery(`At most ${MAX_FILTERS} filters.`);
  const validated = filters.map((filter) => {
    if (findDimension(filter.dimension) === null) {
      throw invalidQuery(`Unknown filter dimension: ${filter.dimension}.`, {
        field: "filters[].dimension",
        candidates: suggest(filter.dimension, dimensionCandidates()),
        nextAction:
          "Use one of details.candidates if it is what the user meant, or call metrika_catalog with kind='dimensions'.",
      });
    }
    const multi = filter.op === "in" || filter.op === "not_in";
    if (filter.values.length === 0 || (!multi && filter.values.length !== 1)) {
      throw invalidQuery(
        `Filter ${filter.dimension} ${filter.op} needs ${multi ? "1 or more values" : "exactly one value"}.`,
      );
    }
    if (filter.values.length > MAX_FILTER_VALUES) {
      throw invalidQuery(`At most ${MAX_FILTER_VALUES} values per filter.`);
    }
    if (filter.values.some((v) => v.length > MAX_FILTER_VALUE_LENGTH)) {
      throw invalidQuery(`Filter values are limited to ${MAX_FILTER_VALUE_LENGTH} characters.`);
    }
    return { dimension: filter.dimension, op: filter.op, values: [...filter.values] };
  });
  const atoms = validated.reduce((sum, f) => sum + f.values.length, 0);
  if (atoms > MAX_FILTER_ATOMS) {
    throw invalidQuery(
      `Filters expand to ${atoms} conditions; the API allows ${MAX_FILTER_ATOMS}.`,
    );
  }
  return validated;
}

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

function compileCondition({ dimension, op, values }: FilterCondition): string {
  const first = quote(values[0] ?? "");
  switch (op) {
    case "eq":
      return `${dimension}==${first}`;
    case "neq":
      return `${dimension}!=${first}`;
    case "contains":
      return `${dimension}=@${first}`;
    case "not_contains":
      return `${dimension}!@${first}`;
    // Lists use documented OR/AND combinations instead of the =. operator,
    // whose list syntax is not shown in the official examples.
    case "in":
      return values.length === 1
        ? `${dimension}==${first}`
        : `(${values.map((v) => `${dimension}==${quote(v)}`).join(" OR ")})`;
    case "not_in":
      return values.map((v) => `${dimension}!=${quote(v)}`).join(" AND ");
  }
}

/**
 * Compiles validated conditions into the Reporting API `filters` syntax. Field
 * names come from the allowlist and values are always quoted and escaped.
 */
export function compileFilters(filters: readonly FilterCondition[]): string | null {
  if (filters.length === 0) return null;
  return filters.map(compileCondition).join(" AND ");
}

/** Evaluates a condition against a raw dimension value (used by the demo source). */
export function matchesFilter(filter: FilterCondition, value: string | null): boolean {
  const v = value ?? "";
  const first = filter.values[0] ?? "";
  switch (filter.op) {
    case "eq":
      return v === first;
    case "neq":
      return v !== first;
    case "contains":
      return v.includes(first);
    case "not_contains":
      return !v.includes(first);
    case "in":
      return filter.values.includes(v);
    case "not_in":
      return !filter.values.includes(v);
  }
}
