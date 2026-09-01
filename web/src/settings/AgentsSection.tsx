import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ArrowLeft, CaretRight, GitBranch, Plus, Robot, Trash } from "../icons";
import { useMediaQuery } from "../lib/use-media-query";
import { cn } from "../lib/utils";
import {
  createAgent,
  deleteAgent,
  deleteAgentSecret,
  listAgents,
  setAgentEnvVars,
  setAgentRepositories,
  setAgentSecret,
  updateAgent,
  type AgentRepository,
  type AgentRepositoryInput,
  type AgentResourceProfile,
  type AgentSummary,
  type UpdateAgentInput,
} from "../agents-api";
import {
  isSettingsProvider,
  isReasoningEffort,
  REASONING_EFFORTS,
  type ModelInputModality,
  type ProviderSettingsView,
  type ReasoningEffort,
  type SettingsProvider,
} from "../settings-api";
import {
  DEFAULT_PROVIDER,
  SETTINGS_PROVIDER_MODEL_PLACEHOLDERS,
  SETTINGS_PROVIDER_OPTIONS,
  defaultModelForProvider,
} from "../settings-ui-config";
import { EffortGauge } from "../icons";
import { shouldOfferEffortControl } from "../lib/reasoning-effort";
import { ModelPicker } from "../components/model/ModelPicker";
import { Alert, AlertDescription } from "../components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Switch } from "../components/ui/switch";
import {
  DetailHeading,
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
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { SandboxEnvVarsPanel } from "./SandboxEnvVarsPanel";
import { SandboxSecretsPanel } from "./SandboxSecretsPanel";
import { AgentRepositories } from "./AgentRepositories";
import { SkillsSection } from "./SkillsSection";
import { MemorySection } from "./MemorySection";

/**
 * An agent's page is grouped into three bands rather than a flat list of cards,
 * because the grouping is the point of the merge: one primitive now owns both a
 * mind (Behaviour) and a machine (Machine), and carries Knowledge between
 * threads. A flat list would hide exactly what changed.
 */
function Band({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <h3 className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
            {title}
          </h3>
          <span aria-hidden className="h-px flex-1 bg-border" />
        </div>
        <p className="mt-1 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}

type AgentForm = {
  name: string;
  description: string;
  systemPrompt: string;
  provider: SettingsProvider;
  model: string;
  modelInputModalities: ModelInputModality[];
  reasoningEffort: ReasoningEffort;
  modelSupportsReasoning: boolean | null;
  setupScript: string;
  resourceProfile: AgentResourceProfile;
  networkDomainAllowlist: string;
};

const EMPTY_FORM: AgentForm = {
  name: "",
  description: "",
  systemPrompt: "",
  provider: DEFAULT_PROVIDER,
  model: "",
  modelInputModalities: ["text"],
  reasoningEffort: "medium",
  modelSupportsReasoning: null,
  setupScript: "",
  resourceProfile: "small",
  networkDomainAllowlist: "",
};

/** The stored column is JSON text; a malformed value degrades to plain text
 *  rather than taking the whole page down. */
function parseModalities(stored: string): ModelInputModality[] {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (Array.isArray(parsed) && parsed.every((entry) => typeof entry === "string")) {
      return parsed as ModelInputModality[];
    }
  } catch {
    // fall through
  }
  return ["text"];
}

function formFrom(agent: AgentSummary): AgentForm {
  return {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    provider: isSettingsProvider(agent.provider) ? agent.provider : DEFAULT_PROVIDER,
    model: agent.model,
    modelInputModalities: parseModalities(agent.modelInputModalities),
    reasoningEffort: isReasoningEffort(agent.reasoningEffort) ? agent.reasoningEffort : "medium",
    modelSupportsReasoning: agent.modelSupportsReasoning,
    setupScript: agent.setupScript,
    resourceProfile: agent.resourceProfile,
    networkDomainAllowlist: agent.networkDomainAllowlist,
  };
}

function repositoriesToInput(repositories: AgentRepository[]): AgentRepositoryInput[] {
  return repositories.map((repository) => ({
    source: repository.source,
    name: repository.name,
    url: repository.url,
    githubRepoId: repository.githubRepoId ?? undefined,
    sourceInstallationId: repository.sourceInstallationId ?? undefined,
    checkoutPathName: repository.checkoutPathName,
    defaultBranch: repository.defaultBranch,
    rootDirectory: repository.rootDirectory,
    setupCommand: repository.setupCommand,
    packageManager: repository.packageManager,
  }));
}

/**
 * The create/edit page for an agent. `agent === null` is the create form.
 * Create shows only what a not-yet-existing agent can carry; the rest (env
 * vars, secrets, skills, memory, the danger zone) needs an id and appears once
 * the agent exists.
 */
function AgentDetailPage({
  agent,
  providers,
  networkAllowlistEnabled,
  isOnlyAgent,
  onCreated,
  onUpdated,
  onDeleted,
  onCancel,
  onReload,
}: {
  agent: AgentSummary | null;
  providers: ProviderSettingsView[];
  networkAllowlistEnabled: boolean;
  /** The workspace's last usable agent can be neither disabled nor deleted. */
  isOnlyAgent: boolean;
  onCreated: (created: AgentSummary) => void;
  onUpdated: (updated: AgentSummary) => void;
  onDeleted: () => void;
  onCancel: () => void;
  /** Refetches the workspace's agents so this pane's env var / secret panels
   *  see the latest saved shape after their own mutations. */
  onReload: () => Promise<void>;
}) {
  const isCreate = agent === null;
  const [form, setForm] = useState<AgentForm>(agent ? formFrom(agent) : EMPTY_FORM);
  // Repositories are staged locally for both create (nothing to save against
  // yet) and edit (the seam below has no per-row save affordance — Save
  // commits whatever is staged here via setAgentRepositories).
  const [repos, setRepos] = useState<AgentRepositoryInput[]>(
    agent ? repositoriesToInput(agent.repositories) : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteConfirmation, setDeleteConfirmation] = useState("");

  const usableProviderOptions = useMemo(
    () =>
      SETTINGS_PROVIDER_OPTIONS.filter((option) =>
        providers.some((entry) => entry.provider === option.value && entry.usable),
      ).map((option) => ({
        ...option,
        whitelistModels:
          providers.find((entry) => entry.provider === option.value)?.whitelistModels ?? null,
      })),
    [providers],
  );
  const selectedProviderUsable =
    providers.find((entry) => entry.provider === form.provider)?.usable ?? false;

  const field = useCallback((key: "name" | "description" | "setupScript", value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      setError("Give the agent a name so you can tell it apart from the others.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isCreate) {
        // Create carries only the fields the create route accepts; a new agent
        // inherits its instructions and model from the workspace's first agent.
        const created = await createAgent({
          name: form.name,
          description: form.description,
          setupScript: form.setupScript,
          resourceProfile: form.resourceProfile,
          networkDomainAllowlist: form.networkDomainAllowlist.trim(),
        });
        const withRepos = repos.length > 0 ? await setAgentRepositories(created.id, repos) : created;
        toast.success("Agent created");
        onCreated(withRepos);
      } else {
        const patch: UpdateAgentInput = {
          name: form.name,
          description: form.description,
          setupScript: form.setupScript,
          resourceProfile: form.resourceProfile,
          networkDomainAllowlist: form.networkDomainAllowlist.trim(),
          systemPrompt: form.systemPrompt,
          provider: form.provider,
          model: form.model,
          modelInputModalities: form.modelInputModalities,
          reasoningEffort: form.reasoningEffort,
          modelSupportsReasoning: form.modelSupportsReasoning,
        };
        await updateAgent(agent.id, patch);
        const withRepos = await setAgentRepositories(agent.id, repos);
        toast.success("Agent saved");
        onUpdated(withRepos);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the agent.");
      toast.error(isCreate ? "Couldn’t create agent" : "Couldn’t save agent");
    } finally {
      setBusy(false);
    }
  }, [form, repos, isCreate, agent, onCreated, onUpdated]);

  const handleToggleEnabled = useCallback(
    async (next: boolean) => {
      if (!agent) return;
      setBusy(true);
      setError(null);
      try {
        const updated = await updateAgent(agent.id, { enabled: next });
        toast.success(next ? "Agent enabled" : "Agent disabled");
        onUpdated(updated);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not change the agent.");
        toast.error(next ? "Couldn’t enable agent" : "Couldn’t disable agent");
      } finally {
        setBusy(false);
      }
    },
    [agent, onUpdated],
  );

  const handleDelete = useCallback(async () => {
    if (!agent) return;
    setBusy(true);
    setError(null);
    try {
      await deleteAgent(agent.id);
      toast.success("Agent deleted");
      setConfirmDelete(false);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete the agent.");
      toast.error("Couldn’t delete agent");
    } finally {
      setBusy(false);
    }
  }, [agent, onDeleted]);

  const id = agent?.id ?? "new";

  const machineCards = (
    <>
      <FormCard
        title="Sandbox"
        description="The machine this agent works on."
      >
        <Field
          label="Machine size"
          hint="Choose medium for large repositories, heavy toolchains, or long builds."
        >
          <Select
            value={form.resourceProfile}
            onValueChange={(value) =>
              setForm((prev) => ({ ...prev, resourceProfile: value as AgentResourceProfile }))
            }
          >
            <SelectTrigger aria-label="Machine size">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="small">Small</SelectItem>
              <SelectItem value="medium">Medium</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {networkAllowlistEnabled && (
          <Field
            label="Allowed domains"
            htmlFor={`agent-network-allowlist-${id}`}
            hint="One host per line, reachable for this agent on top of the workspace allowlist."
          >
            <Textarea
              id={`agent-network-allowlist-${id}`}
              className="min-h-20 font-mono text-xs"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={form.networkDomainAllowlist}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, networkDomainAllowlist: event.target.value }))
              }
              placeholder={"api.example.com\n*.internal.example.com"}
            />
          </Field>
        )}
      </FormCard>

      <FormCard
        title="Repositories"
        description="Cloned into the machine before the setup script runs."
      >
        <AgentRepositories value={repos} onChange={setRepos} />
      </FormCard>

      <FormCard
        title="Setup script"
        description="Runs once after every repository is cloned, before the agent starts work."
      >
        <Textarea
          id={`agent-setup-${id}`}
          className="min-h-28 font-mono text-xs"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={form.setupScript}
          onChange={(event) => field("setupScript", event.target.value)}
          placeholder={"pnpm install\npnpm run db:migrate:local"}
        />
      </FormCard>

      {agent && (
        <>
          <SandboxEnvVarsPanel
            title="Environment variables"
            envVars={agent.envVars}
            onSave={(envVars) => setAgentEnvVars(agent.id, envVars).then(() => onReload())}
          />

          <SandboxSecretsPanel
            title="Secrets"
            secrets={agent.secretEnvNames.map((name) => ({ name, updatedAt: "" }))}
            onUpsert={(envVars) =>
              Promise.all(
                Object.entries(envVars).map(([name, value]) =>
                  setAgentSecret(agent.id, name, value),
                ),
              ).then(() => onReload())
            }
            onDelete={(name) => deleteAgentSecret(agent.id, name).then(() => onReload())}
          />
        </>
      )}
    </>
  );

  return (
    <div className="flex min-h-0 flex-col gap-6">
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DetailHeading eyebrow="Agent" title={isCreate ? "New agent" : agent.name} />

      <FormCard title="Details">
        <Field label="Name" htmlFor={`agent-name-${id}`}>
          <Input
            id={`agent-name-${id}`}
            value={form.name}
            onChange={(event) => field("name", event.target.value)}
            placeholder="e.g. Staging"
          />
        </Field>
        <Field
          label="Description"
          htmlFor={`agent-description-${id}`}
          hint="A short note about what this agent is for."
        >
          <Textarea
            id={`agent-description-${id}`}
            value={form.description}
            onChange={(event) => field("description", event.target.value)}
            placeholder="What does this agent do?"
          />
        </Field>
      </FormCard>

      {agent ? (
        <Band title="Behaviour" description="What this agent thinks with.">
          <FormCard
            title="Instructions"
            description="What the agent is told to be, before anything you say in a chat."
          >
            <Textarea
              id={`agent-system-prompt-${id}`}
              className="min-h-40 resize-y"
              value={form.systemPrompt}
              onChange={(event) =>
                setForm((prev) => ({ ...prev, systemPrompt: event.target.value }))
              }
              disabled={busy}
            />
          </FormCard>

          <FormCard
            title="Model & reasoning"
            description="What new chats on this agent start with."
          >
            <Field label="Provider & model" htmlFor={`agent-model-${id}`}>
              <ModelPicker
                variant="field"
                triggerId={`agent-model-${id}`}
                triggerLabel="Agent provider and model"
                providers={usableProviderOptions}
                provider={form.provider}
                model={form.model}
                placeholder={SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[form.provider]}
                disabled={busy}
                onProviderChange={(nextProvider) =>
                  setForm((prev) => ({
                    ...prev,
                    provider: nextProvider,
                    ...(prev.model.trim()
                      ? {}
                      : {
                          model: defaultModelForProvider(nextProvider),
                          modelInputModalities: ["text" as ModelInputModality],
                        }),
                  }))
                }
                onModelChange={(next) =>
                  setForm((prev) => ({
                    ...prev,
                    model: next,
                    modelInputModalities: ["text"],
                    // A typed model id is a model we know nothing about.
                    modelSupportsReasoning: null,
                  }))
                }
                onModelSelected={(selectedModel) =>
                  setForm((prev) => ({
                    ...prev,
                    modelInputModalities: selectedModel.inputModalities,
                    modelSupportsReasoning: selectedModel.reasoning ?? null,
                  }))
                }
              />
            </Field>

            {!selectedProviderUsable && (
              <Alert role="status">
                <AlertDescription>
                  That provider isn’t fully configured yet. Add its endpoint and secret in the
                  Providers tab before this agent can send a message with it.
                </AlertDescription>
              </Alert>
            )}

            {/* Hidden on the same rule as the composer, so the two never
                disagree about whether this provider can be told how hard to
                think. */}
            {shouldOfferEffortControl({
              provider: form.provider,
              modelSupportsReasoning: form.modelSupportsReasoning,
            }) && (
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-0.5">
                  <Label htmlFor={`agent-reasoning-effort-${id}`}>Thinking effort</Label>
                  <p className="text-muted-foreground text-sm">
                    How hard new chats think by default. Separate from showing the thinking.
                  </p>
                </div>
                <Select
                  value={form.reasoningEffort}
                  onValueChange={(next) => {
                    if (isReasoningEffort(next)) {
                      setForm((prev) => ({ ...prev, reasoningEffort: next }));
                    }
                  }}
                  disabled={busy}
                >
                  <SelectTrigger
                    id={`agent-reasoning-effort-${id}`}
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
                            level === form.reasoningEffort ? "text-primary" : "text-muted-foreground",
                          )}
                        />
                        {EFFORT_LABELS[level]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
          </FormCard>
        </Band>
      ) : null}

      <Band title="Machine" description="What this agent works on.">
        {machineCards}
      </Band>

      {agent && (
        <>
          <Band title="Knowledge" description="What this agent carries between chats.">
            <FormCard
              title="Skills"
              description="Private to this agent. A skill here shadows a library skill of the same name."
            >
              <SkillsSection agentId={agent.id} />
            </FormCard>
            <FormCard title="Memory" description="What this agent remembers between chats.">
              <MemorySection agentId={agent.id} />
            </FormCard>
          </Band>

          <FormCard
            title="Danger zone"
            className="border-destructive/40"
            description={
              isOnlyAgent
                ? "This is the workspace's only agent, so it can't be disabled or deleted. Create another agent first."
                : undefined
            }
          >
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 space-y-0.5">
                <Label htmlFor={`agent-enabled-${id}`}>Available for new work</Label>
                <p className="text-muted-foreground text-sm">
                  Turn this off to stop the agent from running. Its machine and files are kept.
                </p>
              </div>
              <Switch
                id={`agent-enabled-${id}`}
                checked={agent.enabled}
                disabled={busy || (isOnlyAgent && agent.enabled)}
                onCheckedChange={(next) => void handleToggleEnabled(next)}
                aria-label="Available for new work"
              />
            </div>

            <div className="flex flex-col gap-2 border-border border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0 space-y-0.5">
                <p className="font-medium text-foreground text-sm">Delete this agent</p>
                <p className="text-muted-foreground text-sm">
                  Deletes the agent and its machine. Its files are destroyed. Chats it ran stay
                  readable.
                </p>
              </div>
              <Button
                variant="destructive"
                className="shrink-0"
                disabled={busy || isOnlyAgent}
                onClick={() => {
                  setDeleteConfirmation("");
                  setConfirmDelete(true);
                }}
              >
                <Trash aria-hidden />
                Delete agent
              </Button>
            </div>
          </FormCard>

          <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{agent.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  This deletes the agent and its machine. Its files are destroyed, and its
                  repositories, secrets, skills and memories go with it. Chats it ran stay readable.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="space-y-1.5">
                <Label htmlFor={`agent-delete-confirm-${id}`}>
                  Type <span className="font-medium text-foreground">{agent.name}</span> to confirm
                </Label>
                <Input
                  id={`agent-delete-confirm-${id}`}
                  value={deleteConfirmation}
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(event) => setDeleteConfirmation(event.target.value)}
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel>Keep agent</AlertDialogCancel>
                <AlertDialogAction
                  disabled={busy || deleteConfirmation.trim() !== agent.name}
                  onClick={(event) => {
                    // The dialog closes on activation by default; deletion is
                    // async and its failure must stay visible on this pane.
                    event.preventDefault();
                    void handleDelete();
                  }}
                >
                  Delete agent
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      )}

      {/* Primary actions render in the shell's footer slot (below the scroll
          area), so they stay visible on long forms without a sticky bar
          fighting the scroll container's reserved safe-area — which, in an
          installed PWA, otherwise floats the bar above the home indicator. */}
      <SettingsFooterPortal>
        <PaneFooter contentClassName="max-w-4xl">
          <FormActions>
            {isCreate && (
              <Button
                variant="outline"
                className={FORM_ACTION_BUTTON}
                onClick={onCancel}
                disabled={busy}
              >
                Cancel
              </Button>
            )}
            <Button className={FORM_ACTION_BUTTON} onClick={() => void handleSave()} disabled={busy}>
              {busy ? <Spinner className="size-4" /> : null}
              {isCreate ? "Create agent" : "Save agent"}
            </Button>
          </FormActions>
        </PaneFooter>
      </SettingsFooterPortal>
    </div>
  );
}

