// Modera host-support snapshot from plugin-default-agent; no Pi loop is implemented here.
import type { ChatMessage, TokenUsage } from "@modera/contracts";
import { estimateContext } from "./context-manager";
import type {
  ModelAdapter,
  ModelRequest,
  ModelStreamEvent,
} from "@modera/contracts";
import {
  ModelLimitError,
  ModelStreamInterruptedError,
} from "@modera/contracts";
import { addUsage } from "./token-usage";

/** Continue text or regenerate incomplete tool calls before any complete call is emitted. */
export class ContinuingModel implements ModelAdapter {
  constructor(
    private readonly model: ModelAdapter,
    private readonly maxContinuations = 2,
    private readonly inputBudget = Infinity,
  ) {}

  async *stream(request: ModelRequest): AsyncIterable<ModelStreamEvent> {
    let text = "";
    let previousUsage: TokenUsage | undefined;
    let known = true;
    let regenerateTool = false;
    for (let attempt = 0; ; attempt++) {
      request.signal.throwIfAborted();
      const prefix = text;
      let pending = "";
      let filtering = attempt > 0;
      let toolSeen = false;
      const candidates = [
        ...(prefix.length >= 32 ? [prefix] : []),
        ...(prefix.length >= 128 ? [prefix.slice(-128)] : []),
      ];
      const filter = (chunk: string, final = false): string => {
        if (!filtering) return chunk;
        pending += chunk;
        const repeated = candidates.find((candidate) =>
          pending.startsWith(candidate),
        );
        if (repeated) {
          filtering = false;
          const result = pending.slice(repeated.length);
          pending = "";
          return result;
        }
        if (
          !final &&
          candidates.some((candidate) => candidate.startsWith(pending))
        )
          return "";
        filtering = false;
        const result = pending;
        pending = "";
        return result;
      };
      const messages: readonly ChatMessage[] = attempt
        ? [
            ...request.messages,
            ...(prefix
              ? [
                  {
                    id: `continuation-prefix-${attempt}`,
                    role: "assistant" as const,
                    content: prefix,
                    createdAt: new Date(0).toISOString(),
                  },
                ]
              : []),
            {
              id: `continuation-request-${attempt}`,
              role: "user",
              content: regenerateTool
                ? "The previous tool call could not be parsed because its JSON arguments were incomplete or invalid. No tool from that response was executed. Regenerate the intended tool call with complete, valid JSON arguments matching its schema. Do not continue or splice the partial JSON. Do not repeat preceding text or redo previously completed actions. Respect all original task constraints."
                : "The previous response hit its output limit. Continue exactly where it ended. Do not repeat any preceding text or redo completed actions. Complete the original task, respecting all original constraints.",
              createdAt: new Date(0).toISOString(),
            },
          ]
        : request.messages;
      if (
        attempt &&
        estimateContext(messages, request.tools) > this.inputBudget
      )
        throw new Error("MODEL_CONTINUATION_CONTEXT_BUDGET_EXCEEDED");
      try {
        for await (const event of this.model.stream({ ...request, messages })) {
          request.signal.throwIfAborted();
          if (event.type === "text-delta") {
            const delta = filter(event.text);
            if (delta) {
              text += delta;
              yield { type: "text-delta", text: delta };
            }
          } else if (event.type === "completed") {
            const rest = filter("", true);
            if (rest) {
              text += rest;
              yield { type: "text-delta", text: rest };
            }
            if (attempt && text === prefix && !toolSeen)
              throw new Error("MODEL_CONTINUATION_NO_PROGRESS");
            const usage =
              event.usage && known
                ? addUsage(previousUsage, event.usage)
                : undefined;
            yield { type: "completed", ...(usage ? { usage } : {}) };
            return;
          } else {
            if (event.type === "tool-call") toolSeen = true;
            yield event;
          }
        }
        throw new Error("Model stream ended without completion");
      } catch (error) {
        request.signal.throwIfAborted();
        const rest = filter("", true);
        if (rest) {
          text += rest;
          yield { type: "text-delta", text: rest };
        }
        const outputLimit =
          error instanceof ModelLimitError &&
          error.kind === "output" &&
          error.recovery?.canContinueText;
        const interruptedText =
          error instanceof ModelStreamInterruptedError &&
          error.state === "text-partial";
        const incompleteTool =
          error instanceof ModelStreamInterruptedError &&
          error.state === "tool-arguments-partial";
        const interruptedUsage =
          error instanceof ModelLimitError
            ? error.recovery?.usage
            : error instanceof ModelStreamInterruptedError
              ? error.usage
              : undefined;
        if (interruptedUsage)
          previousUsage = addUsage(previousUsage, interruptedUsage);
        else known = false;
        const terminalError =
          error instanceof ModelLimitError ||
          error instanceof ModelStreamInterruptedError
            ? known
              ? withUsage(error, previousUsage)
              : withoutUsage(error)
            : error;
        if (
          (!outputLimit && !interruptedText && !incompleteTool) ||
          toolSeen ||
          (!incompleteTool && (!text || text === prefix)) ||
          text.length > 64_000 ||
          attempt >= this.maxContinuations ||
          (request.recovery && !request.recovery.tryConsume("continuation"))
        )
          throw terminalError;
        regenerateTool = incompleteTool;
      }
    }
  }
}

function withUsage(
  error: ModelLimitError | ModelStreamInterruptedError,
  usage: TokenUsage | undefined,
): ModelLimitError | ModelStreamInterruptedError {
  if (!usage) return error;
  return error instanceof ModelLimitError
    ? new ModelLimitError(error.kind, error.message, {
        canContinueText: error.recovery?.canContinueText ?? false,
        usage,
      })
    : new ModelStreamInterruptedError(
        error.state,
        originalMessage(error),
        usage,
        {
          cause: error,
        },
      );
}

function withoutUsage(
  error: ModelLimitError | ModelStreamInterruptedError,
): ModelLimitError | ModelStreamInterruptedError {
  return error instanceof ModelLimitError
    ? new ModelLimitError(error.kind, error.message, {
        canContinueText: error.recovery?.canContinueText ?? false,
      })
    : new ModelStreamInterruptedError(
        error.state,
        originalMessage(error),
        undefined,
        { cause: error },
      );
}

function originalMessage(error: ModelStreamInterruptedError): string {
  return error.message.replace(/^MODEL_STREAM_INTERRUPTED\([^)]*\): /, "");
}
