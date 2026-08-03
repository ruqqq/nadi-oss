import {
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { FileUIPart } from "ai";
import { toast } from "sonner";
import {
  PromptInput,
  PromptInputActionAddAttachments,
  PromptInputActionMenu,
  PromptInputActionMenuContent,
  PromptInputActionMenuTrigger,
  PromptInputBody,
  PromptInputButton,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  usePromptInputAttachments,
} from "@/components/ai-elements/prompt-input";
import { canModelReadNatively, MAX_ATTACHMENT_BYTES } from "@/lib/attachment-accept";
import { composerKeyAction } from "@/lib/composer-keys";
import {
  isCompactCommand,
  resolveSubmitButton,
  resolveSubmitButtonStatus,
  steerMenuAvailable,
} from "@/lib/composer-submit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowBendDownRight, CaretDown, Clock } from "@/icons";
import { Spinner } from "@/components/ui/spinner";
import type { ModelInputModality } from "@/settings-api";
import { ComposerAttachmentRow } from "./ComposerAttachmentRow";
import { ComposerDictation, type DictationHandle } from "./ComposerDictation";

/** Safari on a non-secure origin, and older embedded webviews, have no getUserMedia. */
const MIC_SUPPORTED =
  typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia);

/** How a submit was triggered: `auto` = the default (idle send, or queue while
 *  busy); `steer` = interject the running turn. Threaded from the button/menu +
 *  keybinding to onSend via a ref (the form's onSubmit can't carry it). */
type SubmitIntent = "auto" | "steer";

function AttachmentCountProbe({ onCount }: { onCount: (count: number) => void }) {
  const attachments = usePromptInputAttachments();

  useEffect(() => {
    onCount(attachments.files.length);
  }, [attachments.files.length, onCount]);

  return null;
}

export type ComposerHandle = {
  focus: () => void;
  /** Fills the textarea with `text` if it is currently empty (whitespace-only
   *  counts as empty). No-op when the user has typed something or `text` is
   *  empty — used to restore a cancelled queued message without clobbering
   *  in-progress input. */
  prefillIfEmpty: (text: string) => void;
  /** Replaces the whole input with `text`, cursor at the end, focusing it unless
   *  `focus: false`. Unlike prefillIfEmpty this clobbers existing input — for a
   *  deliberate pick (a prompt suggestion) where the tap is the intent to swap.
   *  Text seeded without a gesture must pass `focus: false`: raising the
   *  software keyboard on mount covers the copy that explains the text. */
  replaceText: (text: string, options?: { focus?: boolean }) => void;
};

