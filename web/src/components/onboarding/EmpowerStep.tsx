import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { Notebook, PlugsConnected } from "../../icons";
import { FEATURED_CONNECTIONS, findFeaturedServer } from "../../lib/featured-connections";
import type { FeaturedConnectionId } from "../../lib/featured-connections";
import { hasCalendarTool } from "../../lib/automaton-nudge";
import { listMcpServers, type McpServer } from "../../mcp-api";
import { FeaturedConnectionCard } from "./FeaturedConnectionCard";

const CONNECTION_ICONS = {
  markdump: <Notebook aria-hidden className="size-5" />,
  composio: <PlugsConnected aria-hidden className="size-5" />,
} as const;

export function EmpowerStep({
  exaCard,
  onContinue,
  onCalendarConnectedChange,
}: {
  /** The web-search card, owned by the wizard because it holds the Exa form state. */
  exaCard: React.ReactNode;
  onContinue: () => void;
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
  // `null` = not connected (or not yet resolved); `string[]` = connected with
  // exactly these tool names, including `[]` for zero. The two aren't
  // conflated here — `?? []` below treats them the same only because both
  // happen to mean "no calendar" for THIS check. Keep them distinct in the
  // type anyway: a future consumer that cares about "connected" as its own
  // fact (not just "has a calendar") needs that distinction preserved, and
  // `FeaturedConnectionCard`'s `onResolved` doc explains why collapsing them
  // at the source would be the wrong place to lose it.
  type ResolvedMap = Partial<Record<FeaturedConnectionId, string[] | null>>;
  // A ref, not state: nothing renders from this, and its only consumer reads
  // it at click time. As state it was a render behind the card's own
  // "Connected · N tools" text — the card sets that in one commit and reports
  // upward from an effect in the next — so a Continue pressed the instant the
  // text appeared armed the nudge from an empty map. That is a real ordering
  // hazard, not just a flaky test: the user who clicks fastest is the one who
  // gets the wrong nudge.
  const resolvedToolsRef = useRef<ResolvedMap>({});

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

  const handleResolved = useCallback((id: FeaturedConnectionId, toolNames: string[] | null) => {
    resolvedToolsRef.current = { ...resolvedToolsRef.current, [id]: toolNames };
  }, []);

  /**
   * Derived here, at the moment Continue is pressed, rather than mirrored
   * upward from an effect as connections resolve. The nudge is armed from this
   * value, and reading it late is the only way to be sure it reflects every
   * connection that had finished resolving by the time the user committed.
   *
   * `resolvedToolsRef.current[id]` is `null` for anything short of a fully
   * introspected connection, and `?? []` folds that into "no tools to check" —
   * the same outcome a genuinely empty, connected tool list produces.
   * `hasCalendarTool` only ever sees names that actually resolved, so this
   * can't arm the calendar prompt off an unresolved or not-yet-connected row;
   * it can still be bypassed by a future call site that reaches into the ref
   * directly instead of going through this derivation.
   */
  const handleContinue = useCallback(() => {
    const resolved = resolvedToolsRef.current;
    onCalendarConnectedChange?.(
      FEATURED_CONNECTIONS.some((c) => hasCalendarTool(resolved[c.id] ?? [])),
    );
    onContinue();
  }, [onCalendarConnectedChange, onContinue]);

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
          onResolved={handleResolved}
        />
      ))}

      {exaCard}

      <div className="flex justify-end">
        <Button type="button" onClick={handleContinue}>
          Continue
        </Button>
      </div>
    </div>
  );
}
