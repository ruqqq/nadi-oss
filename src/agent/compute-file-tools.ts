import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { ComputeFileService } from "../compute/file-service";
import { ComputePartialWriteError, ComputeStaleFileError } from "../compute/errors";
import { toErrorResult } from "./compute-tools";

/**
 * Structured result shape the model sees for an expected file error. Bare
 * `ComputeError`s map to `{ ok:false, error: <code>, detail }`; two carry more
 * so the model can act instead of just retrying blindly:
 *  - `compute_stale_file` includes `path` and `currentHash` (the file's live
 *    hash) so the model can retarget its retry with the right
 *    optimistic-concurrency token, even out of a multi-file apply_patch.
 *  - `compute_partial_write` includes the sorted `affectedPaths` whose on-disk
 *    state may have changed (the commit is not a filesystem transaction).
 * Unexpected errors fall through to the shared sanitized {@link toErrorResult}.
 */
interface FileErrorResult {
  ok: false;
  error: string;
  detail?: string;
  path?: string;
  currentHash?: string;
  affectedPaths?: string[];
}

/** Upper bound on line window so the model can never request an unbounded read. */
const MAX_READ_LINES = 100_000;

function toFileErrorResult(error: unknown): FileErrorResult {
  if (error instanceof ComputeStaleFileError) {
    return {
      ok: false,
      error: error.code,
      detail: error.message,
      path: error.path,
      currentHash: error.currentHash,
    };
  }
  if (error instanceof ComputePartialWriteError) {
    return {
      ok: false,
      error: error.code,
      detail: error.message,
      affectedPaths: error.affectedPaths,
    };
  }
  return toErrorResult(error);
}

/**
 * The three operations these tools actually call.
 *
 * Structural, not `ComputeFileService` itself: that class has a `private
 * readonly deps`, which makes TypeScript compare it NOMINALLY, so nothing but a
 * real instance can satisfy it. The sandbox session forwards these three
 * methods flat over RPC and regroups them on the near side
 * (`compute/agent-sandbox-client.ts`) — a regrouped object is exactly as good
 * here, and widening the parameter is what stops the cutover casting around the
 * nominal check.
 */
export type ComputeFileToolTarget = Pick<
  ComputeFileService,
  "readFile" | "writeFile" | "applyPatch"
>;

/**
 * AI SDK `tool()` definitions for the model-native file surface: `read_file`,
 * `write_file`, and `apply_patch`. Split out from the exec tools so the schemas
 * and error mapping can be unit-tested with a stub {@link ComputeFileService}.
 * `getFiles` resolves the thread's file service lazily, sharing the exec lease.
 */
export function buildComputeFileToolDefs(getFiles: () => Promise<ComputeFileToolTarget>): ToolSet {
  return {
    read_file: tool({
      description:
        "Read a focused, line-numbered window of a text file under your working directory. Returns the content with a content hash to use as expectedHash for later edits.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative path to a text file."),
        startLine: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based line to start from. Defaults to the first line."),
        maxLines: z
          .number()
          .int()
          .positive()
          .max(MAX_READ_LINES)
          .optional()
          .describe("Maximum number of lines to return; bounded and clamped to the server limit."),
      }),
      execute: async (input) => {
        try {
          const read = await (
            await getFiles()
          ).readFile({
            path: input.path,
            ...(input.startLine === undefined ? {} : { startLine: input.startLine }),
            ...(input.maxLines === undefined ? {} : { maxLines: input.maxLines }),
          });
          return { ok: true, ...read };
        } catch (error) {
          return toFileErrorResult(error);
        }
      },
    }),
    write_file: tool({
      description:
        "Create a new file or completely replace an existing one under your working directory. To replace an existing file, pass its current hash as expectedHash (from a prior read_file); omit expectedHash for a new file. compute_file_too_large is permanent — do not retry it.",
      inputSchema: z.object({
        path: z.string().describe("Workspace-relative destination path."),
        content: z.string().describe("Full file contents to write."),
        expectedHash: z
          .string()
          .optional()
          .describe("Required to overwrite: the file's current content hash. Omit for a new file."),
        createParents: z.boolean().optional().describe("Create missing parent directories."),
      }),
      execute: async (input) => {
        try {
          const result = await (
            await getFiles()
          ).writeFile({
            path: input.path,
            content: input.content,
            ...(input.expectedHash === undefined ? {} : { expectedHash: input.expectedHash }),
            ...(input.createParents === undefined ? {} : { createParents: input.createParents }),
          });
          return { ok: true, ...result };
        } catch (error) {
          return toFileErrorResult(error);
        }
      },
    }),
    apply_patch: tool({
      description:
        "Apply a `*** Begin Patch` / `*** End Patch` diff of add, update, delete, and move operations. Every touched file's current hash must be supplied in expectedHashes. Validation is atomic (nothing is written if any path, hash, or hunk fails); the commit itself is not a cross-file transaction. An empty patch is valid and applies nothing.",
      inputSchema: z.object({
        patch: z.string().describe("Patch text in the `*** Begin Patch` grammar."),
        expectedHashes: z
          .record(z.string(), z.string())
          .describe(
            "Map of workspace-relative path to its current content hash for every source file.",
          ),
      }),
      execute: async (input) => {
        try {
          const result = await (
            await getFiles()
          ).applyPatch({
            patch: input.patch,
            expectedHashes: input.expectedHashes,
          });
          return { ok: true, ...result };
        } catch (error) {
          return toFileErrorResult(error);
        }
      },
    }),
  };
}
