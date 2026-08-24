import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
  pi?: { subagents?: { agents?: string[] } };
  "pi-subagents"?: { agents?: string[] };
};

test("exports bundled agents to Pi subagent discovery", () => {
  assert.deepEqual(packageJson.pi?.subagents?.agents, ["./agents"]);
  assert.deepEqual(packageJson["pi-subagents"]?.agents, ["./agents"]);

  for (const file of ["poteto-agent.md", "comment-sicko.md"]) {
    assert.ok(fs.existsSync(path.join(root, "agents", file)), `${file} should be packaged`);
  }
});

test("uses a namespaced native delegation tool", () => {
  const source = fs.readFileSync(path.join(root, "extensions/pstack/index.ts"), "utf8");
  assert.match(source, /name: "pstack_subagent"/);
  assert.doesNotMatch(source, /name: "subagent"/);
});
