import { useCallback, useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  clearDaytonaOverride,
  clearSpritesOverride,
  getSandboxSettings,
  saveDaytonaSecret,
  saveSpritesSecret,
  saveWorkspaceSandboxSettings,
  testConnection,
  type ComputeProviderReadiness,
  type DaytonaProviderConfig,
  type SandboxConnectionTestResult,
  type SandboxEffectiveConfigReason,
  type SandboxEnvironmentSource,
  type SandboxReadiness,
  type SandboxResourceProfile,
  type SandboxSettingsResponse,
  type SandboxWorkspaceSettings,
  type SpritesProviderConfig,
} from "../sandbox-settings-api";
import {
  SANDBOX_CLOUDFLARE_NETWORK_UNSUPPORTED_CONSEQUENCE_HINT,
  SANDBOX_CLOUDFLARE_PROVISIONING_HINT,
  SANDBOX_CLOUDFLARE_READINESS_GROUPS,
  SANDBOX_CLOUDFLARE_READINESS_HINT,
  SANDBOX_PROVIDER_OPTIONS,
  SANDBOX_SETTINGS_HINT,
  SANDBOX_SNAPSHOT_HINT,
  SANDBOX_SPRITES_HINT,
  sandboxCloudflareNetworkUnsupportedNote,
  type SandboxProviderId,
} from "../settings-ui-config";
import { cn } from "../lib/utils";
import { CheckCircle, XCircle } from "../icons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Switch } from "../components/ui/switch";
import {
  Field,
  FORM_ACTION_BUTTON,
  FormActions,
  FormCard,
  PaneFooter,
  SectionHeading,
} from "./section-ui";
import { SettingsFooterPortal } from "./footer-slot";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const DEFAULT_DAYTONA_CONFIG: DaytonaProviderConfig = {
  kind: "daytona",
  apiKeySecretName: "sandbox:daytona",
  apiUrl: null,
  target: null,
  profiles: { small: null, medium: null },
};

const DEFAULT_SPRITES_CONFIG: SpritesProviderConfig = {
  kind: "sprites",
  apiKeySecretName: "sandbox:sprites",
};

const DEFAULT_WORKSPACE_SANDBOX: SandboxWorkspaceSettings = {
  enabled: false,
  provider: "daytona",
  providerConfig: DEFAULT_DAYTONA_CONFIG,
  idleTimeoutMs: 900_000,
  recoveryTtlMs: 86_400_000,
  maxProcessRuntimeMs: 600_000,
  networkRestrictionEnabled: false,
  networkDomainAllowlist: "",
  envVars: {},
};

/** An empty value clears the profile; the worker stores `null` for "not configured". */
function toEnvironmentSource(
  kind: SandboxEnvironmentSource["kind"],
  value: string,
): SandboxEnvironmentSource | null {
  const trimmed = value.trim();
  return trimmed ? { kind, value: trimmed } : null;
}

const INCOMPLETE_CONFIG_MESSAGES: Record<SandboxEffectiveConfigReason, string> = {
  missing_workspace_settings: "Sandbox execution hasn't been set up for this workspace yet.",
  disabled: "Sandbox execution is turned off.",
  missing_secret: "Add a Daytona API key below to turn on sandbox execution.",
  missing_source: "Set a sandbox image or snapshot below to turn on sandbox execution.",
  unsupported_provider: "The configured sandbox provider isn't supported.",
};

function msToMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

function minutesToMs(minutes: number): number {
  return Math.max(1, Math.round(minutes)) * 60_000;
}

