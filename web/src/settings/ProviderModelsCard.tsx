import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowsClockwise, Plus } from "../icons";
import {
  addCustomModel,
  curatedModels,
  filterModels,
  isCuratedProvider,
  mergeCatalogWithCurated,
} from "../lib/model-picker";
import {
  getProviderModelCatalog,
  type ProviderModelSearchResult,
  type ProviderSettingsView,
} from "../settings-api";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import { ScrollArea } from "../components/ui/scroll-area";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { FormCard } from "./section-ui";
import { AddModelDialog } from "./AddModelDialog";

/**
 * Choose which of a provider's models reach the model picker.
 *
 * CONTROLLED: every edit reports a new list through `onDraftChange` and nothing
 * is written here. The pane's Save commits it alongside the endpoint and key.
 *
 * It used to write on each toggle, which made that Save button look broken —
 * it sat right below a card whose changes it did not apply.
 */
export function ProviderModelsCard({
  provider,
  draft,
  onDraftChange,
}: {
  provider: ProviderSettingsView;
  /** The pending list. `undefined` means untouched — fall back to the saved one. */
  draft: ProviderModelSearchResult[] | null | undefined;
  onDraftChange: (models: ProviderModelSearchResult[] | null) => void;
}) {
  const [catalog, setCatalog] = useState<ProviderModelSearchResult[] | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [addOpen, setAddOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog(null);
    setLoadError(null);
    setQuery("");
    getProviderModelCatalog(provider.provider, {}, (input, init) =>
      fetch(input, { ...init, signal: controller.signal }),
    )
      .then((result) => {
        setCatalog(result.models);
        setFetchedAt(result.fetchedAt);
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setCatalog([]);
        setLoadError(err instanceof Error ? err.message : "Couldn’t load models.");
      });
    return () => controller.abort();
  }, [provider.provider]);

  // The draft wins once the user has touched anything; `undefined` (not `null`)
  // is what distinguishes untouched from "curated to nothing".
  const curated =
    draft !== undefined ? draft : isCuratedProvider(provider) ? curatedModels(provider) : null;
  const selectedIds = new Set(curated?.map((model) => model.id) ?? []);
  // Hand-added models aren't in the catalog — an endpoint that publishes no
  // `/models` list has an empty one — so the rows are the catalog plus whatever
  // the admin entered. Without this union a model you just added disappears.
  const rows = catalog === null ? null : mergeCatalogWithCurated(catalog, curated);
  const visible = rows ? filterModels(rows, query) : [];
  const catalogIds = new Set(catalog?.map((model) => model.id) ?? []);

  function toggle(model: ProviderModelSearchResult, checked: boolean) {
    if (checked) {
      // Ticking is only reachable once curation has started, so build on the
      // curated list — the point of curating is a SHORT list.
      onDraftChange([...(curated ?? []).filter((entry) => entry.id !== model.id), model]);
      return;
    }
    // Unticking on an UNCURATED provider starts from every row, not from an
    // empty list. Every row renders as ticked when uncurated, so unticking is
    // the only possible first action there — starting from `[]` meant removing
    // one model emptied the picker entirely.
    const base = curated ?? rows ?? [];
    onDraftChange(base.filter((entry) => entry.id !== model.id));
  }

  /** Records a capability the catalog could not tell us. Writes into the curated
   *  list, which is where model records live — so declaring on an uncurated
   *  provider starts curation from the whole catalog rather than silently
   *  narrowing the picker to one model. */
  function declareReasoning(model: ProviderModelSearchResult, reasoning: boolean) {
    const base = curated ?? rows ?? [];
    onDraftChange(base.map((entry) => (entry.id === model.id ? { ...entry, reasoning } : entry)));
  }

  async function refresh() {
    setRefreshing(true);
    try {
      const result = await getProviderModelCatalog(provider.provider, { refresh: true });
      if (!mounted.current) return;
      setCatalog(result.models);
      setFetchedAt(result.fetchedAt);
      setLoadError(null);
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Couldn’t refresh the model list.");
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  // Counted against `rows`, not `catalog`: a hand-added model is a real row, and
  // counting only the catalog would report "1 of 0 selected" for an endpoint
  // that publishes no list.
  const summary =
    rows === null
      ? "Loading…"
      : curated === null
        ? `All ${rows.length} models`
        : `${curated.length} of ${rows.length} selected`;

  const addButton = (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => setAddOpen(true)}
      disabled={catalog === null}
    >
      <Plus className="size-4" aria-hidden />
      Add model
    </Button>
  );

  return (
    <FormCard
      title="Models"
      description="Which models appear in the model picker."
      action={
        <div className="flex items-center gap-1">
          {addButton}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void refresh()}
            disabled={refreshing || catalog === null}
            aria-label={`Refresh ${provider.displayName} model list`}
          >
            {refreshing ? <Spinner /> : <ArrowsClockwise className="size-4" aria-hidden />}
            Refresh
          </Button>
        </div>
      }
    >
      <AddModelDialog
        open={addOpen}
        onOpenChange={setAddOpen}
        providerName={provider.displayName}
        existingIds={new Set(rows?.map((model) => model.id) ?? [])}
        onAdd={(model) => onDraftChange(addCustomModel(catalog ?? [], curated, model))}
      />

      {catalog === null ? (
        <div className="space-y-2" aria-busy="true" aria-label="Loading models">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      ) : rows !== null && rows.length === 0 ? (
        // The only route to a usable picker for an endpoint with no `/models`,
        // so the action is the empty state rather than a hint beside it.
        <div className="rounded-md border border-border border-dashed p-6 text-center">
          <p className="mb-3 text-muted-foreground text-sm">
            {loadError
              ? `Couldn’t load models. ${loadError}`
              : `${provider.displayName} doesn’t publish a model list. Add the models it serves.`}
          </p>
          <Button type="button" size="sm" onClick={() => setAddOpen(true)}>
            <Plus className="size-4" aria-hidden />
            Add model
          </Button>
        </div>
      ) : (
        <>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search models"
            aria-label={`Search ${provider.displayName} models`}
            className="text-base sm:text-sm"
          />

          <ScrollArea className="h-72 rounded-md border border-border">
            {visible.length === 0 ? (
              <p className="px-3 py-6 text-center text-muted-foreground text-sm">
                No models match “{query}”.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((model) => {
                  const id = `model-${provider.provider}-${model.id}`;
                  const checked = curated === null || selectedIds.has(model.id);
                  return (
                    <li key={model.id}>
                      <label
                        htmlFor={id}
                        className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/50"
                      >
                        <Checkbox
                          id={id}
                          checked={checked}
                          onCheckedChange={(value) => toggle(model, value === true)}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate font-medium text-sm">
                            {model.name ?? model.id}
                          </span>
                          <span className="block truncate font-mono text-muted-foreground text-xs">
                            {model.id}
                          </span>
                        </span>
                        {/* Hand-registered models are indistinguishable from
                            catalogue rows otherwise, which matters when deciding
                            what is safe to remove. */}
                        {!catalogIds.has(model.id) && (
                          <span className="shrink-0 rounded-full border border-primary/40 px-1.5 py-px text-primary text-xs">
                            Custom
                          </span>
                        )}
                        {/* Only offered where capability is UNKNOWN. A value the
                            catalog published is shown as state, not as an
                            editable claim — overriding an authoritative answer
                            is a support burden, not a feature. */}
                        {model.reasoning === undefined ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="shrink-0 text-muted-foreground text-xs"
                            onClick={(event) => {
                              event.preventDefault();
                              declareReasoning(model, true);
                            }}
                          >
                            Thinking?
                          </Button>
                        ) : model.reasoning ? (
                          <span className="shrink-0 text-muted-foreground text-xs">Thinking</span>
                        ) : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </ScrollArea>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-muted-foreground text-xs" aria-live="polite">
              {summary}
              {fetchedAt !== null ? ` · Updated ${formatAge(fetchedAt)}` : ""}
            </p>
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange([])}
                disabled={curated !== null && curated.length === 0}
              >
                Select none
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => onDraftChange(null)}
                disabled={curated === null}
              >
                Show all
              </Button>
            </div>
          </div>

          {curated !== null && curated.length === 0 && (
            <p className="text-muted-foreground text-xs">
              The picker will be empty for {provider.displayName}. Tick a model, or choose Show all.
            </p>
          )}
        </>
      )}
    </FormCard>
  );
}

function formatAge(fetchedAt: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - fetchedAt) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
