// Modera host-support snapshot from plugin-default-agent; no Pi loop is implemented here.
import type { RunDiagnostic, DiagnosticSink } from "@modera/contracts";
export type { RunDiagnostic, DiagnosticSink } from "@modera/contracts";

export function reportDiagnostic(
  sink: DiagnosticSink | undefined,
  event: RunDiagnostic,
): void {
  // Observability failures must never replay or interrupt a model/tool transaction.
  try {
    sink?.(event);
  } catch {
    /* diagnostics are best effort */
  }
}