export function SandboxSection() {
  const [settings, setSettings] = useState<SandboxSettingsResponse | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);

  const load = useCallback(() => {
    setSettings(null);
    setLoadError(null);
    void getSandboxSettings()
      .then(setSettings)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section aria-label="Sandbox" className="space-y-4">
      <SectionHeading title="Sandbox" description={SANDBOX_SETTINGS_HINT} />

      {loadError ? (
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load sandbox settings. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : settings === null ? (
        <div className="space-y-4" aria-busy="true" aria-label="Loading sandbox settings">
          <Card className="flex flex-col gap-4 p-4">
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-10 w-full" />
            <div className="grid gap-3 sm:grid-cols-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          </Card>
          <Card className="flex flex-col gap-4 p-4">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-10 w-full" />
          </Card>
        </div>
      ) : (
        <SandboxSettingsForm settings={settings} onSaved={setSettings} />
      )}
    </section>
  );
}

function SandboxSettingsForm({
  settings,
  onSaved,
}: {
  settings: SandboxSettingsResponse;
  onSaved: (settings: SandboxSettingsResponse) => void;
}) {
  const showIncompleteAlert = !settings.effective.enabled;
  const reason = settings.effective.enabled ? null : settings.effective.reason;

  return (
    <div className="space-y-4">
      {showIncompleteAlert && (
        <Alert role="status">
          <AlertDescription>
            {reason ? INCOMPLETE_CONFIG_MESSAGES[reason] : "Sandbox execution is unavailable."} The
            agent's exec_* tools stay hidden until this is fixed.
          </AlertDescription>
        </Alert>
      )}

      <WorkspaceSandboxCard
        workspace={settings.workspace}
        daytonaSecretPresent={settings.daytonaSecretPresent}
        readiness={settings.readiness}
        daytonaMode={settings.daytonaMode}
        daytonaAvailable={settings.daytonaAvailable}
        spritesSecretPresent={settings.spritesSecretPresent}
        spritesMode={settings.spritesMode}
        spritesAvailable={settings.spritesAvailable}
        mockAvailable={settings.mockAvailable ?? false}
        cloudflareAvailable={settings.cloudflareAvailable ?? true}
        operatorManagedCompute={settings.operatorManagedCompute ?? false}
        onSaved={onSaved}
      />
    </div>
  );
}

function WorkspaceSandboxCard({
  workspace,
  daytonaSecretPresent,
  readiness,
  daytonaMode: confirmedDaytonaMode,
  daytonaAvailable,
  spritesSecretPresent,
  spritesMode: confirmedSpritesMode,
  spritesAvailable,
  mockAvailable,
  cloudflareAvailable,
  operatorManagedCompute,
  onSaved,
}: {
  workspace: SandboxWorkspaceSettings | null;
  daytonaSecretPresent: boolean;
  readiness: SandboxReadiness;
  daytonaMode: SandboxSettingsResponse["daytonaMode"];
  daytonaAvailable: boolean;
  spritesSecretPresent: boolean;
  spritesMode: SandboxSettingsResponse["spritesMode"];
  spritesAvailable: boolean;
  /** Whether `mock` may be selected — only on a deployment that opted in with
   *  DEFAULT_SANDBOX_PROVIDER=mock. The server refuses it on the same
   *  condition, so this hides an option rather than being the only guard. */
  mockAvailable: boolean;
  /** Whether `cloudflare` may be selected — false on celld, which has no
   *  container bindings. Distinct from `readiness.cloudflare`, which answers
   *  "provisioned yet?" on a platform that HAS containers. The server refuses
   *  it on the same condition. */
  cloudflareAvailable: boolean;
  /** Hides the read-only deployment panel — an operator set this compute up. */
  operatorManagedCompute: boolean;
  onSaved: (settings: SandboxSettingsResponse) => void;
}) {
  const base = workspace ?? DEFAULT_WORKSPACE_SANDBOX;
  // Daytona is the only provider with editable image/snapshot/credential fields;
  // when the workspace is on another provider we fall back to Daytona defaults so
  // hook order stays stable, and gate what actually renders on `provider` below.
  const daytona = base.providerConfig.kind === "daytona" ? base.providerConfig : null;
  const config = daytona ?? DEFAULT_DAYTONA_CONFIG;
  // Sprites has only a BYOK secret name, no other config fields; same
  // hook-order-stability rationale as Daytona above.
  const sprites = base.providerConfig.kind === "sprites" ? base.providerConfig : null;
  const spritesConfig = sprites ?? DEFAULT_SPRITES_CONFIG;
  const initialProvider: SandboxProviderId =
    base.providerConfig.kind === "cloudflare"
      ? "cloudflare"
      : base.providerConfig.kind === "sprites"
        ? "sprites"
        : base.providerConfig.kind === "mock"
          ? "mock"
          : "daytona";
  const [provider, setProvider] = useState<SandboxProviderId>(initialProvider);
  const [daytonaMode, setDaytonaMode] = useState(confirmedDaytonaMode);
  const [spritesMode, setSpritesMode] = useState(confirmedSpritesMode);
  // `@cloudflare/sandbox` has no network-policy API, so a restricted workspace
  // cannot run on Cloudflare. The server is the sole authority for this verdict
  // (derived from the effective allowlist); the UI only consumes it.
  const cloudflareNetworkUnsupported =
    readiness.cloudflare.unsupported.includes("network_restrictions");
  // Mock is a test double and stays out of the list unless the deployment opted
  // in. The `provider === "mock"` escape keeps a workspace already on mock from
  // rendering a Select with no matching item — which would read as an empty
  // provider and silently re-save as something else on the next submit.
  // Both escapes keep a workspace ALREADY on the provider from rendering a
  // Select with no matching item — which reads as an empty provider and
  // silently re-saves as something else on the next submit. That case is real
  // on celld: a deploy that never set DEFAULT_SANDBOX_PROVIDER seeds new
  // workspaces `cloudflare`, and the operator needs to see it to change it.
  const providerOptions = SANDBOX_PROVIDER_OPTIONS.filter((option) => {
    if (option.value === "mock") return mockAvailable || provider === "mock";
    if (option.value === "cloudflare") return cloudflareAvailable || provider === "cloudflare";
    return true;
  });
  const [enabled, setEnabled] = useState(base.enabled);
  const [smallKind, setSmallKind] = useState(config.profiles.small?.kind ?? "snapshot");
  const [smallValue, setSmallValue] = useState(config.profiles.small?.value ?? "");
  const [mediumKind, setMediumKind] = useState(config.profiles.medium?.kind ?? "snapshot");
  const [mediumValue, setMediumValue] = useState(config.profiles.medium?.value ?? "");
  const [apiUrl, setApiUrl] = useState(config.apiUrl ?? "");
  const [target, setTarget] = useState(config.target ?? "");
  const [idleTimeoutMinutes, setIdleTimeoutMinutes] = useState(() =>
    msToMinutes(base.idleTimeoutMs),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [secretValue, setSecretValue] = useState("");

  useEffect(() => {
    setProvider(initialProvider);
    setDaytonaMode(confirmedDaytonaMode);
    setSpritesMode(confirmedSpritesMode);
    setEnabled(base.enabled);
    setSmallKind(config.profiles.small?.kind ?? "snapshot");
    setSmallValue(config.profiles.small?.value ?? "");
    setMediumKind(config.profiles.medium?.kind ?? "snapshot");
    setMediumValue(config.profiles.medium?.value ?? "");
    setApiUrl(config.apiUrl ?? "");
    setTarget(config.target ?? "");
    setIdleTimeoutMinutes(msToMinutes(base.idleTimeoutMs));
  }, [
    base.enabled,
    config.profiles.small?.kind,
    config.profiles.small?.value,
    config.profiles.medium?.kind,
    config.profiles.medium?.value,
    config.apiUrl,
    config.target,
    base.idleTimeoutMs,
    initialProvider,
    confirmedDaytonaMode,
    confirmedSpritesMode,
  ]);

  const submit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (saving) return;
      if (
        provider === "daytona" &&
        daytonaMode === "byok" &&
        (!secretValue.trim() || !smallValue.trim() || !mediumValue.trim())
      ) {
        setError("Add an API key and a source for both Daytona profiles.");
        return;
      }
      setSaving(true);
      setError(null);
      // Shared policy fields go to both providers. The provider-specific
      // `providerConfig` is built per branch so a Cloudflare save carries NO
      // Daytona fields (no image/snapshot/credentials), and vice versa.
      // Network restriction is intentionally omitted: its controls are hidden
      // pending the move to agent-level config, and the PUT merge-preserves
      // the stored values when the keys are absent.
      const shared = {
        enabled,
        idleTimeoutMs: minutesToMs(idleTimeoutMinutes),
      };
      const payload =
        provider === "cloudflare"
          ? { ...shared, provider: "cloudflare", providerConfig: { kind: "cloudflare" } }
          : provider === "mock"
            ? { ...shared, provider: "mock", providerConfig: { kind: "mock" } }
            : provider === "sprites"
              ? {
                  ...shared,
                  provider: "sprites",
                  providerConfig: {
                    kind: "sprites",
                    apiKeySecretName: spritesConfig.apiKeySecretName,
                  },
                }
              : {
                  ...shared,
                  provider: "daytona",
                  providerConfig: {
                    kind: "daytona",
                    apiKeySecretName: config.apiKeySecretName,
                    apiUrl: apiUrl.trim() || null,
                    target: target.trim() || null,
                    profiles: {
                      small: toEnvironmentSource(smallKind, smallValue),
                      medium: toEnvironmentSource(mediumKind, mediumValue),
                    },
                  },
                };
      let workspaceView: SandboxSettingsResponse | null = null;
      try {
        workspaceView = await saveWorkspaceSandboxSettings(payload);
        const next =
          provider === "daytona" && daytonaMode === "byok"
            ? await saveDaytonaSecret({
                value: secretValue.trim(),
                secretName: config.apiKeySecretName,
              })
            : provider === "sprites" && spritesMode === "byok" && secretValue.trim()
              ? await saveSpritesSecret({
                  value: secretValue.trim(),
                  secretName: spritesConfig.apiKeySecretName,
                })
              : workspaceView;
        onSaved(next);
        setSecretValue("");
        toast.success("Saved workspace sandbox settings");
      } catch (err: unknown) {
        const status = err instanceof Error ? err.message.match(/\((\d+)\)/)?.[1] : null;
        if (workspaceView) {
          const savedBase = workspaceView.workspace ?? DEFAULT_WORKSPACE_SANDBOX;
          const savedConfig =
            savedBase.providerConfig.kind === "daytona"
              ? savedBase.providerConfig
              : DEFAULT_DAYTONA_CONFIG;
          onSaved(workspaceView);
          setProvider(
            savedBase.providerConfig.kind === "cloudflare"
              ? "cloudflare"
              : savedBase.providerConfig.kind === "sprites"
                ? "sprites"
                : "daytona",
          );
          setDaytonaMode(workspaceView.daytonaMode);
          setSpritesMode(workspaceView.spritesMode);
          setEnabled(savedBase.enabled);
          setSmallKind(savedConfig.profiles.small?.kind ?? "snapshot");
          setSmallValue(savedConfig.profiles.small?.value ?? "");
          setMediumKind(savedConfig.profiles.medium?.kind ?? "snapshot");
          setMediumValue(savedConfig.profiles.medium?.value ?? "");
          setApiUrl(savedConfig.apiUrl ?? "");
          setTarget(savedConfig.target ?? "");
          setIdleTimeoutMinutes(msToMinutes(savedBase.idleTimeoutMs));
        } else {
          setDaytonaMode(confirmedDaytonaMode);
          setSpritesMode(confirmedSpritesMode);
        }
        setError(
          provider === "daytona" && daytonaMode === "byok"
            ? "Couldn’t save the BYOK Daytona configuration. Your previous mode is unchanged."
            : provider === "sprites" && spritesMode === "byok"
              ? "Couldn’t save the BYOK Sprites configuration. Your previous mode is unchanged."
              : status === "400"
                ? "Check the sandbox image and settings."
                : "Couldn’t save sandbox settings.",
        );
        toast.error("Couldn’t save workspace sandbox settings.");
      } finally {
        setSaving(false);
      }
    },
    [
      saving,
      provider,
      daytonaMode,
      confirmedDaytonaMode,
      spritesMode,
      confirmedSpritesMode,
      spritesConfig.apiKeySecretName,
      enabled,
      config.apiKeySecretName,
      smallKind,
      smallValue,
      mediumKind,
      mediumValue,
      apiUrl,
      target,
      idleTimeoutMinutes,
      secretValue,
      onSaved,
    ],
  );

  const selectSystemManaged = useCallback(async () => {
    if (saving || confirmedDaytonaMode === "system") return;
    setSaving(true);
    setError(null);
    try {
      const next = await clearDaytonaOverride();
      onSaved(next);
      setSecretValue("");
      toast.success("Switched to system-managed Daytona");
    } catch {
      setDaytonaMode(confirmedDaytonaMode);
      setError("Couldn’t switch to system-managed Daytona. Your BYOK configuration is unchanged.");
      toast.error("Couldn’t reset the Daytona configuration.");
    } finally {
      setSaving(false);
    }
  }, [saving, confirmedDaytonaMode, onSaved]);

  const selectSpritesSystemManaged = useCallback(async () => {
    if (saving || confirmedSpritesMode === "system") return;
    setSaving(true);
    setError(null);
    try {
      const next = await clearSpritesOverride();
      onSaved(next);
      setSecretValue("");
      toast.success("Switched to system-managed Sprites");
    } catch {
      setSpritesMode(confirmedSpritesMode);
      setError("Couldn’t switch to system-managed Sprites. Your BYOK configuration is unchanged.");
      toast.error("Couldn’t reset the Sprites configuration.");
    } finally {
      setSaving(false);
    }
  }, [saving, confirmedSpritesMode, onSaved]);

  // Radix already blocks selecting a disabled item; this second guard keeps the
  // gate enforced even if the option is ever rendered enabled by mistake.
  const onProviderChange = useCallback(
    (value: string) => {
      if (value === "cloudflare" && cloudflareNetworkUnsupported) return;
      setProvider(value as SandboxProviderId);
    },
    [cloudflareNetworkUnsupported],
  );

  return (
    <>
    <form id="sandbox-settings-form" className="space-y-4" onSubmit={submit}>
      <FormCard title="Compute provider">
        <Field label="Provider" htmlFor="sandbox-provider">
          <Select value={provider} onValueChange={onProviderChange} disabled={saving}>
            <SelectTrigger id="sandbox-provider" aria-label="Compute provider" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((option) => (
                <SelectItem
                  key={option.value}
                  value={option.value}
                  disabled={option.value === "cloudflare" && cloudflareNetworkUnsupported}
                >
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {cloudflareNetworkUnsupported && (
            <p className="text-muted-foreground text-xs" role="note">
              {sandboxCloudflareNetworkUnsupportedNote(provider)}
            </p>
          )}
        </Field>
      </FormCard>

      <FormCard title="Execution">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label htmlFor="sandbox-enabled">Enable sandbox</Label>
            <p className="text-muted-foreground text-sm">
              Turn on sandbox execution for agents in this workspace.
            </p>
          </div>
          <Switch
            id="sandbox-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={saving}
            aria-label="Enable sandbox execution for the workspace"
          />
        </div>
        {provider === "daytona" && daytonaMode === "byok" && (
          <Field label="Idle timeout (minutes)" htmlFor="sandbox-idle-timeout">
            <Input
              id="sandbox-idle-timeout"
              type="number"
              min={1}
              max={1440}
              value={idleTimeoutMinutes}
              onChange={(event) => setIdleTimeoutMinutes(Number(event.target.value) || 1)}
              disabled={saving}
            />
          </Field>
        )}
      </FormCard>

      {provider === "daytona" ? (
        <>
          <FormCard title="Daytona configuration">
            <div className="space-y-2">
              <ButtonGroup aria-label="Daytona configuration mode">
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={daytonaMode === "system"}
                  className={cn(daytonaMode === "system" && "bg-accent text-accent-foreground")}
                  onClick={selectSystemManaged}
                  disabled={saving}
                >
                  System managed
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={daytonaMode === "byok"}
                  className={cn(daytonaMode === "byok" && "bg-accent text-accent-foreground")}
                  onClick={() => {
                    setError(null);
                    setDaytonaMode("byok");
                  }}
                  disabled={saving}
                >
                  BYOK
                </Button>
              </ButtonGroup>
              {daytonaMode === "system" && (
                <p className="text-muted-foreground text-sm" role="status">
                  {daytonaAvailable
                    ? "System-managed Daytona is ready for this workspace."
                    : "System-managed Daytona is not available for this workspace."}
                </p>
              )}
            </div>
          </FormCard>
          {daytonaMode === "byok" && (
            <>
              <FormCard title="Daytona connection">
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-3">
                    <Label htmlFor="sandbox-daytona-key">Daytona API key</Label>
                    <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          daytonaSecretPresent ? "bg-approve" : "bg-muted-foreground/40",
                        )}
                        aria-hidden="true"
                      />
                      {daytonaSecretPresent ? "Configured" : "Not configured"}
                    </span>
                  </div>
                  <Input
                    id="sandbox-daytona-key"
                    type="password"
                    autoComplete="new-password"
                    placeholder={daytonaSecretPresent ? "••••••••••••" : "dt_…"}
                    value={secretValue}
                    onChange={(event) => setSecretValue(event.target.value)}
                    disabled={saving}
                  />
                  <p className="text-muted-foreground text-xs">
                    The stored key is never displayed. Saving a new value replaces it.
                  </p>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Daytona API URL" htmlFor="sandbox-api-url">
                    <Input
                      id="sandbox-api-url"
                      value={apiUrl}
                      onChange={(event) => setApiUrl(event.target.value)}
                      placeholder="https://app.daytona.io/api"
                      inputMode="url"
                      disabled={saving}
                    />
                  </Field>
                  <Field label="Target / region" htmlFor="sandbox-target">
                    <Input
                      id="sandbox-target"
                      value={target}
                      onChange={(event) => setTarget(event.target.value)}
                      placeholder="us"
                      disabled={saving}
                    />
                  </Field>
                </div>
              </FormCard>

              <FormCard title="Sandbox sizes">
                <div className="grid gap-3 sm:grid-cols-2">
                  <ProfileSourceFields
                    profile="small"
                    label="Small profile"
                    kind={smallKind}
                    value={smallValue}
                    onKindChange={setSmallKind}
                    onValueChange={setSmallValue}
                    disabled={saving}
                  />
                  <ProfileSourceFields
                    profile="medium"
                    label="Medium profile"
                    kind={mediumKind}
                    value={mediumValue}
                    onKindChange={setMediumKind}
                    onValueChange={setMediumValue}
                    disabled={saving}
                  />
                  <p className="text-muted-foreground text-xs sm:col-span-2">
                    {SANDBOX_SNAPSHOT_HINT}
                  </p>
                </div>
              </FormCard>
            </>
          )}
        </>
      ) : provider === "sprites" ? (
        <>
          <FormCard title="Sprites configuration">
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">{SANDBOX_SPRITES_HINT}</p>
              <ButtonGroup aria-label="Sprites configuration mode">
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={spritesMode === "system"}
                  className={cn(spritesMode === "system" && "bg-accent text-accent-foreground")}
                  onClick={selectSpritesSystemManaged}
                  disabled={saving}
                >
                  System managed
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  aria-pressed={spritesMode === "byok"}
                  className={cn(spritesMode === "byok" && "bg-accent text-accent-foreground")}
                  onClick={() => {
                    setError(null);
                    setSpritesMode("byok");
                  }}
                  disabled={saving}
                >
                  BYOK
                </Button>
              </ButtonGroup>
              {spritesMode === "system" && (
                <p className="text-muted-foreground text-sm" role="status">
                  {spritesAvailable
                    ? "Provisioned by the operator."
                    : "No system Sprites token is configured for this deployment."}
                </p>
              )}
            </div>
          </FormCard>
          {spritesMode === "byok" && (
            <FormCard title="Sprites connection">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-3">
                  <Label htmlFor="sandbox-sprites-key">Sprites API token</Label>
                  <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
                    <span
                      className={cn(
                        "size-2 shrink-0 rounded-full",
                        spritesSecretPresent ? "bg-approve" : "bg-muted-foreground/40",
                      )}
                      aria-hidden="true"
                    />
                    {spritesSecretPresent ? "Configured" : "Not configured"}
                  </span>
                </div>
                <Input
                  id="sandbox-sprites-key"
                  type="password"
                  autoComplete="new-password"
                  placeholder={spritesSecretPresent ? "••••••••••••" : "fo1_…"}
                  value={secretValue}
                  onChange={(event) => setSecretValue(event.target.value)}
                  className="font-mono"
                  disabled={saving}
                />
                <p className="text-muted-foreground text-xs">
                  The stored token is never displayed. Saving a new value replaces it.
                </p>
              </div>
            </FormCard>
          )}
        </>
      ) : operatorManagedCompute ? null : (
        <Card className="p-4">
          <CloudflareReadinessPanel readiness={readiness.cloudflare} />
        </Card>
      )}

      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {provider === "daytona" && daytonaMode === "byok" && (
        <Card className="p-4">
          {/* The worker's test endpoint launches the small profile, so that gates it. */}
          <ConnectionTestControl
            canTest={daytonaSecretPresent && config.profiles.small !== null}
            blockedReason={
              !daytonaSecretPresent
                ? "Add a Daytona API key above to test the connection."
                : config.profiles.small === null
                  ? "Set a small-profile image or snapshot above, and save, to test the connection."
                  : null
            }
          />
        </Card>
      )}
    </form>

    <SettingsFooterPortal>
      <PaneFooter contentClassName="max-w-4xl">
        <FormActions>
          <Button
            type="submit"
            form="sandbox-settings-form"
            className={FORM_ACTION_BUTTON}
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? <Spinner /> : null}
            Save workspace settings
          </Button>
        </FormActions>
      </PaneFooter>
    </SettingsFooterPortal>
    </>
  );
}

