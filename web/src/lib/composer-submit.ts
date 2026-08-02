export type SubmitButtonMode = "send" | "stop";

export function isCompactCommand(text: string): boolean {
  return text.trim() === "/compact";
}

export function resolveSubmitButton(
  status: "submitted" | "streaming" | undefined,
  composerDisabled: boolean,
  canStop: boolean,
  hasContent: boolean,
  // When the live thread pipeline isn't ready (socket reconnecting / history
  // reloading) every action is blocked — including stop, which can't reach a
  // dead socket. The textarea stays editable; only the button is disabled.
  sendBlocked = false,
): { mode: SubmitButtonMode; disabled: boolean } {
  const busy = status === "submitted" || status === "streaming";
  if (busy && canStop && !hasContent) return { mode: "stop", disabled: sendBlocked };
  return { mode: "send", disabled: composerDisabled || sendBlocked };
}

export function resolveSubmitButtonStatus(
  status: "submitted" | "streaming" | undefined,
  mode: SubmitButtonMode,
): "submitted" | "streaming" | undefined {
  return mode === "stop" ? status : undefined;
}

// Steering is offered only while a turn is in flight AND the user has typed
// something AND the runtime supports it (think). In that state the submit
// button becomes a split control with a "Steer now" menu, and Cmd/Ctrl+Shift+
// Enter steers. Otherwise the composer behaves exactly as before (idle send,
// stop, or plain queued-send). Pure so it's unit-testable.
export function steerMenuAvailable(opts: {
  status: "submitted" | "streaming" | undefined;
  hasContent: boolean;
  allowSteer: boolean;
  sendBlocked?: boolean;
}): boolean {
  if (opts.sendBlocked) return false;
  const busy = opts.status === "submitted" || opts.status === "streaming";
  return busy && opts.hasContent && opts.allowSteer;
}
