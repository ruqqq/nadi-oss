import { formatMemoryIndex, type MemoryIndexContext } from "./memory-index";
import type { ProjectPromptContext } from "./project-context";

// Recording is TRIGGER-based, not request-based. The old policy (and the old
// `remember` tool description) said to store a memory when the user asks you to,
// which defined proactivity away: the user rarely asks, so nothing was ever
// recorded. Name the moments worth recording, and say what NOT to record --
// without the exclusions, an agent told to be proactive writes down everything.
const MEMORY_POLICY =
  "\n\nAgent memory policy: Memories are durable across threads for this agent. Record a memory yourself, without being asked, when the user corrects you, states a preference or a constraint, settles on a way of working, or tells you something about their project, tools, or environment that will still be true next week. Prefer granular records: one discrete fact, preference, constraint, or workflow per memory — when the user shares several independent points, call `remember` once per point rather than bundling them. Do NOT record what the repository already states (code structure, git history, documented commands), anything that only matters inside this thread, or secrets, credentials, API keys, tokens, or passwords. Prefer `update_memory` over a near-duplicate `remember`, and use `forget_memory` when the user asks you to drop something or you learn a memory is wrong. Memories reflect what was true when written: verify one against the current code before you rely on it.";

// Shared with the software_engineering skill body (builtin-skill-source.ts),
// which appends its own extra sentence about Nadi knowledge-base/skill-registry
// edits. One source of truth so the two guidance copies can't drift apart.
export const FILE_TOOLS_GUIDANCE =
  "Use read_file for focused repository text reads and apply_patch for targeted edits. Use write_file for new or complete replacement files. Continue using exec with rg, fd, git, build tools, and test runners for discovery and repository workflows. Use exec_download_file when the user should receive a sandbox file (charts, screenshots, exports); the chat UI shows it as an attachment. Use exec_publish_artifact when the user should view a built HTML directory (entry page + assets) in the browser; use exec_download_file when they should receive a single file.";

// Only appended when the sandbox is enabled: the native file tools only exist
// then. Keeps the always-on prompt nudging the model toward them even before the
// software-engineering skill body is loaded.
const FILE_TOOLS_POLICY = `\n\nWorkspace file tools policy: ${FILE_TOOLS_GUIDANCE}`;

// Only appended when the sandbox is enabled: GH_TOKEN is a per-session sandbox
// env var, so the guidance is meaningless outside a sandbox. git does not read
// GH_TOKEN on its own (only `gh` does), so without this the model tends to run a
// bare `git clone https://github.com/...` that has no credentials and fails on
// private repos, then self-corrects — this removes that wasted round-trip.
const GITHUB_AUTH_POLICY =
  "\n\nGitHub auth in the sandbox: a short-lived `GH_TOKEN` environment variable (a Nadi-managed GitHub App token scoped to the workspace's authorized repositories) may be present. `git` does NOT use it automatically. To clone or push private GitHub repos over HTTPS, put it in the URL — `git clone https://x-access-token:$GH_TOKEN@github.com/OWNER/REPO.git` — because a bare `https://github.com/...` URL sends no credentials and fails on private repos. The `gh` CLI reads `GH_TOKEN` on its own, so `gh` commands need no extra flags. If `GH_TOKEN` is not set, GitHub access is not configured for this workspace — say so rather than guessing at credentials. Never print or commit the token.";

function formatProjectContext(projectContext: ProjectPromptContext): string {
  const lines = ["Project context:", `Name: ${projectContext.name}`];
  if (projectContext.description !== "") {
    lines.push(`Description: ${projectContext.description}`);
  }
  if (projectContext.instructions !== "") {
    lines.push("", "Project instructions:", projectContext.instructions);
  }
  if (projectContext.repositories.length > 0) {
    lines.push("", "Repositories available to this conversation:");
    for (const repository of projectContext.repositories) {
      lines.push(`- ${repository.name}`);
      lines.push(`  URL: ${repository.url}`);
      lines.push(`  default branch: ${repository.defaultBranch}`);
      lines.push(`  checkout path: ${repository.checkoutPath}`);
      if (repository.rootDirectory !== "") {
        lines.push(`  root directory: ${repository.rootDirectory}`);
      }
      if (repository.setupCommand !== "") {
        lines.push(`  setup command: ${repository.setupCommand}`);
      }
      if (repository.packageManager !== "") {
        lines.push(`  package manager: ${repository.packageManager}`);
      }
    }
  }
  return `\n\n${lines.join("\n")}`;
}

// Naming a new thread is NOT asked of the model: it happens server-side from the
// user's first message (see auto-name-thread.ts). Models with weak tool-calling
// discipline used to just skip the old `nameNewConversation` tool.
export function composeSystemPrompt(input: {
  systemPrompt: string;
  projectContext?: ProjectPromptContext;
  memoryIndex?: MemoryIndexContext;
  sandboxAvailable?: boolean;
}): string {
  return (
    input.systemPrompt +
    MEMORY_POLICY +
    (input.sandboxAvailable ? FILE_TOOLS_POLICY : "") +
    (input.sandboxAvailable ? GITHUB_AUTH_POLICY : "") +
    (input.projectContext ? formatProjectContext(input.projectContext) : "") +
    // Last: the index is the most volatile part of the prompt, and a stable
    // prefix is what the provider prompt caches.
    (input.memoryIndex ? formatMemoryIndex(input.memoryIndex) : "")
  );
}
