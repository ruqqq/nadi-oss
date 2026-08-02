// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, cleanup } from "@testing-library/react";

// jsdom has no mediaDevices, and the composer's MIC_SUPPORTED probe is
// module-level — stub it before the module graph loads.
const { voiceState, listeners, start, stop, mounts, mic } = vi.hoisted(() => {
  // The mic permission state the Permissions API reports, and whether it exists
  // at all — Safari's support is inconsistent, and "unknown" is a real path.
  const mic = {
    permission: "granted" as "granted" | "denied" | "prompt" | "unsupported",
    grantOnPrompt: true,
    getUserMedia: vi.fn(),
    trackStop: vi.fn(),
  };
  mic.getUserMedia.mockImplementation(async () => {
    if (!mic.grantOnPrompt) throw new Error("NotAllowedError");
    return { getTracks: () => [{ stop: mic.trackStop }] };
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    value: { getUserMedia: mic.getUserMedia },
    configurable: true,
  });
  Object.defineProperty(globalThis.navigator, "permissions", {
    value: {
      query: async () => {
        if (mic.permission === "unsupported") throw new Error("not supported");
        return { state: mic.permission };
      },
    },
    configurable: true,
  });
  const voiceState = {
    transcript: "",
    interimTranscript: null as string | null,
    isListening: false,
    audioLevel: 0,
    error: null as string | null,
  };
  return {
    mic,
    voiceState,
    mounts: { count: 0 },
    listeners: new Set<() => void>(),
    start: vi.fn(async () => {
      voiceState.isListening = true;
    }),
    stop: vi.fn(() => {
      voiceState.isListening = false;
    }),
  };
});

/** Pushes the current voiceState into every mounted consumer, like the real
 *  client's events do. */
function emit() {
  for (const listener of listeners) listener();
}

vi.mock("@cloudflare/voice/react", async () => {
  const { useReducer, useEffect } = await import("react");
  return {
    useVoiceInput: () => {
      const [, force] = useReducer((n: number) => n + 1, 0);
      useEffect(() => {
        // The real hook opens its WebSocket here.
        mounts.count += 1;
      }, []);
      useEffect(() => {
        listeners.add(force);
        return () => {
          listeners.delete(force);
        };
      }, []);
      return {
        transcript: voiceState.transcript,
        interimTranscript: voiceState.interimTranscript,
        isListening: voiceState.isListening,
        audioLevel: voiceState.audioLevel,
        isMuted: false,
        error: voiceState.error,
        start,
        stop,
        toggleMute: vi.fn(),
        clear: vi.fn(),
      };
    },
  };
});

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

// jsdom has no ResizeObserver; the composer observes its form to publish
// --composer-clearance for the Toaster.
if (!globalThis.ResizeObserver) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
}

import { Composer } from "./Composer";

function textarea() {
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

async function startDictating() {
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Dictate"));
  });
}

