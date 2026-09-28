export type ExternalActionPolicy =
  | { kind: "allow" }
  | { kind: "block"; reason: string }
  | { kind: "confirm"; operation: string; command: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function knownExternalWrite(command: string): string | undefined {
  const patterns: Array<[RegExp, string]> = [
    [/\bgit\s+push\b/, "git push"],
    [/\bgh\s+pr\s+(create|edit|merge|close)\b/, "GitHub pull-request mutation"],
    [/\bgt\s+(submit|merge|create)\b/, "Graphite mutation"],
    [/\b(terraform|tofu)\s+(apply|destroy)\b/, "infrastructure mutation"],
    [/\bkubectl\s+(apply|delete|rollout)\b/, "Kubernetes mutation"],
    [/\b(vercel|flyctl|railway)\s+(deploy|promote)\b/, "deployment"],
    [/\brm\s+(?:-[A-Za-z]*r[A-Za-z]*|--recursive)\b/, "recursive deletion"],
  ];
  return patterns.find(([pattern]) => pattern.test(command))?.[1];
}

function commandPolicy(command: unknown): ExternalActionPolicy {
  if (typeof command !== "string") return { kind: "block", reason: "The native host command is missing or invalid." };
  const operation = knownExternalWrite(command);
  return operation ? { kind: "confirm", operation, command } : { kind: "allow" };
}

function verifyPolicy(verify: unknown): ExternalActionPolicy {
  if (!Array.isArray(verify)) return { kind: "block", reason: "Native acceptance verification must be an array of command objects." };
  for (const entry of verify) {
    if (!isRecord(entry)) return { kind: "block", reason: "Native acceptance verification has an invalid command entry." };
    const policy = commandPolicy(entry.command);
    if (policy.kind !== "allow") return policy;
  }
  return { kind: "allow" };
}

export function subagentExternalActionPolicy(input: Record<string, unknown>): ExternalActionPolicy {
  const script = input.workflowScript;
  if (typeof script === "string" && /\bruns\.host\s*\(/.test(script)) {
    return { kind: "block", reason: "Raw workflowScript host calls are blocked in Poteto Mode. Use a named workflow for host execution." };
  }

  if (input.workflow === "run-ci") {
    if (!isRecord(input.args)) return { kind: "block", reason: "The run-ci workflow requires a command argument." };
    return commandPolicy(input.args.command);
  }

  if (input.gate !== undefined) {
    const gate = isRecord(input.gate) ? input.gate.command : input.gate;
    const policy = commandPolicy(gate);
    if (policy.kind !== "allow") return policy;
  }

  if (isRecord(input.acceptance) && input.acceptance.verify !== undefined) return verifyPolicy(input.acceptance.verify);
  return { kind: "allow" };
}
