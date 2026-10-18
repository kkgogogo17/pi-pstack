import { execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import type { Message } from "@earendil-works/pi-ai";
import { getAgentDir, SessionManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { bundledAgentsDirectory, discoverAgents, projectAgentsDirectory, type AgentConfig, type AgentScope } from "./agents.ts";
import { ROLE_NAMES, configPath, defaultConfig, modelsForRole, readConfig, writeConfig } from "./config.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const MAX_MODEL_OUTPUT_BYTES = 50 * 1024;
const MODE_ENTRY = "pstack-mode";

const Task = Type.Object({
  agent: Type.String({ description: "Agent name. Use poteto-agent for pstack implementation delegates." }),
  task: Type.String({ description: "Self-contained delegated task. Point to files instead of inlining large payloads." }),
  model: Type.Optional(Type.String({ description: "Pi model selector (provider/model). Overrides the role configuration." })),
  role: Type.Optional(Type.String({ description: "pstack model role configured by /setup-pstack." })),
  cwd: Type.Optional(Type.String({ description: "Working directory for this child Pi process." })),
});

const SubagentParams = Type.Object({
  agent: Type.Optional(Type.String()),
  task: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
  role: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  tasks: Type.Optional(Type.Array(Task)),
  chain: Type.Optional(Type.Array(Task)),
  agentScope: Type.Optional(
    StringEnum(["bundled", "user", "project", "both"] as const, {
      description: "Agent locations. bundled is the safe default. Project agents require explicit opt-in.",
      default: "bundled",
    }),
  ),
  confirmProjectAgents: Type.Optional(Type.Boolean({ default: true })),
});

type TaskInput = {
  agent: string;
  task: string;
  model?: string;
  role?: string;
  cwd?: string;
};

type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
type ChildResult = {
  agent: string;
  source: string;
  task: string;
  model?: string;
  exitCode: number;
  messages: Message[];
  answer?: string;
  stderr: string;
  usage: Usage;
  stopReason?: string;
  errorMessage?: string;
  pane?: PaneDisposition;
};

type PaneDisposition =
  | { kind: "closed"; id: string }
  | { kind: "left-open" | "uncertain"; id: string; reason: string };

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resultText(result: ChildResult): string {
  if (result.answer) {
    const pane = result.pane;
    return pane && pane.kind !== "closed"
      ? `${result.answer}\n\n[Pane ${pane.id}: ${pane.reason}; ${pane.kind}.]`
      : result.answer;
  }
  const final = [...result.messages].reverse().find((message) => message.role === "assistant");
  if (final?.role === "assistant") {
    const text = final.content.find((part) => part.type === "text");
    if (text?.type === "text") {
      const pane = result.pane;
      return pane && pane.kind !== "closed"
        ? `${text.text}\n\n[Pane ${pane.id}: ${pane.reason}; ${pane.kind}.]`
        : text.text;
    }
  }
  return result.errorMessage || result.stderr || "(no output)";
}

function failure(result: ChildResult): boolean {
  return result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted";
}

function truncate(text: string): string {
  if (Buffer.byteLength(text) <= MAX_MODEL_OUTPUT_BYTES) return text;
  let output = text.slice(0, MAX_MODEL_OUTPUT_BYTES);
  while (Buffer.byteLength(output) > MAX_MODEL_OUTPUT_BYTES) output = output.slice(0, -1);
  return `${output}\n\n[Output truncated. Full transcript is retained in the tool details.]`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && fs.existsSync(script) && !script.startsWith("/$bunfs/root/")) {
    return { command: process.execPath, args: [script, ...args] };
  }
  const executable = path.basename(process.execPath).toLowerCase();
  return /^(node|bun)(\.exe)?$/.test(executable)
    ? { command: "pi", args }
    : { command: process.execPath, args };
}

async function temporaryPrompt(agent: AgentConfig): Promise<{ directory: string; file: string }> {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), "pi-pstack-agent-"));
  const file = path.join(directory, `${agent.name.replace(/[^a-z0-9_.-]/gi, "_")}.md`);
  let prompt = agent.systemPrompt.trim();
  if (agent.name === "poteto-agent") {
    prompt += `\n\nBefore any work, use the read tool to load ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")} in full. It is the canonical Pi pstack mode.`;
  }
  await fsp.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
  return { directory, file };
}

