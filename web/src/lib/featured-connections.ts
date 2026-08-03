import type { McpServer } from "../mcp-api";

export type FeaturedConnectionId = "markdump" | "composio";

export interface FeaturedConnection {
  id: FeaturedConnectionId;
  /** The name the server is created with. The user may rename it afterwards. */
  serverName: string;
  /** What the card is called — describes the capability, not the vendor. */
  title: string;
  pitch: string;
  url: string;
}

/**
 * MCP servers Nadi offers by name during onboarding. Data only: no React here,
 * so the matching rule below stays testable and Settings can reuse the list.
 */
export const FEATURED_CONNECTIONS: FeaturedConnection[] = [
  {
    id: "markdump",
    serverName: "Markdump",
    title: "Knowledge base",
    pitch:
      "A wiki your agent reads and writes. It remembers what you tell it across every chat, and you can read it yourself.",
    url: "https://markdump.com/mcp",
  },
  {
    id: "composio",
    serverName: "Composio",
    title: "Connected accounts",
    pitch:
      "Connect Gmail, Calendar, Drive and more, so your agent can work with what's already in your accounts.",
    url: "https://connect.composio.dev/mcp",
  },
];

/**
 * Match by URL, never by name. A user can rename a server, and if a rename made
 * us think the connection was gone we would add a duplicate on the next replay.
 */
export function findFeaturedServer(
  servers: McpServer[],
  connection: FeaturedConnection,
): McpServer | null {
  const target = normalizeUrl(connection.url);
  return servers.find((s) => normalizeUrl(s.url) === target) ?? null;
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host.toLowerCase()}${path}`;
  } catch {
    return value.trim().toLowerCase().replace(/\/+$/, "");
  }
}
