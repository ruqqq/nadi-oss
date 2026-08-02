import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const useProcessGroups = process.platform !== "win32";

function start(args) {
  const child = spawn(pnpm, args, {
    detached: useProcessGroups,
    stdio: "inherit",
  });
  const done = new Promise((resolve) => {
    child.once("error", () => resolve(1));
    child.once("exit", (code) => resolve(code ?? 1));
  });
  return { child, done };
}

function stop(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (useProcessGroups) process.kill(-child.pid, "SIGTERM");
  else child.kill("SIGTERM");
}

async function runStage(name, commands) {
  console.log(`\n=== ${name} ===`);
  const runs = commands.map(start);
  const statuses = await Promise.all(
    runs.map(async ({ done }) => {
      const status = await done;
      if (status !== 0) runs.forEach(({ child: other }) => stop(other));
      return status;
    }),
  );
  return statuses.every((status) => status === 0);
}

const workersPassed = await runStage("Worker integration", [
  ["exec", "vitest", "run", "--project=integration-fast"],
  ["exec", "vitest", "run", "--project=integration-isolated"],
]);

if (workersPassed) {
  const nodePassed = await runStage("Node and web", [
    ["exec", "vitest", "run", "--project=unit", "--project=web-unit"],
  ]);
  if (!nodePassed) process.exitCode = 1;
} else {
  process.exitCode = 1;
}
