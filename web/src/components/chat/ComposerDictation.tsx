import {
  type Ref,
  type RefObject,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Microphone } from "@/icons";
import { preflightMic, queryMicPermission } from "@/lib/mic-permission";
import { useDictation, VOICE_MAX_SECONDS } from "@/lib/use-dictation";
import { cn } from "@/lib/utils";
import {
  applyVoiceText,
  beginVoiceRange,
  cancelVoiceRange,
  type VoiceRange,
} from "@/lib/voice-range";
import { RecordingBar } from "./RecordingBar";

export type DictationHandle = {
  /** Hardens the in-flight phrase into the textarea and ends the session, keeping
   *  every word. The composer calls this before submitting, so speaking and then
   *  hitting send never drops the last thing you said. Synchronous with respect to
   *  the textarea's DOM value, which is what the form reads on submit. */
  stopAndKeep: () => void;
};

/** The library's copy when getUserMedia rejects (voice-client.js #startMic). It
 *  catches the rejection and emits an `error` event — startCall() still resolves,
 *  so a try/catch around start() would never see it. */
const MIC_DENIED = "microphone access denied";

const MIC_BLOCKED_COPY = "Microphone access is blocked. Enable it in your browser's site settings.";

/**
 * The whole dictation surface: the mic button, the recording bar, and the
 * bookkeeping that streams transcripts into the composer's textarea.
 *
 * This is a separate component because `useVoiceInput` opens its WebSocket (and
 * spins up the VoiceAgent DO) from a mount effect. Calling it in the Composer
 * would connect for every user on every composer mount, flag off or not — so the
 * feature flag has to gate a MOUNT, not a render branch.
 */
