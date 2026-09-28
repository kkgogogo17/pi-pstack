export type RoleUpdate<TRole extends string> = Readonly<{
  role: TRole;
  value: string | string[];
}>;

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateRoleUpdate<TRole extends string>(
  roles: readonly TRole[],
  role: unknown,
  model: unknown,
  models: unknown,
): RoleUpdate<TRole> {
  const selectedRole = roles.find((candidate) => candidate === role);
  if (!selectedRole) throw new Error(`Unknown pstack role ${JSON.stringify(role)}.`);
  if (model !== undefined && models !== undefined) throw new Error("pstack_config set accepts either model or models, not both.");
  if (isNonBlankString(model)) return { role: selectedRole, value: model };
  if (model !== undefined) throw new Error("pstack_config set model must be a nonblank string.");
  if (!Array.isArray(models) || models.length === 0 || !models.every(isNonBlankString)) {
    throw new Error("pstack_config set models must be a nonempty array of nonblank model identifiers.");
  }
  return { role: selectedRole, value: [...models] };
}
