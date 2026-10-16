import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { discoverAgents } from "./agents.ts";
import { temporaryPrompt } from "./index.ts";

const skill = fileURLToPath(new URL("../../skills/poteto-mode/SKILL.md", import.meta.url));

test("poteto-mode directs agents to the injected path instead of an ignored file search", async (t) => {
  const agent = discoverAgents(process.cwd(), "bundled").find(({ name }) => name === "poteto-agent");
  assert.ok(agent, "bundled poteto-agent is missing");
  const { directory, file } = await temporaryPrompt(agent);
  t.after(() => rm(directory, { recursive: true, force: true }));
  const [instructions, prompt] = await Promise.all([readFile(skill, "utf8"), readFile(file, "utf8")]);
  assert.ok(instructions.includes("Read the exact absolute `SKILL.md` path supplied in your agent prompt"), "missing direct skill-path instruction");
  assert.ok(instructions.includes("`rg --files` skips installed packages under ignored `node_modules`"), "missing ignored-path warning");
  assert.ok(prompt.includes(skill), "subagent prompt does not include the actual skill path");
  assert.ok(prompt.includes("Read this exact absolute path without searching"), "subagent prompt does not direct agents to read the path");
});