function recordAssistantUsage(result: ChildResult, message: Extract<Message, { role: "assistant" }>): void {
  result.usage.turns += 1;
  const usage = message.usage;
  if (usage) {
    result.usage.input += usage.input ?? 0;
    result.usage.output += usage.output ?? 0;
    result.usage.cacheRead += usage.cacheRead ?? 0;
    result.usage.cacheWrite += usage.cacheWrite ?? 0;
    result.usage.cost += usage.cost?.total ?? 0;
  }
  result.stopReason = message.stopReason;
  result.errorMessage = message.errorMessage;
  if (!result.model && message.model) result.model = message.model;
}

function recordChildEvent(result: ChildResult, event: { type?: string; message?: Message }, update: () => void): void {
  if (event.type !== "message_end" && event.type !== "tool_result_end") return;
  if (!event.message) return;
  result.messages.push(event.message);
  if (event.message.role === "assistant") recordAssistantUsage(result, event.message);
  update();
}

async function runChild(
  parentCwd: string,
  task: TaskInput,
  agents: AgentConfig[],
  model: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: ((result: ChildResult) => void) | undefined,
): Promise<ChildResult> {
  const agent = agents.find((candidate) => candidate.name === task.agent);
  if (!agent) {
    return {
      agent: task.agent,
      source: "unknown",
      task: task.task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent ${JSON.stringify(task.agent)}. Available agents: ${agents.map((item) => item.name).join(", ") || "none"}.`,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
    };
  }

  const result: ChildResult = {
    agent: agent.name,
    source: agent.source,
    task: task.task,
    model,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };

  if (process.env.HERDR_ENV === "1") {
    return await runChildVisible(agent, task, model, parentCwd, signal);
  }

  const temp = await temporaryPrompt(agent);
  try {
    const args = ["--mode", "json", "--print", "--no-session", "--append-system-prompt", temp.file];
    if (model) args.push("--model", model);
    if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
    args.push(`Delegated task:\n${task.task}`);

    await new Promise<void>((resolve) => {
      const invocation = piInvocation(args);
      const process = spawn(invocation.command, invocation.args, {
        cwd: task.cwd ?? parentCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";
      let aborted = false;
      const update = () => onUpdate?.(result);
      const parse = (line: string) => {
        if (!line.trim()) return;
        try {
          recordChildEvent(result, JSON.parse(line) as { type?: string; message?: Message }, update);
        } catch {
          // JSON mode can include diagnostics from third-party extensions. Ignore non-events.
        }
      };
      process.stdout.on("data", (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(parse);
      });
      process.stderr.on("data", (chunk) => {
        result.stderr += chunk.toString();
      });
      process.on("error", (error) => {
        result.exitCode = 1;
        result.stderr += error.message;
      });
      process.on("close", (code) => {
        if (buffer.trim()) parse(buffer);
        result.exitCode = code ?? 1;
        if (aborted) result.stopReason = "aborted";
        resolve();
      });
      const kill = () => {
        aborted = true;
        process.kill("SIGTERM");
        setTimeout(() => process.kill("SIGKILL"), 5_000).unref();
      };
      if (signal?.aborted) kill();
      else signal?.addEventListener("abort", kill, { once: true });
    });
  } finally {
    await fsp.rm(temp.directory, { recursive: true, force: true });
  }
  return result;
}

function runHerdrCmd(args: string[], timeoutMs = 30000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("herdr", args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
      const code = e && typeof e.code === "number" ? e.code : e ? 1 : 0;
      resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

function parseJson<T>(r: { stdout: string }): T | undefined {
  try {
    return JSON.parse(r.stdout) as T;
  } catch {
    return undefined;
  }
}

function uniqueSubName(): string {
  return `psub-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function completedAssistantContent(entry: unknown): unknown[] | undefined {
  if (!isRecord(entry) || entry.type !== "message") return undefined;
  const message = entry.message;
  if (!isRecord(message) || message.role !== "assistant" || message.stopReason !== "stop" ||
    !Array.isArray(message.content)) return undefined;
  return message.content;
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return isRecord(value) && value.type === "text" && typeof value.text === "string";
}

function assistantTextFromLine(line: string): string | undefined {
  if (!line.trim()) return undefined;
  try {
    const text = completedAssistantContent(JSON.parse(line))?.filter(isTextPart)
      .map((part) => part.text).join("\n").trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

function finalTextFromSession(sessionPath: string, offset: number): string | undefined {
  try {
    const data = fs.readFileSync(sessionPath);
    if (data.length < offset) return undefined;
    const appended = data.subarray(offset).toString("utf8");
    const lines = appended.split("\n");
    if (lines.at(-1)) lines.pop();
    let last: string | undefined;
    for (const line of lines) last = assistantTextFromLine(line) || last;
    return last;
  } catch {
    return undefined;
  }
}

function childError(agent: AgentConfig, task: TaskInput, model: string | undefined, stderr: string): ChildResult {
  return {
    agent: agent.name,
    source: agent.source,
    task: task.task,
    model,
    exitCode: 1,
    messages: [],
    stderr,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  };
}

function childSuccess(agent: AgentConfig, task: TaskInput, model: string | undefined, answer: string): ChildResult {
  return {
    agent: agent.name,
    source: agent.source,
    task: task.task,
    model,
    exitCode: 0,
    messages: [],
    answer,
    stderr: "",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 },
    stopReason: "stop",
  };
}

type ChildIdentity = { paneId: string; terminalId: string; status: string; sequence: number };

function parseChildIdentity(agent: {
  pane_id?: unknown; terminal_id?: unknown; agent_status?: unknown; state_change_seq?: unknown;
} | undefined): ChildIdentity | undefined {
  if (typeof agent?.pane_id !== "string") return undefined;
  if (typeof agent.terminal_id !== "string") return undefined;
  if (typeof agent.agent_status !== "string") return undefined;
  if (typeof agent.state_change_seq !== "number") return undefined;
  return { paneId: agent.pane_id, terminalId: agent.terminal_id,
    status: agent.agent_status, sequence: agent.state_change_seq };
}

async function childIdentity(name: string): Promise<ChildIdentity | undefined> {
  const response = await runHerdrCmd(["agent", "get", name]);
  if (response.code !== 0) return undefined;
  const agent = parseJson<{ result?: { agent?: {
    pane_id?: unknown; terminal_id?: unknown; agent_status?: unknown; state_change_seq?: unknown;
  } } }>(response)?.result?.agent;
  return parseChildIdentity(agent);
}

function settledChild(current: ChildIdentity | undefined, original: ChildIdentity): boolean {
  return current?.paneId === original.paneId && current.terminalId === original.terminalId
    && (current.status === "idle" || current.status === "done") && current.sequence > original.sequence;
}

function openChildError(agent: AgentConfig, task: TaskInput, model: string | undefined, paneId: string, reason: string): ChildResult {
  return { ...childError(agent, task, model, `Pane ${paneId} left open: ${reason}`),
    pane: { kind: "left-open", id: paneId, reason } };
}

async function onlyPiForeground(id: string): Promise<boolean> {
  const response = await runHerdrCmd(["pane", "process-info", "--pane", id]);
  if (response.code !== 0) return false;
  const processes = parseJson<{ result?: { process_info?: { foreground_processes?: Array<{ name?: string }> } } }>(response)
    ?.result?.process_info?.foreground_processes;
  return Array.isArray(processes) && processes.length === 1 && processes[0]?.name === "pi";
}

async function closePane(id: string): Promise<PaneDisposition> {
  const closed = await runHerdrCmd(["pane", "close", id]);
  const response = parseJson<{ result?: unknown; error?: unknown }>(closed);
  return closed.code === 0 && response?.result !== undefined && response.error === undefined
    ? { kind: "closed", id }
    : { kind: "uncertain", id, reason: "pane close was not confirmed" };
}

async function closeCompletedChild(name: string, original: ChildIdentity): Promise<PaneDisposition> {
  const id = original.paneId;
  if (!settledChild(await childIdentity(name), original)) {
    return { kind: "left-open", id, reason: "child identity or settled turn changed" };
  }
  if (!await onlyPiForeground(id)) return { kind: "left-open", id, reason: "foreground process is not only Pi" };
  if (!settledChild(await childIdentity(name), original)) {
    return { kind: "left-open", id, reason: "child identity or settled turn changed" };
  }
  return closePane(id);
}

async function verifiedParentPaneId(): Promise<string | undefined> {
  const inheritedId = process.env.HERDR_PANE_ID;
  if (!inheritedId) return undefined;
  const response = await runHerdrCmd(["pane", "current", "--current"]);
  if (response.code !== 0) return undefined;
  const observed = parseJson<{ result?: { pane?: { pane_id?: unknown } } }>(response)?.result?.pane?.pane_id;
  return observed === inheritedId ? inheritedId : undefined;
}

async function createVisiblePane(cwd: string): Promise<string | undefined> {
  const response = await runHerdrCmd(["pane", "split", "--current", "--direction", "right", "--cwd", cwd, "--no-focus"]);
  if (response.code !== 0) return undefined;
  const id = parseJson<{ result?: { pane?: { pane_id?: unknown } } }>(response)?.result?.pane?.pane_id;
  return typeof id === "string" ? id : undefined;
}

async function startVisibleAgent(name: string, paneId: string, agent: AgentConfig, model: string | undefined): Promise<
  { kind: "started"; sessionPath: string; directory: string } | { kind: "failed" }
> {
  const temp = await temporaryPrompt(agent);
  const sessionPath = path.join(temp.directory, "session.jsonl");
  const piArgs = ["--no-extensions", "--extension", path.join(packageRoot(), "extensions/pstack/index.ts"),
    "--skill", path.join(packageRoot(), "skills"), "--append-system-prompt", temp.file, "--session", sessionPath];
  if (model) piArgs.push("--model", model);
  if (agent.tools?.length) piArgs.push("--tools", agent.tools.join(","));
  const response = await runHerdrCmd(["agent", "start", name, "--kind", "pi", "--pane", paneId, "--", ...piArgs], 60000);
  const started = parseJson<{ result?: { agent?: { agent_status?: string } } }>(response)?.result?.agent;
  return response.code === 0 && started?.agent_status
    ? { kind: "started", sessionPath, directory: temp.directory }
    : { kind: "failed" };
}

function visiblePrompt(agent: AgentConfig, task: TaskInput, parentPaneId: string): string {
  const parts = [`[Subagent: ${agent.name}]`];
  parts.push(`Parent Herdr pane ID: ${parentPaneId}. This identifies the pane that delegated your task. Include it in a requested handoff, but do not interrupt or close that pane.`,
    `Delegated task:\n${task.task}`);
  return parts.join("\n\n");
}

function sessionOffset(sessionPath: string): number {
  try {
    return fs.statSync(sessionPath).size;
  } catch {
    return 0;
  }
}

async function initialVisibleIdentity(name: string, paneId: string): Promise<ChildIdentity | undefined> {
  const identity = await childIdentity(name);
  if (identity?.paneId !== paneId) return undefined;
  return identity.status === "idle" || identity.status === "done" ? identity : undefined;
}

type VisibleChild = {
  agent: AgentConfig;
  task: TaskInput;
  model: string | undefined;
  name: string;
  paneId: string;
  parentPaneId: string;
  original: ChildIdentity;
  started: { sessionPath: string; directory: string };
  signal: AbortSignal | undefined;
};

async function finishVisibleChild({ agent, task, model, name, paneId, parentPaneId, original, started, signal }: VisibleChild): Promise<ChildResult> {
  const offset = sessionOffset(started.sessionPath);
  const promptR = await runHerdrCmd(["agent", "prompt", name, visiblePrompt(agent, task, parentPaneId), "--wait", "--timeout", "600000"], 615000);
  if (signal?.aborted) return openChildError(agent, task, model, paneId, "delegation was aborted; submission outcome unknown");
  if (promptR.code !== 0) {
    return openChildError(agent, task, model, paneId, `prompt outcome uncertain: ${promptR.stderr || promptR.stdout}`);
  }
  if (!settledChild(await childIdentity(name), original)) {
    return openChildError(agent, task, model, paneId, "child identity or new settled turn not verified");
  }
  const answer = finalTextFromSession(started.sessionPath, offset);
  if (!answer) return openChildError(agent, task, model, paneId, "no completed result was captured");
  const pane = await closeCompletedChild(name, original);
  if (pane.kind === "closed") await fsp.rm(started.directory, { recursive: true, force: true });
  return { ...childSuccess(agent, task, model, answer), pane };
}

export async function runChildVisible(
  agent: AgentConfig,
  task: TaskInput,
  model: string | undefined,
  parentCwd: string,
  signal: AbortSignal | undefined,
): Promise<ChildResult> {
  if (signal?.aborted) {
    return { ...childError(agent, task, model, "aborted"), stopReason: "aborted" };
  }
  const parentPaneId = await verifiedParentPaneId();
  if (!parentPaneId) return childError(agent, task, model, "Herdr parent pane identity could not be verified");
  const name = uniqueSubName();
  const paneId = await createVisiblePane(task.cwd ?? parentCwd);
  if (!paneId) return childError(agent, task, model, "herdr pane split did not return a pane ID");
  const started = await startVisibleAgent(name, paneId, agent, model);
  if (started.kind === "failed") return openChildError(agent, task, model, paneId, "agent did not start in this pane");
  const original = await initialVisibleIdentity(name, paneId);
  if (!original) return openChildError(agent, task, model, paneId, "agent identity or readiness could not be verified");
  if (signal?.aborted) return openChildError(agent, task, model, paneId, "delegation was aborted before prompt");
  return finishVisibleChild({ agent, task, model, name, paneId, parentPaneId, original, started, signal });
}

async function runLimited<T>(items: T[], callback: (item: T, index: number) => Promise<ChildResult>): Promise<ChildResult[]> {
  const results = new Array<ChildResult>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await callback(items[index], index);
      }
    }),
  );
  return results;
}