export function Composer({
  onSend,
  onStop,
  disabled,
  status,
  defaultValue,
  onDraftChange,
  uploadAttachments,
  attachmentAccept,
  maxFiles,
  modelInputModalities,
  previewFiles,
  allowBusySend,
  allowSteer,
  sendBlocked,
  statusHint,
  safeAreaBottom,
  footerTrailing,
  controlRef,
  voiceEnabled,
  autoFocus,
  placeholder,
}: {
  onSend: (text: string, files: FileUIPart[], opts?: { steer?: boolean }) => void | Promise<void>;
  /** Aborts the in-flight turn. When provided, the button becomes a stop control
   *  while a turn is streaming/submitted. */
  onStop?: () => void;
  disabled: boolean;
  status?: "submitted" | "streaming";
  /** Seeds the (uncontrolled) textarea on mount — used to restore a saved draft. */
  defaultValue?: string;
  /** Fires on every edit with the current text — used to persist the draft. */
  onDraftChange?: (text: string) => void;
  /** Uploads picked files and returns persisted parts. When provided, the attach
   *  affordance + previews render; otherwise the composer has no attachment UI. */
  uploadAttachments?: (files: FileUIPart[]) => Promise<FileUIPart[]>;
  attachmentAccept?: string;
  maxFiles?: number;
  /** Modalities of the selected model — drives the "may not read this" toast. */
  modelInputModalities?: ModelInputModality[];
  /** Read-only attachment chips shown beside the + button (e.g. staged files
   *  while the new-chat composer is disabled during thread creation). */
  previewFiles?: FileUIPart[];
  allowBusySend?: boolean;
  /** Enables the steer affordance (split-button "Steer now" menu + Cmd/Ctrl+
   *  Shift+Enter) while a turn is in flight — think runtime only. */
  allowSteer?: boolean;
  /** Blocks the action path (send / queue / steer / stop) while the live thread
   *  pipeline isn't ready (socket reconnecting / history reloading). The textarea
   *  stays editable and drafts keep saving — only the buttons go disabled. */
  sendBlocked?: boolean;
  /** Short label shown with a spinner in the footer's leading slot when the
   *  thread isn't ready (e.g. "Reconnecting…", "Reloading…"). */
  statusHint?: string;
  /** When the composer is pinned to the bottom edge of the viewport (active
   *  thread + new chat), add an iOS safe-area bottom margin in installed PWA mode
   *  so the card floats clear of the home indicator (margin, not padding, so the
   *  gap sits below the card — cleaner and a better touch target). */
  safeAreaBottom?: boolean;
  /** Controls rendered at the end of the footer, immediately left of the send
   *  button — hosts the provider/model picker (new chat) or the read-only model
   *  badge (active thread), giving both composers a `[+] … [model][send]` row. */
  footerTrailing?: ReactNode;
  /** Imperative access for the parent (see ComposerHandle). */
  controlRef?: Ref<ComposerHandle>;
  /** Shows the mic button. Driven by the VOICE_INPUT_ENABLED server flag. */
  voiceEnabled?: boolean;
  /** Focuses the textarea on mount — used on the new-chat screen so the user
   *  can type immediately. */
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const busy = status === "submitted" || status === "streaming";
  const [textValue, setTextValue] = useState(defaultValue ?? "");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  // The form's onSubmit can't carry the trigger, so the button/menu/keybinding
  // stash the intent here just before requesting submit; onSubmit reads + resets.
  const submitIntentRef = useRef<SubmitIntent>("auto");

  // Publishes the composer's clearance (viewport bottom → composer top) as a CSS
  // var so toasts land right above it (see the Toaster in main.tsx). Measured from
  // the viewport bottom, so margins and safe-area insets are included for free and
  // growth (multi-line drafts, the recording bar) tracks automatically.
  useEffect(() => {
    const el = textareaRef.current?.closest("form");
    if (!el) return;
    const root = document.documentElement;
    const publish = () => {
      const clearance = Math.max(0, window.innerHeight - el.getBoundingClientRect().top);
      root.style.setProperty("--composer-clearance", `${Math.round(clearance)}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(el);
    window.addEventListener("resize", publish);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      root.style.removeProperty("--composer-clearance");
    };
  }, []);

  useImperativeHandle(
    controlRef,
    () => ({
      focus: () => {
        textareaRef.current?.focus();
      },
      prefillIfEmpty: (text: string) => {
        const el = textareaRef.current;
        if (!el || text.length === 0 || el.value.trim().length > 0) return;
        // Same input-event path as the newline shortcut: setRangeText keeps
        // React's value tracker stale, so the dispatched event reaches the
        // onChange handler and textValue + draft persistence stay in sync.
        el.setRangeText(text, 0, el.value.length, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
      },
      replaceText: (text: string, options?: { focus?: boolean }) => {
        const el = textareaRef.current;
        if (!el) return;
        el.setRangeText(text, 0, el.value.length, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        if (options?.focus !== false) el.focus();
      },
    }),
    [],
  );
  // Dictation lives in a child that only mounts when the feature is available:
  // its WebSocket (and the VoiceAgent DO behind it) opens from a mount effect,
  // so a render-level flag check would still connect for every user.
  const voiceAvailable = Boolean(voiceEnabled) && MIC_SUPPORTED;
  const [dictating, setDictating] = useState(false);
  // Words heard but not yet hardened into the textarea (the in-flight phrase).
  const [dictatedWords, setDictatedWords] = useState(false);
  const dictationRef = useRef<DictationHandle | null>(null);

  /** Writes `next` into the textarea via the same input-event path prefillIfEmpty
   *  uses, so React's value tracker stays in sync and drafts keep saving. */
  const writeTextarea = useCallback((next: string) => {
    const el = textareaRef.current;
    if (!el) return;
    el.setRangeText(next, 0, el.value.length, "end");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }, []);

  const [attachmentCount, setAttachmentCount] = useState(previewFiles?.length ?? 0);
  // Speech counts as content: the send button must be live the moment you have
  // said something, not once the transcript has caught up.
  const hasContent = textValue.trim().length > 0 || attachmentCount > 0 || dictatedWords;
  const inputDisabled = disabled && !(allowBusySend && busy);

  // Autofocus once the field is actually usable. React's `autoFocus` attribute
  // only fires on mount, but the new-chat composer starts disabled while the
  // providers resolve — so focus imperatively the first time it goes enabled,
  // dropping the cursor at the end of any prefilled text.
  const autoFocusedRef = useRef(false);
  useEffect(() => {
    if (!autoFocus || inputDisabled || autoFocusedRef.current) return;
    const el = textareaRef.current;
    if (!el) return;
    autoFocusedRef.current = true;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [autoFocus, inputDisabled]);
  const effectiveUploadAttachments = uploadAttachments
    ? (files: FileUIPart[]) =>
        isCompactCommand(textValue) ? Promise.resolve(files) : uploadAttachments(files)
    : undefined;
  const submit = resolveSubmitButton(
    status,
    inputDisabled,
    Boolean(onStop),
    hasContent,
    Boolean(sendBlocked),
  );
  const canSteer = steerMenuAvailable({
    status,
    hasContent,
    allowSteer: Boolean(allowSteer),
    sendBlocked: Boolean(sendBlocked),
  });
  // Stash the intent, then submit through the form (so the same onSubmit path
  // handles button, menu, and keyboard).
  const submitWith = (intent: SubmitIntent) => {
    // Keyboard send/steer must respect the same gate as the (disabled) button.
    if (sendBlocked) return;
    // Sending while the mic is live ends the dictation first, hardening the
    // in-flight phrase into the textarea. flushSync is load-bearing: PromptInput
    // submits from React state, so without it requestSubmit reads the value from
    // BEFORE the phrase was written and the last words spoken are dropped.
    if (dictating) flushSync(() => dictationRef.current?.stopAndKeep());
    submitIntentRef.current = intent;
    textareaRef.current?.form?.requestSubmit();
  };
  const submitButton = (
    <PromptInputSubmit
      status={resolveSubmitButtonStatus(status, submit.mode)}
      disabled={submit.disabled}
      // This button is type=submit: a plain click submits the form NATIVELY and
      // never reaches submitWith. So both special cases live here — stop (abort
      // the turn, swallow the submit), and sending mid-dictation (harden the
      // in-flight phrase into the textarea BEFORE the native submit reads it,
      // then let the submit through).
      onClick={
        submit.mode === "stop"
          ? (e) => {
              e.preventDefault();
              onStop?.();
            }
          : dictating
            ? () => flushSync(() => dictationRef.current?.stopAndKeep())
            : undefined
      }
      aria-label={submit.mode === "stop" ? "Stop" : canSteer ? "Queue" : "Send"}
    />
  );
  const hasLeading = Boolean(uploadAttachments || statusHint);
  // Enter (and Shift+Enter) insert a newline; Ctrl/Cmd+Enter (or the button) sends;
  // Alt/Option+Enter inserts a newline explicitly (browsers don't do it reliably).
  // This overrides PromptInputTextarea's default (Enter submits) — onKeyDown last.
  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction({
      key: e.key,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      isComposing: e.nativeEvent.isComposing,
    });
    if (action === "send") {
      e.preventDefault();
      submitWith("auto");
    } else if (action === "steer") {
      e.preventDefault();
      // Cmd/Ctrl+Shift+Enter steers when steering applies; otherwise it's a
      // normal send (idle, or a runtime without steering).
      submitWith(canSteer ? "steer" : "auto");
    } else if (action === "newline") {
      e.preventDefault();
      const el = e.currentTarget;
      const start = el.selectionStart ?? el.value.length;
      const end = el.selectionEnd ?? el.value.length;
      el.setRangeText("\n", start, end, "end");
      // Let listeners (auto-resize, future draft persistence) see the change.
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
  };

  return (
    <PromptInput
      // Floating card: margins on all sides (w-auto so they don't overflow the
      // base w-full). In installed-PWA mode the bottom margin also clears the
      // home indicator (margin, not padding — the gap sits below the card).
      className={`m-3 w-auto${
        safeAreaBottom ? " standalone:mb-[calc(0.75rem_+_env(safe-area-inset-bottom))]" : ""
      }`}
      accept={attachmentAccept}
      maxFiles={maxFiles}
      maxFileSize={MAX_ATTACHMENT_BYTES}
      uploadAttachments={effectiveUploadAttachments}
      onError={(err) => {
        if (err.code === "accept") toast("That file type isn't supported.");
        else if (err.code === "max_file_size") toast("File is too large (max 10 MB).");
        else if (err.code === "max_files") toast("Too many files — some were not added.");
      }}
      isSupportedForModel={(file) =>
        canModelReadNatively({ type: file.type, name: file.name }, modelInputModalities ?? [])
      }
      onModelUnsupported={(files) => {
        const names = files.map((f) => f.name).join(", ");
        toast(
          `Nadi may not read ${files.length > 1 ? "these files" : "this file"} directly, but it can pass ${files.length > 1 ? "them" : "it"} to tools: ${names}`,
        );
      }}
      onSubmit={(message) => {
        const intent = submitIntentRef.current;
        submitIntentRef.current = "auto";
        const text = message.text.trim();
        if (text || message.files.length > 0) {
          return Promise.resolve(onSend(text, message.files, { steer: intent === "steer" })).then(
            () => {
              setTextValue((current) => (current === message.text ? "" : current));
            },
          );
        }
      }}
    >
      <AttachmentCountProbe onCount={setAttachmentCount} />
      <PromptInputBody>
        <PromptInputTextarea
          ref={textareaRef}
          aria-label="Message"
          placeholder={placeholder ?? "Message Nadi…"}
          disabled={inputDisabled}
          readOnly={dictating}
          defaultValue={defaultValue}
          onKeyDown={handleKeyDown}
          onChange={(e) => {
            const value = e.currentTarget.value;
            setTextValue(value);
            onDraftChange?.(value);
          }}
        />
      </PromptInputBody>
      {/* Chips get their own scrollable row above the toolbar; inline beside the
          + button they overflowed onto the model picker. */}
      <ComposerAttachmentRow
        uploadAttachments={Boolean(uploadAttachments)}
        previewFiles={previewFiles}
      />
      {/* The dictation child keeps a stable position among the footer's children
          so toggling the recording bar never remounts it (and its socket). */}
      <PromptInputFooter className={dictating || hasLeading ? "justify-between" : "justify-end"}>
        {!dictating && (
          <>
            {hasLeading && (
              <div className="flex min-w-0 flex-1 items-center gap-2">
                {uploadAttachments && (
                  <PromptInputTools className="shrink-0">
                    <PromptInputActionMenu>
                      <PromptInputActionMenuTrigger />
                      <PromptInputActionMenuContent>
                        <PromptInputActionAddAttachments />
                      </PromptInputActionMenuContent>
                    </PromptInputActionMenu>
                  </PromptInputTools>
                )}
                {/* After the + so the button never shifts when the hint toggles. */}
                {statusHint && (
                  <span
                    role="status"
                    className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
                  >
                    <Spinner className="size-3.5" />
                    <span className="truncate">{statusHint}</span>
                  </span>
                )}
              </div>
            )}
            {footerTrailing}
          </>
        )}
        {voiceAvailable && (
          <ComposerDictation
            controlRef={dictationRef}
            textareaRef={textareaRef}
            writeTextarea={writeTextarea}
            disabled={inputDisabled}
            onListeningChange={setDictating}
            onWordsChange={setDictatedWords}
          />
        )}
        {/* Mounted in BOTH modes, in the same slot: dictating, the send button
            finalizes the phrase and sends it, and queue/steer keep working because
            this is literally the same control. */}
        <>
          {canSteer ? (
            // Split control: the arrow queues (default); the caret opens the
            // Queue/Steer menu. Steering interjects the running turn (see spec).
            <div className="flex items-center gap-1">
              {submitButton}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <PromptInputButton aria-label="Send options">
                    <CaretDown className="size-4" />
                  </PromptInputButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem onSelect={() => submitWith("auto")}>
                    <Clock className="size-4 text-muted-foreground" />
                    <span className="flex-1">Queue for later</span>
                    <span className="font-mono text-muted-foreground text-xs">⌘↵</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => submitWith("steer")}>
                    <ArrowBendDownRight className="size-4 text-steer" />
                    <span className="flex-1">Steer now</span>
                    <span className="font-mono text-muted-foreground text-xs">⌘⇧↵</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          ) : (
            submitButton
          )}
        </>
      </PromptInputFooter>
    </PromptInput>
  );
}
