import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import type { ProviderModelSearchResult } from "../settings-api";
import { Field } from "./section-ui";

/**
 * Registering a model the provider doesn't list.
 *
 * A dialog rather than a form parked under the list: it is a rare, deliberate
 * action, and inline it competed with the list for attention on every visit
 * while being cramped into two columns on a phone. It is also the ONLY way to
 * configure an endpoint that serves no `/models` route, so it needs to be
 * reachable from the empty state as the primary action.
 */
export function AddModelDialog({
  open,
  onOpenChange,
  providerName,
  existingIds,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  providerName: string;
  /** Rejects a duplicate before it silently replaces the existing record. */
  existingIds: Set<string>;
  onAdd: (model: ProviderModelSearchResult) => void;
}) {
  const idPrefix = useId();
  const [modelId, setModelId] = useState("");
  const [name, setName] = useState("");
  const [acceptsImages, setAcceptsImages] = useState(false);
  const [reasoning, setReasoning] = useState(false);

  // Reopening must not show what was typed last time — especially after a
  // successful add, where the stale id would look like it failed to save.
  useEffect(() => {
    if (!open) return;
    setModelId("");
    setName("");
    setAcceptsImages(false);
    setReasoning(false);
  }, [open]);

  const trimmedId = modelId.trim();
  const duplicate = trimmedId.length > 0 && existingIds.has(trimmedId);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedId || duplicate) return;
    const trimmedName = name.trim();
    onAdd({
      id: trimmedId,
      ...(trimmedName ? { name: trimmedName } : {}),
      inputModalities: acceptsImages ? ["text", "image"] : ["text"],
      // Written both ways on purpose: a hand-registered model has no catalog
      // entry to fall back on, so leaving this absent would park it at
      // "unknown" forever and it could never offer the thinking control.
      reasoning,
      source: "static",
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Add a model</DialogTitle>
            <DialogDescription>
              For models {providerName} doesn’t list. It will be added to your selection.
            </DialogDescription>
          </DialogHeader>

          <Field
            label="Model ID"
            htmlFor={`${idPrefix}-id`}
            hint={duplicate ? undefined : "Exactly as the provider names it."}
          >
            <Input
              id={`${idPrefix}-id`}
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              placeholder="llama-3.3-70b-instruct"
              className="font-mono text-base sm:text-sm"
              autoFocus
            />
          </Field>
          {duplicate && (
            <p className="text-destructive text-xs" role="alert">
              {trimmedId} is already in the list.
            </p>
          )}

          <Field label="Display name" htmlFor={`${idPrefix}-name`} hint="Optional.">
            <Input
              id={`${idPrefix}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Llama 3.3 70B"
              className="text-base sm:text-sm"
            />
          </Field>

          <div className="space-y-2">
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-images`}
                checked={acceptsImages}
                onCheckedChange={(value) => setAcceptsImages(value === true)}
              />
              Accepts image attachments
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm">
              <Checkbox
                id={`${idPrefix}-reasoning`}
                checked={reasoning}
                onCheckedChange={(value) => setReasoning(value === true)}
              />
              Supports thinking
            </label>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!trimmedId || duplicate}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
