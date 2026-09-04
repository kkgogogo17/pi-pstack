import { spawn } from "node:child_process";
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

// ponytail-style opt-in flag: ~/.<agent dir>/.pstack-active. Existence means
// the extension auto-enables poteto mode on every session_start until /pstack
// off removes the file.
function pstackFlagPath(): string {
  return path.join(getAgentDir(), ".pstack-active");
}

function readPstackFlag(): boolean {
  return fs.existsSync(pstackFlagPath());
}

function writePstackFlag(): void {
  fs.writeFileSync(pstackFlagPath(), "poteto", { encoding: "utf8", mode: 0o600 });
}

function clearPstackFlag(): void {
  try {
    fs.unlinkSync(pstackFlagPath());
  } catch {
    // ponytail: best-effort, missing file is the desired end state.
  }
}

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
  stderr: string;
  usage: Usage;
  stopReason?: string;
  errorMessage?: string;
};

function packageRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

function resultText(result: ChildResult): string {
  const final = [...result.messages].reverse().find((message) => message.role === "assistant");
  if (final?.role === "assistant") {
    const text = final.content.find((part) => part.type === "text");
    if (text?.type === "text") return text.text;
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
          const event = JSON.parse(line) as { type?: string; message?: Message };
          if ((event.type === "message_end" || event.type === "tool_result_end") && event.message) {
            result.messages.push(event.message);
            if (event.message.role === "assistant") {
              result.usage.turns += 1;
              const usage = event.message.usage;
              if (usage) {
                result.usage.input += usage.input ?? 0;
                result.usage.output += usage.output ?? 0;
                result.usage.cacheRead += usage.cacheRead ?? 0;
                result.usage.cacheWrite += usage.cacheWrite ?? 0;
                result.usage.cost += usage.cost?.total ?? 0;
              }
              result.stopReason = event.message.stopReason;
              result.errorMessage = event.message.errorMessage;
              if (!result.model && event.message.model) result.model = event.message.model;
            }
            update();
          }
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

export default function (pi: ExtensionAPI) {
  let potetoMode = false;
  let todos: string[] = [];
  let potetoHintShown = false;
  // Delegation tool name: "subagent" when that name is free; "pstack_subagent"
  // when another extension already provides `subagent`. Set by session_start,
  // read by the before_agent_start patch so Poteto Mode always names the
  // tool that is actually registered in this session.
  let delegationTool = "subagent";

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
    // The flag is the persistent opt-in and wins over the branch (read after
    // the walk so a stale MODE_ENTRY cannot clobber it): /pstack on survives
    // restarts, /poteto-mode off stays session-only.
    if (readPstackFlag()) potetoMode = true;
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
      systemPrompt: `${event.systemPrompt}\n\nPstack Poteto Mode is enabled for this session. Follow its persisted workflow: use pstack_todo for non-trivial work, select and read the matching playbook, delegate through the ${delegationTool} tool when delegation helps${delegationTool === "pstack_subagent" ? " (the plain subagent tool belongs to another extension)" : ""}, verify real behavior, and name only principles that changed a decision. The full skill is at ${path.join(packageRoot(), "skills/poteto-mode/SKILL.md")}.`,
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
      // One hint per session: if the persistent flag is not set, tell the user
      // how to opt in so they stop toggling /poteto-mode each new session.
      if (!readPstackFlag() && !potetoHintShown) {
        potetoHintShown = true;
        ctx.ui.notify("Tip: /pstack on makes this stick across Pi sessions.", "info");
      }
      await ctx.sendUserMessage(`/skill:poteto-mode${args.trim() ? ` ${args.trim()}` : ""}`);
    },
  });

  pi.registerCommand("pstack", {
    description: "Toggle persistent pstack mode (opt-in). Default off. Usage: /pstack on|off|status",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      if (/^(on|enable)$/.test(arg)) {
        writePstackFlag();
        potetoMode = true;
        pi.appendEntry(MODE_ENTRY, { enabled: true });
        ctx.ui.setStatus("pstack-mode", "pstack: poteto mode");
        ctx.ui.notify("pstack mode enabled.", "info");
        return;
      }
      if (/^(off|disable)$/.test(arg)) {
        clearPstackFlag();
        potetoMode = false;
        pi.appendEntry(MODE_ENTRY, { enabled: false });
        ctx.ui.setStatus("pstack-mode", undefined);
        ctx.ui.notify("pstack mode disabled.", "info");
        return;
      }
      ctx.ui.notify(`pstack: flag=${readPstackFlag() ? "on" : "off"} session=${potetoMode ? "on" : "off"}`, "info");
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
      const files = sessions.map((session) => session.file);
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

  // Registered lazily in session_start, not at load: pi flags tools with the
  // same name across extensions as a fatal load error, and the user may
  // already run pi-cohort, pi-subagents, @tintinweb/pi-subagents, etc. When
  // the `subagent` name is taken we register ours as `pstack_subagent` so
  // pstack keeps its full semantics (bundled poteto-agent, role→model
  // routing, chain templating) everywhere; registration happens after pi's
  // conflict scan, so the two tools coexist in any load order.
  const registerSubagentTool = (name: string) => pi.registerTool({
    name,
    label: "Subagent",
    description: `Delegate isolated work to Pi subagents. Supports exactly one of single agent/task, parallel tasks (maximum ${MAX_PARALLEL_TASKS}), or sequential chain. Bundled pstack agents live in ${bundledAgentsDirectory()}.`,
    promptGuidelines: [`Use ${name} for pstack Poteto Mode playbook delegation (bundled poteto-agent, role-based model selection).`],
    parameters: SubagentParams,
    async execute(_id, params, signal, onUpdate, ctx) {
      const scope = (params.agentScope ?? "bundled") as AgentScope;
      const agents = discoverAgents(ctx.cwd, scope);
      const requested = params.agent ? [{ agent: params.agent, task: params.task ?? "", model: params.model, role: params.role, cwd: params.cwd }] : undefined;
      const modes = Number(Boolean(requested && params.task)) + Number(Boolean(params.tasks?.length)) + Number(Boolean(params.chain?.length));
      if (modes !== 1) throw new Error("Provide exactly one mode: agent + task, tasks, or chain.");
      if ((scope === "project" || scope === "both") && params.confirmProjectAgents !== false && ctx.hasUI) {
        const names = [...(requested ?? []), ...(params.tasks ?? []), ...(params.chain ?? [])].map((task) => task.agent);
        const project = agents.filter((agent) => agent.source === "project" && names.includes(agent.name));
        if (project.length) {
          const approved = await ctx.ui.confirm("Run project-local Pi agents?", `Agents: ${project.map((agent) => agent.name).join(", ")}\nSource: ${projectAgentsDirectory(ctx.cwd)}`);
          if (!approved) throw new Error("Project-local agents were not approved.");
        }
      }
      const config = await readConfig();
      const childModel = (task: TaskInput, index = 0) => task.model ?? modelsForRole(config, task.role)[index % Math.max(modelsForRole(config, task.role).length, 1)] ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const makeUpdate = (results: ChildResult[]) => onUpdate?.({
        content: [{ type: "text", text: results.map((result) => `${result.agent}: ${resultText(result)}`).join("\n\n") }],
        details: { results },
      });
      const start = (task: TaskInput, index = 0, update?: (result: ChildResult) => void) => runChild(ctx.cwd, task, agents, childModel(task, index), signal, update);

      if (params.chain?.length) {
        const results: ChildResult[] = [];
        let previous = "";
        for (const [index, task] of params.chain.entries()) {
          const result = await start({ ...task, task: task.task.replaceAll("{previous}", previous) }, index, (current) => makeUpdate([...results, current]));
          results.push(result);
          if (failure(result)) throw new Error(`Chain step ${index + 1} (${result.agent}) failed: ${resultText(result)}`);
          previous = resultText(result);
        }
        return { content: [{ type: "text", text: resultText(results.at(-1)!) }], details: { mode: "chain", results } };
      }

      if (params.tasks?.length) {
        if (params.tasks.length > MAX_PARALLEL_TASKS) throw new Error(`At most ${MAX_PARALLEL_TASKS} parallel tasks are allowed.`);
        const updates: ChildResult[] = params.tasks.map((task) => ({ agent: task.agent, source: "pending", task: task.task, exitCode: -1, messages: [], stderr: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } }));
        const results = await runLimited(params.tasks, async (task, index) => {
          const result = await start(task, index, (current) => { updates[index] = current; makeUpdate(updates); });
          updates[index] = result;
          makeUpdate(updates);
          return result;
        });
        const report = results.map((result) => `### ${result.agent} ${failure(result) ? "failed" : "completed"}\n\n${truncate(resultText(result))}`).join("\n\n---\n\n");
        return { content: [{ type: "text", text: report }], details: { mode: "parallel", results } };
      }

      const task = requested![0];
      const result = await start(task, 0, (current) => makeUpdate([current]));
      if (failure(result)) throw new Error(`${result.agent} failed: ${resultText(result)}`);
      return { content: [{ type: "text", text: resultText(result) }], details: { mode: "single", results: [result] } };
    },
  });

  pi.on("session_start", (_event, ctx) => {
    if (pi.getAllTools().some((tool) => tool.name === "subagent")) {
      delegationTool = "pstack_subagent";
      registerSubagentTool(delegationTool);
      if (ctx.mode === "tui") ctx.ui.notify("pstack: another extension provides the subagent tool; pstack delegation registered as pstack_subagent.", "info");
      return;
    }
    delegationTool = "subagent";
    registerSubagentTool(delegationTool);
  });
}
