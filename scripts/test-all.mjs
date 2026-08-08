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

// The four workers-pool projects run one at a time on purpose. Each spins up
// its own workerd pool, and running them concurrently peaks well past a small
// dev box's RAM — the failure mode is an OOM SIGKILL that reads as a test
// failure. Sequential is also no slower now that integration-shared imports the
// module graph once instead of once per file.
async function runStagesSequentially(names) {
  for (const name of names) {
    const passed = await runStage(`Worker integration: ${name}`, [
      ["exec", "vitest", "run", `--project=${name}`],
    ]);
    if (!passed) return false;
  }
  return true;
}

// Every project in vitest.config.ts must be named here (and in
// .github/workflows/ci.yml), or it silently stops running — the bug that
// orphaned the integration-grouped suites from the initial commit. The guard
// in vitest.config.ts catches a test file that matches no project, but it
// cannot catch a project that no runner invokes.
const workersPassed = await runStagesSequentially([
  "integration-fast",
  "integration-grouped",
  "integration-shared",
  "integration-isolated",
]);

if (workersPassed) {
  const nodePassed = await runStage("Node and web", [
    ["exec", "vitest", "run", "--project=unit", "--project=web-unit"],
  ]);
  if (!nodePassed) process.exitCode = 1;
} else {
  process.exitCode = 1;
}
