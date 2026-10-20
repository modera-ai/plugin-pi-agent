import { expect, it, vi } from "vitest";
import {
  ModelLimitError,
  type AgentEvent,
  type AgentToolExecutor,
  type ChatMessage,
  type ModelRequest,
  type RunId,
  type SessionId,
  type ToolDefinition,
} from "@modera/contracts";
import { PiAgentRuntime } from "../src/pi-runtime";

const user = (content = "help", id = "user"): ChatMessage => ({
  id,
  role: "user",
  content,
  createdAt: new Date(0).toISOString(),
});
const input = (patch: Partial<ModelRequest> = {}): ModelRequest => ({
  sessionId: "session" as SessionId,
  runId: "run" as RunId,
  messages: [user()],
  tools: [],
  signal: new AbortController().signal,
  ...patch,
});
const tool: ToolDefinition = {
  id: "probe",
  title: "Probe",
  description: "Probe",
  inputSchema: {
    type: "object",
    properties: { value: { type: "string" } },
    required: ["value"],
    additionalProperties: false,
  },
  requiredPermissions: [],
};
function executor() {
  const execute = vi.fn(async () => "host result");
  const port: AgentToolExecutor = {
    definitions: () => [tool],    title: () => "Probe",
    execute,
    completedCall: () => ({
      images: [{ mimeType: "image/png", data: "YWJj" }],
      toolProvenance: { tool: "probe", owner: "test", version: "1" },
    }),
  };
  return { port, execute };
}
async function drain(runtime: PiAgentRuntime, request = input()) {
  const events: AgentEvent[] = [];
  for await (const event of runtime.run(request)) events.push(event);
  return events;
}
function fixture(argumentsValue: unknown = { value: "ok" }) {
  const { port, execute } = executor();
  const requests: ModelRequest[] = [];
  const runtime = new PiAgentRuntime({
    executor: port,
    model: {
      async *stream(request) {
        requests.push(request);
        if (requests.length === 1) {
          yield { type: "thinking-delta", text: "think" };
          yield { type: "message-phase", phase: "commentary" };
          yield {
            type: "model-blocks",
            blocks: [{ type: "thinking", signature: "signed" }],
          };
          yield {
            type: "tool-call",
            id: "call",
            name: "probe",
            input: argumentsValue,
          };
        } else yield { type: "text-delta", text: "done" };
        yield {
          type: "completed",
          usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 20 },
        };
      },
    },
  });
  return { runtime, requests, execute };
}

it("uses the real Pi loop to call the host executor and request the next response", async () => {
  const { runtime, requests, execute } = fixture();
  const events = await drain(runtime);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(requests).toHaveLength(2);
  const assistant = requests[1].messages.find(
    (message) => message.toolCalls?.length,
  );
  expect(assistant).toMatchObject({
    phase: "commentary",
    thinking: "think",
    modelBlocks: [{ signature: "signed" }],
  });
  expect(
    requests[1].messages.find((message) => message.role === "tool"),
  ).toMatchObject({
    content: "host result",
    images: [{ data: "YWJj" }],
    toolProvenance: { owner: "test" },
  });
  expect(events.at(-1)).toMatchObject({
    type: "completed",
    usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 40 },
  });
  expect(events.map((event) => event.type)).toContain("tool-round-prepared");
});

it.each(["tool-round-prepared", "tool-started"])(
  "does not execute a tool if the consumer stops at %s",
  async (boundary) => {
    const { runtime, execute } = fixture();
    let reached = false;
    for await (const event of runtime.run(input())) {
      if (event.type === boundary) {
        reached = true;
        break;
      }
    }
    expect(reached).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  },
);

it("lets Pi validate arguments and returns the validation failure without executing", async () => {
  const { runtime, execute, requests } = fixture({});
  const events = await drain(runtime);
  expect(execute).not.toHaveBeenCalled();
  expect(events.find((event) => event.type === "tool-finished")).toMatchObject({
    message: { content: expect.stringMatching(/validat|value/i) },
  });
  expect(requests).toHaveLength(2);
});

