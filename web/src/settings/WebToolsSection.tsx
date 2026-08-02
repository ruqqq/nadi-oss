import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  deleteExaSecret,
  getWebToolsSettings,
  saveExaSecret,
  type WebToolsSettings,
} from "../settings-api";
import { WEB_TOOLS_SETTINGS_HINT } from "../settings-ui-config";
import { cn } from "../lib/utils";
import { CheckCircle, Globe } from "../icons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { SectionHeading } from "./section-ui";

function formatSecretDate(value: string | null): string {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

export function WebToolsSection() {
  const [status, setStatus] = useState<WebToolsSettings | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setStatus(null);
    setLoadError(null);
    void getWebToolsSettings()
      .then(setStatus)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Web search" className="space-y-4">
      <SectionHeading
        icon={<Globe aria-hidden className="size-4 text-muted-foreground" />}
        title="Web search"
        description={WEB_TOOLS_SETTINGS_HINT}
      />

      {loadError ? (
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>
              Couldn’t load web search settings. {loadError.message}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : status === null ? (
        <Card
          className="flex flex-col gap-4 p-4"
          aria-busy="true"
          aria-label="Loading web search settings"
        >
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : (
        <WebToolsForm status={status} onChanged={setStatus} />
      )}
    </section>
  );
}

function WebToolsForm({
  status,
  onChanged,
}: {
  status: WebToolsSettings;
  onChanged: (status: WebToolsSettings) => void;
}) {
  const [secretValue, setSecretValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);

  const save = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (saving || !secretValue.trim()) return;
      setSaving(true);
      setError(null);
      void saveExaSecret(secretValue)
        .then((next) => {
          onChanged(next);
          setSecretValue("");
          toast.success("Saved Exa API key");
        })
        .catch(() => {
          setError("Couldn’t save the API key.");
          toast.error("Couldn’t save the Exa API key.");
        })
        .finally(() => setSaving(false));
    },
    [saving, secretValue, onChanged],
  );

  const remove = useCallback(() => {
    if (removing) return;
    setRemoving(true);
    setError(null);
    void deleteExaSecret()
      .then((next) => {
        onChanged(next);
        setConfirmingRemove(false);
        toast.success("Removed Exa API key");
      })
      .catch(() => {
        setError("Couldn’t remove the API key.");
        toast.error("Couldn’t remove the Exa API key.");
      })
      .finally(() => setRemoving(false));
  }, [removing, onChanged]);

  return (
    <Card className="p-4">
      <form className="space-y-4" onSubmit={save}>
        <div className="space-y-1.5">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="web-tools-exa-key">Exa API key</Label>
            <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
              <span
                className={cn(
                  "size-2 shrink-0 rounded-full",
                  status.exaSecretPresent ? "bg-approve" : "bg-muted-foreground/40",
                )}
                aria-hidden="true"
              />
              {status.exaSecretPresent ? "Configured" : "Not configured"}
            </span>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="web-tools-exa-key"
              type="password"
              autoComplete="new-password"
              placeholder={status.exaSecretPresent ? "••••••••••••" : "exa_…"}
              value={secretValue}
              onChange={(event) => setSecretValue(event.target.value)}
              disabled={saving}
              className="flex-1"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={saving || !secretValue.trim()}
              aria-busy={saving}
            >
              {saving ? <Spinner /> : null}
              Save key
            </Button>
          </div>
          {status.exaSecretPresent && (
            <p className="text-muted-foreground text-xs">
              Updated {formatSecretDate(status.exaSecretUpdatedAt)}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            The stored key is never displayed. Saving a new value replaces it.
          </p>
        </div>

        {status.exaSecretPresent && (
          <div className="flex items-center justify-between gap-3">
            <p className="text-muted-foreground text-xs">Remove the key to disable web search.</p>
            {confirmingRemove ? (
              <span className="flex items-center gap-1" role="group" aria-label="Confirm remove">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8 text-reject hover:text-reject"
                  onClick={remove}
                  disabled={removing}
                  aria-busy={removing}
                  aria-label="Confirm remove Exa API key"
                >
                  {removing ? <Spinner /> : null}
                  Remove
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={() => setConfirmingRemove(false)}
                  disabled={removing}
                  aria-label="Cancel remove"
                >
                  Cancel
                </Button>
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="h-8 text-muted-foreground hover:text-reject"
                onClick={() => setConfirmingRemove(true)}
                aria-label="Remove Exa API key"
              >
                Remove key
              </Button>
            )}
          </div>
        )}

        {error && (
          <p className="text-reject text-xs" role="alert">
            {error}
          </p>
        )}

        <Separator />

        <div className="space-y-2">
          <Alert role="status">
            {status.webSearchEnabled && <CheckCircle className="text-approve" />}
            <AlertDescription className={status.webSearchEnabled ? "text-approve" : undefined}>
              {status.webSearchEnabled
                ? "Web search is enabled."
                : "Web search is disabled until a key is set."}
            </AlertDescription>
          </Alert>
          <p className="text-muted-foreground text-xs">
            Page fetching (web_fetch) is always available and needs no key.
          </p>
        </div>
      </form>
    </Card>
  );
}
