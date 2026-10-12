// Modera host-support snapshot from plugin-default-agent; no Pi loop is implemented here.
import type { TokenUsage } from "@modera/contracts";

export function addUsage(
  current: TokenUsage | undefined,
  next: TokenUsage,
): TokenUsage {
  return {
    inputTokens: (current?.inputTokens ?? 0) + next.inputTokens,
    outputTokens: (current?.outputTokens ?? 0) + next.outputTokens,
    cacheReadTokens:
      (current?.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0),
    cacheWriteTokens:
      (current?.cacheWriteTokens ?? 0) + (next.cacheWriteTokens ?? 0),
    ...(current?.reasoningTokens !== undefined ||
    next.reasoningTokens !== undefined
      ? {
          reasoningTokens:
            (current?.reasoningTokens ?? 0) + (next.reasoningTokens ?? 0),
        }
      : {}),
  };
}
