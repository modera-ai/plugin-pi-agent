// Modera host-support snapshot from plugin-default-agent; no Pi loop is implemented here.
import type { RecoveryBudgetPort, RecoveryKind } from "@modera/contracts";
export type { RecoveryKind } from "@modera/contracts";

/** Shared across recovery layers until a model round completes successfully. */
export class RecoveryBudget implements RecoveryBudgetPort {
  #used = 0;

  constructor(readonly limit = 3) {
    if (!Number.isSafeInteger(limit) || limit < 0)
      throw new Error("Invalid recovery budget");
  }

  tryConsume(_kind: RecoveryKind): boolean {
    if (this.#used >= this.limit) return false;
    this.#used += 1;
    return true;
  }

  get used(): number {
    return this.#used;
  }

  resetAfterSuccess(): void {
    this.#used = 0;
  }
}
