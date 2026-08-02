import { useCallback, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { cn } from "../lib/utils";
import { CaretDown, Plus, Trash } from "../icons";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Input } from "../components/ui/input";
import { Separator } from "../components/ui/separator";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";

const SECRETS_HINT =
  "Stored encrypted and never shown again in this UI, but still readable in plain text by the agent inside the sandbox — encryption protects storage and transport, not runtime.";

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 1000 * 60 * 60 * 24 * 365],
  ["month", 1000 * 60 * 60 * 24 * 30],
  ["week", 1000 * 60 * 60 * 24 * 7],
  ["day", 1000 * 60 * 60 * 24],
  ["hour", 1000 * 60 * 60],
  ["minute", 1000 * 60],
];

const relativeTimeFormatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

function formatRelativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "recently";
  const diffMs = then - Date.now();
  for (const [unit, unitMs] of RELATIVE_UNITS) {
    if (Math.abs(diffMs) >= unitMs) {
      return relativeTimeFormatter.format(Math.round(diffMs / unitMs), unit);
    }
  }
  return relativeTimeFormatter.format(Math.round(diffMs / 1000), "second");
}

/** Mirrors the server's `parseDotenv` rules for a client-side preview of a pasted `.env` blob. */
function parseDotenvPairs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const name = line.slice(0, eq).trim();
    if (!name) continue;
    let value = line.slice(eq + 1).trim();
    const first = value.at(0);
    const last = value.at(-1);
    if (value.length >= 2 && (first === '"' || first === "'") && last === first) {
      value = value.slice(1, -1);
    }
    out[name] = value;
  }
  return out;
}

export function SandboxSecretsPanel({
  title,
  secrets,
  onUpsert,
  onDelete,
  disabled = false,
}: {
  title: string;
  secrets: Array<{ name: string; updatedAt: string }>;
  onUpsert: (envVars: Record<string, string>) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  disabled?: boolean;
}) {
  const [newName, setNewName] = useState("");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [deletingName, setDeletingName] = useState<string | null>(null);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const sorted = [...secrets].sort((a, b) => a.name.localeCompare(b.name));

  const addSecret = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      const name = newName.trim();
      if (adding || disabled || !name || !newValue) return;
      setAdding(true);
      setAddError(null);
      onUpsert({ [name]: newValue })
        .then(() => {
          setNewName("");
          setNewValue("");
          toast.success(`Saved secret ${name}`);
        })
        .catch(() => {
          setAddError("Couldn’t save that secret. Check the name and try again.");
          toast.error("Couldn’t save the secret.");
        })
        .finally(() => setAdding(false));
    },
    [adding, disabled, newName, newValue, onUpsert],
  );

  const removeSecret = useCallback(
    (name: string) => {
      if (deletingName || disabled) return;
      setDeletingName(name);
      onDelete(name)
        .then(() => toast.success(`Removed secret ${name}`))
        .catch(() => toast.error(`Couldn’t remove ${name}.`))
        .finally(() => setDeletingName(null));
    },
    [deletingName, disabled, onDelete],
  );

  const importPaste = useCallback(() => {
    const pairs = parseDotenvPairs(pasteText);
    if (Object.keys(pairs).length === 0) return;
    setImporting(true);
    setImportError(null);
    onUpsert(pairs)
      .then(() => {
        setPasteText("");
        setPasteOpen(false);
        toast.success(`Saved ${Object.keys(pairs).length} secret(s)`);
      })
      .catch(() => {
        setImportError("Couldn’t import — check the pasted names and try again.");
        toast.error("Couldn’t import secrets.");
      })
      .finally(() => setImporting(false));
  }, [pasteText, onUpsert]);

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="space-y-0.5">
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="text-muted-foreground text-sm">{SECRETS_HINT}</p>
      </div>

      <Separator />

      <div className="space-y-2">
        {sorted.length === 0 ? (
          <p className="text-muted-foreground text-xs">No secrets set.</p>
        ) : (
          sorted.map((secret) => (
            <div
              key={secret.name}
              className="flex items-center justify-between gap-3 rounded-md border p-2"
            >
              <div className="min-w-0 space-y-0.5">
                <p className="truncate font-mono text-sm">{secret.name}</p>
                <p className="text-muted-foreground text-xs">
                  Updated {formatRelativeTime(secret.updatedAt)}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => removeSecret(secret.name)}
                disabled={disabled || deletingName === secret.name}
                aria-label={`Remove secret ${secret.name}`}
              >
                {deletingName === secret.name ? <Spinner /> : <Trash aria-hidden />}
              </Button>
            </div>
          ))
        )}
      </div>

      <form className="flex flex-col gap-2 sm:flex-row sm:items-center" onSubmit={addSecret}>
        <Input
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="NAME"
          className="font-mono text-sm sm:w-48"
          disabled={disabled || adding}
          aria-label="Secret name"
        />
        <Input
          type="password"
          autoComplete="new-password"
          value={newValue}
          onChange={(event) => setNewValue(event.target.value)}
          placeholder="value"
          className="flex-1 font-mono text-sm"
          disabled={disabled || adding}
          aria-label="Secret value"
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={disabled || adding || !newName.trim() || !newValue}
          aria-busy={adding}
        >
          {adding ? <Spinner /> : <Plus aria-hidden />}
          Add secret
        </Button>
      </form>
      {addError && (
        <p className="text-reject text-xs" role="alert">
          {addError}
        </p>
      )}

      <Separator />

      <Collapsible open={pasteOpen} onOpenChange={setPasteOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="-ml-3 gap-1">
            <CaretDown
              className={cn("transition-transform", pasteOpen && "rotate-180")}
              aria-hidden
            />
            Paste .env
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-2 pt-2">
          <Textarea
            value={pasteText}
            onChange={(event) => setPasteText(event.target.value)}
            placeholder={"GH_TOKEN=ghp_…\n# comments and blank lines are ignored"}
            rows={4}
            className="font-mono text-sm"
            disabled={disabled || importing}
          />
          <p className="text-muted-foreground text-xs">
            Every name below is saved as a new secret; values are discarded from this form
            immediately after saving.
          </p>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={importPaste}
              disabled={disabled || importing || !pasteText.trim()}
              aria-busy={importing}
            >
              {importing ? <Spinner /> : null}
              Import
            </Button>
          </div>
          {importError && (
            <p className="text-reject text-xs" role="alert">
              {importError}
            </p>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