export function ComposerDictation({
  textareaRef,
  writeTextarea,
  disabled,
  onListeningChange,
  onWordsChange,
  controlRef,
}: {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Writes text through the composer's input-event path (keeps drafts in sync). */
  writeTextarea: (next: string) => void;
  disabled: boolean;
  onListeningChange: (listening: boolean) => void;
  /** Whether any words have been heard yet, INCLUDING the in-flight phrase. The
   *  composer gates its send button on this: finals land in the textarea, but the
   *  first second or two of speech exists only as interim, and a send blocked
   *  because "there's no text" would be a lie. */
  onWordsChange?: (hasWords: boolean) => void;
  /** Lets the composer end dictation from its own send path (see DictationHandle). */
  controlRef?: Ref<DictationHandle>;
}) {
  const voiceRangeRef = useRef<VoiceRange | null>(null);
  const [micBlocked, setMicBlocked] = useState(false);
  // Between the tap and the library reporting "listening" there is real work —
  // the permission sheet, a second getUserMedia, the AudioContext, and a server
  // round-trip (isListening only flips on the DO's status message). The button
  // pulses through that window so the tap visibly took.
  const [starting, setStarting] = useState(false);
  // True between start() and any end (stop / cancel / cap / idle / error), so an
  // error raised while nobody is dictating doesn't toast at the user.
  const armedRef = useRef(false);
  const lastErrorRef = useRef<string | null>(null);
  // A preflight we ran ourselves in THIS foreground session. Browsers whose
  // Permissions API can't answer for the microphone (Safari) would otherwise
  // preflight on every tap and never record. Cleared when the page is backgrounded,
  // because that is exactly when iOS drops the grant.
  const micReadyRef = useRef(false);

  // Every exit from recording hands the caret back to the textarea, so the user
  // lands where they review and edit — whether they stopped, cancelled, hit the
  // cap, or the mic heard nothing.
  const dictation = useDictation({
    onStopped: () => {
      finalize();
      armedRef.current = false;
      textareaRef.current?.focus();
      toast(`${VOICE_MAX_SECONDS} second maximum per voice entry.`);
    },
    onIdle: () => {
      armedRef.current = false;
      voiceRangeRef.current = null;
      textareaRef.current?.focus();
      toast("Nadi didn't hear anything, so the mic is off. Tap the mic to try again.");
    },
    // Spoke, then went quiet: finish exactly as Stop does — keep the words, no
    // toast (this is the expected end of a dictation, not an interruption).
    onSilence: () => {
      finalize();
      armedRef.current = false;
      textareaRef.current?.focus();
    },
  });

  useEffect(() => {
    const onHide = () => {
      micReadyRef.current = false;
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);

  /** Hardens the in-flight phrase into the textarea. The end-call path has no
   *  flush, so without this the last 1-3 seconds of speech are destroyed. */
  const finalize = () => {
    const range = voiceRangeRef.current;
    const el = textareaRef.current;
    const interim = dictation.interim.trim();
    if (!range || !el) return;
    if (interim) {
      const finals = dictation.transcript;
      const applied = applyVoiceText(el.value, range, finals ? `${finals} ${interim}` : interim);
      voiceRangeRef.current = applied.range;
      if (applied.text !== el.value) writeTextarea(applied.text);
    }
    voiceRangeRef.current = null;
  };

  // Stream accumulated finals into the textarea as real, editable text.
  useEffect(() => {
    const range = voiceRangeRef.current;
    const el = textareaRef.current;
    if (!range || !el || !dictation.isListening) return;
    const applied = applyVoiceText(el.value, range, dictation.transcript);
    voiceRangeRef.current = applied.range;
    if (applied.text !== el.value) writeTextarea(applied.text);
  }, [dictation.transcript, dictation.isListening]);

  // Backstop: a half-open socket can leave startCall() hanging with no error
  // event and no "listening" status. Re-arm the button rather than wedge it.
  useEffect(() => {
    if (!starting) return;
    const t = setTimeout(() => setStarting(false), 15_000);
    return () => clearTimeout(t);
  }, [starting]);

  // Layout effect so the parent hides the footer's idle controls (model badge,
  // attach) in the SAME paint that swaps the mic button for the recording bar —
  // a passive effect painted one frame of both crammed into the row.
  useLayoutEffect(() => {
    onListeningChange(dictation.isListening);
    if (dictation.isListening) setStarting(false);
  }, [dictation.isListening, onListeningChange]);

  // Interim counts: the finals are already in the textarea, but the first second
  // or two of speech exists only as the in-flight phrase.
  const hasWords = dictation.transcript.trim().length > 0 || dictation.interim.trim().length > 0;
  useEffect(() => {
    onWordsChange?.(dictation.isListening && hasWords);
  }, [dictation.isListening, hasWords, onWordsChange]);

  const endWithError = (message: string) => {
    setStarting(false);
    armedRef.current = false;
    // Keep the finals already in the textarea; only the range bookkeeping goes.
    voiceRangeRef.current = null;
    dictation.stop();
    toast(message);
  };

  // The mic is never denied loudly: the client swallows the rejection and emits
  // an error event, leaving a pulsing mic and a running clock over dead air.
  useEffect(() => {
    const error = dictation.error;
    if (!error) {
      lastErrorRef.current = null;
      return;
    }
    if (error === lastErrorRef.current || !armedRef.current) return;
    lastErrorRef.current = error;
    if (error.toLowerCase().includes(MIC_DENIED)) {
      setMicBlocked(true);
      endWithError(MIC_BLOCKED_COPY);
    } else {
      endWithError("Dictation stopped — Nadi couldn't reach the voice service. Try again.");
    }
  }, [dictation.error]);

  /**
   * The mic tap. Permission is settled BEFORE any recording: the library's
   * startCall() calls getUserMedia itself, so an ungranted mic would raise the
   * browser's dialog inside the recording window — burning the speech budget and
   * streaming silence while it sits open. An already-granted mic records on this
   * single tap; anything else preflights first, then records on the same tap.
   */
  const handleMicTap = async () => {
    setStarting(true);
    if (micReadyRef.current) {
      await startDictation();
      return;
    }
    const permission = await queryMicPermission();
    if (permission === "granted") {
      micReadyRef.current = true;
      await startDictation();
      return;
    }
    if (permission === "denied") {
      setStarting(false);
      setMicBlocked(true);
      toast(MIC_BLOCKED_COPY);
      return;
    }
    // "prompt" or unknown: raise the dialog on our terms, then start recording the
    // moment the grant lands — a second tap would be pure friction. On iOS this is
    // the every-launch path (WebKit never persists the grant for a standalone PWA),
    // so the single tap has to flow through the permission sheet into recording.
    // Safe because the speech budget arms on first audio, not here.
    if (await preflightMic()) {
      micReadyRef.current = true;
      await startDictation();
    } else {
      setStarting(false);
      setMicBlocked(true);
      toast(MIC_BLOCKED_COPY);
    }
  };

  const startDictation = async () => {
    const el = textareaRef.current;
    voiceRangeRef.current = beginVoiceRange(el?.value ?? "");
    armedRef.current = true;
    try {
      await dictation.start();
    } catch {
      endWithError("Dictation couldn't start. Try again.");
    }
  };

  const stopDictation = () => {
    finalize();
    armedRef.current = false;
    dictation.stop();
    textareaRef.current?.focus();
  };

  useImperativeHandle(controlRef, () => ({ stopAndKeep: stopDictation }));

  const cancelDictation = () => {
    const range = voiceRangeRef.current;
    const el = textareaRef.current;
    armedRef.current = false;
    voiceRangeRef.current = null;
    dictation.cancel();
    if (range && el) writeTextarea(cancelVoiceRange(el.value, range));
    el?.focus();
  };

  if (dictation.isListening) {
    return (
      <RecordingBar
        elapsedMs={dictation.elapsedMs}
        audioLevel={dictation.audioLevel}
        interim={dictation.interim}
        onCancel={cancelDictation}
        onStop={stopDictation}
      />
    );
  }

  if (micBlocked) return null;

  // Same primitive as the attach button: secondary composer actions are ghost
  // icon buttons, and the primitive is what carries the focus ring.
  return (
    <PromptInputButton
      onClick={handleMicTap}
      disabled={disabled || starting}
      aria-label={starting ? "Starting dictation" : "Dictate"}
    >
      <Microphone className={cn("size-4", starting && "animate-pulse text-gate")} />
    </PromptInputButton>
  );
}
