export type SubagentStatus = "pending" | "running" | "completed" | "failed";

export type SubagentProgress = {
  agent: string;
  status: SubagentStatus;
  model?: string;
  thinkingLevel?: string;
  contextWindow?: number;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    peakContext: number;
    turns: number;
  };
};

const STATUS_MARKERS: Record<SubagentStatus, string> = {
  pending: "○",
  running: "●",
  completed: "✓",
  failed: "✗",
};

const STATUS_LABELS: Record<SubagentStatus, string> = {
  pending: "queued",
  running: "running",
  completed: "completed",
  failed: "failed",
};

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 10_000) return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${Math.round(tokens / 1_000)}k`;
}

function formatContextPercent(used: number, available: number): string {
  const percent = (used / available) * 100;
  if (percent > 0 && percent < 1) return "<1%";
  return `${Math.round(percent)}%`;
}

export function formatSubagentProgress(items: readonly SubagentProgress[]): string {
  const counts: Record<SubagentStatus, number> = {
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
  };
  for (const item of items) counts[item.status] += 1;

  const finished = counts.completed + counts.failed;
  const summary = [`${finished}/${items.length} finished`];
  if (counts.running) summary.push(`${counts.running} running`);
  if (counts.pending) summary.push(`${counts.pending} queued`);
  if (counts.failed) summary.push(`${counts.failed} failed`);

  const lines = items.map((item, index) => {
    const context = item.contextWindow
      ? `${formatTokens(item.usage.peakContext)}/${formatTokens(item.contextWindow)} ctx (${formatContextPercent(item.usage.peakContext, item.contextWindow)})`
      : `${formatTokens(item.usage.peakContext)} ctx peak`;
    const metadata = [
      STATUS_LABELS[item.status],
      item.model ?? "model pending",
      `${item.thinkingLevel ?? "default"} thinking`,
      context,
    ];
    if (item.usage.turns) metadata.push(`${item.usage.turns} turn${item.usage.turns === 1 ? "" : "s"}`);
    return `${STATUS_MARKERS[item.status]} ${index + 1}. ${item.agent} · ${metadata.join(" · ")}`;
  });

  return [`Subagents: ${summary.join(" · ")}`, ...lines].join("\n");
}
