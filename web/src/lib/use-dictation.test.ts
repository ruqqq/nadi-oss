// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

/**
 * The real `useVoiceInput` returns a FRESH object literal on every render, and
 * its `transcript` is recomputed from every utterance the client has ever seen
 * — it is never reset between calls (`clear()` only blanks the React string,
 * not the client's append-only array, and `startCall()` does not reset it).
 * The mock reproduces both, or the hook's bugs are invisible to the tests.
 */
const voiceState = {
  transcript: "",
  interimTranscript: null as string | null,
  isListening: false,
  audioLevel: 0,
  error: null as string | null,
};

const start = vi.fn(async () => {
  voiceState.isListening = true;
});
const stop = vi.fn(() => {
  voiceState.isListening = false;
});
const clear = vi.fn(); // the library's clear(): does NOT touch the client's transcript

vi.mock("@cloudflare/voice/react", () => ({
  useVoiceInput: () => ({
    transcript: voiceState.transcript,
    interimTranscript: voiceState.interimTranscript,
    isListening: voiceState.isListening,
    audioLevel: voiceState.audioLevel,
    isMuted: false,
    error: voiceState.error,
    start,
    stop,
    toggleMute: vi.fn(),
    clear,
  }),
}));

import {
  useDictation,
  VOICE_IDLE_SECONDS,
  VOICE_MAX_SECONDS,
  VOICE_TRAILING_SILENCE_SECONDS,
} from "./use-dictation";

/** Above the client's silenceThreshold (0.04) — i.e. the library would call it speech. */
const SPEECH_LEVEL = 0.3;

/** The worklet reporting a level the library would call speech. */
function speak(rerender: () => void) {
  voiceState.audioLevel = SPEECH_LEVEL;
  rerender();
}

