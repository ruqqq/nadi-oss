export class UnsupportedInterpreterError extends Error {
  constructor(path: string) {
    super(`unsupported script extension: ${path}`);
    this.name = "UnsupportedInterpreterError";
  }
}

const EXT_TO_INTERPRETER: Record<string, "bash" | "python3" | "node"> = {
  sh: "bash",
  py: "python3",
  js: "node",
  mjs: "node",
};

export function resolveInterpreter(path: string): { interpreter: "bash" | "python3" | "node" } {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  const interpreter = EXT_TO_INTERPRETER[ext];
  if (!interpreter) throw new UnsupportedInterpreterError(path);
  return { interpreter };
}
