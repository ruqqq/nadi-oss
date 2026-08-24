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
  "Use read_file for focused repository text reads and apply_patch for targeted edits. Use write_file for new or complete replacement files. Continue using exec with rg, fd, git, build tools, and test runners for discovery and repository workflows. Prefer exec_publish_artifact whenever you produce HTML the user should open in a browser — a static site / build output directory, a page with CSS/JS/images, or even a single self-contained .html file (publish its parent directory and set entryPath). Downloaded HTML is stored as plain text and will not render, so do not use exec_download_file for HTML meant to be viewed. Reserve exec_download_file for non-HTML deliverables (charts, screenshots, PDFs, data exports) or when the user explicitly wants a downloadable file attachment.";

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

// Only appended when subagents are enabled. The same rules live in
// `SPAWN_DESCRIPTION` and in the spawn tool's `STARTED_NOTE`, and both were
// observed being ignored: a live thread (gpt-5.6-luna) spawned a subagent to
// summarize a PR's architecture, then re-ran that exact investigation itself
// across ~20 tool calls and used the subagent's late result only to say "no
// changes needed". Tool RESULTS are the lowest-trust channel a model has --
// they are the prompt-injection surface -- so behavioural rules delivered
// there are discounted by design; the tool DESCRIPTION is trusted but is read
// when deciding whether to spawn, long before the moment of temptation. The
// system prompt is the only channel with standing, so the rule belongs here
// too, phrased as the positive model of what delegation is for rather than as
// one more prohibition.
const SUBAGENT_POLICY =
  "\n\nSubagent policy: `spawn_subagent` runs a task in the background on the same machine as you and returns immediately; the subagent's result arrives LATER as its own message, never as that tool's return value. Delegate work that is INDEPENDENT of what you do next — a probe, an investigation, or a build whose answer you do not need in order to keep making progress on something else. It is a way to do two things at once, not a way to do the next step of your own plan faster. Once you have spawned a subagent the task is no longer yours: do not investigate, read, or write the same thing in this thread, and avoid editing files it may be touching, because you share one filesystem. If you cannot continue without its result, end your turn — the completion is delivered to you automatically, usually within seconds of the subagent finishing, and you pick the work up from there. Ending the turn to wait is the intended behaviour, not a stall, and it is always better than filling the wait by doing the delegated work yourself. `check_subagents` reports status on demand and is never a way to wait: it cannot reveal anything the completion message would not, and an unfinished run does not finish sooner because you asked. Give each subagent a complete, standalone task — it cannot see this conversation.";

// The transcript renders Arabic with a real Arabic face, RTL flow, and a
// dedicated verse block (web/src/components/chat/QuranBlock.tsx) — but only for
// output shaped the way this describes. Two failure modes drove the wording:
// a model that transliterates instead of quoting, and a model that wraps Arabic
// in a plain code fence, where monospace destroys the letter shaping the script
// depends on. The accuracy sentence is last because it matters most: careful
// typography makes a misquoted ayah MORE convincing, not less.
const ARABIC_OUTPUT_POLICY =
  "\n\nArabic and Qur'anic text: When you quote the Qur'an, put the verse in a ```quran fenced block whose first line is the reference as `surah:ayah`, optionally followed by the s\u016brah's name (`2:255 Al-Baqarah`; a range is `2:255-257`), then the Arabic, then a blank line, then the translation. Write the Arabic in Uthmani orthography with full tashk\u012bl. Quote one verse or one contiguous range per block. For any other Arabic \u2014 a du'\u0101, a hadith, a phrase, a single word \u2014 write it inline as plain Arabic text; the transcript gives it Arabic typography automatically. Never put Arabic inside a plain code fence or inline code: monospace breaks the letter shaping and the text becomes unreadable. Give the Arabic itself rather than transliteration alone, unless the user asks for transliteration. If you are not certain of the exact wording of a verse, say so or look it up rather than reconstructing it from memory.";

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
  subagentsAvailable?: boolean;
}): string {
  return (
    input.systemPrompt +
    MEMORY_POLICY +
    ARABIC_OUTPUT_POLICY +
    (input.sandboxAvailable ? FILE_TOOLS_POLICY : "") +
    (input.sandboxAvailable ? GITHUB_AUTH_POLICY : "") +
    (input.subagentsAvailable ? SUBAGENT_POLICY : "") +
    (input.projectContext ? formatProjectContext(input.projectContext) : "") +
    // Last: the index is the most volatile part of the prompt, and a stable
    // prefix is what the provider prompt caches.
    (input.memoryIndex ? formatMemoryIndex(input.memoryIndex) : "")
  );
}