describe("useDictation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    voiceState.transcript = "";
    voiceState.interimTranscript = null;
    voiceState.isListening = false;
    voiceState.audioLevel = 0;
    voiceState.error = null;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("exposes the cap as 60 seconds", () => {
    expect(VOICE_MAX_SECONDS).toBe(60);
  });

  it("caps a recording at the max seconds of speech", async () => {
    const onStopped = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped, onIdle: vi.fn() }));
    await act(async () => {
      await result.current.start();
    });
    act(() => {
      speak(rerender);
    });

    act(() => {
      vi.advanceTimersByTime((VOICE_MAX_SECONDS - 1) * 1000);
    });
    expect(stop).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  // D1: the budget used to be armed at tap, so lead-in silence — and, on iOS, the
  // permission dialog — ate the user's speech time.
  it("does not start the speech budget until audio activity begins", async () => {
    const onStopped = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped, onIdle: vi.fn() }));
    await act(async () => {
      await result.current.start();
    });

    // 4s of silence (inside the idle cutoff), then the user starts talking.
    act(() => {
      vi.advanceTimersByTime(4000);
      rerender();
    });
    expect(stop).not.toHaveBeenCalled();
    expect(result.current.elapsedMs).toBe(0);

    act(() => {
      speak(rerender);
    });

    // A full 30 seconds of speech is still available from that moment.
    act(() => {
      vi.advanceTimersByTime((VOICE_MAX_SECONDS - 1) * 1000);
    });
    expect(stop).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  // D2 cost backstop: silence is streamed and billed (voice-client.js:645-652 sends
  // every chunk), so a mic left open on dead air has to close itself.
  it("stops after 5 seconds with no audio activity", async () => {
    const onStopped = vi.fn();
    const onIdle = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped, onIdle }));
    await act(async () => {
      await result.current.start();
    });
    rerender();

    act(() => {
      vi.advanceTimersByTime((VOICE_IDLE_SECONDS - 1) * 1000);
    });
    expect(stop).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(onIdle).toHaveBeenCalledTimes(1);
    expect(onStopped).not.toHaveBeenCalled();
  });

  it("does not apply the idle cutoff once the user has spoken", async () => {
    const onIdle = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped: vi.fn(), onIdle }));
    await act(async () => {
      await result.current.start();
    });

    act(() => {
      speak(rerender);
    });
    // A pause past the 5s idle cutoff (but inside the 8s trailing-silence limit)
    // must not end the session: once the user has spoken, idle no longer applies.
    act(() => {
      voiceState.audioLevel = 0;
      rerender();
      vi.advanceTimersByTime((VOICE_IDLE_SECONDS + 2) * 1000);
    });

    expect(stop).not.toHaveBeenCalled();
    expect(onIdle).not.toHaveBeenCalled();
  });

  // C2: the audio worklet re-renders the component at roughly the tick period.
  // An interval torn down and recreated on every render is starved, so the cap
  // fires arbitrarily late or never — the mic stays hot and the STT keeps billing.
  it("still fires the cap when renders arrive at the tick cadence", async () => {
    const onStopped = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped, onIdle: vi.fn() }));
    await act(async () => {
      await result.current.start();
    });

    // Just over the cap in "audio level" renders, each just under the 100ms tick period.
    for (let elapsed = 0; elapsed < (VOICE_MAX_SECONDS + 1) * 1000; elapsed += 99) {
      act(() => {
        voiceState.audioLevel = (voiceState.audioLevel + 0.1) % 1;
        rerender();
        vi.advanceTimersByTime(99);
      });
    }

    expect(stop).toHaveBeenCalled();
    expect(onStopped).toHaveBeenCalledTimes(1);
  });

  // C1: stop → restart must not re-emit the previous dictation's words.
  it("does not duplicate the previous dictation after stop then restart", async () => {
    const { result, rerender } = renderHook(() =>
      useDictation({ onStopped: vi.fn(), onIdle: vi.fn() }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      voiceState.transcript = "hello world";
      rerender();
    });
    expect(result.current.transcript).toBe("hello world");

    act(() => {
      result.current.stop();
      rerender();
    });

    // Restart: the client's accumulated transcript still holds the old utterance.
    await act(async () => {
      await result.current.start();
    });
    rerender();
    expect(result.current.transcript).toBe("");

    // The library appends the new utterance to that same accumulated string.
    act(() => {
      voiceState.transcript = "hello world goodbye";
      rerender();
    });
    expect(result.current.transcript).toBe("goodbye");
  });

  // C1: cancelled text must stay cancelled — the next dictation must not
  // resurrect it.
  it("does not resurrect cancelled text on the next dictation", async () => {
    const { result, rerender } = renderHook(() =>
      useDictation({ onStopped: vi.fn(), onIdle: vi.fn() }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      voiceState.transcript = "hello world";
      rerender();
    });

    act(() => {
      result.current.cancel();
      rerender();
    });

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      voiceState.transcript = "hello world goodbye";
      rerender();
    });
    expect(result.current.transcript).toBe("goodbye");
  });

  // Cancelling mid-phrase leaves the library's interimTranscript non-null: it is
  // only blanked when a phrase FINALIZES (voice-client.js:403), and neither
  // startCall() nor endCall() resets it. A stale interim must not look like
  // speech on the next dictation, or it arms the budget and kills the cutoff.
  it("does not treat a cancelled dictation's in-flight phrase as speech", async () => {
    const onIdle = vi.fn();
    const { result, rerender } = renderHook(() => useDictation({ onStopped: vi.fn(), onIdle }));

    await act(async () => {
      await result.current.start();
    });
    // A phrase is heard but never finalizes — it is still interim when cancelled.
    act(() => {
      voiceState.interimTranscript = "add a retry to the";
      rerender();
    });
    act(() => {
      result.current.cancel();
      rerender();
    });

    // The library leaves the stale interim in place across the restart.
    await act(async () => {
      await result.current.start();
    });

    // Say nothing at all. The idle cutoff must still fire.
    act(() => {
      vi.advanceTimersByTime(VOICE_IDLE_SECONDS * 1000 + 100);
    });
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it("stops 8 seconds after the user stops speaking, keeping what was said", async () => {
    const onSilence = vi.fn();
    const { result, rerender } = renderHook(() =>
      useDictation({ onStopped: vi.fn(), onIdle: vi.fn(), onSilence }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      speak(rerender);
      voiceState.transcript = "add a retry";
      rerender();
    });

    // Goes quiet.
    act(() => {
      voiceState.audioLevel = 0;
      rerender();
    });
    act(() => {
      vi.advanceTimersByTime(VOICE_TRAILING_SILENCE_SECONDS * 1000 - 500);
    });
    expect(onSilence).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(onSilence).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalled();
  });

  it("does not end the session on a shorter thinking pause", async () => {
    const onSilence = vi.fn();
    const { result, rerender } = renderHook(() =>
      useDictation({ onStopped: vi.fn(), onIdle: vi.fn(), onSilence }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      speak(rerender);
      voiceState.transcript = "add a retry";
      rerender();
    });

    // A 5s pause — under the trailing-silence limit.
    act(() => {
      voiceState.audioLevel = 0;
      rerender();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });

    // Then speaks again: the silence clock restarts.
    act(() => {
      speak(rerender);
      voiceState.transcript = "add a retry to the fetch call";
      rerender();
    });
    act(() => {
      voiceState.audioLevel = 0;
      rerender();
    });
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onSilence).not.toHaveBeenCalled();
  });

  it("does not show a cancelled dictation's in-flight phrase on the next one", async () => {
    const { result, rerender } = renderHook(() =>
      useDictation({ onStopped: vi.fn(), onIdle: vi.fn() }),
    );

    await act(async () => {
      await result.current.start();
    });
    act(() => {
      voiceState.interimTranscript = "add a retry to the";
      rerender();
    });
    act(() => {
      result.current.cancel();
      rerender();
    });

    await act(async () => {
      await result.current.start();
    });
    expect(result.current.interim).toBe("");
  });
});
