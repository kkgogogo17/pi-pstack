import assert from "node:assert/strict";
import test from "node:test";
import { subagentExternalActionPolicy } from "../extensions/pstack/policy.ts";
import { validateRoleUpdate } from "../extensions/pstack/validation.ts";

const roles = ["writer", "reviewer"] as const;

test("role updates reject unknown roles and malformed pools", () => {
  assert.throws(() => validateRoleUpdate(roles, "unknown", "provider/model", undefined), /Unknown pstack role/);
  assert.throws(() => validateRoleUpdate(roles, "writer", "provider/model", ["provider/other"]), /either model or models/);
  assert.throws(() => validateRoleUpdate(roles, "writer", undefined, []), /nonempty array/);
  assert.throws(() => validateRoleUpdate(roles, "writer", undefined, [" "]), /nonblank/);
  assert.deepEqual(validateRoleUpdate(roles, "reviewer", undefined, ["provider/one", "provider/two"]), {
    role: "reviewer",
    value: ["provider/one", "provider/two"],
  });
});

test("subagent policy blocks raw host calls and gates unsafe native commands", () => {
  assert.equal(subagentExternalActionPolicy({ workflowScript: "return runs.host('ci', { command: 'git push' })" }).kind, "block");
  assert.deepEqual(subagentExternalActionPolicy({ workflow: "run-ci", args: { command: "git push origin HEAD" } }), {
    kind: "confirm",
    operation: "git push",
    command: "git push origin HEAD",
  });
  assert.equal(subagentExternalActionPolicy({ gate: "npm test" }).kind, "allow");
  assert.equal(subagentExternalActionPolicy({ acceptance: { verify: [{ command: "gh pr merge 42" }] } }).kind, "confirm");
  assert.equal(subagentExternalActionPolicy({ acceptance: { verify: [{ command: "gh pr merge 42" }, { command: "git push" }] } }).kind, "block");
  assert.equal(subagentExternalActionPolicy({ workflow: "run-ci", args: { command: "rm -rf generated" } }).kind, "confirm");
  assert.equal(subagentExternalActionPolicy({ action: "status" }).kind, "allow");
  assert.equal(subagentExternalActionPolicy({ workflowScript: "return runs.all([{ key: 'review', agent: 'reviewer', task: 'Review' }])" }).kind, "allow");
});
