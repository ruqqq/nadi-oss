import { useState } from "react";
import { CaretDown, CaretLeft, CaretRight, Check, MagnifyingGlass } from "@/icons";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { pinnedModelOutsideList, visibleProviders } from "@/lib/model-picker";
import { cn } from "@/lib/utils";
import type { ProviderModelSearchResult, SettingsProvider } from "@/settings-api";
import { ModelSearchCommand } from "./ModelSearchCommand";

export interface ModelPickerProviderOption {
  value: SettingsProvider;
  label: string;
  /** The workspace's curated models, or `null`/absent for "offer everything".
   *  Present here so a curated picker renders with no network call. */
  whitelistModels?: ProviderModelSearchResult[] | null;
}

/**
 * Combined provider + model control as a two-step popover: pick the provider,
 * then search its models. Built for tight spaces (the composer footer) but also
 * used as a form field in Settings.
 *
 * - `variant="composer"` renders a compact, borderless trigger sized to sit
 *   inline with the send button.
 * - `variant="field"` renders a bordered, full-width trigger for forms.
 *
 * Provider changes are only forwarded when the value actually changes, so
 * re-selecting the current provider (to reach its models) never resets the
 * chosen model.
 */
export function ModelPicker({
  providers: allProviders,
  provider,
  model,
  placeholder,
  disabled,
  variant = "field",
  triggerId,
  triggerLabel,
  hideProviderPrefix,
  onProviderChange,
  onModelChange,
  onModelSelected,
}: {
  providers: ModelPickerProviderOption[];
  provider: SettingsProvider;
  model: string;
  placeholder: string;
  disabled?: boolean;
  variant?: "composer" | "field";
  triggerId?: string;
  /** Accessible name for the trigger (e.g. "New chat model"). */
  triggerLabel?: string;
  /**
   * Drop the "Provider · " prefix from the trigger. For callers whose current
   * value isn't a real provider choice yet (e.g. an automaton inheriting its
   * agent's model), where naming a provider would imply one had been pinned.
   */
  hideProviderPrefix?: boolean;
  onProviderChange: (provider: SettingsProvider) => void;
  onModelChange: (model: string) => void;
  onModelSelected?: (model: ProviderModelSearchResult) => void;
}) {
  const [open, setOpen] = useState(false);
  // Filtered here rather than at each call site, so the composer, Settings,
  // Onboarding and the automata form all obey the same rule.
  const providers = visibleProviders(allProviders, provider);
  const multiProvider = providers.length > 1;
  const [step, setStep] = useState<"provider" | "model">(multiProvider ? "provider" : "model");
  // Curated providers show the short list first; this escapes to the full
  // catalog for one session of the popover.
  const [browsingAll, setBrowsingAll] = useState(false);

  const selectedProvider = providers.find((entry) => entry.value === provider);
  const providerLabel = selectedProvider?.label ?? provider;
  const isDisabled = disabled || providers.length === 0;

  const curated = Array.isArray(selectedProvider?.whitelistModels)
    ? selectedProvider.whitelistModels
    : null;
  const showCurated = curated !== null && !browsingAll;
  const pinned = showCurated ? pinnedModelOutsideList(curated, model) : null;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    // Each session starts at the provider step (unless there's only one), so
    // the flow reads as "choose provider, then model" every time.
    if (next) setStep(multiProvider ? "provider" : "model");
    if (next) setBrowsingAll(false);
  }

  function chooseProvider(next: SettingsProvider) {
    if (next !== provider) onProviderChange(next);
    setBrowsingAll(false);
    setStep("model");
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        {variant === "composer" ? (
          <button
            type="button"
            id={triggerId}
            aria-label={triggerLabel}
            disabled={isDisabled}
            className="flex h-8 min-w-0 max-w-[min(60vw,16rem)] items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none aria-expanded:bg-accent aria-expanded:text-foreground disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="truncate">{model || placeholder}</span>
            <CaretDown className="size-3.5 shrink-0 opacity-60" aria-hidden />
          </button>
        ) : (
          <button
            type="button"
            id={triggerId}
            aria-label={triggerLabel}
            aria-expanded={open}
            role="combobox"
            disabled={isDisabled}
            className="flex h-10 w-full items-center gap-2 rounded-md border border-input bg-transparent px-3 text-left text-sm shadow-xs transition-colors hover:bg-accent/50 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <span className="min-w-0 flex-1 truncate">
              {multiProvider && !hideProviderPrefix && (
                <span className="text-muted-foreground">{providerLabel} · </span>
              )}
              <span className={cn(!model && "text-muted-foreground")}>{model || placeholder}</span>
            </span>
            <CaretDown className="size-4 shrink-0 opacity-50" aria-hidden />
          </button>
        )}
      </PopoverTrigger>
      <PopoverContent
        align={variant === "composer" ? "start" : "start"}
        className={cn(
          "p-0",
          variant === "composer"
            ? "w-[calc(100vw-1.5rem)] max-w-[22rem]"
            : "w-[var(--radix-popover-trigger-width)] min-w-[18rem]",
        )}
      >
        {step === "provider" ? (
          <div className="p-1">
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Provider</div>
            <div className="flex flex-col">
              {providers.map((entry) => (
                <button
                  key={entry.value}
                  type="button"
                  onClick={() => chooseProvider(entry.value)}
                  className="flex items-center gap-2 rounded-sm px-2 py-2.5 text-left text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                >
                  <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                  {entry.value === provider && (
                    <Check className="size-4 shrink-0 text-foreground" aria-hidden />
                  )}
                  <CaretRight className="size-4 shrink-0 opacity-40" aria-hidden />
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div>
            {multiProvider && (
              <button
                type="button"
                onClick={() => setStep("provider")}
                className="flex w-full items-center gap-1.5 border-b px-3 py-2.5 text-left font-medium text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
              >
                <CaretLeft className="size-4 shrink-0 opacity-60" aria-hidden />
                <span className="min-w-0 flex-1 truncate">{providerLabel}</span>
                <span className="shrink-0 text-muted-foreground text-xs">Change</span>
              </button>
            )}
            <ModelSearchCommand
              key={`${provider}:${showCurated ? "curated" : "all"}`}
              provider={provider}
              {...(showCurated ? { models: curated } : {})}
              // Start empty so opening the picker always shows the full model
              // list; the selected model still reads on the trigger. Seeding
              // with the current id filtered the list to that one row and
              // forced the user to clear the field to browse.
              initialQuery=""
              placeholder={placeholder}
              inputId={triggerId ? `${triggerId}-search` : undefined}
              autoFocusInput
              {...(pinned
                ? { leadingGroup: { heading: "Current", models: [pinned] } }
                : {})}
              {...(showCurated
                ? {
                    footer: (
                      <button
                        type="button"
                        onClick={() => setBrowsingAll(true)}
                        className="flex w-full items-center gap-1.5 border-t px-3 py-2.5 text-left text-muted-foreground text-sm transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent focus-visible:text-foreground focus-visible:outline-none"
                      >
                        <MagnifyingGlass className="size-4 shrink-0 opacity-60" aria-hidden />
                        Search all models
                      </button>
                    ),
                  }
                : {})}
              onQueryChange={onModelChange}
              onSelect={(picked) => {
                onModelChange(picked.id);
                // Re-picking the model already in use changes nothing, so don't
                // report a selection. The "Current" row is synthesized from an
                // id alone and claims `text` modalities it cannot know — firing
                // this for it would silently strip image support from a vision
                // model the thread is already running on.
                if (picked.id !== model) onModelSelected?.(picked);
                setOpen(false);
              }}
            />
            {showCurated && curated.length === 0 && !pinned && (
              <p className="border-t px-3 py-2.5 text-muted-foreground text-xs">
                No models chosen for {providerLabel}. Pick some in Settings → Providers.
              </p>
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