function knownExternalWrite(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/, "git push"],
    [/\bgh\s+pr\s+(create|edit|merge|close)\b/, "GitHub pull-request mutation"],
    [/\bgt\s+(submit|merge|create)\b/, "Graphite mutation"],
    [/\b(terraform|tofu)\s+(apply|destroy)\b/, "infrastructure mutation"],
    [/\bkubectl\s+(apply|delete|rollout)\b/, "Kubernetes mutation"],
    [/\b(vercel|flyctl|railway)\s+(deploy|promote)\b/, "deployment"],
    [/\brm\s+(-[A-Za-z]*r|--recursive)/, "recursive deletion"],
  ];
  return patterns.find(([pattern]) => pattern.test(command))?.[1];
}

type StartChild = (task: TaskInput, index?: number, update?: (result: ChildResult) => void) => Promise<ChildResult>;
type ChildUpdate = (results: ChildResult[]) => void;
type SubagentToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: { mode: "single" | "parallel" | "chain"; results: ChildResult[] };
};

async function executeChain(tasks: TaskInput[], start: StartChild, makeUpdate: ChildUpdate): Promise<SubagentToolResult> {
  const results: ChildResult[] = [];
  let previous = "";
  for (const [index, task] of tasks.entries()) {
    const result = await start({ ...task, task: task.task.replaceAll("{previous}", previous) }, index,
      (current) => makeUpdate([...results, current]));
    results.push(result);
    if (failure(result)) throw new Error(`Chain step ${index + 1} (${result.agent}) failed: ${resultText(result)}`);
    previous = resultText(result);
  }
  return { content: [{ type: "text", text: previous }], details: { mode: "chain", results } };
}

