import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Spinner } from "../ui/spinner";
import { Check } from "../../icons";
import type { FeaturedConnection } from "../../lib/featured-connections";
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
}: {
  connection: FeaturedConnection;
  icon: React.ReactNode;
  /** The existing server for this connection, or null if it isn't added yet. */
  server: McpServer | null;
  onAdded: (server: McpServer) => void;
}) {
  const [state, setState] = useState<FeaturedConnectionState>(server ? "unknown" : "not-added");
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

  const connect = useCallback(() => {
    if (state === "busy") return;
    setState("busy");
    setError(null);
    void (async () => {
      try {
        const target = server ?? (await createMcpServer({ name: connection.serverName, url: connection.url }));
        if (!server) onAdded(target);
        await resolve(target, true);
      } catch {
        setError("Couldn't connect just now. You can add this later in Settings.");
        setState(server ? "needs-auth" : "not-added");
      }
    })();
  }, [state, server, connection, onAdded, resolve]);

  // A server that already exists needs one read to learn which state it is in.
  // In an effect, not during render — `resolve` calls the network and sets
  // state, and a render-phase call would fire again on every re-render.
  const probedRef = useRef(false);
  useEffect(() => {
    if (!server || probedRef.current) return;
    probedRef.current = true;
    void resolve(server, false).catch(() => setState("needs-auth"));
  }, [server, resolve]);

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
