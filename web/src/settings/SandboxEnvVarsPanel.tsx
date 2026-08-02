import { useCallback, useRef, useState } from "react";
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

const ENV_VARS_HINT =
  "Available to the agent as environment variables inside the sandbox at runtime. Stored in plain text — keep tokens and credentials in Secrets below instead.";

interface EnvVarRow {
  id: string;
  name: string;
  value: string;
}

function rowsFromMap(map: Record<string, string>): EnvVarRow[] {
  return Object.entries(map).map(([name, value]) => ({ id: crypto.randomUUID(), name, value }));
}

/**
 * Client-side prep for a pasted `.env` blob: mirrors the server's `parseDotenv`
 * rules (split on the first `=`, skip blank/`#`-comment lines, strip one
 * matching surrounding quote pair) so pasted rows look right before Save,
 * which is where name/value validation actually happens.
 */
function parseDotenvRows(text: string): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
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
    out.push({ name, value });
  }
  return out;
}

export function SandboxEnvVarsPanel({
  title,
  envVars,
  onSave,
  disabled = false,
}: {
  title: string;
  envVars: Record<string, string>;
  onSave: (envVars: Record<string, string>) => Promise<void>;
  disabled?: boolean;
}) {
  const [rows, setRows] = useState<EnvVarRow[]>(() => rowsFromMap(envVars));
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const appliedKeyRef = useRef(JSON.stringify(envVars));

  // Re-seed local rows only when the saved map actually changes (e.g. after
  // this panel's own save, or a fresh load) — not on every unrelated
  // re-render of the settings page, which would otherwise clobber in-progress edits.
  const key = JSON.stringify(envVars);
  if (appliedKeyRef.current !== key) {
    appliedKeyRef.current = key;
    setRows(rowsFromMap(envVars));
    setError(null);
  }

  const updateRow = useCallback((id: string, patch: Partial<Pick<EnvVarRow, "name" | "value">>) => {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }, []);

  const removeRow = useCallback((id: string) => {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }, []);

  const addRow = useCallback(() => {
    setRows((prev) => [...prev, { id: crypto.randomUUID(), name: "", value: "" }]);
  }, []);

  const importPaste = useCallback(() => {
    const parsed = parseDotenvRows(pasteText);
    if (parsed.length === 0) return;
    setRows((prev) => {
      const byName = new Map(prev.map((row) => [row.name, row] as const));
      for (const { name, value } of parsed) {
        const existing = byName.get(name);
        if (existing) {
          byName.set(name, { ...existing, value });
        } else {
          byName.set(name, { id: crypto.randomUUID(), name, value });
        }
      }
      return [...byName.values()];
    });
    setPasteText("");
    setPasteOpen(false);
  }, [pasteText]);

  const handleSave = useCallback(() => {
    if (saving || disabled) return;
    const map: Record<string, string> = {};
    for (const row of rows) {
      const name = row.name.trim();
      if (!name) continue;
      map[name] = row.value;
    }
    setSaving(true);
    setError(null);
    onSave(map)
      .then(() => toast.success(`Saved ${title.toLowerCase()}`))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(
          message.includes("(400)")
            ? "Check your variable names — letters, numbers, and underscores only, not starting with a number."
            : "Couldn’t save environment variables.",
        );
        toast.error(`Couldn’t save ${title.toLowerCase()}.`);
      })
      .finally(() => setSaving(false));
  }, [saving, disabled, rows, onSave, title]);

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div className="space-y-0.5">
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="text-muted-foreground text-sm">{ENV_VARS_HINT}</p>
      </div>

      <Separator />

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-muted-foreground text-xs">No environment variables set.</p>
        ) : (
          rows.map((row) => (
            // Mobile: the name takes its own row, then value + delete pair up on
            // the next — so the trash never floats alone. Desktop: one flex row.
            <div
              key={row.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-row"
            >
              <Input
                value={row.name}
                onChange={(event) => updateRow(row.id, { name: event.target.value })}
                placeholder="NAME"
                className="col-span-2 font-mono text-sm sm:col-span-1 sm:w-48"
                disabled={disabled || saving}
                aria-label="Variable name"
              />
              <Input
                value={row.value}
                onChange={(event) => updateRow(row.id, { value: event.target.value })}
                placeholder="value"
                className="font-mono text-sm sm:flex-1"
                disabled={disabled || saving}
                aria-label="Variable value"
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => removeRow(row.id)}
                disabled={disabled || saving}
                aria-label={`Remove ${row.name || "variable"}`}
              >
                <Trash aria-hidden />
              </Button>
            </div>
          ))
        )}
      </div>

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addRow}
        disabled={disabled || saving}
      >
        <Plus aria-hidden /> Add variable
      </Button>

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
            placeholder={"NODE_ENV=production\n# comments and blank lines are ignored"}
            rows={4}
            className="font-mono text-sm"
            disabled={disabled || saving}
          />
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={importPaste}
              disabled={disabled || saving || !pasteText.trim()}
            >
              Import
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Separator />

      <div className="flex items-center justify-end gap-3">
        {error && (
          <p className="mr-auto text-reject text-xs" role="alert">
            {error}
          </p>
        )}
        <Button type="button" onClick={handleSave} disabled={disabled || saving} aria-busy={saving}>
          {saving ? <Spinner /> : null}
          Save
        </Button>
      </div>
    </Card>
  );
}
