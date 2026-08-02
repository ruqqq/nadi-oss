/**
 * Microphone permission, handled BEFORE a recording session ever starts.
 *
 * `startCall()` calls getUserMedia every time (voice-client.js #startMic), so a
 * mic that has not been granted yet raises the browser's permission dialog INSIDE
 * the recording window — on iOS especially, where WebKit does not persist the
 * grant and a resumed standalone PWA is a fresh document. That dialog would eat
 * the speech budget and stream silence to the transcriber while it sits open.
 */
export type MicPermission = "granted" | "denied" | "prompt" | "unknown";

/**
 * Safari's support for the "microphone" descriptor is inconsistent: the call may
 * be absent, throw, or resolve with a state we don't recognise. All of those are
 * "unknown", which is handled exactly like "prompt" — preflight, don't record.
 */
export async function queryMicPermission(): Promise<MicPermission> {
  try {
    const status = await navigator.permissions?.query({
      name: "microphone" as PermissionName,
    });
    const state = status?.state;
    return state === "granted" || state === "denied" || state === "prompt" ? state : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Raises the permission dialog on our terms and releases the mic immediately, so
 * the grant exists before any recording starts. Returns false if the user (or the
 * platform) refused — the caller treats that as blocked.
 */
export async function preflightMic(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return true;
  } catch {
    return false;
  }
}
