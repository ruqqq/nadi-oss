import { useEffect, useState } from "react";
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
  onSelect,
}: {
  value: ModelTuple;
  providers: ModelPickerProviderOption[];
  disabled?: boolean;
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

  return (
    <ModelPicker
      variant="composer"
      triggerLabel={`Model: ${value.model}`}
      providers={providers}
      provider={provider}
      model={value.model}
      placeholder="Search models"
      disabled={disabled}
      onProviderChange={setProvider}
      // Typed search text is not a selection — only onModelSelected commits.
      onModelChange={() => {}}
      onModelSelected={(picked) => {
        onSelect({ provider, model: picked.id }, picked);
      }}
    />
  );
}