async function executeParallel(tasks: TaskInput[], start: StartChild, makeUpdate: ChildUpdate): Promise<SubagentToolResult> {
  if (tasks.length > MAX_PARALLEL_TASKS) throw new Error(`At most ${MAX_PARALLEL_TASKS} parallel tasks are allowed.`);
  const updates: ChildResult[] = tasks.map((task) => ({ agent: task.agent, source: "pending", task: task.task,
    exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }));
  const results = await runLimited(tasks, async (task, index) => {
    const result = await start(task, index, (current) => { updates[index] = current; makeUpdate(updates); });
    updates[index] = result;
    makeUpdate(updates);
    return result;
  });
  const report = results.map((result) => `### ${result.agent} ${failure(result) ? "failed" : "completed"}\n\n${truncate(resultText(result))}`).join("\n\n---\n\n");
  return { content: [{ type: "text", text: report }], details: { mode: "parallel", results } };
}

async function executeSingle(task: TaskInput, start: StartChild, makeUpdate: ChildUpdate): Promise<SubagentToolResult> {
  const result = await start(task, 0, (current) => makeUpdate([current]));
  if (failure(result)) throw new Error(`${result.agent} failed: ${resultText(result)}`);
  return { content: [{ type: "text", text: resultText(result) }], details: { mode: "single", results: [result] } };
}

