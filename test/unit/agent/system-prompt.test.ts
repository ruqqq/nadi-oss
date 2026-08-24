import { describe, expect, it } from "vitest";
import { composeSystemPrompt } from "../../../src/agent/system-prompt";

describe("composeSystemPrompt", () => {
  it("keeps the unassigned prompt text unchanged when no project context is provided", () => {
    expect(composeSystemPrompt({ systemPrompt: "You are Nadi." })).toBe(
      "You are Nadi.\n\nAgent memory policy: Memories are durable across threads for this agent. Record a memory yourself, without being asked, when the user corrects you, states a preference or a constraint, settles on a way of working, or tells you something about their project, tools, or environment that will still be true next week. Prefer granular records: one discrete fact, preference, constraint, or workflow per memory — when the user shares several independent points, call `remember` once per point rather than bundling them. Do NOT record what the repository already states (code structure, git history, documented commands), anything that only matters inside this thread, or secrets, credentials, API keys, tokens, or passwords. Prefer `update_memory` over a near-duplicate `remember`, and use `forget_memory` when the user asks you to drop something or you learn a memory is wrong. Memories reflect what was true when written: verify one against the current code before you rely on it.\n\nArabic and Qur'anic text: When you quote the Qur'an, put the verse in a ```quran fenced block whose first line is the reference as `surah:ayah`, optionally followed by the s\u016brah's name (`2:255 Al-Baqarah`; a range is `2:255-257`), then the Arabic, then a blank line, then the translation. Write the Arabic in Uthmani orthography with full tashk\u012bl. Quote one verse or one contiguous range per block. For any other Arabic \u2014 a du'\u0101, a hadith, a phrase, a single word \u2014 write it inline as plain Arabic text; the transcript gives it Arabic typography automatically. Never put Arabic inside a plain code fence or inline code: monospace breaks the letter shaping and the text becomes unreadable. Give the Arabic itself rather than transliteration alone, unless the user asks for transliteration. If you are not certain of the exact wording of a verse, say so or look it up rather than reconstructing it from memory.",
    );
  });

  it("puts the Arabic policy between the memory policy and project context", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      projectContext: { name: "Nadi", description: "", instructions: "", repositories: [] },
    });

    expect(out.indexOf("Agent memory policy:")).toBeLessThan(
      out.indexOf("Arabic and Qur'anic text:"),
    );
    expect(out.indexOf("Arabic and Qur'anic text:")).toBeLessThan(out.indexOf("Project context:"));
  });

  it("names the quran fence the renderer actually looks for", () => {
    // web/src/lib/rehype-arabic.ts matches `language-quran`, and
    // web/src/lib/quran-verse.ts parses `surah:ayah` from the first body line.
    // If either half is renamed without the other, verses render as code.
    const out = composeSystemPrompt({ systemPrompt: "You are Nadi." });
    expect(out).toContain("```quran");
    expect(out).toContain("whose first line is the reference as `surah:ayah`");
    expect(out).toContain("2:255 Al-Baqarah");
  });

  it("renders project context after the memory policy", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      projectContext: {
        name: "Nadi",
        description: "Main app",
        instructions: "Prefer focused tests.",
        repositories: [
          {
            name: "nadi",
            url: "https://github.com/acme/nadi.git",
            defaultBranch: "main",
            checkoutPath: "nadi",
            rootDirectory: "/",
            setupCommand: "pnpm install",
            packageManager: "pnpm",
          },
        ],
      },
    });

    expect(out.indexOf("You are Nadi.")).toBeLessThan(out.indexOf("Agent memory policy:"));
    expect(out.indexOf("Agent memory policy:")).toBeLessThan(out.indexOf("Project context:"));
    expect(out.indexOf("Project context:")).toBeLessThan(
      out.indexOf("Repositories available to this conversation:"),
    );
    expect(out).toContain("Project context:\nName: Nadi\nDescription: Main app");
    expect(out).toContain("Project instructions:\nPrefer focused tests.");
    expect(out).toContain("- nadi\n  URL: https://github.com/acme/nadi.git");
    expect(out).toContain("  package manager: pnpm");
  });

  it("omits empty project fields", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      projectContext: {
        name: "Nadi",
        description: "",
        instructions: "",
        repositories: [
          {
            name: "nadi",
            url: "https://github.com/acme/nadi.git",
            defaultBranch: "main",
            checkoutPath: "nadi",
            rootDirectory: "",
            setupCommand: "",
            packageManager: "",
          },
        ],
      },
    });

    expect(out).toContain("Project context:\nName: Nadi");
    expect(out).not.toContain("Description:");
    expect(out).not.toContain("Project instructions:");
    expect(out).not.toContain("root directory:");
    expect(out).not.toContain("setup command:");
    expect(out).not.toContain("package manager:");
  });

  // The policy has to TELL the model to record unprompted -- the old wording
  // ("only when the user asks") is why nothing was ever recorded proactively.
  it("tells the agent to record memories unprompted, with exclusions", () => {
    const out = composeSystemPrompt({ systemPrompt: "You are Nadi." });

    expect(out).toContain("durable across threads for this agent");
    expect(out).toContain("without being asked");
    expect(out).toContain("corrects you");
    expect(out).toContain("update_memory");
    expect(out).toContain("forget_memory");
    expect(out).toContain("Do NOT record what the repository already states");
    expect(out).toContain("secrets, credentials, API keys, tokens, or passwords");
    expect(out).not.toContain("explicitly asks");
  });

  // Bundled multi-topic memories blunt the index hooks and block surgical
  // update/forget. The policy must prefer one discrete point per record.
  it("prefers granular memory records over bundled multi-topic dumps", () => {
    const out = composeSystemPrompt({ systemPrompt: "You are Nadi." });

    expect(out).toContain("Prefer granular records");
    expect(out).toContain("one discrete fact, preference, constraint, or workflow per memory");
    expect(out).toContain("once per point rather than bundling them");
  });

  it("lists the agent's memories so recall needs no search", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      memoryIndex: {
        total: 2,
        entries: [
          { id: "mem_1", kind: "preference", hook: "Deploys — always squash before deploying" },
          { id: "mem_2", kind: "project", hook: "Box has ~3.8GB RAM" },
        ],
      },
    });

    expect(out).toContain("Memory index");
    expect(out).toContain("[preference] mem_1: Deploys — always squash before deploying");
    expect(out).toContain("[project] mem_2: Box has ~3.8GB RAM");
  });

  it("omits the index entirely for an agent with no memories", () => {
    expect(composeSystemPrompt({ systemPrompt: "You are Nadi." })).not.toContain("Memory index");
  });

  // Naming moved server-side (auto-name-thread.ts): the prompt must never ask the
  // model to name the thread, because weak models simply didn't.
  it("never asks the model to name the conversation", () => {
    const out = composeSystemPrompt({ systemPrompt: "You are Nadi." });
    expect(out).toContain("You are Nadi.");
    expect(out).not.toContain("nameNewConversation");
    expect(out).not.toContain("does not have a title");
  });

  it("appends workspace file-tools guidance when the sandbox is available", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      sandboxAvailable: true,
    });
    expect(out).toContain("Workspace file tools policy");
    expect(out).toContain("read_file");
    expect(out).toContain("apply_patch");
    expect(out).toContain("write_file");
    // Discovery affordances are retained, not replaced.
    expect(out).toContain("rg, fd, git");
    expect(out).toContain("exec_download_file");
    expect(out).toContain("exec_publish_artifact");
    expect(out).toContain("Prefer exec_publish_artifact");
    expect(out).toContain("do not use exec_download_file for HTML");
  });

  it("omits workspace file-tools guidance when the sandbox is unavailable", () => {
    for (const input of [
      { systemPrompt: "You are Nadi." },
      { systemPrompt: "You are Nadi.", sandboxAvailable: false },
    ]) {
      const out = composeSystemPrompt(input);
      expect(out).not.toContain("Workspace file tools policy");
    }
  });

  it("appends GitHub auth guidance when the sandbox is available", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      sandboxAvailable: true,
    });
    expect(out).toContain("GitHub auth in the sandbox");
    expect(out).toContain("GH_TOKEN");
    expect(out).toContain("x-access-token:$GH_TOKEN@github.com");
  });

  it("omits GitHub auth guidance when the sandbox is unavailable", () => {
    for (const input of [
      { systemPrompt: "You are Nadi." },
      { systemPrompt: "You are Nadi.", sandboxAvailable: false },
    ]) {
      const out = composeSystemPrompt(input);
      expect(out).not.toContain("GitHub auth in the sandbox");
    }
  });

  // The same rules already sit in the spawn tool's description and in its
  // result `note`, and a live thread ignored both -- a tool RESULT is the
  // lowest-trust channel there is. The system prompt is the one with standing.
  it("appends subagent guidance when subagents are available", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      subagentsAvailable: true,
    });
    expect(out).toContain("Subagent policy");
    expect(out).toContain("spawn_subagent");
    expect(out).toContain("check_subagents");
    // The positive model: what delegation is FOR.
    expect(out).toContain("INDEPENDENT of what you do next");
    expect(out).toContain("not a way to do the next step of your own plan faster");
    // The failure this exists to prevent.
    expect(out).toContain("the task is no longer yours");
    expect(out).toContain("end your turn");
    expect(out).toContain("Ending the turn to wait is the intended behaviour");
    expect(out).toContain("never a way to wait");
    expect(out).toContain("complete, standalone task");
  });

  it("omits subagent guidance when subagents are unavailable", () => {
    for (const input of [
      { systemPrompt: "You are Nadi." },
      { systemPrompt: "You are Nadi.", subagentsAvailable: false },
    ]) {
      const out = composeSystemPrompt(input);
      expect(out).not.toContain("Subagent policy");
      expect(out).not.toContain("spawn_subagent");
    }
  });

  // Sandbox and subagents are independently gated: a workspace can have exec
  // without background work, and the policies must not ride on each other.
  it("gates the subagent policy independently of the sandbox policies", () => {
    const sandboxOnly = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      sandboxAvailable: true,
    });
    expect(sandboxOnly).toContain("Workspace file tools policy");
    expect(sandboxOnly).not.toContain("Subagent policy");

    const subagentsOnly = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      subagentsAvailable: true,
    });
    expect(subagentsOnly).toContain("Subagent policy");
    expect(subagentsOnly).not.toContain("Workspace file tools policy");
    expect(subagentsOnly).not.toContain("GitHub auth in the sandbox");
  });

  // Prompt-cache friendliness: the volatile memory index stays last, so every
  // policy block must land before it.
  it("orders the subagent policy before project context and the memory index", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      sandboxAvailable: true,
      subagentsAvailable: true,
      projectContext: {
        name: "Nadi",
        description: "",
        instructions: "",
        repositories: [],
      },
      memoryIndex: {
        total: 1,
        entries: [{ id: "mem_1", kind: "project", hook: "Box has ~3.8GB RAM" }],
      },
    });

    expect(out.indexOf("GitHub auth in the sandbox")).toBeLessThan(out.indexOf("Subagent policy"));
    expect(out.indexOf("Subagent policy")).toBeLessThan(out.indexOf("Project context:"));
    expect(out.indexOf("Project context:")).toBeLessThan(out.indexOf("Memory index"));
  });

  it("does not steer the model toward manual attachment OCR", () => {
    const out = composeSystemPrompt({
      systemPrompt: "You are Nadi.",
      sandboxAvailable: true,
    });
    expect(out).not.toContain("Attachment OCR policy");
    expect(out).not.toContain("tesseract");
    expect(out).not.toContain("pdftoppm");
  });

  it("omits attachment OCR guidance when the sandbox is unavailable", () => {
    for (const input of [
      { systemPrompt: "You are Nadi." },
      { systemPrompt: "You are Nadi.", sandboxAvailable: false },
    ]) {
      const out = composeSystemPrompt(input);
      expect(out).not.toContain("Attachment OCR policy");
      expect(out).not.toContain("tesseract");
    }
  });
});
