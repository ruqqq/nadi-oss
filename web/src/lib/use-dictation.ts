import { useCallback, useEffect, useRef, useState } from "react";
import { useVoiceInput } from "@cloudflare/voice/react";

/** Hard cap per voice entry, counted from the first sound. Product requirement. */
export const VOICE_MAX_SECONDS = 60;

/**
 * Mic open on dead air for this long ends the session. Cost control, not product:
 * the client streams EVERY worklet chunk (voice-client.js:645-652 — the silence
 * detector only emits end_of_speech and drives the meter, it does not gate the
 * audio), so silence is transcribed and billed. Once the speech budget no longer
 * arms at tap, this is what stops a pocketed phone from streaming forever.
 */
export const VOICE_IDLE_SECONDS = 5;

/** Clock repaint cadence. The limits themselves are deadlines, not tick counts. */
const TICK_MS = 100;

/**
 * RMS above which we call it audio activity. Matches the client's own
 * `silenceThreshold` default (voice-client.js:159) — the level at which the
 * library itself declares start_of_speech.
 */
const ACTIVITY_LEVEL = 0.04;

/**
 * How long a dictation may sit in silence *after* the user has spoken before it
 * finalizes itself. Long enough to survive a thinking pause mid-sentence, short
 * enough that a finished speaker doesn't have to reach for Stop (and doesn't
 * keep streaming billable dead air).
 */
export const VOICE_TRAILING_SILENCE_SECONDS = 8;

/**
 * Dictation for the composer: `useVoiceInput` plus two independent limits and an
 * elapsed clock. Recording is continuous — a silence pause finalizes an
 * utterance but never ends the session. Only stop(), the speech cap or the idle
 * cutoff end it.
 *
 * Two facts about the library shape this hook:
 *
 * 1. `useVoiceInput().transcript` is recomputed from EVERY utterance the client
 *    has received since mount. `startCall()` does not reset it and `clear()`
 *    only blanks the React string, not the client's append-only array. So a
 *    per-dictation transcript has to come from a baseline captured in start().
 * 2. The hook returns a fresh object literal on every render, so nothing may
 *    depend on its identity — a cap effect that did would be torn down and
 *    recreated on every audio-level render and never get to fire.
 *
 * The speech budget arms on the first audio activity, not at tap: `startCall()`
 * calls getUserMedia every time, so arming at tap spent the user's 30 seconds on
 * lead-in silence and (on iOS) on the permission dialog.
 */