describe("Composer dictation", () => {
  beforeEach(() => {
    voiceState.transcript = "";
    voiceState.interimTranscript = null;
    voiceState.isListening = false;
    voiceState.audioLevel = 0;
    voiceState.error = null;
    mounts.count = 0;
    mic.permission = "granted";
    mic.grantOnPrompt = true;
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  // The gate added for I4 must stay narrow: Cmd/Ctrl+Enter still sends normally.
  it("sends on Cmd+Enter when not dictating", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} voiceEnabled />);
    fireEvent.change(textarea(), { target: { value: "typed" } });
    await act(async () => {
      fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    });
    expect(onSend).toHaveBeenCalled();
  });

  // I4: the textarea is readOnly, not disabled, so it still fires keydown —
  // Cmd/Ctrl+Enter used to send mid-dictation and leave the voice range stale.
  // Sending mid-dictation used to be blocked outright (it would have stranded the
  // voice range). Now it ends the dictation first and sends what was said --
  // INCLUDING the in-flight phrase, which is the part that was easiest to lose.
  it("sends the dictated words, in-flight phrase and all", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} disabled={false} voiceEnabled />);

    await startDictating();
    act(() => {
      voiceState.transcript = "add a retry";
      voiceState.interimTranscript = "to the deploy";
      emit();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Send"));
    });

    expect(onSend).toHaveBeenCalledWith("add a retry to the deploy", [], { steer: false });
    expect(stop).toHaveBeenCalled();
  });

  // Steering is offered only when the composer has content. Finals reach the
  // textarea a beat after you speak, so without counting the in-flight phrase,
  // dictating "steer left" mid-turn would offer no way to steer with it.
  it("offers queue/steer for words that are still only in-flight", async () => {
    render(
      <Composer
        onSend={vi.fn()}
        onStop={vi.fn()}
        disabled={false}
        status="streaming"
        allowSteer
        allowBusySend
        voiceEnabled
      />,
    );

    await startDictating();
    expect(screen.queryByLabelText("Send options")).toBeNull();

    act(() => {
      voiceState.interimTranscript = "actually check the migration";
      emit();
    });

    expect(screen.getByLabelText("Send options")).toBeTruthy();
    expect(screen.getByLabelText("Queue")).toBeTruthy();
  });

  // I5: Stop must finalize — the in-flight phrase (shown muted in the footer)
  // was silently destroyed by the server's no-flush end-call path.
  it("keeps the in-flight phrase when dictation is stopped", async () => {
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();
    act(() => {
      voiceState.transcript = "add a retry";
      voiceState.interimTranscript = "and a timeout";
      emit();
    });

    await act(async () => {
      fireEvent.click(screen.getByLabelText("Accept dictation"));
    });
    expect(stop).toHaveBeenCalled();
    expect(textarea().value).toBe("add a retry and a timeout");
  });

  // I3: useVoiceInput connects from a mount effect, so a render-level flag check
  // would still open a socket (and spin up the VoiceAgent DO) for every user.
  it("does not touch the voice client when the flag is off", () => {
    render(<Composer onSend={vi.fn()} disabled={false} />);
    expect(screen.queryByLabelText("Dictate")).toBeNull();
    expect(mounts.count).toBe(0);
  });

  // I1 + I2: the client catches the getUserMedia rejection and only emits an
  // `error` event — startCall() resolves, so nothing threw and nothing consumed
  // the error. The user got a pulsing mic over dead air for 30 seconds.
  it("exits recording and explains a blocked microphone", async () => {
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();
    act(() => {
      voiceState.transcript = "add a retry";
      emit();
    });

    await act(async () => {
      voiceState.error = "Microphone access denied. Please allow microphone access and try again.";
      emit();
    });

    expect(stop).toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Microphone access is blocked. Enable it in your browser's site settings.",
    );
    // Finals already written stay put.
    expect(textarea().value).toBe("add a retry");
  });

  // D2: iOS does not persist a getUserMedia grant, so a resumed PWA re-prompts.
  // The prompt must never happen inside a recording session — it would eat the
  // speech budget and stream silence. So an ungranted mic gets a preflight
  // (grab the mic, release it immediately) and then recording starts on the SAME
  // tap: on iOS the preflight happens every launch, and a second tap after the
  // permission sheet would be pure friction.
  it("preflights the microphone and records on the same tap when permission was not yet granted", async () => {
    mic.permission = "prompt";
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(mic.trackStop).toHaveBeenCalled(); // the mic is released again
    expect(start).toHaveBeenCalledTimes(1); // recording starts without a second tap
    expect(screen.getByLabelText("Accept dictation")).toBeTruthy();
  });

  // Safari's Permissions API support for "microphone" is inconsistent — a throw
  // or a missing API must be treated as unknown, i.e. preflight before recording.
  it("preflights when the Permissions API is unavailable", async () => {
    mic.permission = "unsupported";
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    expect(mic.getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(start).toHaveBeenCalledTimes(1);
  });

  // isListening only flips when the server round-trips "listening", so the tap
  // has a real startup window (permission, AudioContext, round-trip). The button
  // must visibly acknowledge the tap and refuse a second one meanwhile.
  it("shows a starting state between the tap and the server reporting listening", async () => {
    start.mockImplementationOnce(async () => {}); // call started, server not yet listening
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    const button = screen.getByLabelText("Starting dictation") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    // The server flips us to listening: the recording bar takes over.
    act(() => {
      voiceState.isListening = true;
      emit();
    });
    expect(screen.getByLabelText("Accept dictation")).toBeTruthy();
  });

  // The normal desktop case must stay a single tap.
  it("records on one tap when permission is already granted", async () => {
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    expect(mic.getUserMedia).not.toHaveBeenCalled(); // no redundant preflight
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("Accept dictation")).toBeTruthy();
  });

  it("does not open the mic when permission is blocked", async () => {
    mic.permission = "denied";
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    expect(mic.getUserMedia).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Microphone access is blocked. Enable it in your browser's site settings.",
    );
  });

  it("treats a rejected preflight as a blocked microphone", async () => {
    mic.permission = "prompt";
    mic.grantOnPrompt = false;
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();

    expect(start).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(
      "Microphone access is blocked. Enable it in your browser's site settings.",
    );
  });

  it("explains a voice-service failure in words, not a status code", async () => {
    render(<Composer onSend={vi.fn()} disabled={false} voiceEnabled />);

    await startDictating();
    await act(async () => {
      voiceState.error = "Cannot start call: not connected. Call connect() first.";
      emit();
    });

    expect(stop).toHaveBeenCalled();
    const message = toast.mock.calls.at(-1)?.[0] as string;
    expect(message).toContain("Dictation stopped");
    expect(message).not.toMatch(/\d{3}/);
  });
});
