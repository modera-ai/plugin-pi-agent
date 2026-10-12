import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AssistantMessage,
  JsonObject,
  Model,
  Usage,
} from "@earendil-works/pi-ai";
import type { ChatMessage, TokenUsage } from "@modera/contracts";

// Routing descriptor only. The injected Modera ModelAdapter owns actual model selection.
export const HOST_MODEL: Model<"modera-host"> = {
  id: "host-selected",
  name: "Modera host model",
  api: "modera-host",
  provider: "modera",
  baseUrl: "",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 48000,
  maxTokens: 8192,
};

export function piUsage(usage?: TokenUsage): Usage {
  const cacheRead = usage?.cacheReadTokens ?? 0;
  const cacheWrite = usage?.cacheWriteTokens ?? 0;
  return {
    input: Math.max(0, (usage?.inputTokens ?? 0) - cacheRead - cacheWrite),
    output: usage?.outputTokens ?? 0,
    cacheRead,
    cacheWrite,
    ...(usage?.reasoningTokens !== undefined
      ? { reasoning: usage.reasoningTokens }
      : {}),
    totalTokens: (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: HOST_MODEL.api,
    provider: HOST_MODEL.provider,
    model: HOST_MODEL.id,
    usage: piUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

export function toPi(message: ChatMessage): AgentMessage {
  const timestamp = Date.parse(message.createdAt);
  if (message.role === "system")
    return { role: "system", content: message.content, timestamp };
  if (message.role === "user")
    return {
      role: "user",
      timestamp,
      content: message.images?.length
        ? [
            { type: "text", text: message.content },
            ...message.images.map((image) => ({
              type: "image" as const,
              ...image,
            })),
          ]
        : message.content,
    };
  if (message.role === "tool")
    return {
      role: "toolResult",
      timestamp,
      toolCallId: message.toolCallId ?? message.id,
      toolName: message.toolProvenance?.tool ?? "host-tool",
      content: [
        { type: "text", text: message.content },
        ...(message.images ?? []).map((image) => ({
          type: "image" as const,
          ...image,
        })),
      ],
      isError: false,
    };
  return {
    ...assistantMessage(),
    timestamp,
    stopReason: message.toolCalls?.length ? "toolUse" : "stop",
    content: [
      ...(message.content
        ? [{ type: "text" as const, text: message.content }]
        : []),
      ...(message.thinking
        ? [{ type: "thinking" as const, thinking: message.thinking }]
        : []),
      ...(message.toolCalls ?? []).map((call) => ({
        type: "toolCall" as const,
        id: call.id,
        name: call.name,
        arguments: call.input as JsonObject,
      })),
    ],
  };
}

export function fromPi(message: AssistantMessage): ChatMessage {
  return {
    id: randomUUID(),
    role: "assistant",
    createdAt: new Date(message.timestamp).toISOString(),
    content: message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join(""),
    thinking: message.content
      .filter((block) => block.type === "thinking")
      .map((block) => block.thinking)
      .join(""),
    ...(message.content.some((block) => block.type === "toolCall")
      ? {
          toolCalls: message.content
            .filter((block) => block.type === "toolCall")
            .map((call) => ({
              id: call.id,
              name: call.name,
              input: call.arguments,
            })),
        }
      : {}),
  };
}
