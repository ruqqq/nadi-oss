import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import {
  MCP_RETURN_PATH_KEY,
  parseProvidersRoute,
  parseWorkbenchesRoute,
  providersPath,
  settingsPath,
  workbenchesPath,
  type SettingsTab,
} from "./lib/settings-routes";
import {
  authorizeMcpServer,
  createMcpServer,
  deleteMcpServer,
  listMcpServers,
  listMcpServerTools,
  setMcpServerPolicies,
  updateMcpServer,
  type McpServer,
  type McpToolView,
  type ToolPolicy,
} from "./mcp-api";
import {
  buildDefaultAgentSettingsSaveInput,
  getDefaultAgentSettings,
  isSettingsProvider,
  saveDefaultAgentSettings,
  type AgentSettingsResponse,
  type ModelInputModality,
  type ProviderSettingsView,
  type SettingsProvider,
} from "./settings-api";
import {
  getBrowserNotifications,
  saveBrowserPushSubscription,
  updateBrowserNotificationSettings,
  type BrowserNotificationsResponse,
} from "./notifications-api";
import {
  browserNotificationStatusText,
  classifyBrowserNotificationSupport,
  ensurePushSubscription,
  getExistingPushSubscription,
} from "./lib/browser-notifications";
import { ArrowLeft, CaretRight, Key, Plus, Trash } from "./icons";
import { cn } from "./lib/utils";
import { EffortGauge } from "./icons";
import { isReasoningEffort, REASONING_EFFORTS, type ReasoningEffort } from "./settings-api";
import { shouldOfferEffortControl } from "./lib/reasoning-effort";

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};
import { useTheme, type Theme } from "./lib/theme";
import { track } from "./lib/posthog";
import { canUseWorkspaceTelemetry } from "./lib/workspace-telemetry";
import { SkillsSection } from "./settings/SkillsSection";
import { MemorySection } from "./settings/MemorySection";
import { PrivacySection } from "./settings/PrivacySection";
import { ConnectionsSection } from "./settings/ConnectionsSection";
import { WorkbenchesSection } from "./settings/WorkbenchesSection";
import { ProvidersSection } from "./settings/ProvidersSection";
import { SandboxSection } from "./settings/SandboxSection";
import { ReasoningDisplaySection } from "./settings/ReasoningDisplaySection";
import { VoiceSection } from "./settings/VoiceSection";
import { WebToolsSection } from "./settings/WebToolsSection";
import { FORM_ACTION_BUTTON, FormActions, PaneFooter, SectionHeading } from "./settings/section-ui";
import { SettingsFooterContext, SettingsFooterPortal } from "./settings/footer-slot";
import { ModelPicker } from "./components/model/ModelPicker";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Alert, AlertDescription } from "./components/ui/alert";
import { Card } from "./components/ui/card";
import { Switch } from "./components/ui/switch";
import { Separator } from "./components/ui/separator";
import { Spinner } from "./components/ui/spinner";
import { Skeleton } from "./components/ui/skeleton";
import { Textarea } from "./components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  AGENT_SETTINGS_TITLE,
  DEFAULT_PROVIDER,
  GENERAL_SETTINGS_SHOW_WORKSPACE_SECTION,
  SETTINGS_PROVIDER_MODEL_PLACEHOLDERS,
  defaultModelForProvider,
  SETTINGS_PROVIDER_OPTIONS,
} from "./settings-ui-config";

/**
 * Settings — an operator panel for appearance, default agent behavior, provider
 * credentials, and tool permissions. Rendered inside the chat shell alongside
 * the other panels, so it keeps the sidebar on desktop.
 */
