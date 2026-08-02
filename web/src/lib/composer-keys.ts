/**
 * Decide what an Enter keypress means in the composer. Pure and React-free so
 * it's unit-testable; the component adapts its event into this minimal shape.
 *
 * Policy: plain Enter and Shift+Enter insert a newline (the textarea does this
 * natively, so we return "ignore" and let the default happen); Cmd/Ctrl+Enter
 * sends; Cmd/Ctrl+Shift+Enter steers (interject the running turn — the component
 * falls back to a normal send when steering isn't applicable); Alt/Option+Enter
 * inserts a newline explicitly, because browsers don't reliably insert one for
 * Alt+Enter on their own. IME composition is left alone.
 */
export type ComposerKeyAction = "send" | "steer" | "newline" | "ignore";

export interface ComposerKeyEvent {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

export function composerKeyAction(e: ComposerKeyEvent): ComposerKeyAction {
  if (e.key !== "Enter" || e.isComposing) return "ignore";
  if (e.metaKey || e.ctrlKey) return e.shiftKey ? "steer" : "send";
  if (e.altKey) return "newline";
  return "ignore";
}
