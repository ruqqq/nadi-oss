/**
 * Routes for the panel surfaces (Projects, Automata, Invites, Feedback inbox).
 *
 * Selection lives in the URL so a panel can be linked to, restored on reload,
 * and stepped out of with the browser's Back button.
 *
 * Repositories are not here: they are workspace config, so they live under
 * /settings/repositories rather than inside the Projects panel. The feedback
 * inbox keeps its historical /admin/feedback path, but follows the same
 * URL-backed master-detail rules as the other panels.
 */

export type PanelKind = "projects" | "automata" | "invites" | "feedback-inbox";

export type PanelRoute = {
  kind: PanelKind;
  /** The item being viewed, or null for the list. Always null for invites. */
  selectedId: string | null;
};

/** The list path for a panel — the level a detail view goes "up" to. */
export function panelListPath(kind: PanelKind): string {
  switch (kind) {
    case "projects":
      return "/projects";
    case "automata":
      return "/automata";
    case "invites":
      return "/invites";
    case "feedback-inbox":
      return "/admin/feedback";
  }
}

export function panelDetailPath(kind: PanelKind, id: string): string {
  return `${panelListPath(kind)}/${encodeURIComponent(id)}`;
}

export function panelPath(kind: PanelKind, selectedId: string | null): string {
  return selectedId ? panelDetailPath(kind, selectedId) : panelListPath(kind);
}

/** null when the path isn't a panel route (a thread, /chats, the composer…). */
export function parsePanelRoute(pathname: string): PanelRoute | null {
  const segments = pathname.split("/").filter(Boolean).map(decodeSegment);

  switch (segments[0]) {
    case "projects":
      return { kind: "projects", selectedId: segments[1] ?? null };
    case "automata":
      return { kind: "automata", selectedId: segments[1] ?? null };
    case "invites":
      return { kind: "invites", selectedId: null };
    case "admin":
      if (segments[1] === "feedback") {
        return { kind: "feedback-inbox", selectedId: segments[2] ?? null };
      }
      return null;
    default:
      return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // A malformed escape (a bare "%") would otherwise throw and take the whole
    // route parse down with it; treat it as the literal it is.
    return segment;
  }
}
