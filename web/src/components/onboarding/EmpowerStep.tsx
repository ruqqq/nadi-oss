import { useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Notebook, PlugsConnected } from "../../icons";
import { FEATURED_CONNECTIONS, findFeaturedServer } from "../../lib/featured-connections";
import { listMcpServers, type McpServer } from "../../mcp-api";
import { FeaturedConnectionCard } from "./FeaturedConnectionCard";

const CONNECTION_ICONS = {
  markdump: <Notebook aria-hidden className="size-5" />,
  composio: <PlugsConnected aria-hidden className="size-5" />,
} as const;

export function EmpowerStep({
  exaCard,
  onContinue,
  onConnectionsChange,
}: {
  /** The web-search card, owned by the wizard because it holds the Exa form state. */
  exaCard: React.ReactNode;
  onContinue: () => void;
  /** Unused until Task 9, which needs to know whether Composio ended up connected. */
  onConnectionsChange?: (servers: McpServer[]) => void;
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listMcpServers()
      .then((list) => {
        if (!cancelled) setServers(list);
      })
      // A failed read just means every card starts as not-added. Connecting
      // still works; the duplicate guard is the URL match on the next load.
      .catch(() => {
        if (!cancelled) setServers([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (servers) onConnectionsChange?.(servers);
  }, [servers, onConnectionsChange]);

  return (
    <div className="mt-4 space-y-4">
      <div className="space-y-1">
        <h2 className="font-display font-semibold text-lg">Empower your agent</h2>
        <p className="text-muted-foreground text-sm">
          Optional — connect any of these now, or later in Settings.
        </p>
      </div>

      {FEATURED_CONNECTIONS.map((connection) => (
        <FeaturedConnectionCard
          key={connection.id}
          connection={connection}
          icon={CONNECTION_ICONS[connection.id]}
          server={servers ? findFeaturedServer(servers, connection) : null}
          onAdded={(server) => setServers((current) => [...(current ?? []), server])}
        />
      ))}

      {exaCard}

      <div className="flex justify-end">
        <Button type="button" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
