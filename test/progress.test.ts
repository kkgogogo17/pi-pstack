import assert from "node:assert/strict";
import test from "node:test";
import { formatSubagentProgress, type SubagentProgress } from "../extensions/pstack/progress.ts";

function progress({
  agent,
  status,
  turns = 0,
  peakContext = 0,
  contextWindow = 272_000,
  model = "openai-codex/test-model",
  thinkingLevel = "high",
}: {
  agent: string;
  status: SubagentProgress["status"];
  turns?: number;
  peakContext?: number;
  contextWindow?: number;
  model?: string;
  thinkingLevel?: string;
}): SubagentProgress {
  return {
    agent,
    status,
    model,
    thinkingLevel,
    contextWindow,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, peakContext, turns },
  };
}

test("shows the total and every active subagent status", () => {
  const output = formatSubagentProgress([
    progress({ agent: "worker-a", status: "running", turns: 2, peakContext: 1_250 }),
    progress({ agent: "worker-b", status: "pending" }),
    progress({ agent: "reviewer", status: "completed", turns: 3, peakContext: 12_400 }),
    progress({ agent: "worker-c", status: "failed", turns: 1, peakContext: 400 }),
  ]);

  assert.equal(
    output,
    [
      "Subagents: 2/4 finished · 1 running · 1 queued · 1 failed",
      "● 1. worker-a · running · openai-codex/test-model · high thinking · 1.3k/272k ctx (<1%) · 2 turns",
      "○ 2. worker-b · queued · openai-codex/test-model · high thinking · 0/272k ctx (0%)",
      "✓ 3. reviewer · completed · openai-codex/test-model · high thinking · 12k/272k ctx (5%) · 3 turns",
      "✗ 4. worker-c · failed · openai-codex/test-model · high thinking · 400/272k ctx (<1%) · 1 turn",
    ].join("\n"),
  );
});

test("keeps a useful summary after all subagents complete", () => {
  assert.equal(
    formatSubagentProgress([progress({ agent: "worker", status: "completed", turns: 1, peakContext: 16_963 })]),
    "Subagents: 1/1 finished\n✓ 1. worker · completed · openai-codex/test-model · high thinking · 17k/272k ctx (6%) · 1 turn",
  );
});
