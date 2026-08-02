import { PromptInputButton } from "@/components/ai-elements/prompt-input";
import { Check, Microphone, X } from "@/icons";
import { VOICE_MAX_SECONDS } from "@/lib/use-dictation";
import { cn } from "@/lib/utils";

const BARS = 12;
/** Last 5 seconds turn the clock red. */
const WARN_AT_MS = (VOICE_MAX_SECONDS - 5) * 1000;

function formatClock(ms: number) {
  const total = Math.min(Math.floor(ms / 1000), VOICE_MAX_SECONDS);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Discrete vertical bars rather than a smooth waveform — it matches the mono /
 * tabular register the design system already uses for config values, and reads
 * as an instrument rather than a consumer voice-note.
 */
function LevelMeter({ level }: { level: number }) {
  const lit = Math.round(Math.min(Math.max(level, 0), 1) * BARS);
  return (
    <div className="hidden items-end gap-px sm:flex" aria-hidden="true">
      {Array.from({ length: BARS }, (_, i) => (
        <span
          key={i}
          className={cn(
            "w-0.5 rounded-full transition-[height,background-color] duration-75",
            i < lit ? "bg-gate" : "bg-border",
          )}
          style={{ height: `${4 + (i % 3) * 3}px` }}
        />
      ))}
    </div>
  );
}

export function RecordingBar({
  elapsedMs,
  audioLevel,
  interim,
  onCancel,
  onStop,
}: {
  elapsedMs: number;
  audioLevel: number;
  interim: string;
  onCancel: () => void;
  onStop: () => void;
}) {
  const warn = elapsedMs >= WARN_AT_MS;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Microphone className="size-4 shrink-0 animate-pulse text-gate" />
      <LevelMeter level={audioLevel} />
      <span
        role="timer"
        className={cn(
          "shrink-0 font-mono text-xs tabular-nums",
          warn ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="sm:hidden">{formatClock(elapsedMs)}</span>
        <span className="hidden sm:inline">
          {formatClock(elapsedMs)} / {formatClock(VOICE_MAX_SECONDS * 1000)}
        </span>
      </span>
      {/* The in-flight phrase. Truncates from the left so the newest words stay
          visible; it hardens into the textarea within a second or two. */}
      <span
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-left text-muted-foreground text-xs italic [direction:rtl] [text-align:left]"
      >
        {interim}
      </span>
      {/* Both ghost: the composer's own send button stays mounted to our right and
          remains the row's single filled primary, in the same slot it occupies when
          idle — so the three exits read reject (✕) / accept and edit (✓) / send now
          (the send button itself, which finalizes the phrase before sending). */}
      <PromptInputButton onClick={onCancel} aria-label="Reject dictation">
        <X className="size-4 text-reject" />
      </PromptInputButton>
      <PromptInputButton onClick={onStop} aria-label="Accept dictation">
        <Check className="size-4 text-approve" />
      </PromptInputButton>
    </div>
  );
}
