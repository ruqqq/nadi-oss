import { WarningCircle } from "@/icons";

/**
 * The transcript's record that a turn died before it said anything.
 *
 * This is the durable counterpart to the transient error a connected client
 * gets mid-stream: a queued send or an automaton run can fail with nobody
 * attached, and without this the thread just sat on typing dots. Carries the
 * provider's own wording, because "Missing API key" or "this account has been
 * blocked" is the whole actionable content — a generic "something went wrong"
 * would have left the beta looking like a Nadi outage.
 */
export function TurnErrorNotice({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-reject/40 bg-reject/10 px-3 py-2 text-reject text-sm"
    >
      <WarningCircle className="mt-0.5 size-4 shrink-0" weight="bold" />
      <span className="min-w-0 break-words">{message}</span>
    </div>
  );
}
