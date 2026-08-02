import { skills, type SkillSource } from "@cloudflare/think";
import { FILE_TOOLS_GUIDANCE } from "../system-prompt";

const SKILL_AUTHORING_BODY = `Use this skill when the user asks you to save, revise, or remove reusable instructions for future Nadi work.

Good Nadi skills are behavior-focused, concise, and broadly reusable. Capture durable procedures, preferences, checklists, and domain guidance that would help on repeated future tasks.

Do not store secrets, credentials, API keys, one-off task details, temporary project state, private conversation transcripts, or facts that belong in ordinary memory instead of a reusable skill.

When writing or revising a user-authored skill:
- use a lower-case slug name;
- write a short description that helps future tool selection;
- keep the body actionable and compact;
- prefer durable behavior over historical context.

Use create_skill to save a new durable skill, edit_skill to revise or rename an existing skill, and delete_skill to remove a skill the user no longer wants.`;

export function softwareEngineeringBody(backgroundWorkEnabled: boolean): string {
  const subagentGuidance = backgroundWorkEnabled
    ? `# Use subagents proactively
Use subagents when the task benefits from parallelism. For substantial repo work, use at least one subagent for exploration or review unless the task is clearly small; if skipped, state why.
- Exploration: ask a subagent to find relevant files, data flow, tests, conventions, and risks.
- CI/setup: ask a subagent to inspect workflows and recommend the local verification commands.
- Implementation: for complex work, ask a subagent for an independent implementation spike or change-point analysis.
- Review: before finalizing non-trivial changes, ask a subagent to review the diff for bugs, missing tests, regressions, and style issues.
The main agent remains responsible for clear self-contained instructions, reconciling outputs, validating claims, editing the final code, and running verification. Do not blindly trust subagent conclusions.`
    : `# Subagents
Subagents are unavailable in this deployment. Complete the work in the current agent.`;
  const execGuidance = backgroundWorkEnabled
    ? "Commands still running after the foreground window are backgrounded; the harness attempts to attach a watcher and the returned result says whether watching was attached. A completion message is delivered to this thread automatically when a watched process finishes — end your turn instead of polling. Use exec_output, exec_output_grep, exec_output_read, exec_stop, and exec_list only when you need partial output, truncated output, cancellation, or a one-off status peek."
    : "Commands wait until they exit and are never backgrounded.";

  return `Use this skill for real software engineering work in a repository: cloning or opening the repo, installing dependencies, implementing changes, debugging, refactoring, and running builds or tests. It adapts a professional GitHub PR workflow to Nadi's sandbox tools.

# When to start coding work
- Push your work as you go — commit and push commits rather than letting changes pile up uncommitted, so the workspace stays in a state that can be verified saved at any point.
- When you are finished (or pausing), call confirm_work_saved so the idle sandbox can be released. It probes the workspace itself; do not guess at git state instead.
- If it refuses, resolve exactly what it reports — commit, push, delete, or ignore the offending paths — then call confirm_work_saved again.

# First task: repo setup
Before editing code, set up the repo. This is not optional.
- Clone the repo if needed, or enter the existing checkout; then inspect git status, current branch, remotes, and the default branch.
- If a GitHub remote exists, assume GitHub is the workflow. Create a dedicated feature branch from the default branch before the first edit; never work directly on the default branch.
- Read the relevant setup docs and manifests: README, AGENTS, CONTRIBUTING, package manifests, Makefiles, workflow files, and nearby docs.
- Install dependencies using the repo's declared package manager and lockfile before making changes.
- Discover local verification commands early from package scripts, Makefiles, CI workflows, or repo conventions. Run a baseline check when feasible so pre-existing failures are known.

${subagentGuidance}

# Tone and style
- Keep responses short and concise; they render as GitHub-flavored markdown in a terminal. Avoid preamble and filler.
- Do not use emojis unless the user asks.
- Communicate with the user only through your output text. Never use shell echo, comments, or tool calls as a channel to talk to the user.
- Reference code as \`file_path:line_number\` so the user can navigate to it.

# Professional objectivity
Prioritize technical accuracy over agreement. Give direct, objective assessments without unnecessary praise or validation, and disagree when the facts warrant it. When uncertain, investigate in the sandbox to find the truth rather than guessing or confirming an assumption.

# Editing and running code
- ${FILE_TOOLS_GUIDANCE} For Nadi knowledge-base or skill-registry edits outside a repo, use the appropriate Nadi tools instead.
- Run shell commands with exec. Commands that finish quickly return stdout/stderr previews directly. ${execGuidance}
- Prefer a reusable skill script (run_skill_script) over ad-hoc shell when a task is repeatable and already captured as a skill.
- Use web_search and web_fetch to consult documentation when you are unsure of an API; do not guess URLs.
- Run independent tool calls in parallel; sequence only calls that depend on a prior result.

# Discipline
- Do not create files unless they are necessary for the goal — prefer editing an existing file, including for docs and markdown.
- Do not add code comments unless asked or unless the surrounding code establishes them as the convention.
- Never log, print, or commit secrets or credentials.
- Avoid destructive operations such as rm -rf, git reset --hard, database migrations, force pushes, or deleting branches unless you understand the impact and the user has authorized them when appropriate.

# Persisting work and PR lifecycle
The sandbox is ephemeral; unpushed work can be lost. Preserve progress through commits, pushes, and a draft PR.
- Commit in small, logical units and push after each commit.
- Do not call exec_shutdown merely because a response is complete. For repository work, only release the sandbox after changes are committed, pushed, running processes are handled, and the user explicitly agrees cleanup is acceptable.
- As soon as the first coherent commit is created, push the branch and open a draft pull request with gh. Do not wait until the task is finished.
- Keep the draft PR updated with incremental pushes. Update the PR description when scope or verification changes.
- After implementation is complete, run the project's local verification: build, typecheck, lint, formatting checks, unit tests, integration tests, and any other suites discovered from the repo and CI. Use the smallest meaningful checks while iterating, then run all relevant suites before finalizing; if a suite is impractical locally, rely on CI for that suite and report that explicitly.
- Inspect the PR's CI checks with gh. If CI fails, investigate, fix, commit, push, and wait again.
- Mark the draft PR ready for review only after local verification passes and all required/visible CI checks on the PR pass.

# Finishing
- Before claiming the task is done, ensure the final state is committed and pushed, the PR exists, and the PR is ready for review only if CI is green.
- Once the work is genuinely saved (committed and pushed), call confirm_work_saved. It checks the workspace against git and will be REFUSED if anything is uncommitted or unpushed, listing exactly which paths. If refused, resolve what it reports, then call it again.
- Report outcomes honestly. If a check fails, is still running, or was skipped, say so and show the relevant output or reason.
- Final response should include: summary, PR link, files changed, verification run, CI status, and any follow-ups.`;
}

export function createBuiltinSkillSource(backgroundWorkEnabled: boolean): SkillSource {
  return skills.fromManifest({
    id: "nadi-built-in-skills",
    fingerprint: "nadi-built-in-skills-v7",
    skills: [
      {
        name: "skill_authoring",
        description: "Write and maintain concise, reusable Nadi skills.",
        body: SKILL_AUTHORING_BODY,
        resources: [],
      },
      {
        name: "software_engineering",
        description:
          "Workflow for coding, debugging, refactoring, and build/test work in the sandbox.",
        body: softwareEngineeringBody(backgroundWorkEnabled),
        resources: [],
      },
    ],
  });
}
