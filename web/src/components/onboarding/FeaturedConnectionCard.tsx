import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Spinner } from "../ui/spinner";
import { Check } from "../../icons";
import type { FeaturedConnection, FeaturedConnectionId } from "../../lib/featured-connections";
import { MCP_RETURN_PATH_KEY } from "../../lib/settings-routes";
import { onboardingStepPath } from "../../lib/onboarding";
import {
  authorizeMcpServer,
  createMcpServer,
  listMcpServerTools,
  type McpServer,
} from "../../mcp-api";

export type FeaturedConnectionState = "unknown" | "not-added" | "busy" | "needs-auth" | "connected";

export function FeaturedConnectionCard({
  connection,
  icon,
  server,
  onAdded,
  onStateChange,
}: {
  connection: FeaturedConnection;
  icon: React.ReactNode;
  /**
   * The existing server for this connection: `undefined` while the list is
   * still loading, `null` once it has loaded and there is no row. The
   * distinction is load-bearing — returning from OAuth consent reloads the
   * page, and a card that read a still-loading list as "not added" would offer
   * Connect to the user who just authorized, creating a second server row.
   */
  server: McpServer | null | undefined;
  onAdded: (server: McpServer) => void;
  /**
   * The card's RESOLVED state, lifted so the wizard can tell an authorized
   * connection from a row that merely exists.
   */
  onStateChange?: (connectionId: FeaturedConnectionId, state: FeaturedConnectionState) => void;
}) {
  const [state, setState] = useState<FeaturedConnectionState>(
    server === null ? "not-added" : "unknown",
  );
  const [toolCount, setToolCount] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /** Reads the server's live state; starts consent when it needs authorizing. */
  const resolve = useCallback(
    async (target: McpServer, startAuth: boolean) => {
      const { needsAuth, tools } = await listMcpServerTools(target.id);
      if (!needsAuth) {
        setToolCount(tools.length);
        setState("connected");
        return;
      }
      if (!startAuth) {
        setState("needs-auth");
        return;
      }
      const result = await authorizeMcpServer(target.id);
      if (result.authUrl) {
        // Consent is a full-page redirect. Stash where to come back to — the
        // wizard's own step — or the user lands at the app root with a server
        // that was added and never authorized.
        sessionStorage.setItem(MCP_RETURN_PATH_KEY, onboardingStepPath("empower"));
        window.location.href = result.authUrl;
        return;
      }
      // Already authorized server-side (no OAuth, or credentials cached).
      const after = await listMcpServerTools(target.id);
      setToolCount(after.tools.length);
      setState(after.needsAuth ? "needs-auth" : "connected");
    },
    [],
  );

  // Guards two different kinds of reentrancy:
  // - `busyRef` makes "one connect at a time" a synchronous invariant instead
  //   of leaning on `disabled` + React's click scheduling.
  // - `probedRef` remembers every server id this card has already resolved
  //   (via either `connect` or the mount probe below), keyed by id rather
  //   than a plain boolean, so it survives the `server` prop flipping from
  //   `null` to the row `connect` itself just created.
  const busyRef = useRef(false);
  const probedRef = useRef<Set<string>>(new Set());

  const connect = useCallback(() => {
    if (busyRef.current) return;
    busyRef.current = true;
    setState("busy");
    setError(null);
    void (async () => {
      let target = server;
      try {
        if (!target) {
          target = await createMcpServer({ name: connection.serverName, url: connection.url });
          // Mark before `onAdded` so the mount-probe effect — which re-runs
          // once the parent's server list update flows back into `server` —
          // sees this id as already handled and does not issue a second,
          // overlapping `resolve()` while this one is still in flight.
          probedRef.current.add(target.id);
          onAdded(target);
        }
        await resolve(target, true);
      } catch {
        setError("Couldn't connect just now. You can add this later in Settings.");
        // `target` is set whenever a server row exists — either it was
        // already there, or creation above succeeded and only the resolve/
        // authorize step failed. Only a null `target` means creation itself
        // never happened. (Checking the `target` local, not the `server`
        // prop, matters here: the prop is a stale closure over the
        // pre-`onAdded` value for a row this same call just created.)
        setState(target ? "needs-auth" : "not-added");
      } finally {
        busyRef.current = false;
      }
    })();
  }, [server, connection, onAdded, resolve]);

  // A server that already exists needs one read to learn which state it is in.
  // In an effect, not during render — `resolve` calls the network and sets
  // state, and a render-phase call would fire again on every re-render.
  useEffect(() => {
    // Still loading: stay "unknown" so the button reads Connect but cannot be
    // pressed.
    if (server === undefined) return;
    if (server === null) {
      // The list resolved with no row for this connection. Only leave the
      // loading state — never clobber a state a click already moved us to.
      setState((current) => (current === "unknown" ? "not-added" : current));
      return;
    }
    if (probedRef.current.has(server.id)) return;
    probedRef.current.add(server.id);
    void resolve(server, false).catch(() => setState("needs-auth"));
  }, [server, resolve]);

  useEffect(() => {
    onStateChange?.(connection.id, state);
  }, [connection.id, state, onStateChange]);

  return (
    <Card className="gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display font-semibold text-base">{connection.title}</h3>
          <p className="mt-0.5 text-muted-foreground text-sm">{connection.pitch}</p>
        </div>
      </div>
      <div className="flex items-center justify-between gap-3">
        <span className="truncate font-mono text-muted-foreground text-xs">{connection.url}</span>
        {state === "connected" ? (
          <span className="flex shrink-0 items-center gap-1.5 text-approve text-sm">
            <Check aria-hidden />
            Connected · {toolCount} {toolCount === 1 ? "tool" : "tools"}
          </span>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={connect}
            disabled={state === "busy" || state === "unknown"}
            aria-busy={state === "busy"}
            className="shrink-0"
          >
            {state === "busy" ? <Spinner /> : null}
            {state === "needs-auth" ? "Authorize" : "Connect"}
          </Button>
        )}
      </div>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}
