import { findDimension } from "./catalog.ts";
import { invalidQuery } from "./errors.ts";

export const FILTER_OPERATORS = ["eq", "neq", "contains", "not_contains", "in", "not_in"] as const;
export type FilterOperator = (typeof FILTER_OPERATORS)[number];

export const MAX_FILTERS = 10;
export const MAX_FILTER_VALUES = 50;
export const MAX_FILTER_VALUE_LENGTH = 1000;

export interface FilterCondition {
  readonly dimension: string;
  readonly op: FilterOperator;
  readonly values: readonly string[];
}

/** Validates typed filter conditions (combined with AND) against the dimension allowlist. */
export function validateFilters(filters: readonly FilterCondition[]): FilterCondition[] {
  if (filters.length > MAX_FILTERS) throw invalidQuery(`At most ${MAX_FILTERS} filters.`);
  return filters.map((filter) => {
    if (findDimension(filter.dimension) === null) {
      throw invalidQuery(
        `Unknown filter dimension: ${filter.dimension}.`,
        "Call metrika_catalog with kind='dimensions' to list supported dimensions.",
      );
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
    case "in":
      return `${dimension}=.(${values.map(quote).join(",")})`;
    case "not_in":
      return `${dimension}!.(${values.map(quote).join(",")})`;
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
