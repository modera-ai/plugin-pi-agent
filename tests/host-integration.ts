import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AgentPluginRuntime,
  ToolRegistry,
  serviceAgentFactory,
} from "@modera/agent-host";
// @ts-expect-error Resolved by tools/test-host.mjs to the explicitly selected host checkout.
import { localPluginSource } from "modera-test-host/local-plugin-source";
import {
  ModelStreamInterruptedError,
  type AgentEvent,
  type ModelRequest,
  type RunId,
  type SessionId,
} from "@modera/contracts";

const request = (): ModelRequest => ({
  sessionId: "integration" as SessionId,
  runId: "run" as RunId,
  messages: [
    {
      id: "user",
      role: "user",
      content: "probe",
      createdAt: new Date(0).toISOString(),
    },
  ],
  tools: [],
  signal: new AbortController().signal,
});
async function harness() {
  const enabled = new Set(["modera.pi-agent"]);
  const runtime = new AgentPluginRuntime(
    new ToolRegistry(),
    (id) => enabled.has(id),
    async () => "",
  );
  runtime.add(await localPluginSource(process.env.MODERA_PI_AGENT_DIR!));
  await runtime.reconcile(enabled);
  assert.equal(runtime.list()[0]?.state, "active");
  return {
    runtime,
    factory: serviceAgentFactory(runtime.services, () => ({
      provider: "modera.pi-agent",
      service: "modera.pi-agent.runtime",
    })),
  };
}

test("compiled Pi plugin runs through the host reference service and retains checkpoint barriers", async () => {
  const { runtime, factory } = await harness();
  let calls = 0;
  let executions = 0;
  const recovery = {
    limit: 3,
    used: 0,
    tryConsume: () => true,
    resetAfterSuccess: () => {},
  };
  const events: AgentEvent[] = [];
  try {
    const agent = factory({
      model: {
        async *stream(input) {
          assert.equal(input.recovery, recovery);
          if (++calls === 1)
            yield {
              type: "tool-call",
              id: "probe-call",
              name: "probe",
              input: {},
            };
          else yield { type: "text-delta", text: "finished" };
          yield { type: "completed" };
        },
      },
      executor: {
        definitions: () => [
          {
            id: "probe",
            title: "Probe",
            description: "Probe",
            inputSchema: { type: "object", properties: {} },
            requiredPermissions: [],
          },
        ],
        guidance: () => [],
        title: () => "Probe",
        completedCall: () => undefined,
        execute: async () => {
          executions++;
          return "host executed";
        },
      },
    });
    for await (const event of agent.run({ ...request(), recovery })) {
      if (
        event.type === "tool-round-prepared" ||
        event.type === "tool-started"
      ) {
        assert.equal(executions, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(executions, 0);
      }
      events.push(event);
    }
    assert.equal(calls, 2);
    assert.equal(executions, 1);
    assert.equal(events.at(-1)?.type, "completed");
  } finally {
    await runtime.close();
  }
});

test("compiled Pi adapter recognizes host recovery errors across the bundle boundary", async () => {
  const { runtime, factory } = await harness();
  let attempts = 0;
  try {
    const agent = factory({
      model: {
        async *stream() {
          if (++attempts === 1) {
            yield { type: "text-delta", text: "partial" };
            throw new ModelStreamInterruptedError("text-partial", "cut");
          }
          yield { type: "text-delta", text: " done" };
          yield { type: "completed" };
        },
      },
    });
    const events: AgentEvent[] = [];
    for await (const event of agent.run(request())) events.push(event);
    assert.equal(attempts, 2);
    assert.equal(events.at(-1)?.type, "completed");
  } finally {
    await runtime.close();
  }
});
