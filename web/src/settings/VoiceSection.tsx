import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  getVoiceSettings,
  saveVoiceSettings,
  type VoiceLanguage,
  type VoiceSettingsResponse,
} from "../voice-settings-api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { SectionHeading } from "./section-ui";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const VOICE_LANGUAGE_LABELS: Record<VoiceLanguage, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  hi: "Hindi",
  ja: "Japanese",
  pt: "Portuguese",
  it: "Italian",
  nl: "Dutch",
  ru: "Russian",
};

/**
 * Voice settings — the language the model listens for when dictating a
 * message. Follows the card conventions in `SandboxSection.tsx`: a titled
 * section with a one-line purpose hint, over a single settings card.
 */
export function VoiceSection() {
  const [settings, setSettings] = useState<VoiceSettingsResponse | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setSettings(null);
    setLoadError(null);
    void getVoiceSettings()
      .then(setSettings)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Voice" className="space-y-4">
      <SectionHeading
        eyebrow="Dictation"
        title="Voice"
        description="The language Nadi listens for when you dictate a message."
      />

      {loadError ? (
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load voice settings. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : settings === null ? (
        <Card
          className="flex flex-col gap-3 p-4"
          aria-busy="true"
          aria-label="Loading voice settings"
        >
          <Skeleton className="h-3.5 w-32" />
          <Skeleton className="h-10 w-full" />
        </Card>
      ) : (
        <VoiceSettingsForm settings={settings} onSaved={setSettings} />
      )}
    </section>
  );
}

function VoiceSettingsForm({
  settings,
  onSaved,
}: {
  settings: VoiceSettingsResponse;
  onSaved: (settings: VoiceSettingsResponse) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onLanguageChange = useCallback(
    (value: string) => {
      const language = value as VoiceLanguage;
      if (saving || language === settings.language) return;
      setSaving(true);
      setError(null);
      void saveVoiceSettings(language)
        .then((next) => {
          onSaved(next);
          toast.success("Saved dictation language");
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Couldn’t save the dictation language.");
          toast.error("Couldn’t save the dictation language.");
        })
        .finally(() => setSaving(false));
    },
    [saving, settings.language, onSaved],
  );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="space-y-1.5">
        <Label htmlFor="voice-language">Dictation language</Label>
        <p className="text-muted-foreground text-sm">
          The language you speak when dictating a message.
        </p>
        <Select value={settings.language} onValueChange={onLanguageChange} disabled={saving}>
          <SelectTrigger id="voice-language" aria-label="Dictation language" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {settings.supported.map((code) => (
              <SelectItem key={code} value={code}>
                {VOICE_LANGUAGE_LABELS[code]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </Card>
  );
}
