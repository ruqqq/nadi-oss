export const MAX_ENV_VAR_VALUE_BYTES = 16_384;
export const MAX_ENV_VARS_PER_SCOPE = 64;
export const MAX_ENV_VARS_JSON_BYTES = 65_536;

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const encoder = new TextEncoder();

export function validateEnvVarName(name: string): string {
  const trimmed = name.trim();
  if (!ENV_VAR_NAME_RE.test(trimmed)) throw new Error("sandbox_env_var_name_invalid");
  return trimmed;
}

export function validateEnvVarValue(value: string): string {
  if (encoder.encode(value).length > MAX_ENV_VAR_VALUE_BYTES) {
    throw new Error("sandbox_env_var_value_too_large");
  }
  return value;
}

export function parseEnvVarMap(raw: unknown): Record<string, string> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("sandbox_env_vars_invalid");
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > MAX_ENV_VARS_PER_SCOPE) throw new Error("sandbox_env_vars_too_many");
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (typeof value !== "string") throw new Error("sandbox_env_vars_invalid");
    out[validateEnvVarName(name)] = validateEnvVarValue(value);
  }
  return out;
}

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = validateEnvVarName(line.slice(0, eq));
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value[value.length - 1] === value[0]
    ) {
      value = value.slice(1, -1);
    }
    out[name] = validateEnvVarValue(value);
  }
  if (Object.keys(out).length > MAX_ENV_VARS_PER_SCOPE)
    throw new Error("sandbox_env_vars_too_many");
  return out;
}

export function parseEnvVarsJson(raw: string | null | undefined): Record<string, string> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  try {
    return parseEnvVarMap(parsed);
  } catch {
    return {};
  }
}

export function serializeEnvVarsJson(map: Record<string, string>): string {
  const json = JSON.stringify(parseEnvVarMap(map));
  if (encoder.encode(json).length > MAX_ENV_VARS_JSON_BYTES) {
    throw new Error("sandbox_env_vars_too_large");
  }
  return json;
}

export function mergeComputeEnv(
  ...maps: Array<Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const map of maps) {
    if (!map) continue;
    for (const [name, value] of Object.entries(map)) out[name] = value;
  }
  return out;
}
