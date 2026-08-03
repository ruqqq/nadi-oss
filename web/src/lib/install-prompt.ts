/**
 * `beforeinstallprompt` fires ONCE, early — typically before React has mounted,
 * and always before the onboarding wizard renders. The listener is attached at
 * app startup (main.tsx) and the event stashed, because there is no way to ask
 * for it again: miss it and the install button has nothing to call.
 */
export type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

let deferred: InstallPromptEvent | null = null;
let installed = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** Idempotent — safe under StrictMode's double-invoke and a hot reload. */
let started = false;
export function startInstallPromptCapture(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    // Suppressing the browser's own mini-infobar is the point: the wizard's
    // install step is where we ask, so two prompts would compete.
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    notify();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferred = null;
    notify();
  });
}

export function getInstallPrompt(): InstallPromptEvent | null {
  return deferred;
}

export function wasInstalledThisSession(): boolean {
  return installed;
}

/** Clears the stashed event after use — it can only be prompted once. */
export function consumeInstallPrompt(): void {
  deferred = null;
  notify();
}

export function subscribeInstallPrompt(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
