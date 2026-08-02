import { useEffect, useState } from "react";
import { listMcpServers } from "../mcp-api";
import type { ToolNameServer } from "./resolve-tool-name";

/**
 * The workspace's MCP servers (id + display name), used to map namespaced tool
 * keys to friendly names in chat. Fetched once per page load and cached at module
 * scope so switching threads doesn't refetch. On failure, names fall back to the
 * raw key — never blocks rendering.
 */
let cache: ToolNameServer[] | null = null;

export function useToolServers(): ToolNameServer[] {
  const [servers, setServers] = useState<ToolNameServer[]>(cache ?? []);

  useEffect(() => {
    if (cache) return;
    let active = true;
    listMcpServers()
      .then((list) => {
        cache = list.map((s) => ({ id: s.id, name: s.name }));
        if (active) setServers(cache);
      })
      .catch(() => {
        /* leave servers empty — resolveToolName falls back to the raw key */
      });
    return () => {
      active = false;
    };
  }, []);

  return servers;
}
