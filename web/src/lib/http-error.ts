/**
 * Turn a failed `fetch` Response into a human-readable Error, so the UI never
 * surfaces a bare HTTP status code. Prefers the server's own message (our
 * routes reply with short text like "Workspace not found"); otherwise falls
 * back to a friendly, action-specific sentence.
 *
 * `action` is an infinitive phrase describing what failed, e.g. "create the
 * project" — it reads as "You don't have permission to create the project."
 */
export async function errorFromResponse(res: Response, action: string): Promise<Error> {
  // 401 bodies are usually the jargon "Unauthorized" — always prefer a
  // friendlier, actionable message.
  if (res.status !== 401) {
    const serverMessage = await readServerMessage(res);
    if (serverMessage) return new Error(serverMessage);
  }
  return new Error(friendlyStatusMessage(res.status, action));
}

async function readServerMessage(res: Response): Promise<string | null> {
  let text: string;
  try {
    text = (await res.text()).trim();
  } catch {
    return null;
  }
  // Ignore empty, oversized, or HTML (error-page) bodies.
  if (!text || text.length > 300 || text.startsWith("<")) return null;

  // Some routes reply with JSON like {"error":"..."} or {"message":"..."}.
  if (text.startsWith("{")) {
    try {
      const parsed = JSON.parse(text) as { error?: unknown; message?: unknown };
      const field = typeof parsed.error === "string" ? parsed.error : parsed.message;
      const message = typeof field === "string" ? field.trim() : "";
      return message || null;
    } catch {
      return null;
    }
  }
  return text;
}

function friendlyStatusMessage(status: number, action: string): string {
  switch (status) {
    case 401:
      return "Your session expired. Refresh the page and sign in again.";
    case 403:
      return `You don't have permission to ${action}.`;
    case 404:
      return "That item couldn't be found — it may have already been removed.";
    case 409:
      return `Couldn't ${action} because it conflicts with something that already exists.`;
    case 429:
      return "Too many requests. Wait a moment and try again.";
    default:
      if (status >= 500) return `Something went wrong while trying to ${action}. Please try again.`;
      return `Couldn't ${action}. Please try again.`;
  }
}
