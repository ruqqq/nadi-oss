/**
 * Dev-only entry point for the mocked app (`mock.html?scenario=…`).
 *
 * Mirrors `main.tsx` exactly EXCEPT:
 *  - no `installServiceWorker()` — a real service worker intercepts requests
 *    ahead of MSW, so the mock would be bypassed for anything it precached.
 *  - no `initPostHog()` — visual QA must not emit analytics.
 *  - MSW is started and the store seeded BEFORE the first render.
 *
 * This module and everything under `src/mocks/` are excluded from the
 * production bundle: `index.html` never references them, and
 * `scripts/check-mock-isolation.mjs` fails the build if product code imports
 * them.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { IconContext } from "@phosphor-icons/react";
import "./fonts";
import "./index.css";
import App from "./App.tsx";
import { AppToaster } from "./components/ui/sonner";
import { ServiceWorkerUpdateToast } from "./components/ServiceWorkerUpdateToast";
import { TooltipProvider } from "./components/ui/tooltip";
import { installEdgeSwipeGuard } from "./lib/edge-swipe-guard";
import { startInstallPromptCapture } from "./lib/install-prompt";
import { BOOTSTRAP_CACHE_KEY, BOOTSTRAP_CACHE_VERSION } from "./lib/bootstrap-cache";
import { worker } from "./mocks/browser";
import { seedStore } from "./mocks/store";
import { useFakeThreadAgent, useFakeThreadChat } from "./mocks/chat/fake-thread-chat";
import { installLiveSocketStub } from "./mocks/live";
import { scheduleThreadActivityDemo } from "./mocks/thread-activity-demo";

const rootEl = document.getElementById("root");
if (!rootEl) throw new Error("Root element #root not found");

const params = new URLSearchParams(location.search);

if (params.get("theme") === "dark") {
  localStorage.setItem("nadi-theme", "dark");
  document.documentElement.classList.add("dark");
}

/**
 * Force the app to consider itself online.
 *
 * `lib/app-fetch.ts` rejects every non-GET/HEAD request with `OfflineError`
 * when `networkIsOnline()` is false — and it does so BEFORE the request ever
 * reaches MSW. A headless browser, a throttled devtools profile, or a laptop
 * that woke up with a stale `online` event would therefore make every mocked
 * mutation fail in a way that looks like a mock bug. Pinning `navigator.onLine`
 * removes that whole failure mode from visual QA.
 */
Object.defineProperty(navigator, "onLine", {
  configurable: true,
  get: () => true,
});

installEdgeSwipeGuard();

// Mirrors main.tsx: `beforeinstallprompt` fires once, early, so the mock app
// needs the same capture wired up for the onboarding install step to be
// exercisable at all (a synthetic dispatch in visual QA is otherwise inert).
startInstallPromptCapture();

const store = seedStore(params.get("scenario") ?? "default");

/**
 * Prime the synchronous bootstrap cache so first paint lands signed-in.
 *
 * This is not just an optimization here: it is what makes the shell render at
 * all before the REST handlers exist. The envelope shape and every field
 * checked below are enforced by `isBootstrapData` in `lib/bootstrap-cache.ts`
 * (current version) — a mismatch is silently discarded and the app renders signed-out.
 */
localStorage.setItem(
  BOOTSTRAP_CACHE_KEY,
  JSON.stringify({
    v: BOOTSTRAP_CACHE_VERSION,
    cachedAt: Date.now(),
    data: {
      session: store.session,
      settings: store.settings,
      threads: store.threads,
      threadsNextCursor: null,
      projects: store.projects,
      voiceEnabled: false,
      workersAiEnabled: false,
      feedbackAdminEnabled: store.features.feedbackAdmin,
      backgroundWorkEnabled: store.features.backgroundWork,
      agentNetworkAllowlistEnabled: store.features.agentNetworkAllowlist,
    },
  }),
);

await worker.start({
  onUnhandledRequest: "warn",
  quiet: false,
  serviceWorker: { url: "/mockServiceWorker.js" },
});

/**
 * Stub the `/live` user-hub WebSocket.
 *
 * MUST run AFTER `worker.start()`. MSW 2.x patches the global `WebSocket` when
 * the worker starts — installing before it means MSW clobbers this Proxy and
 * swallows `/live` itself, logging "intercepted a WebSocket connection without
 * a matching event handler" instead. Verified: install-before leaves the stub
 * inert; install-after wins.
 *
 * We deliberately do NOT use MSW's WebSocket interception — the design
 * intercepts REST only. This swaps `window.WebSocket` for a Proxy that fakes
 * `/live` and delegates every other URL to the native constructor.
 */
installLiveSocketStub();

// Scenario-driven live traffic. Must follow installLiveSocketStub(), and is a
// no-op for every scenario but its own.
scheduleThreadActivityDemo(params.get("scenario"), store);

createRoot(rootEl).render(
  <StrictMode>
    {/* Shared icon identity: bold weight echoes the monospace UI; size tracks text. */}
    <IconContext.Provider value={{ weight: "bold", size: "1em" }}>
      {/* App-root Tooltip context so any shadcn <Tooltip> works without a local
          provider — guards against the whole "must be used within
          TooltipProvider" crash class. Nested per-component providers are fine. */}
      <TooltipProvider>
        {/* The one injection point: the real chat seam is replaced by the
            scripted fake. Both hooks are supplied — the pair must stay a pair,
            since the dial runs outside the history Suspense boundary. */}
        <App
          threadChat={{
            useThreadAgent: useFakeThreadAgent,
            useThreadChat: useFakeThreadChat,
          }}
        />
      </TooltipProvider>
      <AppToaster />
      {/* After <AppToaster />, deliberately: sonner drops toasts fired before
          the Toaster subscribes, and sibling effects run in render order. */}
      <ServiceWorkerUpdateToast />
    </IconContext.Provider>
  </StrictMode>,
);