export function useDictation({
  onStopped,
  onIdle,
  onSilence,
}: {
  onStopped: () => void;
  onIdle: () => void;
  /** The user spoke, then went quiet: finalize and keep what was said. */
  onSilence?: () => void;
}) {
  const voice = useVoiceInput({ agent: "voice-agent" });
  const [elapsedMs, setElapsedMs] = useState(0);
  const deadlineRef = useRef<number | null>(null);
  const idleDeadlineRef = useRef<number | null>(null);
  // Whether this dictation has heard anything yet. State (not just a ref) because
  // it flips the timer effect from the idle cutoff to the speech budget.
  const [speaking, setSpeaking] = useState(false);
  const speakingRef = useRef(false);
  // Bumped on every start() so the timer effect re-runs and picks up the fresh
  // deadlines even when isListening was already true.
  const [session, setSession] = useState(0);
  // The client's accumulated transcript as of this dictation's start(). Whatever
  // lies beyond it is what the user has said since.
  const baselineRef = useRef("");
  // The in-flight phrase left over from a previous dictation. The library only
  // blanks interimTranscript when a phrase FINALIZES (voice-client.js:403) —
  // neither startCall() nor endCall() resets it — so cancelling (or stopping)
  // mid-phrase strands it. Left alone it would render as this dictation's interim
  // AND count as speech, arming the budget and killing the idle cutoff before the
  // user has said anything. Suppressed until a different value arrives.
  const staleInterimRef = useRef<string | null>(null);
  // Latest values without making anything depend on `voice`'s identity.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  const onStoppedRef = useRef(onStopped);
  onStoppedRef.current = onStopped;
  const onIdleRef = useRef(onIdle);
  onIdleRef.current = onIdle;
  const onSilenceRef = useRef(onSilence);
  onSilenceRef.current = onSilence;
  // When we last heard anything. Drives the trailing-silence cutoff. Note this
  // must be *change* detection: `transcript !== baseline` stays true forever once
  // the user has spoken, so it says "has spoken", not "is still speaking".
  const lastActivityRef = useRef<number | null>(null);
  const prevTranscriptRef = useRef("");
  const prevInterimRef = useRef("");

  const stop = useCallback(() => {
    deadlineRef.current = null;
    idleDeadlineRef.current = null;
    speakingRef.current = false;
    setSpeaking(false);
    voiceRef.current.stop();
  }, []);

  const start = useCallback(async () => {
    baselineRef.current = voiceRef.current.transcript;
    staleInterimRef.current = voiceRef.current.interimTranscript ?? null;
    lastActivityRef.current = null;
    prevTranscriptRef.current = voiceRef.current.transcript;
    prevInterimRef.current = "";
    setElapsedMs(0);
    deadlineRef.current = null;
    speakingRef.current = false;
    setSpeaking(false);
    idleDeadlineRef.current = Date.now() + VOICE_IDLE_SECONDS * 1000;
    setSession((s) => s + 1);
    await voiceRef.current.start();
  }, []);

  const cancel = useCallback(() => {
    stop();
    // Advancing the baseline past everything spoken so far is what makes the
    // cancelled words stay gone — the library's clear() would not.
    baselineRef.current = voiceRef.current.transcript;
  }, [stop]);

  // A phrase stranded by the previous dictation reads as neither text nor speech
  // until the server sends a different one.
  const rawInterim = voice.interimTranscript ?? "";
  const interim = rawInterim !== "" && rawInterim === staleInterimRef.current ? "" : rawInterim;
  if (interim !== "") staleInterimRef.current = null;

  // First audio activity arms the speech budget and disarms the idle cutoff. The
  // level is the primary signal: it comes straight off the worklet every ~100ms,
  // while an interim transcript needs a server round-trip and would both delay
  // the budget and risk arriving after the idle cutoff. Transcript text is a
  // secondary signal, so a very quiet speaker whose RMS never crosses the
  // threshold still cannot be cut off as idle.
  useEffect(() => {
    if (!voice.isListening || speakingRef.current) return;
    const heard =
      voice.audioLevel >= ACTIVITY_LEVEL ||
      interim !== "" ||
      voice.transcript !== baselineRef.current;
    if (!heard) return;
    speakingRef.current = true;
    idleDeadlineRef.current = null;
    deadlineRef.current = Date.now() + VOICE_MAX_SECONDS * 1000;
    setSpeaking(true);
  }, [voice.isListening, voice.audioLevel, voice.transcript, interim, session]);

  // Refresh the trailing-silence clock on any sign of life: a loud enough level,
  // or new text from the server (which covers a speaker too quiet to cross the
  // RMS threshold).
  useEffect(() => {
    if (!voice.isListening) return;
    const changed =
      voice.transcript !== prevTranscriptRef.current || interim !== prevInterimRef.current;
    prevTranscriptRef.current = voice.transcript;
    prevInterimRef.current = interim;
    if (voice.audioLevel >= ACTIVITY_LEVEL || changed) lastActivityRef.current = Date.now();
  }, [voice.isListening, voice.audioLevel, voice.transcript, interim]);

  useEffect(() => {
    if (!voice.isListening) return;

    // Nothing heard yet: the only live limit is the idle cutoff.
    if (!speaking) {
      if (idleDeadlineRef.current === null) return;
      // The window measures dead air the user can act on, so it starts when the
      // mic is actually live — not at start(), whose deadline the connection
      // handshake (and the effect only running once isListening flips) eats into.
      idleDeadlineRef.current = Date.now() + VOICE_IDLE_SECONDS * 1000;
      const idleAt = idleDeadlineRef.current;
      const idle = setTimeout(
        () => {
          idleDeadlineRef.current = null;
          voiceRef.current.stop();
          onIdleRef.current();
        },
        Math.max(idleAt - Date.now(), 0),
      );
      return () => clearTimeout(idle);
    }

    const end = deadlineRef.current;
    if (end === null) return;
    // The cap is one timer against a wall-clock deadline; the interval only
    // repaints the clock, so a starved or late tick cannot extend a recording.
    const cap = setTimeout(
      () => {
        deadlineRef.current = null;
        voiceRef.current.stop();
        onStoppedRef.current();
      },
      Math.max(end - Date.now(), 0),
    );
    const clock = setInterval(() => {
      const at = deadlineRef.current;
      if (at === null) return;
      setElapsedMs(VOICE_MAX_SECONDS * 1000 - Math.max(at - Date.now(), 0));

      // Sample the level on the tick rather than trusting the render cadence:
      // the silence clock must not depend on React choosing to re-render.
      if (voiceRef.current.audioLevel >= ACTIVITY_LEVEL) lastActivityRef.current = Date.now();

      // Trailing silence: the user spoke, then stopped. Checked on the tick
      // rather than as a timer because every utterance pushes the deadline out.
      // The cap above remains the authority — a starved tick can only make this
      // fire late, never extend the recording past 30s.
      const last = lastActivityRef.current;
      if (last !== null && Date.now() - last >= VOICE_TRAILING_SILENCE_SECONDS * 1000) {
        deadlineRef.current = null;
        lastActivityRef.current = null;
        voiceRef.current.stop();
        onSilenceRef.current?.();
      }
    }, TICK_MS);

    return () => {
      clearTimeout(cap);
      clearInterval(clock);
    };
  }, [voice.isListening, speaking, session]);

  // Only what has been said since this dictation started; `voice.transcript`
  // still carries every earlier utterance (see the note above).
  const accumulated = voice.transcript;
  const baseline = baselineRef.current;
  const transcript = accumulated.startsWith(baseline)
    ? accumulated.slice(baseline.length).trimStart()
    : accumulated;

  return {
    isListening: voice.isListening,
    transcript,
    interim,
    audioLevel: voice.audioLevel,
    elapsedMs,
    error: voice.error,
    start,
    stop,
    cancel,
  };
}
