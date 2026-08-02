/**
 * The Agents SDK will not run a skill script whose path is outside `scripts/`
 * (`validateSkillScriptPath`, agents/dist/skills/index.js). Nothing enforced that
 * on the way IN, so a skill could be stored with any path at all — and was: the
 * imported superpowers skills carry `path: "none"`, `content: "# no script"`.
 *
 * That is not merely junk. The presence of a script resource is what opens the
 * `run_skill_script` gate (`shouldEnableScriptRunner`), so those rows advertise a
 * runnable script that cannot exist, and the model can only find that out by
 * calling the tool and failing.
 *
 * Mirrors the SDK's rule so a path we accept is a path it will run.
 */
export const SKILL_SCRIPT_PREFIX = "scripts/";

export class InvalidSkillScriptPathError extends Error {
  constructor(path: string) {
    super(
      `Skill script path must start with "${SKILL_SCRIPT_PREFIX}" and name a real file (e.g. "scripts/run.py"), got: ${path}. Omit the script entirely if the skill has none.`,
    );
    this.name = "InvalidSkillScriptPathError";
  }
}

export function isValidSkillScriptPath(path: string): boolean {
  if (!path.startsWith(SKILL_SCRIPT_PREFIX)) return false;
  if (path.startsWith("/") || path.includes("\0")) return false;
  // No empty, "." or ".." segments — a script must not escape its own directory.
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return false;
  // Something has to follow "scripts/".
  return path.length > SKILL_SCRIPT_PREFIX.length;
}

/** Throws `InvalidSkillScriptPathError` unless the path is one the SDK would run. */
export function assertValidSkillScriptPath(path: string): void {
  if (!isValidSkillScriptPath(path)) throw new InvalidSkillScriptPathError(path);
}
