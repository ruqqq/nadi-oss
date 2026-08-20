/**
 * A continuity index: what the thread has already DONE, computed from the
 * transcript rather than written by a summarizer.
 *
 * A prose summary is produced by a model that is itself under context pressure,
 * and the first thing it drops is bookkeeping — which is exactly what stops the
 * next turn from repeating work. On thr_ba1be632 the agent re-ran an
 * investigation a subagent had already finished; that is the failure this
 * exists to prevent. pi does the same thing with `extractFileOpsFromMessage`,
 * merging file operations across successive compactions so workspace state
 * survives a lossy summary.
 *
 * Shapes here are read from the real tools, not assumed:
 * - `read_file` / `write_file` carry `input.path` (compute-file-tools.ts:62,96)
 * - `apply_patch` carries NO path — its touched files are the KEYS of
 *   `input.expectedHashes` (compute-file-tools.ts:121)
 * - `spawn_subagent` returns `{ runId, status }` (subagent-tools.ts:148)
 * - `exec_publish_artifact` returns `{ artifactId, title, url }`
 *   (compute-tools.ts:1045)
 *
 * Nothing here may throw: it runs inside the compaction path, where an
 * exception turns recoverable context pressure into a failed turn.
 */

export type ContinuitySubagent = { runId: string; label: string; outcome: string };
export type ContinuityArtifact = { title: string; url: string };

export type ContinuityIndex = {
  filesRead: string[];
  filesWritten: string[];
  sandboxId?: string;
  workbenchId?: string;
  branch?: string;
  subagents: ContinuitySubagent[];
  artifacts: ContinuityArtifact[];
};

export const EMPTY_CONTINUITY: ContinuityIndex = {
  filesRead: [],
  filesWritten: [],
  subagents: [],
  artifacts: [],
};

type LoosePart = {
  type?: unknown;
  state?: unknown;
  toolName?: unknown;
  input?: unknown;
  output?: unknown;
};
type LooseMessage = { parts?: unknown };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** Append preserving first-seen order; the next turn cares most about what came last. */
function pushUnique(target: string[], value: string | undefined): void {
  if (value !== undefined && !target.includes(value)) target.push(value);
}

function toolNameOf(part: LoosePart): string | undefined {
  const name = str(part.toolName);
  if (name !== undefined) return name;
  const type = str(part.type);
  return type?.startsWith("tool-") === true ? type.slice("tool-".length) : undefined;
}

export function extractContinuity(messages: readonly LooseMessage[]): ContinuityIndex {
  const index: ContinuityIndex = {
    filesRead: [],
    filesWritten: [],
    subagents: [],
    artifacts: [],
  };

  for (const message of messages) {
    const parts = Array.isArray(message?.parts) ? (message.parts as LoosePart[]) : [];
    for (const part of parts) {
      if (!isRecord(part) || part.state !== "output-available") continue;
      const name = toolNameOf(part);
      if (name === undefined) continue;
      const input = isRecord(part.input) ? part.input : {};
      const output = isRecord(part.output) ? part.output : {};

      switch (name) {
        case "read_file":
          pushUnique(index.filesRead, str(input.path));
          break;
        case "write_file":
          pushUnique(index.filesWritten, str(input.path));
          break;
        case "apply_patch": {
          const hashes = input.expectedHashes;
          if (isRecord(hashes))
            for (const path of Object.keys(hashes)) pushUnique(index.filesWritten, path);
          break;
        }
        case "spawn_subagent": {
          const runId = str(output.runId);
          if (runId !== undefined && !index.subagents.some((s) => s.runId === runId)) {
            index.subagents.push({
              runId,
              label: str(input.label) ?? str(input.task)?.slice(0, 60) ?? runId,
              outcome: str(output.status) ?? "unknown",
            });
          }
          break;
        }
        case "exec_publish_artifact": {
          const url = str(output.url);
          if (url !== undefined && !index.artifacts.some((a) => a.url === url)) {
            index.artifacts.push({ title: str(output.title) ?? url, url });
          }
          break;
        }
        default:
          break;
      }

      // Environment identity, wherever a tool happens to report it. Last writer
      // wins: a thread can be reset onto a new sandbox mid-run.
      const sandboxId = str(output.sandboxId);
      if (sandboxId !== undefined) index.sandboxId = sandboxId;
      const workbenchId = str(output.workbenchId);
      if (workbenchId !== undefined) index.workbenchId = workbenchId;
      const branch = str(output.branch);
      if (branch !== undefined) index.branch = branch;
    }
  }

  return index;
}
