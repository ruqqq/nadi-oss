import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { getUserPreferences, saveUserPreferences } from "../user-preferences-api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { SectionHeading } from "./section-ui";

/**
 * Whether the model's thinking is displayed. A viewer preference, not agent or
 * thread configuration: it changes nothing about how the model runs, and two
 * people reading the same thread may want different answers.
 */
export function ReasoningDisplaySection() {
  const [showReasoning, setShowReasoning] = useState<boolean | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const load = useCallback(() => {
    setShowReasoning(null);
    setLoadError(null);
    void getUserPreferences()
      .then((prefs) => setShowReasoning(prefs.showReasoning))
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = useCallback(
    (next: boolean) => {
      if (saving) return;
      setSaving(true);
      setSaveError(null);
      // Optimistic: the switch should not lag behind the finger.
      setShowReasoning(next);
      void saveUserPreferences(next)
        .then((prefs) => {
          setShowReasoning(prefs.showReasoning);
          toast.success(prefs.showReasoning ? "Showing reasoning" : "Hiding reasoning");
        })
        .catch((err: unknown) => {
          setShowReasoning(!next);
          setSaveError(err instanceof Error ? err.message : "Couldn’t save your preference.");
          toast.error("Couldn’t save your preference.");
        })
        .finally(() => setSaving(false));
    },
    [saving],
  );

  return (
    <section aria-label="Reasoning" className="space-y-4">
      <SectionHeading
        eyebrow="Display"
        title="Reasoning"
        description="Whether Nadi shows you its thinking as it works."
      />

      {loadError ? (
        <div className="space-y-3">
          <Alert variant="destructive">
            <AlertDescription>
              Couldn’t load display preferences. {loadError.message}
            </AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : showReasoning === null ? (
        <Card
          className="flex flex-col gap-3 p-4"
          aria-busy="true"
          aria-label="Loading display preferences"
        >
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="show-reasoning">Show reasoning</Label>
              <p className="text-muted-foreground text-sm">
                Display the model’s thinking in every chat. Does not change how hard it
                thinks.
              </p>
            </div>
            <Switch
              id="show-reasoning"
              checked={showReasoning}
              onCheckedChange={onToggle}
              disabled={saving}
              aria-label="Show reasoning"
            />
          </div>

          {saveError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{saveError}</AlertDescription>
            </Alert>
          )}
        </Card>
      )}
    </section>
  );
}
