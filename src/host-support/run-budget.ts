// Modera host-support snapshot from plugin-default-agent; no Pi loop is implemented here.
import type { RunLimits } from "@modera/contracts";
export type { RunLimits } from "@modera/contracts";

/** Limits are enforced between model rounds, never halfway through a tool transaction. */
export class RunBudget {
  private suspendedMs = 0;
  excludeSuspension(durationMs: number): void {
    if (Number.isFinite(durationMs) && durationMs > 0)
      this.suspendedMs += durationMs;
  }
  private readonly started = performance.now();
  readonly maxSteps: number;
  private readonly duration: number;
  private readonly tokens: number;

  constructor(limits: RunLimits = {}) {
    this.maxSteps = optionalLimit(limits.maxSteps);
    this.duration = optionalLimit(limits.maxDurationMs);
    this.tokens = optionalLimit(limits.maxTokens);
  }

  check(step: number, consumedTokens: number): void {
    if (step >= this.maxSteps)
      throw new Error(`RUN_STEP_BUDGET_EXCEEDED (${this.maxSteps})`);
    if (performance.now() - this.started - this.suspendedMs >= this.duration)
      throw new Error("RUN_TIME_BUDGET_EXCEEDED");
    if (consumedTokens >= this.tokens)
      throw new Error("RUN_TOKEN_BUDGET_EXCEEDED");
  }
}

/** No implicit lifetime cutoff. Callers such as evaluations can opt into limits. */
function optionalLimit(value: number | undefined): number {
  if (value === undefined) return Infinity;
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error("Invalid run budget");
  return value;
}

/** Compare both operation and evidence: polling that returns new state is progress. */
export class ProgressGuard {
  private previous = "";
  private repeats = 0;

  observe(calls: unknown, results: readonly string[]): void {
    const fingerprint = JSON.stringify([calls, results]);
    this.repeats = fingerprint === this.previous ? this.repeats + 1 : 0;
    this.previous = fingerprint;
    if (this.repeats >= 2)
      throw new Error("Repeated tool calls without progress; run stopped");
  }
}
