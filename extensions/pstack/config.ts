import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const ROLE_NAMES = [
  "feature, refactoring",
  "bug-fix",
  "perf-issue",
  "hillclimb",
  "judgment and prose",
  "hardest tasks",
  "how explorer",
  "how explainer",
  "how critics",
  "why investigators",
  "why synthesizer",
  "reflect tooling",
  "reflect judgment, divergent, synthesizer",
  "arena runners",
  "arena cross-judge pool",
  "swarm workers",
  "architect runners",
  "interrogate reviewers",
] as const;

export type RoleName = (typeof ROLE_NAMES)[number];
export type ProviderModelId = string;
export type RoleValue = ProviderModelId | ProviderModelId[];
export type RoleSelection = Readonly<{
  role: RoleName;
  slot: number;
  model: ProviderModelId;
}>;

export interface PstackConfig {
  version: 1;
  roles: Record<string, RoleValue>;
}

export function configPath(): string {
  return path.join(getAgentDir(), "pstack", "models.json");
}

export function defaultConfig(): PstackConfig {
  return {
    version: 1,
    roles: Object.fromEntries(ROLE_NAMES.map((role) => [role, "inherit-parent"])),
  };
}

export async function readConfig(): Promise<PstackConfig> {
  try {
    const parsed = JSON.parse(await fs.readFile(configPath(), "utf8")) as Partial<PstackConfig>;
    if (parsed.version !== 1 || !parsed.roles || typeof parsed.roles !== "object") return defaultConfig();
    const roles: Record<string, RoleValue> = { ...defaultConfig().roles };
    for (const [role, value] of Object.entries(parsed.roles)) {
      if (typeof value === "string" || (Array.isArray(value) && value.every((item) => typeof item === "string"))) {
        roles[role] = value;
      }
    }
    return { version: 1, roles };
  } catch {
    return defaultConfig();
  }
}

export async function writeConfig(config: PstackConfig): Promise<void> {
  const target = configPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export function isRoleName(role: string): role is RoleName {
  return ROLE_NAMES.some((name) => name === role);
}

export function resolveRoleSelection(
  config: PstackConfig,
  role: RoleName,
  slot: number,
  parentModel: ProviderModelId | undefined,
  availableModels: readonly ProviderModelId[],
): RoleSelection {
  if (!Number.isInteger(slot) || slot < 0) throw new Error("pstack_config resolve requires a nonnegative integer slot.");
  const value = config.roles[role];
  const pool = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const configuredModel = pool.length ? pool[slot % pool.length] : undefined;
  if (!configuredModel) throw new Error(`No model is configured for pstack role ${JSON.stringify(role)}.`);
  if (configuredModel === "inherit-parent") {
    if (!parentModel) throw new Error("Cannot resolve inherit-parent because the parent session has no selected model.");
    return { role, slot, model: parentModel };
  }
  const matches = availableModels.filter((model) => model === configuredModel);
  if (matches.length === 0) throw new Error(`Configured model ${JSON.stringify(configuredModel)} is unavailable. Use pstack_config list-models to choose an available model.`);
  if (matches.length > 1) throw new Error(`Configured model ${JSON.stringify(configuredModel)} is ambiguous in the current Pi model registry.`);
  return { role, slot, model: configuredModel };
}