export function Settings({
  consentWorkspaceId = null,
  closeLabel,
  onClose,
  voiceEnabled = false,
  agentNetworkAllowlistEnabled = false,
  tab,
  onTabChange,
  routePath,
  onNavigate,
}: {
  consentWorkspaceId?: string | null;
  /** What the back button goes back to — "Back" or "Chats", per history state. */
  closeLabel: string;
  onClose: () => void;
  /** VOICE_INPUT_ENABLED. Off means there is no dictation anywhere, so the
   *  language card has nothing to configure. */
  voiceEnabled?: boolean;
  agentNetworkAllowlistEnabled?: boolean;
  /** The tab in the URL — so it can be linked to, and survives an OAuth redirect. */
  tab: SettingsTab;
  onTabChange: (tab: SettingsTab) => void;
  /** The full path under /settings — sub-routing within a tab (Workbenches'
   *  master-detail) is parsed from this rather than from `tab` alone. */
  routePath: string;
  /** Navigates within Settings below the tab level, e.g. selecting a
   *  workbench. Tab switches themselves still go through `onTabChange`. */
  onNavigate: (path: string, mode: "push" | "replace") => void;
}) {
  const [servers, setServers] = useState<McpServer[] | null>(null); // null = loading
  const [serversLoadError, setServersLoadError] = useState<Error | null>(null);
  const [settings, setSettings] = useState<AgentSettingsResponse | null>(null); // null = loading
  const [settingsLoadError, setSettingsLoadError] = useState<Error | null>(null);

  const loadMcpServers = useCallback(() => {
    setServers(null);
    setServersLoadError(null);
    void listMcpServers()
      .then(setServers)
      .catch((err: unknown) => {
        setServers([]);
        setServersLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  const loadSettings = useCallback(() => {
    setSettings(null);
    setSettingsLoadError(null);
    void getDefaultAgentSettings()
      .then(setSettings)
      .catch((err: unknown) => {
        setSettingsLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(() => {
    loadMcpServers();
    loadSettings();
  }, [loadMcpServers, loadSettings]);

  const onAdded = useCallback((server: McpServer) => {
    setServers((current) => [...(current ?? []), server]);
  }, []);

  const onChanged = useCallback((server: McpServer) => {
    setServers((current) => current?.map((s) => (s.id === server.id ? server : s)) ?? null);
  }, []);

  const onRemoved = useCallback((id: string) => {
    setServers((current) => current?.filter((s) => s.id !== id) ?? null);
  }, []);

  const onAgentSaved = useCallback((nextSettings: AgentSettingsResponse) => {
    setSettings(nextSettings);
  }, []);

  const workbenchesSelectedId = parseWorkbenchesRoute(routePath)?.selectedId ?? null;
  const onSelectWorkbench = useCallback(
    (id: string) => onNavigate(workbenchesPath(id), "push"),
    [onNavigate],
  );
  const onNewWorkbench = useCallback(() => onNavigate(workbenchesPath("new"), "push"), [onNavigate]);
  const onBackToWorkbenchesList = useCallback(
    () => onNavigate(workbenchesPath(null), "replace"),
    [onNavigate],
  );

  const providersSelectedId = parseProvidersRoute(routePath)?.selectedId ?? null;
  const onSelectProvider = useCallback(
    (id: string) => onNavigate(providersPath(id), "push"),
    [onNavigate],
  );
  const onBackToProvidersList = useCallback(
    () => onNavigate(providersPath(null), "replace"),
    [onNavigate],
  );

  // The tab strip scrolls horizontally on narrow screens. Keep the active tab
  // in view when it changes, so landing on a right-hand tab (e.g. Workbenches)
  // doesn't leave its own label clipped at the edge. No-op where the strip fits.
  const tabsListRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const list = tabsListRef.current;
    const active = list?.querySelector<HTMLElement>('[data-state="active"]');
    if (!list || !active) return;
    const delta =
      active.getBoundingClientRect().left -
      list.getBoundingClientRect().left -
      (list.clientWidth - active.offsetWidth) / 2;
    list.scrollBy({ left: delta, behavior: "smooth" });
  }, [tab]);

  const onProviderChanged = useCallback((provider: ProviderSettingsView) => {
    setSettings((current) => {
      if (!current) return current;
      const providers = current.providers.some((entry) => entry.provider === provider.provider)
        ? current.providers.map((entry) =>
            entry.provider === provider.provider ? provider : entry,
          )
        : [...current.providers, provider];
      return { ...current, providers };
    });
  }, []);

  // Footer slot: tabs portal their primary actions here (see footer-slot.tsx),
  // so a long form's Save bar sits below the scroll area instead of fighting it.
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm">Settings</div>
        </div>
      </header>

      <SettingsFooterContext.Provider value={footerEl}>
      <main className="min-h-0 flex-1 overflow-y-auto standalone:pb-[env(safe-area-inset-bottom)]">
        <div className="mx-auto w-full max-w-4xl p-4 md:p-6">
          <Tabs
            value={tab}
            onValueChange={(value) => onTabChange(value as SettingsTab)}
            className="space-y-4"
          >
            <TabsList
              ref={tabsListRef}
              className="w-full max-w-full justify-start overflow-x-auto overflow-y-hidden overscroll-x-none touch-pan-x sm:w-fit sm:justify-center sm:overflow-visible [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <TabsTrigger value="general" className="flex-none px-3">
                General
              </TabsTrigger>
              <TabsTrigger value="agent" className="flex-none px-3">
                Agent
              </TabsTrigger>
              <TabsTrigger value="providers" className="flex-none px-3">
                Providers
              </TabsTrigger>
              <TabsTrigger value="sandbox" className="flex-none px-3">
                Sandbox
              </TabsTrigger>
              <TabsTrigger value="workbenches" className="flex-none px-3">
                Workbenches
              </TabsTrigger>
              <TabsTrigger value="connections" className="flex-none px-3">
                Connections
              </TabsTrigger>
              <TabsTrigger value="tools" className="flex-none px-3">
                Tools
              </TabsTrigger>
              <TabsTrigger value="skills" className="flex-none px-3">
                Skills
              </TabsTrigger>
              <TabsTrigger value="memory" className="flex-none px-3">
                Memory
              </TabsTrigger>
            </TabsList>

            <TabsContent value="general" className="space-y-8">
              <GeneralSection
                consentWorkspaceId={consentWorkspaceId}
                settings={settings}
                loadError={settingsLoadError}
                onRetry={loadSettings}
                voiceEnabled={voiceEnabled}
              />
            </TabsContent>

            <TabsContent value="agent">
              <AgentSection
                consentWorkspaceId={consentWorkspaceId}
                settings={settings}
                loadError={settingsLoadError}
                onRetry={loadSettings}
                onSaved={onAgentSaved}
              />
            </TabsContent>

            <TabsContent value="providers">
              <ProvidersSection
                settings={settings}
                loadError={settingsLoadError}
                onRetry={loadSettings}
                onProviderChanged={onProviderChanged}
                selectedId={providersSelectedId}
                onSelectProvider={onSelectProvider}
                onBackToList={onBackToProvidersList}
              />
            </TabsContent>

            <TabsContent value="sandbox">
              <SandboxSection />
            </TabsContent>

            <TabsContent value="tools" className="space-y-8">
              <WebToolsSection />
              <Separator />
              <McpServersSection
                servers={servers}
                loadError={serversLoadError}
                onRetry={loadMcpServers}
                onAdded={onAdded}
                onChanged={onChanged}
                onRemoved={onRemoved}
              />
            </TabsContent>

            <TabsContent value="workbenches">
              <WorkbenchesSection
                networkAllowlistEnabled={agentNetworkAllowlistEnabled}
                selectedId={workbenchesSelectedId}
                onSelectWorkbench={onSelectWorkbench}
                onNewWorkbench={onNewWorkbench}
                onBackToList={onBackToWorkbenchesList}
              />
            </TabsContent>
            <TabsContent value="connections">
              <ConnectionsSection />
            </TabsContent>
            <TabsContent value="skills">
              <SkillsSection />
            </TabsContent>
            <TabsContent value="memory">
              <MemorySection />
            </TabsContent>
          </Tabs>
        </div>
      </main>
      {/* Portal target for a tab's primary actions. Stays hidden (and takes no
          height) while empty; a tab fills it via SettingsFooterPortal. */}
      <div ref={setFooterEl} className="shrink-0 empty:hidden" />
      </SettingsFooterContext.Provider>
    </div>
  );
}

function formatProvider(provider: string) {
  return SETTINGS_PROVIDER_OPTIONS.find((option) => option.value === provider)?.label ?? provider;
}

function SettingsLoadError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="space-y-3" role="alert">
      <Alert variant="destructive">
        <AlertDescription>Couldn’t load settings. {message}</AlertDescription>
      </Alert>
      <Button variant="outline" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

function GeneralSection({
  consentWorkspaceId,
  settings,
  loadError,
  onRetry,
  voiceEnabled,
}: {
  consentWorkspaceId: string | null;
  settings: AgentSettingsResponse | null;
  voiceEnabled: boolean;
  loadError: Error | null;
  onRetry: () => void;
}) {
  return (
    <>
      <AppearanceSection />
      <ReasoningDisplaySection />
      <BrowserNotificationsSection />
      {voiceEnabled && <VoiceSection />}
      <PrivacySection consentWorkspaceId={consentWorkspaceId} />
      {GENERAL_SETTINGS_SHOW_WORKSPACE_SECTION ? (
        <section aria-label="Workspace and default agent" className="space-y-4">
          <SectionHeading title="Workspace" description="Default agent and provider routing." />

          <SettingsSummary settings={settings} loadError={loadError} onRetry={onRetry} />
        </section>
      ) : null}
    </>
  );
}

function BrowserNotificationsSection() {
  const [settings, setSettings] = useState<
    (BrowserNotificationsResponse & { deviceSubscribed: boolean }) | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const support = classifyBrowserNotificationSupport({
    Notification: typeof Notification === "undefined" ? undefined : Notification,
    PushManager: typeof PushManager === "undefined" ? undefined : PushManager,
    navigator: typeof navigator === "undefined" ? undefined : navigator,
  });

  useEffect(() => {
    let active = true;
    Promise.all([getBrowserNotifications(), getExistingPushSubscription()])
      .then(([next, subscription]) => {
        if (active) {
          setSettings({ ...next, deviceSubscribed: Boolean(subscription) });
          setError(null);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(
            err instanceof Error ? err.message : "Could not load browser notification settings.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const accountEnabled = settings?.browserPushEnabled ?? false;
  const enabled = accountEnabled && (settings?.deviceSubscribed ?? false);
  const vapidUnavailable = !enabled && settings?.vapidPublicKey === null;
  const switchDisabled =
    !settings || !support.supported || busy || support.permission === "denied" || vapidUnavailable;

  const handleToggle = useCallback(
    async (checked: boolean) => {
      if (!settings || busy) return;
      setBusy(true);
      setError(null);
      try {
        if (checked) {
          if (!support.supported) {
            throw new Error("Push notifications are not supported in this browser.");
          }
          if (!settings.vapidPublicKey) {
            throw new Error("Browser notifications are not configured for this workspace yet.");
          }
          const subscription = await ensurePushSubscription(settings.vapidPublicKey);
          await saveBrowserPushSubscription(subscription);
        }
        const next = await updateBrowserNotificationSettings({ browserPushEnabled: checked });
        setSettings({
          ...next,
          deviceSubscribed: checked ? true : settings.deviceSubscribed,
        });
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : "Could not save browser notification settings.",
        );
      } finally {
        setBusy(false);
      }
    },
    [busy, settings, support],
  );

  const handlePreviewToggle = useCallback(
    async (checked: boolean) => {
      if (!settings || busy) return;
      setBusy(true);
      setError(null);
      // Optimistic: the switch is the only thing this writes, so a failure can
      // put it straight back rather than reloading the whole section.
      setSettings({ ...settings, pushPreviewEnabled: checked });
      try {
        const next = await updateBrowserNotificationSettings({ pushPreviewEnabled: checked });
        setSettings({ ...next, deviceSubscribed: settings.deviceSubscribed });
      } catch (err: unknown) {
        setSettings(settings);
        setError(err instanceof Error ? err.message : "Could not save the message preview setting.");
      } finally {
        setBusy(false);
      }
    },
    [busy, settings],
  );

  return (
    <section aria-label="Browser notifications" className="space-y-4">
      <SectionHeading
        title="Browser notifications"
        description="Delivery to this browser when Nadi needs your attention."
      />

      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="browser-notifications-toggle">Enable in this browser</Label>
            <p className="text-muted-foreground text-sm">
              Uses this device&apos;s push support for long-running threads and attention alerts.
            </p>
          </div>
          <Switch
            id="browser-notifications-toggle"
            checked={enabled}
            disabled={switchDisabled}
            onCheckedChange={(checked) => {
              void handleToggle(checked);
            }}
            aria-label="Enable browser notifications"
          />
        </div>

        <p className="text-muted-foreground text-xs" role="status">
          {browserNotificationStatusText(support, accountEnabled, settings?.deviceSubscribed)}
        </p>

        {vapidUnavailable && (
          <p className="text-muted-foreground text-xs">
            Browser notifications are not configured for this workspace yet.
          </p>
        )}

        <div className="border-border flex items-start justify-between gap-4 border-t pt-3 pl-4">
          <div className="space-y-0.5">
            <Label htmlFor="notification-preview-toggle">Show message preview</Label>
            <p className="text-muted-foreground text-sm">
              Notifications include the start of Nadi&apos;s reply. Turn off to show only the thread
              name.
            </p>
          </div>
          <Switch
            id="notification-preview-toggle"
            checked={settings?.pushPreviewEnabled ?? true}
            disabled={!settings || busy || !accountEnabled}
            onCheckedChange={(checked) => {
              void handlePreviewToggle(checked);
            }}
            aria-label="Show message preview in notifications"
          />
        </div>

        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </Card>
    </section>
  );
}

function SettingsSummary({
  settings,
  loadError,
  onRetry,
}: {
  settings: AgentSettingsResponse | null;
  loadError: Error | null;
  onRetry: () => void;
}) {
  if (loadError) {
    return <SettingsLoadError message={loadError.message} onRetry={onRetry} />;
  }

  if (settings === null) {
    return (
      <Card className="grid gap-4 p-4 sm:grid-cols-2" aria-busy="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-5 w-40 max-w-full" />
          </div>
        ))}
      </Card>
    );
  }

  return (
    <Card className="grid gap-4 p-4 sm:grid-cols-2">
      <SummaryItem
        label="Workspace"
        value={settings.workspace.name}
        detail={settings.workspace.id}
      />
      <SummaryItem label="Default agent" value={settings.agent.name} detail={settings.agent.id} />
      <SummaryItem label="Provider" value={formatProvider(settings.agent.provider)} />
      <SummaryItem label="Model" value={settings.agent.model} />
    </Card>
  );
}

function SummaryItem({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="break-words font-medium text-sm">{value}</p>
      {detail && <p className="break-all text-muted-foreground text-xs">{detail}</p>}
    </div>
  );
}

const THEME_OPTIONS: { value: Theme; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function AppearanceSection() {
  const { theme, setTheme } = useTheme();

  return (
    <section aria-label="Appearance" className="space-y-4">
      <SectionHeading title="Appearance" description="How Nadi looks on this device." />

      <Card className="flex flex-row items-center justify-between gap-4 p-4">
        <div className="space-y-0.5">
          <Label htmlFor="theme-select">Theme</Label>
          <p className="text-muted-foreground text-xs">Light, dark, or follow your system.</p>
        </div>
        <Select value={theme} onValueChange={(value) => setTheme(value as Theme)}>
          <SelectTrigger id="theme-select" className="w-36" aria-label="Theme">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {THEME_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Card>
    </section>
  );
}

function AgentSection({
  consentWorkspaceId,
  settings,
  loadError,
  onRetry,
  onSaved,
}: {
  consentWorkspaceId: string | null;
  settings: AgentSettingsResponse | null;
  loadError: Error | null;
  onRetry: () => void;
  onSaved: (settings: AgentSettingsResponse) => void;
}) {
  if (loadError) {
    return <SettingsLoadError message={loadError.message} onRetry={onRetry} />;
  }

  if (settings === null) {
    return (
      <section aria-label={AGENT_SETTINGS_TITLE} className="space-y-4">
        <SectionHeading title={AGENT_SETTINGS_TITLE} description="System prompt, provider, and model." />
        <Card className="flex flex-col gap-4 p-4" aria-busy="true">
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-32 w-full" />
          <div className="grid gap-3 sm:grid-cols-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        </Card>
      </section>
    );
  }

  return (
    <AgentSettingsForm
      consentWorkspaceId={consentWorkspaceId}
      settings={settings}
      onSaved={onSaved}
    />
  );
}

function AgentSettingsForm({
  consentWorkspaceId,
  settings,
  onSaved,
}: {
  consentWorkspaceId: string | null;
  settings: AgentSettingsResponse;
  onSaved: (settings: AgentSettingsResponse) => void;
}) {
  const selectedProvider = isSettingsProvider(settings.agent.provider)
    ? settings.agent.provider
    : DEFAULT_PROVIDER;
  const [systemPrompt, setSystemPrompt] = useState(settings.agent.systemPrompt);
  const [provider, setProvider] = useState<SettingsProvider>(selectedProvider);
  const [providerChanged, setProviderChanged] = useState(false);
  const [model, setModel] = useState(settings.agent.model);
  const [modelInputModalities, setModelInputModalities] = useState<ModelInputModality[]>(
    settings.agent.modelInputModalities,
  );
  const [reasoningEffort, setReasoningEffort] = useState(settings.agent.reasoningEffort);
  const [modelSupportsReasoning, setModelSupportsReasoning] = useState(
    settings.agent.modelSupportsReasoning,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasUnknownProvider = !isSettingsProvider(settings.agent.provider);
  const selectedProviderSettings = settings.providers.find((entry) => entry.provider === provider);
  const selectedProviderUsable = selectedProviderSettings?.usable ?? false;
  const usableProviderOptions = SETTINGS_PROVIDER_OPTIONS.filter((option) =>
    settings.providers.some((entry) => entry.provider === option.value && entry.usable),
  ).map((option) => ({
    ...option,
    whitelistModels:
      settings.providers.find((entry) => entry.provider === option.value)?.whitelistModels ?? null,
  }));

  useEffect(() => {
    setSystemPrompt(settings.agent.systemPrompt);
    setProvider(
      isSettingsProvider(settings.agent.provider) ? settings.agent.provider : DEFAULT_PROVIDER,
    );
    setProviderChanged(false);
    setModel(settings.agent.model);
    setModelInputModalities(settings.agent.modelInputModalities);
    setReasoningEffort(settings.agent.reasoningEffort);
    setModelSupportsReasoning(settings.agent.modelSupportsReasoning);
    setError(null);
  }, [
    settings.agent.systemPrompt,
    settings.agent.provider,
    settings.agent.model,
    settings.agent.modelInputModalities,
    settings.agent.reasoningEffort,
    settings.agent.modelSupportsReasoning,
  ]);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (saving || !systemPrompt.trim() || !model.trim() || !selectedProviderUsable) return;
      setSaving(true);
      setError(null);
      void saveDefaultAgentSettings(
        buildDefaultAgentSettingsSaveInput({
          systemPrompt,
          model,
          modelInputModalities,
          currentProvider: settings.agent.provider,
          selectedProvider: provider,
          providerChanged,
          reasoningEffort,
          modelSupportsReasoning,
        }),
      )
        .then((nextSettings) => {
          onSaved(nextSettings);
          toast.success("Saved default agent settings");
          if (
            canUseWorkspaceTelemetry({
              consentWorkspaceId,
              workspaceId: nextSettings.workspace.id,
            })
          ) {
            track("settings_saved", {
              section: "agent",
              provider: nextSettings.agent.provider,
              model: nextSettings.agent.model,
            });
          }
        })
        .catch((err: unknown) => {
          const status = err instanceof Error ? err.message.match(/\((\d+)\)/)?.[1] : null;
          setError(
            status === "400" ? "Check the prompt, provider, and model." : "Couldn’t save settings.",
          );
          toast.error("Couldn’t save default agent settings.");
        })
        .finally(() => setSaving(false));
    },
    [
      saving,
      systemPrompt,
      providerChanged,
      settings.agent.provider,
      provider,
      model,
      modelInputModalities,
      reasoningEffort,
      modelSupportsReasoning,
      selectedProviderUsable,
      consentWorkspaceId,
      onSaved,
    ],
  );

  return (
    <section aria-label={AGENT_SETTINGS_TITLE} className="space-y-4">
      <SectionHeading title={AGENT_SETTINGS_TITLE} description="System prompt, provider, and model." />

      <Card className="p-4">
        <form id="agent-settings-form" className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor="agent-system-prompt">System prompt</Label>
            <Textarea
              id="agent-system-prompt"
              value={systemPrompt}
              onChange={(event) => setSystemPrompt(event.target.value)}
              className="min-h-40 resize-y"
              disabled={saving}
            />
          </div>

          <div className="min-w-0 space-y-1.5">
            <Label htmlFor="agent-model">Provider &amp; model</Label>
            <ModelPicker
              variant="field"
              triggerId="agent-model"
              triggerLabel="Agent provider and model"
              providers={usableProviderOptions}
              provider={provider}
              model={model}
              placeholder={SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[provider]}
              disabled={saving}
              onProviderChange={(nextProvider) => {
                setProvider(nextProvider);
                setProviderChanged(true);
                if (!model.trim()) {
                  setModel(defaultModelForProvider(nextProvider));
                  setModelInputModalities(["text"]);
                }
              }}
              onModelChange={(next) => {
                setModel(next);
                setModelInputModalities(["text"]);
                // A typed model id is a model we know nothing about.
                setModelSupportsReasoning(null);
              }}
              onModelSelected={(selectedModel) => {
                setModelInputModalities(selectedModel.inputModalities);
                setModelSupportsReasoning(selectedModel.reasoning ?? null);
              }}
            />
            {hasUnknownProvider && (
              <p className="break-words text-muted-foreground text-xs">
                Current provider: {settings.agent.provider}
              </p>
            )}
          </div>

          {!selectedProviderUsable && (
            <Alert role="status">
              <AlertDescription>
                {formatProvider(provider)} is not fully configured. Save endpoint and secret details
                in the Providers tab before sending messages with this provider.
              </AlertDescription>
            </Alert>
          )}

          {/* Hidden on the same rule as the composer, so the two never disagree
              about whether this provider can be told how hard to think. A form
              field, so it IS labelled — the icon-only rule is about the composer
              footer, where space is scarce and the gauge does the work. */}
          {shouldOfferEffortControl({ provider, modelSupportsReasoning }) && (
          <div className="flex items-center justify-between gap-3">
            <div className="space-y-0.5">
              <Label htmlFor="agent-reasoning-effort">Thinking effort</Label>
              <p className="text-muted-foreground text-sm">
                How hard new chats think by default. Separate from showing the thinking.
              </p>
            </div>
            <Select
              value={reasoningEffort}
              onValueChange={(next) => {
                if (isReasoningEffort(next)) setReasoningEffort(next);
              }}
              disabled={saving}
            >
              <SelectTrigger
                id="agent-reasoning-effort"
                className="w-36"
                aria-label="Thinking effort"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONING_EFFORTS.map((level) => (
                  <SelectItem key={level} value={level}>
                    <EffortGauge
                      level={level}
                      className={cn(
                        "size-4",
                        level === reasoningEffort ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    {EFFORT_LABELS[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          )}

          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </form>
      </Card>

      <SettingsFooterPortal>
        <PaneFooter contentClassName="max-w-4xl">
          <FormActions>
            <Button
              type="submit"
              form="agent-settings-form"
              className={FORM_ACTION_BUTTON}
              disabled={saving || !systemPrompt.trim() || !model.trim() || !selectedProviderUsable}
              aria-busy={saving}
            >
              {saving ? <Spinner /> : null}
              Save agent
            </Button>
          </FormActions>
        </PaneFooter>
      </SettingsFooterPortal>
    </section>
  );
}

function McpServersSection({
  servers,
  loadError,
  onRetry,
  onAdded,
  onChanged,
  onRemoved,
}: {
  servers: McpServer[] | null;
  loadError: Error | null;
  onRetry: () => void;
  onAdded: (server: McpServer) => void;
  onChanged: (server: McpServer) => void;
  onRemoved: (id: string) => void;
}) {
  return (
    <section aria-label="MCP servers" className="space-y-4">
      <SectionHeading
        title="MCP servers"
        description="MCP servers give the agent tools. Add a server, then choose how each of its tools is allowed to run."
      />

      <AddServerForm onAdded={onAdded} />

      {servers === null ? (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading servers">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex items-center gap-3 p-3">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
              <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
            </Card>
          ))}
        </ul>
      ) : loadError ? (
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load servers. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={onRetry}>
            Retry
          </Button>
        </div>
      ) : servers.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed py-10 text-center">
          <p className="text-muted-foreground text-sm">No servers yet</p>
          <p className="mt-1 text-muted-foreground text-xs">
            Add one above to give the agent tools.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {servers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onChanged={onChanged}
              onRemoved={onRemoved}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function AddServerForm({ onAdded }: { onAdded: (server: McpServer) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(
    (event: FormEvent) => {
      event.preventDefault();
      if (adding || !name.trim() || !url.trim()) return;
      setAdding(true);
      setError(null);
      void createMcpServer({ name: name.trim(), url: url.trim() })
        .then((server) => {
          onAdded(server);
          setName("");
          setUrl("");
          toast.success(`Added ${server.name}`);
        })
        .catch((err: unknown) => {
          const status = err instanceof Error ? err.message.match(/\((\d+)\)/)?.[1] : null;
          setError(status === "400" ? "Check the name and URL." : "Couldn’t add the server.");
        })
        .finally(() => setAdding(false));
    },
    [adding, name, url, onAdded],
  );

  return (
    <Card className="p-4">
      <form className="space-y-3" onSubmit={submit}>
        <div className="flex flex-col gap-3 sm:flex-row">
          <div className="space-y-1.5 sm:w-40">
            <Label htmlFor="mcp-name">Name</Label>
            <Input
              id="mcp-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              disabled={adding}
            />
          </div>
          <div className="flex-1 space-y-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://…/mcp"
              inputMode="url"
              disabled={adding}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button type="submit" disabled={adding || !name.trim() || !url.trim()} aria-busy={adding}>
            {adding ? <Spinner /> : <Plus aria-hidden />}
            Add server
          </Button>
        </div>
        {error && (
          <Alert variant="destructive" role="alert">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </form>
    </Card>
  );
}

function ServerRow({
  server,
  onChanged,
  onRemoved,
}: {
  server: McpServer;
  onChanged: (server: McpServer) => void;
  onRemoved: (id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const toggle = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void updateMcpServer(server.id, { enabled: !server.enabled })
      .then(onChanged)
      .catch(() => toast.error("Couldn’t update the server."))
      .finally(() => setBusy(false));
  }, [busy, server.id, server.enabled, onChanged]);

  const remove = useCallback(() => {
    if (busy) return;
    setBusy(true);
    void deleteMcpServer(server.id)
      .then(() => {
        onRemoved(server.id);
        toast.success(`Removed ${server.name}`);
      })
      .catch(() => {
        toast.error("Couldn’t remove the server.");
        setBusy(false);
        setConfirming(false);
      });
  }, [busy, server.id, server.name, onRemoved]);

  return (
    <li>
      <Card className={cn("overflow-hidden p-0", !server.enabled && "opacity-70")}>
        <div className="flex items-center gap-3 p-3">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              server.enabled ? "bg-approve" : "bg-muted-foreground/40",
            )}
            aria-hidden="true"
          />
          <button
            className="group/expand -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/50"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={`tools-${server.id}`}
            title={expanded ? "Hide tool permissions" : "Show tool permissions"}
          >
            <CaretRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-90",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-sm">{server.name}</span>
              <span className="truncate text-muted-foreground text-xs">{server.url}</span>
              {!expanded && (
                <span className="mt-0.5 truncate text-[11px] text-muted-foreground/70">
                  Set tool permissions
                </span>
              )}
            </span>
          </button>

          <Switch
            checked={server.enabled}
            onCheckedChange={toggle}
            disabled={busy}
            aria-label={server.enabled ? `Disable ${server.name}` : `Enable ${server.name}`}
          />

          {confirming ? (
            <span className="flex items-center gap-1" role="group" aria-label="Confirm remove">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-reject hover:text-reject"
                onClick={remove}
                disabled={busy}
                aria-label={`Confirm remove ${server.name}`}
              >
                Remove
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-8"
                onClick={() => setConfirming(false)}
                aria-label="Cancel remove"
              >
                Cancel
              </Button>
            </span>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="text-muted-foreground hover:text-reject"
              onClick={() => setConfirming(true)}
              disabled={busy}
              aria-label={`Remove ${server.name}`}
              title="Remove server"
            >
              <Trash aria-hidden />
            </Button>
          )}
        </div>

        {expanded && (
          <>
            <Separator />
            <ToolsPanel serverId={server.id} />
          </>
        )}
      </Card>
    </li>
  );
}

const POLICY_OPTIONS: { value: ToolPolicy; label: string }[] = [
  { value: "auto_allow", label: "Auto" },
  { value: "approval_required", label: "Ask" },
  { value: "deny", label: "Deny" },
];

function ToolsPanel({ serverId }: { serverId: string }) {
  const [tools, setTools] = useState<McpToolView[] | null>(null); // null = discovering
  const [needsAuth, setNeedsAuth] = useState(false);
  const [failed, setFailed] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [authorizeError, setAuthorizeError] = useState<string | null>(null);

  const load = useCallback(() => {
    setTools(null);
    setNeedsAuth(false);
    setFailed(false);
    setAuthorizeError(null);
    void listMcpServerTools(serverId)
      .then(({ needsAuth: na, tools: t }) => {
        setNeedsAuth(na);
        setTools(t);
      })
      .catch(() => {
        setTools([]);
        setFailed(true);
      });
  }, [serverId]);

  useEffect(() => {
    load();
  }, [load]);

  const authorize = useCallback(() => {
    if (authorizing) return;
    setAuthorizing(true);
    setAuthorizeError(null);
    void authorizeMcpServer(serverId)
      .then((result) => {
        if (result.authUrl) {
          // OAuth consent is a full-page redirect to the provider and back, and it
          // returns to the app root — so the path we want back is what we stash.
          sessionStorage.setItem(MCP_RETURN_PATH_KEY, settingsPath("tools"));
          window.location.href = result.authUrl;
        } else if (result.ready) {
          load();
        }
      })
      .catch((err: unknown) => {
        setAuthorizeError(err instanceof Error ? err.message : "Authorization failed.");
        setAuthorizing(false);
      });
  }, [authorizing, serverId, load]);

  const setPolicy = useCallback(
    (toolName: string, policy: ToolPolicy) => {
      // Optimistic; reload from the server on failure to revert.
      setTools(
        (current) =>
          current?.map((tool) => (tool.name === toolName ? { ...tool, policy } : tool)) ?? null,
      );
      void setMcpServerPolicies(serverId, [{ toolName, policy }]).catch(() => load());
    },
    [serverId, load],
  );

  const setAllPolicies = useCallback(
    (policy: ToolPolicy) => {
      const current = tools;
      if (!current || current.length === 0) return;
      setTools((c) => c?.map((tool) => ({ ...tool, policy })) ?? null);
      void setMcpServerPolicies(
        serverId,
        current.map((tool) => ({ toolName: tool.name, policy })),
      ).catch(() => load());
    },
    [serverId, tools, load],
  );

  // The shared policy when every tool agrees; null when mixed (no active option).
  const firstTool = tools?.[0];
  const sharedPolicy =
    firstTool && tools?.every((t) => t.policy === firstTool.policy) ? firstTool.policy : null;

  return (
    <div className="p-3" id={`tools-${serverId}`}>
      {tools === null ? (
        <div className="space-y-2 py-1" aria-busy="true" aria-label="Discovering tools">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-28" />
                <Skeleton className="h-3 w-44" />
              </div>
              <Skeleton className="h-7 w-28 rounded-md" />
            </div>
          ))}
        </div>
      ) : failed ? (
        <div className="flex flex-col items-start gap-2 py-2" role="alert">
          <span className="text-reject text-sm">Couldn’t reach this server.</span>
          <Button variant="outline" size="sm" onClick={load}>
            Refresh
          </Button>
        </div>
      ) : needsAuth ? (
        <div className="flex flex-col items-start gap-2 py-2" role="status">
          <span className="flex items-center gap-2 text-sm">
            <Key aria-hidden className="text-muted-foreground" />
            This server needs authorization.
          </span>
          <Button size="sm" onClick={authorize} disabled={authorizing} aria-busy={authorizing}>
            {authorizing ? <Spinner /> : null}
            Authorize
          </Button>
          {authorizeError && (
            <span className="text-reject text-xs" role="alert">
              {authorizeError}
            </span>
          )}
        </div>
      ) : tools.length === 0 ? (
        <div className="py-4 text-center text-muted-foreground text-sm">No tools</div>
      ) : (
        <ul className="space-y-1">
          <li className="flex items-center justify-between gap-3 rounded-md bg-secondary/50 px-3 py-2">
            <div className="min-w-0">
              <p className="font-medium text-sm">All tools</p>
              <p className="text-muted-foreground text-xs">Apply one policy to every tool</p>
            </div>
            <PolicySelect toolName="all tools" value={sharedPolicy} onChange={setAllPolicies} />
          </li>
          {tools.map((tool) => (
            <li className="flex items-center justify-between gap-3 px-3 py-2" key={tool.name}>
              <div className="min-w-0">
                <p className="truncate font-medium text-sm">{tool.name}</p>
                {tool.description && (
                  <p className="truncate text-muted-foreground text-xs">{tool.description}</p>
                )}
              </div>
              <PolicySelect
                toolName={tool.name}
                value={tool.policy}
                onChange={(policy) => setPolicy(tool.name, policy)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PolicySelect({
  toolName,
  value,
  onChange,
}: {
  toolName: string;
  // null = no single shared value (used by the "All tools" control when the
  // per-tool policies are mixed) — no option renders active.
  value: ToolPolicy | null;
  onChange: (policy: ToolPolicy) => void;
}) {
  return (
    <div
      className="inline-flex shrink-0 rounded-md border border-border bg-background p-0.5"
      role="radiogroup"
      aria-label={`Policy for ${toolName}`}
    >
      {POLICY_OPTIONS.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            className={cn(
              "rounded px-2.5 py-1 font-medium text-xs transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
