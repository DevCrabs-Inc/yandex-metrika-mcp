import type { ExportSpec, PartRow } from "./types.ts";

const FORMULA_START = /^[=+\-@\t\r]/;

function csvCell(value: string | number | null, excelSafe: boolean): string {
  if (value === null) return "";
  if (typeof value === "number") return String(value);
  let text = value;
  if (excelSafe && FORMULA_START.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\r\n]|^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvHeader(spec: ExportSpec): string {
  const excelSafe = spec.format === "csv_excel_safe";
  const columns = [
    ...spec.dimensions.flatMap((d) => [d.id, `${d.id}:id`]),
    ...spec.metrics.map((m) => m.id),
  ];
  return `${excelSafe ? "\ufeff" : ""}${columns.map((c) => csvCell(c, false)).join(",")}\r\n`;
}

export function csvRow(spec: ExportSpec, row: PartRow): string {
  const excelSafe = spec.format === "csv_excel_safe";
  const cells = [
    ...row.d.flatMap(([id, name]) => [csvCell(name, excelSafe), csvCell(id, excelSafe)]),
    // Metric values are numbers or exact digit strings; neither needs formula protection.
    ...row.v.map((v) => csvCell(v, false)),
  ];
  return `${cells.join(",")}\r\n`;
}

export function jsonHeader(
  spec: ExportSpec,
  totals: Readonly<Record<string, number | string | null>>,
): string {
  const head = {
    schema_version: "1.0",
    kind: "metrika_export",
    counter: spec.counter,
    period: spec.period,
    columns: { dimensions: spec.dimensions, metrics: spec.metrics },
    filters: spec.filters,
    sort: spec.sort,
    totals,
  };
  const json = JSON.stringify(head);
  return `${json.slice(0, -1)},"rows":[\n`;
}

export function jsonRow(row: PartRow, first: boolean): string {
  const value = {
    key: row.k,
    dimensions: row.d.map(([id, name]) => ({ id, name })),
    values: row.v,
  };
  return `${first ? "" : ",\n"}${JSON.stringify(value)}`;
}

export const JSON_FOOTER = "\n]}\n";

export function mediaType(format: ExportSpec["format"]): string {
  return format === "json" ? "application/json" : "text/csv; charset=utf-8";
}

export function fileName(spec: ExportSpec, jobId: string): string {
  const ext = spec.format === "json" ? "json" : "csv";
  return `metrika-${spec.counter.id}-${spec.period.start}_${spec.period.end}-${jobId.slice(-6)}.${ext}`;
}
