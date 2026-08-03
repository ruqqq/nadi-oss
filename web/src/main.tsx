import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import "./fonts";
import "./index.css";
import App from "./App.tsx";
import { initPostHog } from "./lib/posthog";
import { AppToaster } from "./components/ui/sonner";
import { ServiceWorkerUpdateToast } from "./components/ServiceWorkerUpdateToast";
import { TooltipProvider } from "./components/ui/tooltip";
import { installServiceWorker } from "./lib/register-sw";
import { installEdgeSwipeGuard } from "./lib/edge-swipe-guard";
import { installStaleBundleRecovery } from "./lib/stale-bundle";
import { startInstallPromptCapture } from "./lib/install-prompt";
import { RootErrorBoundary } from "./components/RootErrorBoundary";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

// Registers the app's one service worker (shell precache + push) and makes it
// the single update mechanism: a new build activates immediately and the page
// reloads onto it.
installServiceWorker();

// A deploy under an open tab leaves it asking for chunks that no longer exist.
// Catch the ones that never reach a React boundary (Vite preload failures, an
// import that rejects outside render) and recover onto the new build.
installStaleBundleRecovery();

// In an installed PWA, cancel the OS edge-swipe history navigation (back/forward)
// so it can't fire under the app's own gestures. No-op in a browser tab.
installEdgeSwipeGuard();

// `beforeinstallprompt` fires once, early — before the wizard's install step
// exists to use it. Capture it now or it's gone.
startInstallPromptCapture();

const posthogKey = import.meta.env.VITE_POSTHOG_KEY;

initPostHog({
  key: posthogKey,
  host: import.meta.env.VITE_POSTHOG_HOST,
});

createRoot(rootEl).render(
  <StrictMode>
    {/* Shared icon identity: bold weight echoes the monospace UI; size tracks text. */}
    <IconContext.Provider value={{ weight: "bold", size: "1em" }}>
      {/* App-root Tooltip context so any shadcn <Tooltip> works without a local
          provider — guards against the whole "must be used within
          TooltipProvider" crash class. Nested per-component providers are fine. */}
      <TooltipProvider>
        {/* Last line of defence: a missing chunk (deployed under this tab) used
            to reject past every Suspense boundary and white-screen the app. */}
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </TooltipProvider>
      <AppToaster />
      {/* After <AppToaster />, deliberately: sonner drops toasts fired before
          the Toaster subscribes, and sibling effects run in render order. */}
      <ServiceWorkerUpdateToast />
    </IconContext.Provider>
  </StrictMode>,
);
