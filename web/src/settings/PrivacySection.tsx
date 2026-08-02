import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Card } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import { SectionHeading } from "./section-ui";
import {
  getPrivacySettings as getPrivacySettingsDefault,
  savePrivacySettings as savePrivacySettingsDefault,
  type PrivacySettings,
} from "../settings-api";
import {
  setPostHogConsent as setPostHogConsentDefault,
  track as trackDefault,
} from "../lib/posthog";

interface PrivacySectionProps {
  consentWorkspaceId?: string | null;
  getPrivacySettings?: () => Promise<PrivacySettings>;
  savePrivacySettings?: (input: { telemetryEnabled: boolean }) => Promise<PrivacySettings>;
  setPostHogConsent?: (enabled: boolean) => void;
  track?: (event: string, props?: Record<string, unknown>) => void;
}

export function PrivacySection({
  consentWorkspaceId = null,
  getPrivacySettings = getPrivacySettingsDefault,
  savePrivacySettings = savePrivacySettingsDefault,
  setPostHogConsent = setPostHogConsentDefault,
  track = trackDefault,
}: PrivacySectionProps) {
  const [settings, setSettings] = useState<PrivacySettings | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [saving, setSaving] = useState(false);

  function applyConsentForActiveWorkspace(next: PrivacySettings) {
    if (next.workspaceId === consentWorkspaceId) {
      setPostHogConsent(next.telemetryEnabled);
    }
  }

  useEffect(() => {
    let active = true;
    getPrivacySettings()
      .then((next) => {
        if (!active) return;
        setSettings(next);
        applyConsentForActiveWorkspace(next);
      })
      .catch((error) => {
        if (!active) return;
        setLoadError(
          error instanceof Error ? error : new Error("Could not load privacy settings."),
        );
      });
    return () => {
      active = false;
    };
  }, [consentWorkspaceId, getPrivacySettings, setPostHogConsent]);

  async function onTelemetryChange(telemetryEnabled: boolean) {
    if (!settings || saving) return;
    const previous = settings;
    setSaving(true);
    setSettings({ ...settings, telemetryEnabled });
    if (!telemetryEnabled && previous.workspaceId === consentWorkspaceId) {
      setPostHogConsent(false);
    }
    try {
      const saved = await savePrivacySettings({ telemetryEnabled });
      setSettings(saved);
      applyConsentForActiveWorkspace(saved);
      toast.success("Saved privacy settings");
      if (saved.telemetryEnabled && saved.workspaceId === consentWorkspaceId) {
        track("settings_saved", {
          section: "privacy",
          telemetryEnabled: true,
          workspace_id: saved.workspaceId,
        });
      }
    } catch (error) {
      setSettings(previous);
      applyConsentForActiveWorkspace(previous);
      toast.error(error instanceof Error ? error.message : "Could not save privacy settings.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section aria-label="Privacy" className="space-y-4">
      <SectionHeading title="Privacy" description="What Nadi collects about your usage." />

      {loadError ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>Couldn’t load privacy settings. {loadError.message}</AlertDescription>
        </Alert>
      ) : null}

      <Card className="flex flex-row items-start justify-between gap-4 p-4">
        <div className="space-y-0.5">
          <Label htmlFor="telemetry-enabled">Share usage data</Label>
          <p className="text-muted-foreground text-sm">
            Sends your email, the models you run, token counts, latency, errors, and feature usage.
            Message and tool content is included in traces.
          </p>
        </div>
        <Switch
          id="telemetry-enabled"
          checked={settings?.telemetryEnabled ?? false}
          disabled={settings === null || saving}
          onCheckedChange={onTelemetryChange}
          aria-label="Share usage data"
        />
      </Card>
    </section>
  );
}
