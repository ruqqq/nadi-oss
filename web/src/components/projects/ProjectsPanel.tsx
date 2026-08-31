import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  Archive,
  ArrowLeft,
  ArrowsClockwise,
  ArrowSquareOut,
  CaretRight,
  ChatCircle,
  FolderSimple,
  Plus,
} from "../../icons";
import { useMediaQuery } from "../../lib/use-media-query";
import { nextPanelSelection } from "../../lib/projects-panel-selection";
import {
  archiveProject,
  createProject,
  getProject,
  listProjects,
  updateProject,
  type ProjectSummary,
} from "../../projects-api";
import { listAgents as listWorkbenches, type AgentSummary as WorkbenchSummary } from "../../agents-api";
import { listThreads, type ThreadSummary } from "../../threads-api";
import { isNetworkFailure } from "../../lib/offline-state";
import { isThreadListEmpty, THREAD_PAGE_SIZE } from "../../lib/thread-list-state";
import { formatRelativeTime } from "../../lib/thread-time";
import { useProgressiveList } from "../../lib/use-progressive-list";
import { useThreadQuery } from "../../lib/use-thread-query";
import { cn } from "../../lib/utils";
import { ShowMoreRow } from "../chat/ShowMoreRow";
import { ThreadIndicator } from "../chat/ThreadIndicator";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import {
  DetailHeading,
  Field,
  FORM_ACTION_BUTTON,
  FormActions,
  FormCard,
  PaneFooter,
} from "../../settings/section-ui";

type ProjectFormState = {
  name: string;
  description: string;
  customInstructions: string;
  defaultAgentId: string | null;
};

type ProjectDetailTab = "configure" | "chats";

// A project's chats are already in memory; this is a render budget, not a page
// size. Enough to fill any viewport before the observer has to grow it.
const CHATS_PAGE_SIZE = 25;

const EMPTY_PROJECT_FORM: ProjectFormState = {
  name: "",
  description: "",
  customInstructions: "",
  defaultAgentId: null,
};


/** Centered empty state for a list pane. */
function ListEmptyState({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
      <div className="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground [&_svg]:size-5">
        {icon}
      </div>
      <p className="max-w-[16rem] text-balance text-muted-foreground text-sm">{children}</p>
    </div>
  );
}

