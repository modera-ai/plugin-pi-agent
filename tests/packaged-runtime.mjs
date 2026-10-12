import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { join, dirname, resolve, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { gunzipSync } from "node:zlib";

test("packed plugin carries Pi and runs without source, vendor or node_modules", async () => {
  const directory = "release/plugin-market";
  const names = (await readdir(directory)).filter((name) =>
    name.endsWith(".moderax"),
  );
  assert.ok(names.length);
  // Use the current preview catalog to select the exact artifact, not a stale build.
  const catalog = JSON.parse(
    await readFile(join(directory, "catalog.preview.json"), "utf8"),
  );
  assert.equal(catalog.entries[0].manifest.id, "modera.pi-agent");
  const packageName = catalog.entries[0].url;
  assert.ok(names.includes(packageName));
  const archive = JSON.parse(
    gunzipSync(await readFile(join(directory, packageName))).toString("utf8"),
  );
  const root = await mkdtemp(join(tmpdir(), "modera-pi-package-"));
  try {
    for (const [path, entry] of Object.entries(archive.files)) {
      assert.ok(!/^(src|vendor|node_modules|tests)\//.test(path));
      const target = resolve(root, path);
      const inside = relative(root, target);
      assert.ok(!inside.startsWith("..") && !isAbsolute(inside));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, Buffer.from(entry, "base64"));
    }
    assert.ok(archive.files.NOTICE);
    const plugin = createRequire(join(root, "plugin.json"))(
      join(root, "dist/index.cjs"),
    );
    const contributions = await plugin.activate();
    const stream =
      contributions.services["modera.pi-agent.runtime"].methods.run.stream;
    const signal = new AbortController().signal;
    const events = [];
    for await (const event of stream(
      {
        dependencies: {
          model: {
            async *stream() {
              yield { type: "text-delta", text: "standalone Pi" };
              yield { type: "completed" };
            },
          },
        },
        request: {
          sessionId: "session",
          runId: "run",
          tools: [],
          messages: [],
          signal,
        },
      },
      { signal },
    ))
      events.push(event);
    assert.equal(events.at(-1)?.type, "completed");
    assert.ok(
      events.some(
        (event) =>
          event.type === "text-delta" && event.text === "standalone Pi",
      ),
    );
  } finally {
    // root is the exact absolute directory returned by mkdtemp for this test.
    await rm(root, { recursive: true, force: true });
  }
});
