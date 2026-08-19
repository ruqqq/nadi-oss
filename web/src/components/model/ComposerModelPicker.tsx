import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { willCompactOnSwitch } from "@/lib/context-window";
import type { ProviderModelSearchResult, SettingsProvider } from "@/settings-api";
import { ModelPicker, type ModelPickerProviderOption } from "./ModelPicker";

/** A provider/model pair — the shape a composer-level model control reads
 *  and writes. Mirrors the server's `ModelTuple` (`src/agent/model-switch.ts`),
 *  redeclared here because web and worker code build under separate
 *  tsconfigs and share no runtime import. */
export interface ModelTuple {
  provider: SettingsProvider;
  model: string;
}

/**
 * Interactive composer-footer model control that replaces the read-only
 * {@link ThreadModelBadge} once mid-conversation switching is available.
 *
 * Takes exactly one `value` and renders it — there is no committed/pending
 * distinction inside this component. A selected-but-uncommitted model must
 * render identically to a committed one (see the task 9 brief's "no pending
 * affordance" note): the caller resolves which value that is (its own pending
 * state, falling back to the thread's committed model) and hands it down as
 * one prop. Feedback that a switch is taking effect comes later, from a
 * transcript divider at the moment it actually commits — not from this
 * control.
 *
 * Wraps `<ModelPicker variant="composer">` and matches `ThreadModelBadge`'s
 * container classes exactly (via that same composer trigger), so swapping
 * one for the other in the same footer slot causes no relayout.
 */
export function ComposerModelPicker({
  value,
  providers,
  disabled,
  currentUsageTokens,
  onSelect,
}: {
  value: ModelTuple;
  providers: ModelPickerProviderOption[];
  disabled?: boolean;
  /**
   * The thread's current token usage, when the caller has one. Used only to
   * mark rows whose catalog window is smaller than this — see
   * {@link ModelSearchCommand}'s doc — and to gate the one-time confirm
   * below. `null`/absent (a new-thread picker, or a pre-feature thread with
   * no recorded usage) shows no warnings and skips the confirm entirely.
   */
  currentUsageTokens?: number | null;
  /**
   * Fires only on a genuine model pick — never while the user is typing a
   * search query — and carries the full catalog entry alongside the tuple so
   * the caller can forward its modalities / reasoning support to the server.
   */
  onSelect: (tuple: ModelTuple, picked: ProviderModelSearchResult) => void;
}) {
  // The provider step is ModelPicker's own in-popover navigation (pick a
  // provider, then a model within it). Track it locally so browsing a
  // different provider doesn't require a commit to reach its models, but
  // resync it whenever the displayed value changes out from under us —
  // hydration landing, or a switch committed elsewhere — so reopening the
  // popover starts at the right provider instead of a stale one.
  const [provider, setProvider] = useState<SettingsProvider>(value.provider);
  useEffect(() => {
    setProvider(value.provider);
  }, [value.provider]);

  // A pick that would shrink below the thread's current usage waits here for
  // one confirmation before it reaches `onSelect` (and so before it's stored
  // as the pending switch). Not a disable: deliberately compacting onto a
  // cheaper/smaller model is legitimate, it just shouldn't happen by accident.
  const [pendingConfirm, setPendingConfirm] = useState<{
    tuple: ModelTuple;
    picked: ProviderModelSearchResult;
  } | null>(null);

  return (
    <>
      <ModelPicker
        variant="composer"
        triggerLabel={`Model: ${value.model}`}
        providers={providers}
        provider={provider}
        model={value.model}
        placeholder="Search models"
        disabled={disabled}
        currentUsageTokens={currentUsageTokens}
        onProviderChange={setProvider}
        // Typed search text is not a selection — only onModelSelected commits.
        onModelChange={() => {}}
        onModelSelected={(picked) => {
          const tuple = { provider, model: picked.id };
          if (willCompactOnSwitch(picked.contextLength, currentUsageTokens)) {
            setPendingConfirm({ tuple, picked });
            return;
          }
          onSelect(tuple, picked);
        }}
      />
      <AlertDialog
        open={pendingConfirm !== null}
        onOpenChange={(next) => {
          if (!next) setPendingConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Switch to {pendingConfirm?.picked.name ?? pendingConfirm?.picked.id}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This conversation is already past this model's compaction threshold, so switching will
              compact it right away to fit.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingConfirm) onSelect(pendingConfirm.tuple, pendingConfirm.picked);
                setPendingConfirm(null);
              }}
            >
              Switch and compact
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
