import type { ToolSet } from "ai";
import type { Env } from "../env";
import type { ThreadKnowledgeScope } from "../thread-knowledge/types";
import { createAttachmentTools } from "./attachment-tools";
import { createAutomatonManagementTools } from "./automaton-tools";
import { createMemoryTools } from "./memory-tools";
import { createSkillManagementTools } from "./skill-management-tools";
import { createFileTransferTools } from "./file-transfer-tools";
import { createThreadKnowledgeTools } from "./thread-knowledge-tools";

/**
 * The always-on native thread tools (attachments, memory, skills).
 * Constructed synchronously so runtimes whose tool hook is synchronous (Think's
 * `getTools()`) can compose them without awaiting; the config-aware sandbox
 * tools are layered on separately.
 */
export function createBaseNativeThreadTools(input: {
  env: Env;
  threadId: string;
  resolveThreadKnowledgeScope?: () => Promise<ThreadKnowledgeScope>;
}): ToolSet {
  return {
    ...createAttachmentTools({ env: input.env, threadId: input.threadId }),
    ...createMemoryTools({ env: input.env, threadId: input.threadId }),
    ...createSkillManagementTools({ env: input.env, threadId: input.threadId }),
    ...createAutomatonManagementTools({ env: input.env, threadId: input.threadId }),
    ...createFileTransferTools({ env: input.env, threadId: input.threadId }),
    ...createThreadKnowledgeTools({
      env: input.env,
      threadId: input.threadId,
      ...(input.resolveThreadKnowledgeScope
        ? { resolveScope: input.resolveThreadKnowledgeScope }
        : {}),
    }),
  };
}

/**
 * Pure composition step: fold the compute tools into the base tool set only
 * when compute execution is enabled. Kept pure (no I/O) so the "hide all
 * compute exec tools when disabled" contract is unit-testable in isolation.
 */
export function mergeNativeThreadTools(input: {
  baseTools: ToolSet;
  sandboxTools: ToolSet;
  sandboxEnabled: boolean;
}): ToolSet {
  if (input.sandboxEnabled) return { ...input.baseTools, ...input.sandboxTools };
  const sandboxToolNames = new Set(Object.keys(input.sandboxTools));
  return Object.fromEntries(
    Object.entries(input.baseTools).filter(([name]) => !sandboxToolNames.has(name)),
  ) as ToolSet;
}