it("persists an intermediate answer before following up with queued input", async () => {
  const requests: ModelRequest[] = [];
  let delivered = false;
  const runtime = new PiAgentRuntime({
    takeInput: async (finishing) =>
      finishing && !delivered
        ? ((delivered = true), [user("next", "next")])
        : [],
    model: {
      async *stream(request) {
        requests.push(request);
        yield {
          type: "text-delta",
          text: requests.length === 1 ? "first" : "second",
        };
        yield { type: "completed" };
      },
    },
  });
  const events = await drain(runtime);
  expect(requests).toHaveLength(2);
  expect(requests[1].messages.map((message) => message.content)).toEqual(
    expect.arrayContaining(["first", "next"]),
  );
  expect(events.find((event) => event.type === "messages")).toMatchObject({
    messages: [
      { role: "assistant", content: "first" },
      { role: "user", content: "next" },
    ],
  });
  expect(events.at(-1)?.type).toBe("completed");
});

it("propagates the original model failure and never completes or executes tools", async () => {
  const error = new Error("provider failed");
  const { port, execute } = executor();
  const runtime = new PiAgentRuntime({
    executor: port,
    model: {
      async *stream() {
        yield {
          type: "tool-call",
          id: "call",
          name: "probe",
          input: { value: "ok" },
        };
        throw error;
      },
    },
  });
  await expect(drain(runtime)).rejects.toBe(error);
  expect(execute).not.toHaveBeenCalled();
});

it("cancels an active host model stream when the host aborts", async () => {
  const controller = new AbortController();
  let stopped = false;
  const runtime = new PiAgentRuntime({
    model: {
      async *stream(request) {
        try {
          yield { type: "text-delta", text: "partial" };
          await new Promise<void>((resolve) =>
            request.signal.addEventListener("abort", () => resolve(), {
              once: true,
            }),
          );
          request.signal.throwIfAborted();
        } finally {
          stopped = true;
        }
      },
    },
  });
  await expect(
    (async () => {
      for await (const event of runtime.run(
        input({ signal: controller.signal }),
      ))
        if (event.type === "text-delta") controller.abort();
    })(),
  ).rejects.toThrow();
  expect(stopped).toBe(true);
});

it("uses host prompt transforms, transient context, recovery ports and restored checkpoints", async () => {
  const recovery = {
    limit: 3,
    used: 0,
    tryConsume: vi.fn(() => true),
    resetAfterSuccess: vi.fn(),
  };
  const requests: ModelRequest[] = [];
  const runtime = new PiAgentRuntime({
    transformPromptDocument: async (blocks) => [
      ...blocks,
      { owner: "test", id: "extra", kind: "project", text: "custom policy" },
    ],
    collectContext: async () => [
      { owner: "test", id: "evidence", text: "derived evidence" },
    ],
    model: {
      async *stream(request) {
        requests.push(request);
        yield { type: "completed" };
      },
    },
  });
  await drain(
    runtime,
    input({
      recovery,
      messages: [user("old", "old"), user("new", "new")],
      contextCheckpoint: {
        version: 1,
        throughMessageId: "old",
        summary: "saved handoff",
        createdAt: new Date(0).toISOString(),
        retainedUserMessageIds: [],
      },
    }),
  );
  expect(requests[0].recovery).toBe(recovery);
  expect(
    requests[0].messages.map((message) => message.content).join("\n"),
  ).toContain("saved handoff");
  expect(requests[0].messages[0].content).toContain("custom policy");
  expect(
    requests[0].messages.map((message) => message.content).join("\n"),
  ).toContain("derived evidence");
  expect(recovery.resetAfterSuccess).toHaveBeenCalled();
});

it("enforces the host step budget before a second provider call", async () => {
  const { port } = executor();
  let calls = 0;
  const runtime = new PiAgentRuntime({
    executor: port,
    limits: { maxSteps: 1 },
    model: {
      async *stream() {
        calls++;
        yield {
          type: "tool-call",
          id: "call",
          name: "probe",
          input: { value: "ok" },
        };
        yield { type: "completed" };
      },
    },
  });
  await expect(drain(runtime)).rejects.toThrow("RUN_STEP_BUDGET_EXCEEDED");
  expect(calls).toBe(1);
});

