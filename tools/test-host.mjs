import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const host = resolve(
  process.argv[2] ?? process.env.MODERA_HOST_WORKSPACE ?? "../../modera",
);
const output = resolve(
  host,
  "modera-app/artifacts/pi-agent-tests/host-integration.cjs",
);
await mkdir(resolve(output, ".."), { recursive: true });
await build({
  entryPoints: ["tests/host-integration.ts"],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  packages: "external",
  alias: {
    "@modera/agent-host": resolve(
      host,
      "modera-app/core/packages/agent-host/src/index.ts",
    ),
    "modera-test-host/local-plugin-source": resolve(
      host,
      "modera-app/core/apps/desktop/src/main/plugins/local-plugin-source.ts",
    ),
  },
});
const result = spawnSync(process.execPath, ["--test", output], {
  windowsHide: true,
  stdio: "inherit",
  env: { ...process.env, MODERA_PI_AGENT_DIR: process.cwd() },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
