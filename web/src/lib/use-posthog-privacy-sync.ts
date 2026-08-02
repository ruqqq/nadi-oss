import { useEffect, useState } from "react";
import type { AuthSession } from "../auth-api";
import {
  getPrivacySettings as getPrivacySettingsDefault,
  type PrivacySettings,
} from "../settings-api";
import {
  identifyUser as identifyUserDefault,
  setPostHogConsent as setPostHogConsentDefault,
} from "./posthog";

type GetPrivacySettings = (input: { workspaceId?: string }) => Promise<PrivacySettings>;

export function usePostHogPrivacySync({
  session,
  consentWorkspaceId,
  getPrivacySettings = getPrivacySettingsDefault,
  setPostHogConsent = setPostHogConsentDefault,
  identifyUser = identifyUserDefault,
}: {
  session: AuthSession | null;
  consentWorkspaceId: string | null;
  getPrivacySettings?: GetPrivacySettings;
  setPostHogConsent?: (enabled: boolean) => void;
  identifyUser?: (user: { id: string; email?: string }) => void;
}): void {
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const authenticatedUser = session?.authenticated ? session.user : null;

  useEffect(() => {
    setTelemetryEnabled(false);
    setPostHogConsent(false);
    if (!authenticatedUser || consentWorkspaceId === null) return;

    let active = true;
    const workspaceId = consentWorkspaceId;

    void getPrivacySettings({ workspaceId })
      .then((settings) => {
        if (!active || settings.workspaceId !== workspaceId) return;
        setTelemetryEnabled(settings.telemetryEnabled);
        setPostHogConsent(settings.telemetryEnabled);
      })
      .catch(() => {
        if (!active) return;
        setTelemetryEnabled(false);
        setPostHogConsent(false);
      });

    return () => {
      active = false;
    };
  }, [authenticatedUser, consentWorkspaceId, getPrivacySettings, setPostHogConsent]);

  useEffect(() => {
    if (!telemetryEnabled || !authenticatedUser) return;
    identifyUser({ id: authenticatedUser.id, email: authenticatedUser.email });
  }, [authenticatedUser, identifyUser, telemetryEnabled]);
}