const EFFORT_LABELS: Record<ReasoningEffort, string> = {
  off: "Off",
  low: "Low",
  medium: "Medium",
  high: "High",
};

/**
 * Master-detail host for Agents. The list is editorial and real; the detail
 * pane is the create/edit page (AgentDetailPage).
 */
export function AgentsSection({
  providers,
  networkAllowlistEnabled,
  selectedId,
  onSelectAgent,
  onNewAgent,
  onBackToList,
}: {
  providers: ProviderSettingsView[];
  networkAllowlistEnabled: boolean;
  /** The agent in the URL: null for the list, "new" for the create form,
   *  or an agent id. */
  selectedId: string | null;
  onSelectAgent: (id: string) => void;
  onNewAgent: () => void;
  onBackToList: () => void;
}) {
  // Below lg the master-detail collapses into a drill-down: the list is the
  // default view and selecting a row navigates into the detail pane.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [agents, setAgents] = useState<AgentSummary[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Silent refetch — does not clear the list to the loading state, so it's
  // safe to call after a save without flashing skeletons under the form.
  const refresh = useCallback(async () => {
    const next = await listAgents("active");
    setAgents(next);
    return next;
  }, []);

  const load = useCallback(() => {
    setAgents(null);
    setLoadError(null);
    void refresh().catch((err: unknown) => {
      setAgents([]);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
    });
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  const inDetail = selectedId !== null;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;

  const selectedAgent =
    selectedId && selectedId !== "new"
      ? (agents?.find((agent) => agent.id === selectedId) ?? null)
      : null;

  // "Only agent" is measured the way the server measures it: agents that are
  // active AND enabled. Two agents where the other is already disabled still
  // leaves this one the last usable one.
  const usableCount = (agents ?? []).filter((agent) => agent.enabled).length;
  const isOnlyAgent =
    selectedAgent !== null && selectedAgent.enabled && usableCount <= 1;

  const handleReload = useCallback(async () => {
    await refresh().catch(() => undefined);
  }, [refresh]);

  // Created/updated summaries come from the API response but the list is the
  // source of truth here — a refetch keeps both panes consistent.
  const handleCreated = useCallback(() => {
    void refresh();
    onBackToList();
  }, [refresh, onBackToList]);

  const handleUpdated = useCallback(() => {
    void refresh();
  }, [refresh]);

  const handleDeleted = useCallback(() => {
    void refresh();
    onBackToList();
  }, [refresh, onBackToList]);

  return (
    <section aria-label="Agents" className="space-y-4">
      {/* Full-width editorial header — the list column (18rem) is too narrow
          to hold a font-display title alongside the New button. */}
      {showList && (
        <SectionHeading
          title="Agents"
          action={
            <Button variant="outline" size="sm" onClick={onNewAgent}>
              <Plus aria-hidden />
              New agent
            </Button>
          }
        />
      )}

      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {showList && (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              An agent is a set of instructions, a default model, and a machine with your
              repositories on it.
            </p>

            {agents === null ? (
              <ul className="space-y-3" aria-busy="true" aria-label="Loading agents">
                {[0, 1, 2].map((i) => (
                  <Card key={i} className="flex flex-row items-center gap-3 p-3">
                    <Skeleton className="size-4 shrink-0 rounded" />
                    <div className="flex flex-1 flex-col gap-1.5">
                      <Skeleton className="h-4 w-32" />
                      <Skeleton className="h-3 w-48" />
                    </div>
                  </Card>
                ))}
              </ul>
            ) : loadError ? (
              <div className="space-y-3" role="alert">
                <Alert variant="destructive">
                  <AlertDescription>Couldn’t load agents. {loadError.message}</AlertDescription>
                </Alert>
                <Button variant="outline" onClick={load}>
                  Retry
                </Button>
              </div>
            ) : agents.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border border-dashed py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Robot aria-hidden className="size-5" />
                </span>
                <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">
                  Create an agent to give your chats instructions, a default model, and a machine
                  with your repositories on it.
                </p>
                <Button variant="outline" size="sm" className="mt-1" onClick={onNewAgent}>
                  <Plus aria-hidden />
                  New agent
                </Button>
              </div>
            ) : (
              <ul className="space-y-2">
                {agents.map((agent) => (
                  <li key={agent.id}>
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
                      onClick={() => onSelectAgent(agent.id)}
                      aria-current={agent.id === selectedId ? "true" : undefined}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Robot aria-hidden className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-foreground text-sm">
                          {agent.name}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {agent.enabled ? agent.description || "No description" : "Disabled"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                        <GitBranch aria-hidden className="size-3.5" />
                        {agent.repositories.length}{" "}
                        {agent.repositories.length === 1 ? "repo" : "repos"}
                      </span>
                      <CaretRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {showDetail && (
          <div className="flex min-h-0 flex-col gap-4">
            {!isDesktop && (
              <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={onBackToList}>
                <ArrowLeft aria-hidden />
                All agents
              </Button>
            )}

            {selectedId === "new" ? (
              <AgentDetailPage
                key="new"
                agent={null}
                providers={providers}
                networkAllowlistEnabled={networkAllowlistEnabled}
                isOnlyAgent={false}
                onCreated={handleCreated}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
                onCancel={onBackToList}
                onReload={handleReload}
              />
            ) : selectedId && agents === null ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading agent">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : selectedId && !selectedAgent ? (
              <div className="rounded-lg border border-border border-dashed py-10 text-center">
                <p className="text-muted-foreground text-sm">
                  That agent isn’t here — it may have been deleted.
                </p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onBackToList}>
                  Back to agents
                </Button>
              </div>
            ) : selectedId ? (
              <AgentDetailPage
                key={selectedId}
                agent={selectedAgent}
                providers={providers}
                networkAllowlistEnabled={networkAllowlistEnabled}
                isOnlyAgent={isOnlyAgent}
                onCreated={handleCreated}
                onUpdated={handleUpdated}
                onDeleted={handleDeleted}
                onCancel={onBackToList}
                onReload={handleReload}
              />
            ) : (
              <div className="hidden items-center justify-center rounded-lg border border-border border-dashed py-16 text-center lg:flex">
                <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">
                  Pick an agent to change what it knows and what it runs on.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
