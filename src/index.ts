import {
  AGENT_RUNTIME_CONTRACT,
  type AgentRunInvocation,
  type PluginModule,
} from "@modera/contracts";
import { PiAgentRuntime } from "./pi-runtime";
import { BASE_SYSTEM_POLICY } from "./host-support/system-prompt";

export const activate: PluginModule["activate"] = async () => ({
  promptPolicy: { id: "system-policy", text: BASE_SYSTEM_POLICY },
  services: {
    "modera.pi-agent.runtime": {
      ...AGENT_RUNTIME_CONTRACT,
      methods: {
        run: {
          timeoutMs: 0,
          call: async () => {
            throw new Error("Agent runtime requires streaming");
          },
          async *stream(input, context) {
            const { dependencies, request } = input as AgentRunInvocation;
            yield* new PiAgentRuntime(dependencies).run({
              ...request,
              signal: AbortSignal.any([request.signal, context.signal]),
            });
          },
        },
      },
    },
  },
});