async function confirmProjectAgents(
  scope: AgentScope, requested: TaskInput[], agents: AgentConfig[], cwd: string,
  confirm: (title: string, message: string) => Promise<boolean>,
): Promise<void> {
  if (scope !== "project" && scope !== "both") return;
  const names = requested.map((task) => task.agent);
  const project = agents.filter((agent) => agent.source === "project" && names.includes(agent.name));
  if (!project.length) return;
  const approved = await confirm("Run project-local Pi agents?",
    `Agents: ${project.map((agent) => agent.name).join(", ")}\nSource: ${projectAgentsDirectory(cwd)}`);
  if (!approved) throw new Error("Project-local agents were not approved.");
}

function childModelForTask(task: TaskInput, index: number, config: Awaited<ReturnType<typeof readConfig>>, fallback?: string): string | undefined {
  const pool = modelsForRole(config, task.role);
  return task.model ?? pool[index % Math.max(pool.length, 1)] ?? fallback;
}

type DelegationMode =
  | { kind: "single"; task: TaskInput }
  | { kind: "parallel"; tasks: TaskInput[] }
  | { kind: "chain"; tasks: TaskInput[] };

function delegationMode(params: Partial<TaskInput> & { tasks?: TaskInput[]; chain?: TaskInput[] }): DelegationMode {
  const single = params.agent && params.task ? { agent: params.agent, task: params.task,
    model: params.model, role: params.role, cwd: params.cwd } : undefined;
  const count = Number(Boolean(single)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
  if (count !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, or chain.");
  if (params.chain?.length) return { kind: "chain", tasks: params.chain };
  if (params.tasks?.length) return { kind: "parallel", tasks: params.tasks };
  if (!single) throw new Error("Missing single subagent task.");
  return { kind: "single", task: single };
}

export default function (pi: ExtensionAPI) {
  let potetoMode = false;
  let todos: string[] = [];

  pi.on("session_start", (_event, ctx) => {
    potetoMode = false;
    todos = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === MODE_ENTRY) potetoMode = Boolean((entry.data as { enabled?: boolean }).enabled);
      if (entry.type === "custom" && entry.customType === "pstack-todo") {
        const items = (entry.data as { items?: unknown }).items;
        if (Array.isArray(items) && items.every((item) => typeof item === "string")) todos = items;
      }
    }
    if (ctx.mode === "tui") ctx.ui.setStatus("pstack-mode", potetoMode ? "pstack: poteto mode" : undefined);
  });

  pi.on("input", (event) => {
    if (/^\/skill:poteto-mode(?:\s|$)/.test(event.text)) {
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
    }
    return { action: "continue" } as const;
  });

  pi.on("before_agent_start", (event) => {
    if (!potetoMode) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nPstack Poteto Mode is enabled for this session. Follow its persisted workflow: use pstack_todo for non-trivial work, select and read the matching playbook, delegate through the subagent tool when delegation helps, verify real behavior, and name only principles that changed a decision. The full skill is at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")}.`,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return;
    const input = event.input as { command?: string };
    const operation = input.command ? knownExternalWrite(input.command) : undefined;
    if (!operation) return;
    if (!ctx.hasUI) return { block: true, reason: `${operation} requires explicit user confirmation; non-interactive Pi cannot request it.` };
    const approved = await ctx.ui.confirm("Confirm external or irreversible action", `Allow ${operation}?\n\n${input.command}`);
    if (!approved) return { block: true, reason: `User declined ${operation}.` };
  });

  pi.registerCommand("poteto-mode", {
    description: "Enable or disable sticky pstack Poteto Mode for this Pi session. Usage: /poteto-mode [task] | /poteto-mode off",
    handler: async (args, ctx) => {
      if (/^(off|disable|stop)$/i.test(args.trim())) {
        potetoMode = false;
        pi.appendEntry(MODE_ENTRY, { enabled: false });
        ctx.ui.setStatus("pstack-mode", undefined);
        ctx.ui.notify("Poteto Mode disabled for this session.", "info");
        return;
      }
      potetoMode = true;
      pi.appendEntry(MODE_ENTRY, { enabled: true });
      ctx.ui.setStatus("pstack-mode", "pstack: poteto mode");
      pi.sendUserMessage(`/skill:poteto-mode${args.trim() ? ` ${args.trim()}` : ""}`,
        { deliverAs: ctx.isIdle() ? undefined : "followUp", expandPromptTemplates: true });
    },
  });

  pi.registerCommand("setup-pstack", {
    description: "Interactively map pstack delegation roles to models available in Pi.",
    handler: async (_args, ctx) => {
      const config = await readConfig();
      const available = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
        .map((model) => `${model.provider}/${model.id}`);
      const choices = ["inherit-parent", ...new Set(available)];
      if (!ctx.hasUI) {
        await writeConfig(defaultConfig());
        return;
      }
      for (const role of ROLE_NAMES) {
        const current = config.roles[role];
        const selected = await ctx.ui.select(`Model for ${role}`, choices.map((model) => model === current ? `${model} (current)` : model));
        if (!selected) break;
        config.roles[role] = selected.replace(/ \(current\)$/, "");
      }
      await writeConfig(config);
      ctx.ui.notify(`Saved pstack model settings to ${configPath()}.`, "info");
    },
  });

  pi.registerTool({
    name: "pstack_todo",
    label: "Pstack Todo",
    description: "Maintain pstack's current task checklist. Use at the start of non-trivial multi-step work, then update it as work advances.",
    parameters: Type.Object({
      action: StringEnum(["get", "set", "add", "complete"] as const),
      items: Type.Optional(Type.Array(Type.String())),
      item: Type.Optional(Type.String()),
    }),
    async execute(_id, params) {
      if (params.action === "set") todos = params.items ?? [];
      if (params.action === "add" && params.item) todos = [...todos, params.item];
      if (params.action === "complete" && params.item) todos = todos.map((item) => item === params.item ? `[done] ${item}` : item);
      pi.appendEntry("pstack-todo", { items: todos });
      return { content: [{ type: "text", text: todos.length ? todos.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No pstack todo items." }], details: { items: todos } };
    },
  });

  pi.registerTool({
    name: "pstack_sessions",
    label: "Pstack Sessions",
    description: "List Pi session files for the current working directory. Use before reading prior Pi transcripts; never glob other project session directories.",
    parameters: Type.Object({ action: StringEnum(["list"] as const) }),
    async execute(_id, _params, _signal, _update, ctx) {
      const sessions = await SessionManager.list(ctx.cwd);
      const files = sessions.map((session) => session.path);
      return { content: [{ type: "text", text: files.join("\n") || "No saved sessions for this working directory." }], details: { files } };
    },
  });

  pi.registerTool({
    name: "pstack_config",
    label: "Pstack Config",
    description: "Read or update pstack's role-to-model configuration. Use list-models before setting a model. inherit-parent makes a subagent use the parent session model.",
    parameters: Type.Object({
      action: StringEnum(["get", "list-models", "set"] as const),
      role: Type.Optional(Type.String()),
      model: Type.Optional(Type.String()),
      models: Type.Optional(Type.Array(Type.String(), { description: "Optional ordered model pool for a parallel review role." })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (params.action === "list-models") {
        const models = (ctx.scopedModels.length ? ctx.scopedModels.map((entry) => entry.model) : ctx.modelRegistry.getAvailable())
          .map((model) => `${model.provider}/${model.id}`);
        return { content: [{ type: "text", text: ["inherit-parent", ...models].join("\n") }], details: { models } };
      }
      const config = await readConfig();
      if (params.action === "set") {
        if (!params.role || (!params.model && !params.models?.length)) throw new Error("pstack_config set requires role plus model or models.");
        config.roles[params.role] = params.models?.length ? params.models : params.model!;
        await writeConfig(config);
      }
      return { content: [{ type: "text", text: JSON.stringify(config, null, 2) }], details: config };
    },
  });

  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    description: `Delegate isolated work to Pi subagents. Supports exactly one of single agent/task, parallel tasks (maximum ${MAX_PARALLEL_TASKS}), or sequential chain. Bundled pstack agents live in ${bundledAgentsDirectory()}.`,
    parameters: SubagentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const scope = (params.agentScope ?? "bundled") as AgentScope;
      const agents = discoverAgents(ctx.cwd, scope);
      const mode = delegationMode(params);
      if (params.confirmProjectAgents !== false && ctx.hasUI) {
        await confirmProjectAgents(scope, mode.kind === "single" ? [mode.task] : mode.tasks,
          agents, ctx.cwd, (title, message) => ctx.ui.confirm(title, message));
      }
      const config = await readConfig();
      const fallback = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
      const childModel = (task: TaskInput, index = 0) => childModelForTask(task, index, config, fallback);
      const makeUpdate = (results: ChildResult[]) => onUpdate?.({
        content: [{ type: "text", text: results.map((result) => `${result.agent}: ${resultText(result)}`).join("\n\n") }],
        details: { results },
      });
      const start = (task: TaskInput, index = 0, update?: (result: ChildResult) => void) => runChild(ctx.cwd, task, agents, childModel(task, index), signal, update);

      if (mode.kind === "chain") return executeChain(mode.tasks, start, makeUpdate);
      if (mode.kind === "parallel") return executeParallel(mode.tasks, start, makeUpdate);
      return executeSingle(mode.task, start, makeUpdate);
    },
  });
}
