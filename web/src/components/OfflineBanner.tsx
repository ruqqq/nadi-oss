import { WifiSlash } from "@/icons";
import { useOffline } from "@/lib/use-offline";

/**
 * Offline is read-only, and the app must say so — with a cached shell the UI
 * otherwise looks completely functional right up until a write silently fails.
 */
export function OfflineBanner() {
  const offline = useOffline();
  if (!offline) return null;

  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-border border-b bg-muted px-3 py-1.5 text-muted-foreground text-xs"
    >
      <WifiSlash className="size-3.5" />
      <span>Offline — showing your saved workspace. You can read, but not make changes.</span>
    </div>
  );
}