export function ProjectsPanel({
  projects,
  threads,
  onThreadsLoaded,
  onProjectsChange,
  selectedId,
  onSelect,
  onBackToList,
  onSelectThread,
  onManageWorkbenches,
  closeLabel,
  onClose,
}: {
  projects: ProjectSummary[];
  /**
   * The active chats the client currently knows about — page one at boot,
   * growing on demand as surfaces page it in (mergeThreadsPage in App.tsx).
   * NOT every active chat in the workspace. Filtering to one project here is
   * still a local filter over this array; the Chats tab's own `useThreadQuery`
   * below (via `onThreadsLoaded`) is what grows the array with this project's
   * chats when they aren't already in it. Archived chats are fetched per-view
   * in All chats and deliberately aren't here.
   */
  threads: ThreadSummary[];
  /** Feeds a fetched page of this project's chats into the shared array
   *  (App's `mergeThreadsPage`) — this component never owns the data. */
  onThreadsLoaded: (threads: ThreadSummary[]) => void;
  onProjectsChange: (projects: ProjectSummary[]) => void;
  /** The project in the URL. Selection is a route, not local state. */
  selectedId: string | null;
  onSelect: (id: string | null, mode: "push" | "replace") => void;
  onBackToList: () => void;
  onSelectThread: (threadId: string) => void;
  /** Workbenches are workspace config, so they are managed in Settings. */
  onManageWorkbenches: () => void;
  closeLabel: string;
  onClose: () => void;
}) {
  // On narrow screens the master-detail collapses into a drill-down: the list
  // is the default view and selecting an item pushes its editor into view.
  // Desktop shows both panes at once, so selecting there is not a navigation —
  // it replaces the entry instead of pushing one.
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [creating, setCreating] = useState(false);

  const selectedProjectId = selectedId;

  // A blank form has nothing to link to, so "new" stays local state.
  const inDetail = selectedId !== null || creating;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;
  const [projectForm, setProjectForm] = useState<ProjectFormState>(EMPTY_PROJECT_FORM);
  // The workbench list is read-only here — it is what the default-workbench
  // picker is made of. Workbenches themselves are created and edited in Settings.
  const [workbenches, setWorkbenches] = useState<WorkbenchSummary[]>([]);
  const [loadingWorkbenches, setLoadingWorkbenches] = useState(true);
  const [busyProject, setBusyProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  // A failed workbench load must not read as "no workbenches yet" — the
  // picker says so plainly instead.
  const [workbenchesError, setWorkbenchesError] = useState<string | null>(null);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  // Which half of the detail pane is showing. A project that doesn't exist yet
  // has no chats, so the blank form is never tabbed — hence the forced value.
  const [detailTab, setDetailTab] = useState<ProjectDetailTab>("configure");
  const isCreatingView = creating || selectedProjectId === null;
  const activeTab: ProjectDetailTab = isCreatingView ? "configure" : detailTab;

  const projectThreads = useMemo(
    () =>
      selectedProjectId ? threads.filter((thread) => thread.projectId === selectedProjectId) : [],
    [threads, selectedProjectId],
  );

  // Keyed on the project: a different one starts at the top rather than
  // inheriting how far the last was scrolled.
  const chats = useProgressiveList(projectThreads, {
    pageSize: CHATS_PAGE_SIZE,
    resetKey: selectedProjectId ?? "",
  });

  // Pages this project's active chats into the SHARED array via
  // `onThreadsLoaded` — never owned locally — so live socket updates keep
  // reaching `projectThreads` above for free. Gated on the Chats tab: fetching
  // a project's chats while nobody is looking at them is waste.
  const chatsQuery = useThreadQuery({
    key: `project-chats:${selectedProjectId ?? ""}`,
    fetchPage: (cursor) =>
      listThreads(fetch, "active", selectedProjectId ?? "all", {
        limit: THREAD_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }).catch((error: unknown) => {
        if (isNetworkFailure(error)) {
          throw new Error("You're offline. Reconnect to load chats.");
        }
        throw error;
      }),
    onPage: (page) => onThreadsLoaded(page),
    enabled: selectedProjectId !== null && activeTab === "chats",
  });

  // Same shape as AllChatsView's active half (App.tsx): the render budget
  // reveals a page at a time; once it has nothing left but the server has
  // more, fetch the next page. `chatsQuery.loading` is required — a page
  // that is 100% duplicates (already merged into `threads`) adds no rows, so
  // `chats.hasMore`/`projectThreads.length` don't change and `loading` is the
  // only state that moves, which is what re-evaluates this effect after a
  // no-op page lands. `chatsQuery.error === null` is required too: the error
  // path never sets `exhausted`, so without this guard a failure re-triggers
  // `loadMore` on every `loading` flip — an unthrottled retry storm. Because
  // of that guard, nothing here ever clears `error` again once it's set — the
  // Retry buttons below (calling `chatsQuery.reload()`) are the only way back.
  useEffect(() => {
    if (!chats.hasMore && chatsQuery.hasMore && chatsQuery.error === null) chatsQuery.loadMore();
  }, [chats.hasMore, chatsQuery.hasMore, chatsQuery.error, chatsQuery.loading, chatsQuery.loadMore]);

  const chatsEmpty = isThreadListEmpty({
    count: projectThreads.length,
    loading: chatsQuery.loading,
    exhausted: chatsQuery.exhausted,
  });

  // A different project is a different pane: open it on Configure rather than
  // dropping the user into a chat list they didn't ask for.
  useEffect(() => {
    setDetailTab("configure");
  }, [selectedProjectId]);

  const refreshProjects = useCallback(async () => {
    const nextProjects = await listProjects("active");
    onProjectsChange(nextProjects);
    return nextProjects;
  }, [onProjectsChange]);

  const refreshWorkbenches = useCallback(async () => {
    const nextWorkbenches = await listWorkbenches("active");
    setWorkbenches(nextWorkbenches);
    return nextWorkbenches;
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingWorkbenches(true);
    void refreshWorkbenches()
      .catch((error: unknown) => {
        if (!active) return;
        setWorkbenchesError(
          error instanceof Error ? error.message : "Could not load workbenches.",
        );
      })
      .finally(() => {
        if (active) setLoadingWorkbenches(false);
      });
    return () => {
      active = false;
    };
  }, [refreshWorkbenches]);

  // Keep the URL's selection honest: land on the first item when nothing is
  // selected, and drop a selection whose item is gone (deleted, or a stale link).
  // Desktop only — on mobile an empty selection *is* the list view, and
  // auto-selecting would drill the user into a detail they never opened.
  const availableIds = projects.map((project) => project.id);
  useEffect(() => {
    if (creating) return;
    const next = isDesktop
      ? nextPanelSelection(selectedId, availableIds)
      : // Mobile: keep the selection only if it still exists. Falling back to the
        // first item would drill into something the user never picked.
        selectedId && availableIds.includes(selectedId)
        ? selectedId
        : null;
    if (next !== selectedId) onSelect(next, "replace");
    // availableIds is rebuilt each render; compare by value, not identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [creating, isDesktop, selectedId, availableIds.join(","), onSelect]);

  useEffect(() => {
    if (!selectedProject) {
      setProjectForm(EMPTY_PROJECT_FORM);
      return;
    }
    setProjectForm({
      name: selectedProject.name,
      description: selectedProject.description,
      customInstructions: selectedProject.customInstructions,
      defaultAgentId: selectedProject.defaultAgentId,
    });
  }, [selectedProject]);

  useEffect(() => {
    if (!selectedProjectId) {
      setProjectError(null);
      return;
    }

    let active = true;
    setProjectError(null);

    void getProject(selectedProjectId)
      .then((project) => {
        if (!active) return;
        setProjectForm((current) => ({
          ...current,
          defaultAgentId: project.defaultAgentId,
        }));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setProjectError(error instanceof Error ? error.message : "Could not load project.");
      });

    return () => {
      active = false;
    };
  }, [selectedProjectId]);

  const handleProjectField = useCallback(
    (field: keyof Omit<ProjectFormState, "defaultAgentId">, value: string) => {
      setProjectForm((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const handleDefaultWorkbenchChange = useCallback((value: string) => {
    setProjectForm((current) => ({
      ...current,
      defaultAgentId: value === "none" ? null : value,
    }));
  }, []);

  const startNewProject = useCallback(() => {
    setCreating(true);
    setProjectError(null);
    setProjectForm(EMPTY_PROJECT_FORM);
    if (selectedProjectId) onSelect(null, "replace");
  }, [onSelect, selectedProjectId]);

  const openProjectDetail = useCallback(
    (projectId: string) => {
      setCreating(false);
      onSelect(projectId, isDesktop ? "replace" : "push");
    },
    [isDesktop, onSelect],
  );

  // "New" never pushed an entry (a blank form isn't a place), so leaving it is a
  // state change, not a navigation.
  const backToList = useCallback(() => {
    if (creating) {
      setCreating(false);
      return;
    }
    onBackToList();
  }, [creating, onBackToList]);

  const inMobileDetail = !isDesktop && inDetail;
  const backLabel = inMobileDetail ? "All projects" : closeLabel;
  const now = Date.now();

  const handleSaveProject = useCallback(async () => {
    if (!projectForm.name.trim()) {
      setProjectError("Project name is required.");
      return;
    }
    setBusyProject(true);
    setProjectError(null);
    try {
      const payload = {
        name: projectForm.name,
        description: projectForm.description,
        customInstructions: projectForm.customInstructions,
        defaultAgentId: projectForm.defaultAgentId,
      };
      const savedProject = selectedProjectId
        ? await updateProject(selectedProjectId, payload)
        : await createProject(payload);
      await refreshProjects();
      setCreating(false);
      onSelect(savedProject.id, "replace");
      toast.success(selectedProjectId ? "Project updated" : "Project created");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Could not save project.");
      toast.error("Couldn't save project");
    } finally {
      setBusyProject(false);
    }
  }, [projectForm, refreshProjects, selectedProjectId, onSelect]);

  const handleArchiveProject = useCallback(async () => {
    if (!selectedProjectId) return;
    setBusyProject(true);
    setProjectError(null);
    try {
      await archiveProject(selectedProjectId);
      await refreshProjects();
      // Leaves no entry pointing at the archived project: pops the detail entry
      // on mobile, replaces it on desktop (where it lands on the next one).
      onBackToList();
      toast.success("Project archived");
    } catch (error) {
      setProjectError(error instanceof Error ? error.message : "Could not archive project.");
      toast.error("Couldn't archive project");
    } finally {
      setBusyProject(false);
    }
  }, [refreshProjects, selectedProjectId, onBackToList]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        {/* One back affordance: it always goes up exactly one level — to the list
            while drilled into a detail on mobile, to chats otherwise. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={inMobileDetail ? backToList : onClose}
          aria-label={backLabel}
          title={backLabel}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm">Projects</div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {showList && (
          <ScrollArea className="min-h-0 lg:border-border lg:border-r">
            <div className="flex items-center justify-between px-4 py-3">
              <div className="font-medium text-foreground text-sm">Active projects</div>
              <Button variant="outline" size="sm" onClick={startNewProject}>
                <Plus aria-hidden />
                New
              </Button>
            </div>
            <div className="flex flex-col gap-1 px-2 pb-3">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                    isDesktop && project.id === selectedProjectId
                      ? "bg-accent"
                      : "hover:bg-accent/60",
                  )}
                  onClick={() => openProjectDetail(project.id)}
                >
                  <FolderSimple aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium text-foreground">{project.name}</span>
                    <span className="truncate text-muted-foreground text-xs">
                      {project.description || "No description"}
                    </span>
                  </span>
                  <CaretRight
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground lg:hidden"
                  />
                </button>
              ))}
              {projects.length === 0 && (
                <ListEmptyState icon={<FolderSimple aria-hidden />}>
                  No projects yet. Create one to group related chats and share instructions.
                </ListEmptyState>
              )}
            </div>
          </ScrollArea>
        )}

        {showDetail && (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setDetailTab(value as ProjectDetailTab)}
            className="flex min-h-0 flex-col gap-0"
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 py-4 sm:px-6">
                {projectError && (
                  <Alert variant="destructive">
                    <AlertDescription>{projectError}</AlertDescription>
                  </Alert>
                )}

                <DetailHeading
                  eyebrow="Project"
                  title={
                    selectedProjectId
                      ? projectForm.name.trim() || "Untitled project"
                      : "New project"
                  }
                />

                {!isCreatingView && (
                  <TabsList className="w-full sm:w-fit">
                    <TabsTrigger value="configure" className="sm:px-4">
                      Configure
                    </TabsTrigger>
                    <TabsTrigger value="chats" className="sm:px-4">
                      Chats
                    </TabsTrigger>
                  </TabsList>
                )}

                <TabsContent value="configure" className="flex flex-none flex-col gap-4">
                  <FormCard title="Details">
                    <Field label="Name" htmlFor="project-name">
                      <Input
                        id="project-name"
                        value={projectForm.name}
                        onChange={(event) => handleProjectField("name", event.target.value)}
                        placeholder="e.g. Marketing site"
                      />
                    </Field>
                    <Field
                      label="Description"
                      htmlFor="project-description"
                      hint="A short note about what this project is for."
                    >
                      <Textarea
                        id="project-description"
                        value={projectForm.description}
                        onChange={(event) => handleProjectField("description", event.target.value)}
                        placeholder="What is this project about?"
                      />
                    </Field>
                  </FormCard>

                  <FormCard
                    title="Custom instructions"
                    description="Appended to the model's system prompt for every chat in this project."
                  >
                    <Textarea
                      id="project-instructions"
                      value={projectForm.customInstructions}
                      onChange={(event) =>
                        handleProjectField("customInstructions", event.target.value)
                      }
                      placeholder="e.g. Always respond in TypeScript and prefer a functional style."
                      className="min-h-28"
                    />
                  </FormCard>

                  <FormCard
                    title="Default workbench"
                    description="New chats in this project start with this workbench. You can change it per chat."
                    action={
                      <Button
                        variant="ghost"
                        size="sm"
                        className="-mr-2 h-8 text-muted-foreground hover:text-foreground"
                        onClick={onManageWorkbenches}
                      >
                        Manage
                        <ArrowSquareOut aria-hidden />
                      </Button>
                    }
                  >
                    <Field label="Workbench" htmlFor="project-default-workbench">
                      {workbenchesError ? (
                        <div className="rounded-md border border-dashed border-border px-3 py-2 text-muted-foreground text-sm">
                          {workbenchesError}
                        </div>
                      ) : loadingWorkbenches ? (
                        <div className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-muted-foreground text-sm">
                          <Spinner className="size-4" label="Loading workbenches" />
                          Loading
                        </div>
                      ) : workbenches.length === 0 ? (
                        <button
                          type="button"
                          onClick={onManageWorkbenches}
                          className="rounded-md border border-dashed border-border px-3 py-2 text-left text-muted-foreground text-sm transition-colors hover:border-primary hover:text-foreground"
                        >
                          No workbenches yet — add one in Settings.
                        </button>
                      ) : (
                        <Select
                          value={projectForm.defaultAgentId ?? "none"}
                          onValueChange={handleDefaultWorkbenchChange}
                        >
                          <SelectTrigger id="project-default-workbench" className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="none">None</SelectItem>
                            {workbenches.map((workbench) => (
                              <SelectItem key={workbench.id} value={workbench.id}>
                                {workbench.name}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      )}
                    </Field>
                  </FormCard>
                </TabsContent>

                {/* The tab already says "Chats", so this pane leads with what
                    they are here rather than repeating the word in a header. */}
                <TabsContent value="chats" className="flex flex-none flex-col gap-3">
                  <p className="text-muted-foreground text-sm">
                    Chats filed under this project. Archived ones stay in All chats.
                  </p>
                  {chatsQuery.error !== null && projectThreads.length === 0 ? (
                    // Only the full-screen box: a non-empty list must never be
                    // wiped by a failed page fetch — see AllChatsView
                    // (App.tsx) for the identical rationale.
                    <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center text-destructive text-sm">
                      {chatsQuery.error.message}
                      <Button variant="outline" size="sm" onClick={() => chatsQuery.reload()}>
                        Try again
                      </Button>
                    </div>
                  ) : chatsEmpty ? (
                    <ListEmptyState icon={<ChatCircle aria-hidden />}>
                      No chats in this project yet. Pick it in the composer when you start one, or
                      move an existing chat here.
                    </ListEmptyState>
                  ) : projectThreads.length === 0 ? (
                    <div
                      className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-muted-foreground text-sm"
                      aria-busy="true"
                    >
                      <Spinner className="size-4" label="Loading chats" />
                      Loading chats…
                    </div>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                      {chats.visible.map((thread) => (
                        <button
                          key={thread.threadId}
                          type="button"
                          className="flex w-full min-w-0 flex-col gap-1 border-border border-b px-4 py-3 text-left transition-colors last:border-b-0 hover:bg-accent/60"
                          onClick={() => onSelectThread(thread.threadId)}
                        >
                          <span className="flex w-full min-w-0 items-center gap-1.5">
                            <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                              {thread.title || "Untitled chat"}
                            </span>
                            <ThreadIndicator thread={thread} />
                            <span className="shrink-0 text-muted-foreground text-xs">
                              {formatRelativeTime(thread.updatedAt, now)}
                            </span>
                          </span>
                          {/*
                            `lastMessagePreview` is deliberately NOT rendered. It
                            is a search input — thread search matches on it and
                            reports `matchedIn: "preview"` — not a display field.
                            It sat empty until the search projector began writing
                            it, which silently turned this row into a preview
                            list nobody asked for. Populate it, search it, don't
                            show it.
                          */}
                        </button>
                      ))}
                      {chats.hasMore && (
                        <ShowMoreRow
                          remaining={chats.remaining}
                          noun="chat"
                          onShowMore={chats.showMore}
                          sentinelRef={chats.sentinelRef}
                        />
                      )}
                      {chatsQuery.error !== null ? (
                        // Alongside ShowMoreRow, not instead of it — see
                        // AllChatsView (App.tsx) for the identical rationale.
                        <div className="flex items-center justify-between gap-2 px-4 py-3 text-destructive text-sm">
                          {chatsQuery.error.message}
                          <Button variant="ghost" size="xs" onClick={() => chatsQuery.reload()}>
                            <ArrowsClockwise aria-hidden />
                            Retry
                          </Button>
                        </div>
                      ) : (
                        !chats.hasMore &&
                        chatsQuery.loading && (
                          <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
                            <Spinner className="size-3.5" />
                            Loading more…
                          </div>
                        )
                      )}
                    </div>
                  )}
                </TabsContent>
              </div>
            </ScrollArea>

            {/* The form is long enough to scroll past its own actions, so they
                    sit on a bar pinned to the bottom of the pane instead. Chats
                    is read-only, so it has nothing for this bar to do. */}
            {activeTab === "configure" && (
              <PaneFooter className="shrink-0">
                <FormActions>
                  {selectedProjectId && (
                    <Button
                      variant="outline"
                      className={FORM_ACTION_BUTTON}
                      onClick={() => void handleArchiveProject()}
                      disabled={busyProject}
                    >
                      <Archive aria-hidden />
                      Archive
                    </Button>
                  )}
                  <Button
                    className={FORM_ACTION_BUTTON}
                    onClick={() => void handleSaveProject()}
                    disabled={busyProject}
                  >
                    {busyProject ? <Spinner className="size-4" /> : null}
                    {selectedProjectId ? "Save project" : "Create project"}
                  </Button>
                </FormActions>
              </PaneFooter>
            )}
          </Tabs>
        )}
      </div>
    </div>
  );
}
