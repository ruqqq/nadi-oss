import { Component, type ReactNode, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { StaleBundleNotice } from "@/components/StaleBundleNotice";
import { isChunkLoadError, recoverFromStaleBundle } from "@/lib/stale-bundle";
import { evictThreadHistory } from "@/lib/thread-history";
import { useOffline } from "@/lib/use-offline";

/**
 * The fallback shown when a thread's history load fails. It reads the live
 * offline state so the copy matches reality — the boundary is tripped by ANY
 * failed history fetch, which offline is guaranteed but which also happens on a
 * transient blip (a resume, a cellular↔wifi handoff) while genuinely online.
 * Calling it "offline" then would be a lie.
 *
 * It also auto-retries the moment connectivity returns, so a blip doesn't leave
 * the user stranded on a dead-end error screen. The escape hatch is the header's
 * own leading control (a Back arrow or the rail toggle, depending on where the
 * thread was opened from) — the same one every other thread carries.
 */
export function ThreadHistoryUnavailable({
  header,
  onRetry,
}: {
  header?: ReactNode;
  onRetry: () => void;
}) {
  const offline = useOffline();

  // Retry as soon as we come back online (offline → not-offline). Guarded on the
  // transition, not the current value, so a failure that happened while online
  // doesn't retry in a loop — the user taps "Try again" for that.
  const wasOffline = useRef(offline);
  useEffect(() => {
    if (wasOffline.current && !offline) onRetry();
    wasOffline.current = offline;
  }, [offline, onRetry]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {header}
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="font-display text-lg">
          {offline ? "This conversation isn't available offline" : "Couldn't load this conversation"}
        </p>
        <p className="max-w-sm text-muted-foreground text-sm">
          {offline
            ? "Nadi hasn't saved this conversation to your device. Reconnect to read it."
            : "Something went wrong reaching Nadi. Try again in a moment."}
        </p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * Catches a failed thread-history load. useAgentChat fetches history over HTTP
 * and suspends on it; without a boundary a rejection reaches the React root and
 * white-screens the app. Offline that rejection is guaranteed — Layer 1 caches
 * no message history.
 *
 * Must be a class: React has no hook equivalent for componentDidCatch. The
 * fallback UI lives in ThreadHistoryUnavailable so it can use hooks (offline
 * state + auto-retry).
 */
export class ThreadHistoryErrorBoundary extends Component<
  {
    children: ReactNode;
    threadId: string;
    onRetry: () => void;
    fallbackHeader?: ReactNode;
  },
  { failed: boolean; stale: boolean }
> {
  state = { failed: false, stale: false };

  static getDerivedStateFromError(error: unknown) {
    // The lazily-loaded ChatLog chunk renders under this boundary, so a deploy
    // under an open tab trips it — and "Couldn't load this conversation" would
    // be a lie whose Try again re-imports the same dead URL forever.
    return { failed: true, stale: isChunkLoadError(error) };
  }

  componentDidCatch(error: unknown) {
    if (isChunkLoadError(error)) {
      void recoverFromStaleBundle();
      return;
    }
    // The cached rejected promise has now been re-thrown by the retry render,
    // so it is safe to drop — and it must be dropped, or reopening this thread
    // (same reload nonce) would replay the rejection instead of refetching.
    // Evicting any earlier would send the retry render back to the network.
    evictThreadHistory(this.props.threadId);
  }

  // Stable identity so the fallback's auto-retry effect doesn't re-run every
  // render; reads the latest onRetry through this.props at call time.
  private handleRetry = () => {
    this.setState({ failed: false, stale: false });
    this.props.onRetry();
  };

  render() {
    if (!this.state.failed) return this.props.children;
    if (this.state.stale) return <StaleBundleNotice header={this.props.fallbackHeader} />;
    return (
      <ThreadHistoryUnavailable header={this.props.fallbackHeader} onRetry={this.handleRetry} />
    );
  }
}