/**
 * Read-only readiness for Cloudflare compute. Cloudflare is provisioned per
 * deployment (bindings + R2 secrets), so this shows which config an operator has
 * set — by NAME only (from the server's `missingConfig`), never a value. Binding
 * and profile names render in `font-mono` per the Dispatch design language.
 */
function CloudflareReadinessPanel({ readiness }: { readiness: ComputeProviderReadiness }) {
  const missing = new Set(readiness.missingConfig);
  const networkUnsupported = readiness.unsupported.includes("network_restrictions");
  return (
    <div className="flex flex-col gap-4">
      <div className="space-y-0.5">
        <p className="font-medium text-sm">Cloudflare deployment</p>
        <p className="text-muted-foreground text-sm">{SANDBOX_CLOUDFLARE_READINESS_HINT}</p>
      </div>

      {readiness.ready ? (
        <Alert role="status">
          <CheckCircle />
          <AlertDescription className="text-approve">
            Cloudflare compute is provisioned and ready for this workspace.
          </AlertDescription>
        </Alert>
      ) : (
        // `unsupported` ("you can't use this here") and `missingConfig` ("an
        // operator hasn't finished provisioning it") are distinct causes that
        // can both be true at once; render both, never let one hide the other.
        <div className="flex flex-col gap-3">
          {networkUnsupported && (
            <Alert variant="destructive" role="status">
              <XCircle />
              <AlertDescription>
                {SANDBOX_CLOUDFLARE_NETWORK_UNSUPPORTED_CONSEQUENCE_HINT}
              </AlertDescription>
            </Alert>
          )}
          {missing.size > 0 && (
            <Alert role="status">
              <AlertDescription>{SANDBOX_CLOUDFLARE_PROVISIONING_HINT}</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      <div className="flex flex-col gap-4">
        {SANDBOX_CLOUDFLARE_READINESS_GROUPS.map((group) => (
          <div key={group.title} className="flex flex-col gap-2">
            <div className="space-y-0.5">
              <p className="font-medium text-sm">{group.title}</p>
              <p className="text-muted-foreground text-xs">{group.hint}</p>
            </div>
            <div className="flex flex-col gap-1.5">
              {group.names.map((name) => {
                const isMissing = missing.has(name);
                return (
                  <div
                    key={name}
                    data-readiness-row
                    className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-2.5 py-1.5"
                  >
                    <span className="font-mono text-xs break-all">{name}</span>
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 text-xs",
                        isMissing ? "text-reject" : "text-approve",
                      )}
                    >
                      <span
                        className={cn(
                          "size-2 shrink-0 rounded-full",
                          isMissing ? "bg-reject" : "bg-approve",
                        )}
                        aria-hidden="true"
                      />
                      {isMissing ? "Missing" : "Present"}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ProfileSourceFields({
  profile,
  label,
  kind,
  value,
  onKindChange,
  onValueChange,
  disabled,
}: {
  profile: SandboxResourceProfile;
  label: string;
  kind: SandboxEnvironmentSource["kind"];
  value: string;
  onKindChange: (kind: SandboxEnvironmentSource["kind"]) => void;
  onValueChange: (value: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`sandbox-${profile}-source`}>{label}</Label>
      <div className="flex gap-2">
        <Select
          value={kind}
          onValueChange={(next) => onKindChange(next as SandboxEnvironmentSource["kind"])}
          disabled={disabled}
        >
          <SelectTrigger className="w-32" aria-label={`${label} source type`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="snapshot">Snapshot</SelectItem>
            <SelectItem value="image">Image</SelectItem>
          </SelectContent>
        </Select>
        <Input
          id={`sandbox-${profile}-source`}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={kind === "image" ? "daytonaio/sandbox:latest" : `nadi-${profile}`}
          className="flex-1 font-mono text-sm"
          disabled={disabled}
        />
      </div>
    </div>
  );
}

type ConnectionTestState =
  | { status: "idle" }
  | { status: "testing" }
  | { status: "done"; result: SandboxConnectionTestResult };

function ConnectionTestControl({
  canTest,
  blockedReason,
}: {
  canTest: boolean;
  blockedReason: string | null;
}) {
  const [state, setState] = useState<ConnectionTestState>({ status: "idle" });
  const testing = state.status === "testing";

  const runTest = useCallback(() => {
    if (testing) return;
    setState({ status: "testing" });
    void testConnection()
      .then((result) => setState({ status: "done", result }))
      .catch((err: unknown) => {
        setState({
          status: "done",
          result: {
            ok: false,
            phase: "connection",
            error: err instanceof Error ? err.message : String(err),
          },
        });
      });
  }, [testing]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <Label htmlFor="sandbox-test-connection">Connection</Label>
          <p className="text-muted-foreground text-sm">
            Creates and removes a temporary sandbox to confirm the saved Daytona settings work.
          </p>
        </div>
        <Button
          id="sandbox-test-connection"
          type="button"
          variant="outline"
          onClick={runTest}
          disabled={!canTest || testing}
          aria-busy={testing}
        >
          {testing ? <Spinner /> : null}
          Test connection
        </Button>
      </div>

      {!canTest && blockedReason && (
        <p className="text-muted-foreground text-xs">{blockedReason}</p>
      )}

      {state.status === "done" &&
        (state.result.ok ? (
          <Alert role="status">
            <CheckCircle />
            <AlertDescription className="text-approve">
              Connected. Daytona created and removed a test sandbox.
            </AlertDescription>
          </Alert>
        ) : (
          <Alert variant="destructive" role="alert">
            <XCircle />
            <AlertDescription>
              {state.result.phase === "cleanup"
                ? "Connected, but couldn’t remove the test sandbox. Check your Daytona dashboard for a leftover sandbox."
                : "Couldn’t connect to Daytona. Check the API key and sandbox image."}
            </AlertDescription>
          </Alert>
        ))}
    </div>
  );
}
