/**
 * Settings tabs live in the URL (`/settings/tools`), so a tab can be linked to
 * and survives the round trip through an MCP OAuth consent screen.
 */

/**
 * The old per-workspace `agent` tab and its separate machine tab are gone: one
 * agent now carries both a mind and a machine, so there is one tab for both.
 * `memory` is gone too — memories belong to an agent, and are reached from that
 * agent's page. `skills` stays: it is the workspace LIBRARY every agent
 * inherits, not one agent's property.
 */
export const SETTINGS_TABS = [
  "general",
  "agents",
  "providers",
  "sandbox",
  // GitHub App connections (installations, connect/disconnect) live here.
  "connections",
  "tools",
  "skills",
] as const;

export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = "general";

export function isSettingsPath(pathname: string): boolean {
  return pathname === "/settings" || pathname.startsWith("/settings/");
}

/** Unknown or missing tab falls back to General rather than rendering nothing. */
export function parseSettingsTab(pathname: string): SettingsTab {
  const segment = pathname.split("/").filter(Boolean)[1];
  return SETTINGS_TABS.find((tab) => tab === segment) ?? DEFAULT_SETTINGS_TAB;
}

export function settingsPath(tab: SettingsTab): string {
  return `/settings/${tab}`;
}

/**
 * The Agents tab is a master-detail: a third path segment selects an agent
 * (`/settings/agents/:id`), starts a create form (`.../new`), or is absent
 * for the list (`/settings/agents`).
 */
export type AgentsRoute = {
  tab: "agents";
  selectedId: string | "new" | null;
};

/** null when the path isn't under the Agents tab at all. */
export function parseAgentsRoute(pathname: string): AgentsRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[1] !== "agents") return null;
  const third = segments[2];
  if (third === undefined) return { tab: "agents", selectedId: null };
  if (third === "new") return { tab: "agents", selectedId: "new" };
  return { tab: "agents", selectedId: decodeSegment(third) };
}

export function agentsPath(selectedId: string | "new" | null): string {
  if (selectedId === null) return settingsPath("agents");
  const segment = selectedId === "new" ? "new" : encodeURIComponent(selectedId);
  return `${settingsPath("agents")}/${segment}`;
}

/**
 * The Providers tab is a master-detail: a third path segment selects a provider
 * (`/settings/providers/:id`), or is absent for the list. There is no "new" —
 * the provider set is fixed by the server.
 */
export type ProvidersRoute = {
  tab: "providers";
  selectedId: string | null;
};

/** null when the path isn't under the Providers tab at all. */
export function parseProvidersRoute(pathname: string): ProvidersRoute | null {
  const segments = pathname.split("/").filter(Boolean);
  if (segments[1] !== "providers") return null;
  const third = segments[2];
  return { tab: "providers", selectedId: third === undefined ? null : decodeSegment(third) };
}

export function providersPath(selectedId: string | null): string {
  if (selectedId === null) return settingsPath("providers");
  return `${settingsPath("providers")}/${encodeURIComponent(selectedId)}`;
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

/**
 * Where to land after an MCP OAuth consent redirect. The provider sends the
 * browser back to the app root, which drops SPA state, so the path to restore is
 * stashed before leaving.
 */
export const MCP_RETURN_PATH_KEY = "nadi.mcp.returnPath";

/**
 * The onboarding wizard is the second legal return target for an MCP OAuth
 * redirect. It is matched exactly — root path, `onboarding=force` present —
 * so a stashed value can never redirect the user somewhere arbitrary.
 */
export function isOnboardingPath(pathAndQuery: string): boolean {
  if (!pathAndQuery.startsWith("/?")) return false;
  const [pathname, search = ""] = pathAndQuery.split("?", 2) as [string, string?];
  if (pathname !== "/") return false;
  return new URLSearchParams(search).get("onboarding") === "force";
}

/**
 * Only ever restore a path we recognize — this comes back from storage, not
 * from us. Consume it either way, so a rejected value can't linger and hijack a
 * later navigation.
 */
export function takeMcpReturnPath(storage: Pick<Storage, "getItem" | "removeItem">): string | null {
  const stored = storage.getItem(MCP_RETURN_PATH_KEY);
  if (stored === null) return null;
  storage.removeItem(MCP_RETURN_PATH_KEY);
  return isSettingsPath(stored) || isOnboardingPath(stored) ? stored : null;
}
