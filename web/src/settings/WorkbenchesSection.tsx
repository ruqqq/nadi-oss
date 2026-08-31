import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Archive, ArrowLeft, CaretRight, GitBranch, Plus, Toolbox } from "../icons";
import { useMediaQuery } from "../lib/use-media-query";
import {
  // Renamed server-side to agents-api (Task 5, the wire-contract rename).
  // Aliased back to the pre-merge names here rather than shotgun-renaming
  // this file's ~120 internal references — Task 6 owns the Agents section
  // redesign and will do that rename as part of its visual pass.
  archiveAgent as archiveWorkbench,
  createAgent as createWorkbench,
  deleteAgentSecret as deleteWorkbenchSecret,
  listAgents as listWorkbenches,
  setAgentEnvVars as setWorkbenchEnvVars,
  setAgentRepositories as setWorkbenchRepositories,
  setAgentSecret as setWorkbenchSecret,
  updateAgent as updateWorkbench,
  type AgentRepository as WorkbenchRepository,
  type AgentRepositoryInput as WorkbenchRepositoryInput,
  type AgentResourceProfile as WorkbenchResourceProfile,
  type AgentSummary as WorkbenchSummary,
} from "../agents-api";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Input } from "../components/ui/input";
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
import { WorkbenchRepositories } from "./WorkbenchRepositories";

type WorkbenchForm = {
  name: string;
  description: string;
  setupScript: string;
  resourceProfile: WorkbenchResourceProfile;
  networkDomainAllowlist: string;
};

const EMPTY_FORM: WorkbenchForm = {
  name: "",
  description: "",
  setupScript: "",
  resourceProfile: "small",
  networkDomainAllowlist: "",
};

function formFrom(workbench: WorkbenchSummary): WorkbenchForm {
  return {
    name: workbench.name,
    description: workbench.description,
    setupScript: workbench.setupScript,
    resourceProfile: workbench.resourceProfile,
    networkDomainAllowlist: workbench.networkDomainAllowlist,
  };
}

