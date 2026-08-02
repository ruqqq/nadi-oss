/**
 * Human-readable labels for built-in tools that don't get a richer, dynamic
 * card (those come from `buildToolLogEntry` — exec commands, skills, etc.).
 *
 * A tool card should never surface a raw identifier like `confirm_work_saved`.
 * Curated names below win; anything unmapped is humanized (snake_case /
 * camelCase → "Sentence case") so a new tool still reads as prose, not an id.
 */
const FRIENDLY_TOOL_NAMES: Record<string, string> = {
  confirm_work_saved: "Confirm work saved",
  remember: "Save memory",
  search_memories: "Search memory",
  update_memory: "Update memory",
  forget_memory: "Forget memory",
  web_search: "Search the web",
  web_fetch: "Fetch a page",
  web_fetch_read: "Read fetched page",
  web_fetch_grep: "Search fetched page",
  spawn_subagent: "Start subagent",
  check_subagents: "Check subagents",
  read_file: "Read file",
  write_file: "Write file",
  apply_patch: "Apply patch",
  exec_shutdown: "Shut down sandbox",
  confirm_workbench_switch: "Confirm workbench switch",
  exec_list: "List processes",
  exec_upload_file: "Upload file",
  create_skill: "Create skill",
  edit_skill: "Edit skill",
  delete_skill: "Delete skill",
  getAttachmentUrl: "Open attachment",
  listAttachments: "List attachments",
  // Retired server-side (threads are now named from the first message), but old
  // transcripts still carry the call and must not render a raw identifier.
  nameNewConversation: "Name conversation",
};

/** Turn `some_tool` / `someTool` into "Some tool" as a last resort. */
function humanize(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_+/g, " ")
    .trim();
  if (!spaced) return name;
  const lower = spaced.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export function friendlyToolName(name: string): string {
  return FRIENDLY_TOOL_NAMES[name] ?? humanize(name);
}