it("saves compaction checkpoints before the next conversational model request", async () => {
  let calls = 0;
  let conversationalCalls = 0;
  let checkpointSaved = false;
  const messages = [
    user("retain constraints"),
    ...Array.from({ length: 14 }, (_, index): ChatMessage => ({
      id: `old-${index}`,
      role: "assistant",
      content: "old evidence ".repeat(300),
      createdAt: new Date(0).toISOString(),
    })),
    user("latest", "latest"),
  ];
  const runtime = new PiAgentRuntime({
    context: { inputBudget: 12000 },
    model: {
      async *stream(request) {
        calls++;
        if (request.messages[0].id === "handoff-policy")
          yield {
            type: "text-delta",
            text: "Retained constraints and evidence.",
          };
        else {
          conversationalCalls++;
          expect(checkpointSaved).toBe(true);
          yield { type: "text-delta", text: "done" };
        }
        yield { type: "completed" };
      },
    },
  });
  for await (const event of runtime.run(input({ messages }))) {
    if (event.type === "context-compacted") {
      expect(conversationalCalls).toBe(0);
      checkpointSaved = true;
    }
  }
  expect(checkpointSaved).toBe(true);
  expect(calls).toBeGreaterThan(1);
  expect(conversationalCalls).toBe(1);
});

it("recovers a rejected context request through host compaction using the shared recovery budget", async () => {
  const recovery = {
    limit: 3,
    used: 0,
    tryConsume: vi.fn(() => true),
    resetAfterSuccess: vi.fn(),
  };
  let conversationalCalls = 0;
  const messages = [
    user(),
    ...Array.from({ length: 10 }, (_, index): ChatMessage => ({
      id: `old-${index}`,
      role: "assistant",
      content: "evidence ".repeat(160),
      createdAt: new Date(0).toISOString(),
    })),
    user("latest", "latest"),
  ];
  const runtime = new PiAgentRuntime({
    context: { inputBudget: 20000 },
    model: {
      async *stream(request) {
        if (request.messages[0].id === "handoff-policy")
          yield { type: "text-delta", text: "Saved evidence." };
        else if (++conversationalCalls === 1)
          throw new ModelLimitError("context", "too long");
        else yield { type: "text-delta", text: "done" };
        yield { type: "completed" };
      },
    },
  });
  const events = await drain(runtime, input({ messages, recovery }));
  expect(conversationalCalls).toBe(2);
  expect(recovery.tryConsume).toHaveBeenCalledWith("context");
  expect(events.some((event) => event.type === "context-compacted")).toBe(true);
  expect(events.at(-1)?.type).toBe("completed");
});

it("rejects duplicate call IDs before Pi dispatches any tool", async () => {
  const { port, execute } = executor();
  const runtime = new PiAgentRuntime({
    executor: port,
    model: {
      async *stream() {
        yield {
          type: "tool-call",
          id: "duplicate",
          name: "probe",
          input: { value: "ok" },
        };
        yield {
          type: "tool-call",
          id: "duplicate",
          name: "probe",
          input: { value: "ok" },
        };
        yield { type: "completed" };
      },
    },
  });
  await expect(drain(runtime)).rejects.toThrow(
    "Invalid or excessive tool calls",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("forwards Pi-coerced arguments through the host authorization executor", async () => {
  const { runtime, execute } = fixture({ value: 42 });
  await drain(runtime);
  expect(execute).toHaveBeenCalledWith(
    expect.objectContaining({ input: { value: "42" } }),
    expect.anything(),
    expect.any(Number),
  );
});

it.each([true, false])(
  "uses Pi scheduling for independent-read=%s batches",
  async (independent) => {
    let active = 0;
    let maximum = 0;
    let rounds = 0;
    const { port } = executor();
    const runtime = new PiAgentRuntime({
      executor: {
        ...port,
        definitions: () => [
          { ...tool, id: "first", concurrency: "independent-read" },
          {
            ...tool,
            id: "second",
            ...(independent
              ? { concurrency: "independent-read" as const }
              : {}),
          },
        ],
        execute: async () => {
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return "done";
        },
      },
      model: {
        async *stream() {
          if (++rounds === 1) {
            yield {
              type: "tool-call",
              id: "first",
              name: "first",
              input: { value: "ok" },
            };
            yield {
              type: "tool-call",
              id: "second",
              name: "second",
              input: { value: "ok" },
            };
          }
          yield { type: "completed" };
        },
      },
    });
    const events = await drain(runtime);
    expect(maximum).toBe(independent ? 2 : 1);
    const saved = events.find((event) => event.type === "messages");
    expect(saved).toMatchObject({
      messages: [
        { role: "assistant" },
        { toolCallId: "first" },
        { toolCallId: "second" },
      ],
    });
  },
);
