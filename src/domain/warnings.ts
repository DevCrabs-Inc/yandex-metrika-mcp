export type WarningSeverity = "info" | "warning";

export interface Warning {
  readonly code: string;
  readonly severity: WarningSeverity;
  readonly message: string;
  readonly affected_fields: string[];
}
