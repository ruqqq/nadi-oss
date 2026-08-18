import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Spinner } from "@/components/ui/spinner";
import { filterModels } from "@/lib/model-picker";
import {
  getProviderModelCatalog,
  type ModelInputModality,
  type ProviderModelSearchResult,
  type SettingsProvider,
} from "@/settings-api";

/**
 * The provider-model search — a cmdk Command with a search input and a results
 * list. Kept free of any Popover/trigger chrome so it can be dropped into both
 * the field-style {@link ModelCombobox} and the two-step ModelPicker.
 *
 * It loads the provider's catalog **once per mount** and filters in the
 * browser. It used to refetch on every keystroke, and each fetch reached the
 * provider's live `/models` API; the catalog is now cached server-side, so one
 * request covers the whole session with the picker open.
 *
 * Pass `models` to render a supplied list instead — the curated case, which
 * needs no request at all.
 */
export function ModelSearchCommand({
  provider,
  models: suppliedModels,
  initialQuery,
  placeholder,
  inputId,
  autoFocusInput,
  leadingGroup,
  footer,
  currentUsageTokens,
  onQueryChange,
  onSelect,
}: {
  provider: SettingsProvider;
  /** Render these instead of loading the catalog. */
  models?: ProviderModelSearchResult[];
  /** Seeds the search box (usually the current model id). */
  initialQuery: string;
  placeholder: string;
  inputId?: string;
  autoFocusInput?: boolean;
  /** An extra group above the main list, filtered by the same query. Used for
   *  the thread's current model when it sits outside the curated list. */
  leadingGroup?: { heading: string; models: ProviderModelSearchResult[] };
  /** Rendered below the list, e.g. the escape hatch to the full catalog. */
  footer?: ReactNode;
  /** The thread's current token usage, when the caller has one to compare
   *  rows against. A row whose model window sits below this gets a muted
   *  "will compact" note — see {@link ModelRow}. `null`/absent means the
   *  caller has no usage signal (new-thread pickers, Settings) and no row
   *  is marked. */
  currentUsageTokens?: number | null;
  /** Fires while typing — treat as a free-typed model id. */
  onQueryChange: (value: string) => void;
  /** Fires when a model is picked from the list. */
  onSelect: (model: ProviderModelSearchResult) => void;
}) {
  const generatedId = useId();
  const id = inputId ?? generatedId;
  const [query, setQuery] = useState(initialQuery);
  const [catalog, setCatalog] = useState<ProviderModelSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  const supplied = suppliedModels !== undefined;

  useEffect(() => {
    if (supplied) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    getProviderModelCatalog(provider, {}, (input, init) => {
      return fetch(input, { ...init, signal: controller.signal });
    })
      .then((result) => setCatalog(result.models))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCatalog([]);
        setFailed(true);
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
    // Deliberately not keyed on `query`: filtering is local, so typing must not
    // refetch. Keying on the provider is what makes a provider switch reload.
  }, [provider, supplied]);

  const source = suppliedModels ?? catalog;
  const visible = filterModels(source, query);
  const leading = leadingGroup ? filterModels(leadingGroup.models, query) : [];
  const showEmpty = !loading && !failed && visible.length === 0 && leading.length === 0;

  function pick(model: ProviderModelSearchResult) {
    setQuery(model.id);
    onQueryChange(model.id);
    onSelect(model);
  }

  return (
    <Command shouldFilter={false}>
      <CommandInput
        id={id}
        // 16px on mobile keeps iOS Safari from zooming the viewport on focus;
        // shrink back to the compact 14px on larger screens.
        className="text-base sm:text-sm"
        autoFocus={autoFocusInput}
        value={query}
        onValueChange={(next) => {
          setQuery(next);
          onQueryChange(next);
        }}
        placeholder={placeholder}
      />
      <CommandList>
        {loading && source.length === 0 && (
          <div className="flex items-center gap-2 px-3 py-2 text-muted-foreground text-sm">
            <Spinner label="Loading models" />
          </div>
        )}
        {!loading && failed && (
          <CommandEmpty>Couldn’t load models. Type a model ID to use one anyway.</CommandEmpty>
        )}
        {showEmpty && (
          <CommandEmpty>No models match. Type a model ID to use one anyway.</CommandEmpty>
        )}
        {leadingGroup && leading.length > 0 && (
          <CommandGroup heading={leadingGroup.heading}>
            {leading.map((model) => (
              <ModelRow
                key={`leading-${model.id}`}
                model={model}
                currentUsageTokens={currentUsageTokens}
                onSelect={() => pick(model)}
              />
            ))}
          </CommandGroup>
        )}
        <CommandGroup>
          {visible.map((model) => (
            <ModelRow
              key={model.id}
              model={model}
              currentUsageTokens={currentUsageTokens}
              onSelect={() => pick(model)}
            />
          ))}
        </CommandGroup>
        {footer}
      </CommandList>
    </Command>
  );
}

function ModelRow({
  model,
  currentUsageTokens,
  onSelect,
}: {
  model: ProviderModelSearchResult;
  currentUsageTokens?: number | null;
  onSelect: () => void;
}) {
  // Only a KNOWN, smaller window earns the note. `contextLength` is absent
  // for an uncurated provider or a catalog miss — that's unknown, not "too
  // small", and warning on every row would just train the user to ignore it.
  const willCompact =
    typeof currentUsageTokens === "number" &&
    typeof model.contextLength === "number" &&
    model.contextLength < currentUsageTokens;

  return (
    <CommandItem value={model.id} onSelect={onSelect}>
      <div className="min-w-0">
        <div className="truncate font-medium">{model.name ?? model.id}</div>
        <div className="truncate font-mono text-muted-foreground text-xs">
          {model.id} · {formatModalities(model.inputModalities)}
        </div>
        {willCompact && (
          <div className="truncate text-muted-foreground text-xs italic">
            Will compact this conversation
          </div>
        )}
      </div>
    </CommandItem>
  );
}

export function formatModalities(modalities: ModelInputModality[]): string {
  return modalities.length > 0 ? modalities.join(", ") : "text";
}