function repositoriesToInput(repositories: WorkbenchRepository[]): WorkbenchRepositoryInput[] {
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
 * The create/edit page for a workbench. `workbench === null` is the create
 * form; otherwise it's the edit form for that workbench. Both share the same
 * Details → Setup script → Repositories top layout; edit adds Environment
 * variables + Secrets below, since those only make sense once the workbench
 * (and its id) exist.
 */
function WorkbenchDetailPage({
  workbench,
  networkAllowlistEnabled,
  onCreated,
  onUpdated,
  onArchived,
  onCancel,
  onReload,
}: {
  workbench: WorkbenchSummary | null;
  networkAllowlistEnabled: boolean;
  onCreated: (created: WorkbenchSummary) => void;
  onUpdated: (updated: WorkbenchSummary) => void;
  onArchived: () => void;
  onCancel: () => void;
  /** Refetches the workspace's workbenches so this pane's env var / secret
   *  panels see the latest saved shape after their own mutations. */
  onReload: () => Promise<void>;
}) {
  const isCreate = workbench === null;
  const [form, setForm] = useState<WorkbenchForm>(workbench ? formFrom(workbench) : EMPTY_FORM);
  // Repositories are staged locally for both create (nothing to save against
  // yet) and edit (the seam below has no per-row save affordance — Save
  // commits whatever is staged here via setWorkbenchRepositories).
  const [repos, setRepos] = useState<WorkbenchRepositoryInput[]>(
    workbench ? repositoriesToInput(workbench.repositories) : [],
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = useCallback((key: keyof WorkbenchForm, value: string) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.name.trim()) {
      setError("Name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        name: form.name,
        description: form.description,
        setupScript: form.setupScript,
        resourceProfile: form.resourceProfile,
        networkDomainAllowlist: form.networkDomainAllowlist.trim(),
      };
      if (isCreate) {
        const created = await createWorkbench(payload);
        const withRepos =
          repos.length > 0 ? await setWorkbenchRepositories(created.id, repos) : created;
        toast.success("Workbench created");
        onCreated(withRepos);
      } else {
        await updateWorkbench(workbench.id, payload);
        const withRepos = await setWorkbenchRepositories(workbench.id, repos);
        toast.success("Workbench saved");
        onUpdated(withRepos);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the workbench.");
      toast.error(isCreate ? "Couldn’t create workbench" : "Couldn’t save workbench");
    } finally {
      setBusy(false);
    }
  }, [form, repos, isCreate, workbench, onCreated, onUpdated]);

  const handleArchive = useCallback(async () => {
    if (!workbench) return;
    setBusy(true);
    setError(null);
    try {
      await archiveWorkbench(workbench.id);
      toast.success(`Archived “${workbench.name}”`);
      onArchived();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not archive the workbench.");
      toast.error("Couldn’t archive workbench");
    } finally {
      setBusy(false);
    }
  }, [workbench, onArchived]);

  const id = workbench?.id ?? "new";

  return (
    <div className="flex min-h-0 flex-col gap-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <DetailHeading eyebrow="Workbench" title={isCreate ? "New workbench" : workbench.name} />

      <FormCard title="Details">
        <Field label="Name" htmlFor={`workbench-name-${id}`}>
          <Input
            id={`workbench-name-${id}`}
            value={form.name}
            onChange={(event) => field("name", event.target.value)}
            placeholder="e.g. Staging"
          />
        </Field>
        <Field
          label="Description"
          htmlFor={`workbench-description-${id}`}
          hint="A short note about what this workbench is for."
        >
          <Textarea
            id={`workbench-description-${id}`}
            value={form.description}
            onChange={(event) => field("description", event.target.value)}
            placeholder="What is this workbench for?"
          />
        </Field>
      </FormCard>

      <FormCard
        title="Setup script"
        description="Run once after every repository is cloned, before the agent starts work."
      >
        <Textarea
          id={`workbench-setup-${id}`}
          className="min-h-28 font-mono text-xs"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          value={form.setupScript}
          onChange={(event) => field("setupScript", event.target.value)}
          placeholder={"pnpm install\npnpm run db:migrate:local"}
        />
      </FormCard>

      <FormCard title="Sandbox">
        <Field
          label="Sandbox size"
          hint="Threads started from this workbench get a sandbox this size. Choose medium for large repos, heavy toolchains, or long builds."
        >
          <Select
            value={form.resourceProfile}
            onValueChange={(value) =>
              setForm((prev) => ({
                ...prev,
                resourceProfile: value as WorkbenchResourceProfile,
              }))
            }
          >
            <SelectTrigger aria-label="Sandbox size">
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
            hint="One host per line. On Daytona, these are added to Nadi's default allowed hosts and outbound access is restricted to the combined list."
          >
            <Textarea
              id={`agent-network-allowlist-${id}`}
              className="min-h-20 font-mono text-xs"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={form.networkDomainAllowlist}
              onChange={(event) => field("networkDomainAllowlist", event.target.value)}
              placeholder={"api.example.com\n*.internal.example.com"}
            />
          </Field>
        )}
      </FormCard>

      <FormCard
        title="Repositories"
        description="Cloned into the sandbox before the setup script runs."
      >
        <WorkbenchRepositories value={repos} onChange={setRepos} />
      </FormCard>

      {workbench && (
        <>
          <SandboxEnvVarsPanel
            title="Environment variables"
            envVars={workbench.envVars}
            onSave={(envVars) => setWorkbenchEnvVars(workbench.id, envVars).then(() => onReload())}
          />

          <SandboxSecretsPanel
            title="Secrets"
            secrets={workbench.secretEnvNames.map((name) => ({ name, updatedAt: "" }))}
            onUpsert={(envVars) =>
              Promise.all(
                Object.entries(envVars).map(([name, value]) =>
                  setWorkbenchSecret(workbench.id, name, value),
                ),
              ).then(() => onReload())
            }
            onDelete={(name) => deleteWorkbenchSecret(workbench.id, name).then(() => onReload())}
          />
        </>
      )}

      {/* Primary actions render in the shell's footer slot (below the scroll
          area), so they stay visible on long forms without a sticky bar
          fighting the scroll container's reserved safe-area — which, in an
          installed PWA, otherwise floats the bar above the home indicator. */}
      <SettingsFooterPortal>
        <PaneFooter contentClassName="max-w-4xl">
          <FormActions>
            {workbench ? (
              <Button
                variant="outline"
                className={FORM_ACTION_BUTTON}
                onClick={() => void handleArchive()}
                disabled={busy}
              >
                <Archive aria-hidden />
                Archive
              </Button>
            ) : (
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
              {workbench ? "Save workbench" : "Create workbench"}
            </Button>
          </FormActions>
        </PaneFooter>
      </SettingsFooterPortal>
    </div>
  );
}

/**
 * Master-detail host for Workbenches. The list is editorial and real; the
 * detail pane is the create/edit form (WorkbenchDetailPage).
 */
export function WorkbenchesSection({
  networkAllowlistEnabled,
  selectedId,
  onSelectWorkbench,
  onNewWorkbench,
  onBackToList,
}: {
  networkAllowlistEnabled: boolean;
  /** The workbench in the URL: null for the list, "new" for the create form,
   *  or a workbench id. */
  selectedId: string | null;
  onSelectWorkbench: (id: string) => void;
  onNewWorkbench: () => void;
  onBackToList: () => void;
}) {
  // Below lg the master-detail collapses into a drill-down: the list is the
  // default view and selecting a row navigates into the detail pane.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [workbenches, setWorkbenches] = useState<WorkbenchSummary[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);

  // Silent refetch — does not clear the list to the loading state, so it's
  // safe to call after a save without flashing skeletons under the form.
  const refresh = useCallback(async () => {
    const next = await listWorkbenches("active");
    setWorkbenches(next);
    return next;
  }, []);

  const load = useCallback(() => {
    setWorkbenches(null);
    setLoadError(null);
    void refresh().catch((err: unknown) => {
      setWorkbenches([]);
      setLoadError(err instanceof Error ? err : new Error(String(err)));
    });
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  const inDetail = selectedId !== null;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;

  const selectedWorkbench =
    selectedId && selectedId !== "new"
      ? (workbenches?.find((workbench) => workbench.id === selectedId) ?? null)
      : null;

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

  const handleArchived = useCallback(() => {
    void refresh();
    onBackToList();
  }, [refresh, onBackToList]);

  return (
    <section aria-label="Workbenches" className="space-y-4">
      {/* Full-width editorial header — the list column (18rem) is too narrow
          to hold a font-display title alongside the New button. */}
      {showList && (
        <SectionHeading
          title="Workbenches"
          action={
            <Button variant="outline" size="sm" onClick={onNewWorkbench}>
              <Plus aria-hidden />
              New workbench
            </Button>
          }
        />
      )}

      <div className="grid min-h-0 grid-cols-1 gap-4 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {showList && (
          <div className="space-y-3">
            <p className="text-muted-foreground text-sm">
              Repeatable sandbox setups — repositories, setup scripts, env vars, and secrets.
            </p>

            {workbenches === null ? (
              <ul className="space-y-3" aria-busy="true" aria-label="Loading workbenches">
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
                  <AlertDescription>Couldn’t load workbenches. {loadError.message}</AlertDescription>
                </Alert>
                <Button variant="outline" onClick={load}>
                  Retry
                </Button>
              </div>
            ) : workbenches.length === 0 ? (
              <div className="flex flex-col items-center gap-2 rounded-lg border border-border border-dashed py-10 text-center">
                <span className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Toolbox aria-hidden className="size-5" />
                </span>
                <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">
                  No workbenches yet. Create one to give a chat a repeatable setup script,
                  repositories, and secrets.
                </p>
                <Button variant="outline" size="sm" className="mt-1" onClick={onNewWorkbench}>
                  <Plus aria-hidden />
                  New workbench
                </Button>
              </div>
            ) : (
              <ul className="space-y-2">
                {workbenches.map((workbench) => (
                  <li key={workbench.id}>
                    <button
                      type="button"
                      className="flex w-full min-w-0 items-center gap-3 rounded-lg border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/60"
                      onClick={() => onSelectWorkbench(workbench.id)}
                      aria-current={workbench.id === selectedId ? "true" : undefined}
                    >
                      <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                        <Toolbox aria-hidden className="size-4" />
                      </span>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate font-medium text-foreground text-sm">
                          {workbench.name}
                        </span>
                        <span className="truncate text-muted-foreground text-xs">
                          {workbench.description || "No description"}
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
                        <GitBranch aria-hidden className="size-3.5" />
                        {workbench.repositories.length}{" "}
                        {workbench.repositories.length === 1 ? "repo" : "repos"}
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
                All workbenches
              </Button>
            )}

            {selectedId === "new" ? (
              <WorkbenchDetailPage
                key="new"
                workbench={null}
                networkAllowlistEnabled={networkAllowlistEnabled}
                onCreated={handleCreated}
                onUpdated={handleUpdated}
                onArchived={handleArchived}
                onCancel={onBackToList}
                onReload={handleReload}
              />
            ) : selectedId && workbenches === null ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading workbench">
                <Skeleton className="h-6 w-40" />
                <Skeleton className="h-32 w-full" />
                <Skeleton className="h-32 w-full" />
              </div>
            ) : selectedId && !selectedWorkbench ? (
              <div className="rounded-lg border border-border border-dashed py-10 text-center">
                <p className="text-muted-foreground text-sm">Workbench not found.</p>
                <Button variant="outline" size="sm" className="mt-3" onClick={onBackToList}>
                  Back to workbenches
                </Button>
              </div>
            ) : selectedId ? (
              <WorkbenchDetailPage
                key={selectedId}
                workbench={selectedWorkbench}
                networkAllowlistEnabled={networkAllowlistEnabled}
                onCreated={handleCreated}
                onUpdated={handleUpdated}
                onArchived={handleArchived}
                onCancel={onBackToList}
                onReload={handleReload}
              />
            ) : (
              <div className="hidden items-center justify-center rounded-lg border border-border border-dashed py-16 text-center lg:flex">
                <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">
                  Select a workbench, or create one to get started.
                </p>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
