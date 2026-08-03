import { useCallback, useEffect, useState } from "react";
import { Button } from "../ui/button";
import { Notebook, PlugsConnected } from "../../icons";
import { FEATURED_CONNECTIONS, findFeaturedServer } from "../../lib/featured-connections";
import type { FeaturedConnectionId } from "../../lib/featured-connections";
import { hasCalendarTool } from "../../lib/automaton-nudge";
import { listMcpServers, type McpServer } from "../../mcp-api";
import { FeaturedConnectionCard, type FeaturedConnectionState } from "./FeaturedConnectionCard";

const CONNECTION_ICONS = {
  markdump: <Notebook aria-hidden className="size-5" />,
  composio: <PlugsConnected aria-hidden className="size-5" />,
} as const;

export function EmpowerStep({
  exaCard,
  onContinue,
  onConnectedChange,
  onCalendarConnectedChange,
}: {
  /** The web-search card, owned by the wizard because it holds the Exa form state. */
  exaCard: React.ReactNode;
  onContinue: () => void;
  /**
   * The connections that are actually AUTHORIZED — not merely added. Completion
   * seeds a prompt from this, and a row the user never consented to would make
   * that prompt ask for data the agent cannot reach.
   */
  onConnectedChange?: (connected: FeaturedConnectionId[]) => void;
  /**
   * Whether a calendar-named tool actually resolved on any authorized
   * connection. This is deliberately NOT derived from which connections are
   * authorized — Composio finishing OAuth means the platform is connected,
   * not that a calendar account is attached inside it. Only a resolved tool
   * name counts.
   */
  onCalendarConnectedChange?: (calendarConnected: boolean) => void;
}) {
  // `undefined` until the list resolves; the cards read that as "don't know yet"
  // and refuse to offer Connect, which is what stops a post-OAuth reload from
  // adding a second row for a server the user just authorized.
  const [servers, setServers] = useState<McpServer[] | undefined>(undefined);
  type StateMap = Partial<Record<FeaturedConnectionId, FeaturedConnectionState>>;
  const [states, setStates] = useState<StateMap>({});
  type ToolsMap = Partial<Record<FeaturedConnectionId, string[]>>;
  const [toolsByConnection, setToolsByConnection] = useState<ToolsMap>({});

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

  const handleStateChange = useCallback(
    (id: FeaturedConnectionId, state: FeaturedConnectionState, toolNames: string[]) => {
      setStates((current) => (current[id] === state ? current : { ...current, [id]: state }));
      setToolsByConnection((current) => ({ ...current, [id]: toolNames }));
    },
    [],
  );

  useEffect(() => {
    onConnectedChange?.(
      FEATURED_CONNECTIONS.filter((c) => states[c.id] === "connected").map((c) => c.id),
    );
  }, [states, onConnectedChange]);

  useEffect(() => {
    // Impossible to arm the calendar prompt without a resolved calendar-named
    // tool: a connection contributes only while it is actually "connected",
    // and only its own resolved tool names are consulted.
    const calendarConnected = FEATURED_CONNECTIONS.some(
      (c) => states[c.id] === "connected" && hasCalendarTool(toolsByConnection[c.id] ?? []),
    );
    onCalendarConnectedChange?.(calendarConnected);
  }, [states, toolsByConnection, onCalendarConnectedChange]);

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
          server={servers ? findFeaturedServer(servers, connection) : undefined}
          onAdded={(server) => setServers((current) => [...(current ?? []), server])}
          onStateChange={handleStateChange}
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
