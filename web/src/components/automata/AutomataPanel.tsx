import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  ArrowBendDownRight,
  ArrowLeft,
  ArrowsClockwise,
  BellRinging,
  CaretRight,
  CheckCircle,
  CircleNotch,
  Clock,
  Play,
  Plus,
  Trash,
  XCircle,
} from "../../icons";
import { useMediaQuery } from "../../lib/use-media-query";
import { cn } from "../../lib/utils";
import { writeThenRefresh } from "../../lib/write-then-refresh";
import {
  archiveAutomaton,
  createAutomaton,
  defaultOnceDate,
  utcMsToZonedDateParts,
  zonedDateTimeToUtcMs,
  describeSchedule,
  getAutomaton,
  parseAutomatonSchedule,
  runAutomatonNow,
  updateAutomaton,
  listAutomata,
  type AutomatonRun,
  type AutomatonRunStatus,
  type AutomatonSchedule,
  type AutomatonSummary,
  type CreateAutomatonInput,
} from "../../automata-api";
import { dismissThreadOutcome } from "../../threads-api";
import {
  getDefaultAgentSettings,
  isSettingsProvider,
  type ModelInputModality,
  type ProviderSettingsView,
  type SettingsProvider,
} from "../../settings-api";
import { SETTINGS_PROVIDER_MODEL_PLACEHOLDERS } from "../../settings-ui-config";
import { ModelPicker } from "../model/ModelPicker";
import type { ProjectSummary } from "../../projects-api";
import { listAgents, type AgentListItem } from "../../agents-api";
import { AgentOverridePicker } from "../agents/AgentPicker";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
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

// Mono config fields hold literal values (a cron expression, an IANA
// timezone), so the keyboard must not autocorrect, auto-capitalize, or
// spell-check them.
const monoFieldProps = {
  className: "font-mono text-xs",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

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

/**
 * Run status reuses Nadi's intent tokens rather than a new palette. The
 * mapping is semantic, not decorative: `--gate` was minted for approval
 * gating, and a run that stopped for approval IS the gate. Every chip pairs
 * colour with an icon and a word, so status never depends on colour alone.
 */
const RUN_STATUS: Record<
  AutomatonRunStatus,
  { label: string; Icon: typeof Clock; className: string }
> = {
  queued: { label: "Queued", Icon: Clock, className: "border-border text-muted-foreground" },
  running: { label: "Running", Icon: CircleNotch, className: "border-border text-foreground" },
  completed: {
    label: "Completed",
    Icon: CheckCircle,
    className: "border-transparent bg-approve/12 text-approve",
  },
  waiting_for_approval: {
    label: "Needs you",
    Icon: BellRinging,
    className: "border-transparent bg-gate-bg text-gate",
  },
  failed: {
    label: "Failed",
    Icon: XCircle,
    className: "border-transparent bg-reject/12 text-reject",
  },
  skipped: {
    label: "Skipped",
    Icon: ArrowBendDownRight,
    className: "border-border text-muted-foreground",
  },
};

function RunStatusChip({ status }: { status: AutomatonRunStatus }) {
  const { label, Icon, className } = RUN_STATUS[status];
  return (
    <Badge variant="outline" className={className}>
      <Icon aria-hidden className={status === "running" ? "animate-spin" : undefined} />
      <span>{label}</span>
    </Badge>
  );
}

type RepeatKind = "hourly" | "daily" | "weekdays" | "weekly" | "once";

type AutomatonFormState = {
  name: string;
  prompt: string;
  repeat: RepeatKind;
  hour: number;
  minute: number;
  weekday: number;
  onceDate: string;
  timezone: string;
  cronExpr: string;
  projectId: string; // "none" or a ProjectSummary id
  /** null = inherit the project's default agent; otherwise an agent id. */
  agentId: string | null;
  enabled: boolean;
  notifyMode: "all" | "failures_only";
  // The model override. A null provider means "run on the workspace agent's
  // model", which is also what an automaton starts life with.
  modelProvider: SettingsProvider | null;
  model: string;
  modelInputModalities: ModelInputModality[];
};

const WEEKDAY_OPTIONS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

function defaultTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const EMPTY_FORM: AutomatonFormState = {
  name: "",
  prompt: "",
  repeat: "weekdays",
  hour: 8,
  minute: 0,
  weekday: 1,
  onceDate: defaultOnceDate(defaultTimezone()),
  timezone: defaultTimezone(),
  cronExpr: "",
  projectId: "none",
  agentId: null,
  enabled: true,
  notifyMode: "all",
  modelProvider: null,
  model: "",
  modelInputModalities: ["text"],
};

/** Stored JSON column → modalities, degrading to text-only rather than throwing. */
function parseStoredModalities(value: string | null): ModelInputModality[] {
  if (!value) return ["text"];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return ["text"];
    return parsed as ModelInputModality[];
  } catch {
    return ["text"];
  }
}

function formFromAutomaton(automaton: AutomatonSummary): AutomatonFormState {
  const base = {
    name: automaton.name,
    prompt: automaton.prompt,
    timezone: automaton.timezone,
    projectId: automaton.projectId ?? "none",
    agentId: automaton.agentId,
    enabled: automaton.enabled,
    notifyMode: automaton.notifyMode,
    // A provider the workspace no longer offers is dropped back to the agent
    // default, matching what the server would actually run.
    // `modelProvider` is nullable — a null one means "no override", which lands on
    // the same `null` as a provider the workspace no longer offers.
    modelProvider:
      automaton.modelProvider !== null && isSettingsProvider(automaton.modelProvider)
        ? automaton.modelProvider
        : null,
    model: automaton.model ?? "",
    modelInputModalities: parseStoredModalities(automaton.modelInputModalities),
  };
  let schedule: AutomatonSchedule;
  try {
    schedule = parseAutomatonSchedule(automaton.scheduleJson);
  } catch {
    schedule = { kind: "weekdays", hour: 8, minute: 0 };
  }
  switch (schedule.kind) {
    case "cron":
      return {
        ...base,
        repeat: "weekdays",
        hour: 8,
        minute: 0,
        weekday: 1,
        onceDate: defaultOnceDate(automaton.timezone),
        cronExpr: schedule.expr,
      };
    case "hourly":
      return {
        ...base,
        repeat: "hourly",
        hour: 8,
        minute: schedule.minute,
        weekday: 1,
        onceDate: defaultOnceDate(automaton.timezone),
        cronExpr: "",
      };
    case "once": {
      const parts = utcMsToZonedDateParts(schedule.runAt, automaton.timezone);
      return {
        ...base,
        repeat: "once",
        hour: parts.hour,
        minute: parts.minute,
        weekday: 1,
        onceDate: parts.date,
        cronExpr: "",
      };
    }
    case "weekly":
      return {
        ...base,
        repeat: "weekly",
        hour: schedule.hour,
        minute: schedule.minute,
        weekday: schedule.weekday,
        onceDate: defaultOnceDate(automaton.timezone),
        cronExpr: "",
      };
    default:
      return {
        ...base,
        repeat: schedule.kind,
        hour: schedule.hour,
        minute: schedule.minute,
        weekday: 1,
        onceDate: defaultOnceDate(automaton.timezone),
        cronExpr: "",
      };
  }
}

function scheduleFromForm(form: AutomatonFormState): AutomatonSchedule {
  if (form.cronExpr.trim()) return { kind: "cron", expr: form.cronExpr.trim() };
  if (form.repeat === "once") {
    return {
      kind: "once",
      runAt: zonedDateTimeToUtcMs(form.onceDate, form.hour, form.minute, form.timezone),
    };
  }
  switch (form.repeat) {
    case "hourly":
      return { kind: "hourly", minute: form.minute };
    case "daily":
      return { kind: "daily", hour: form.hour, minute: form.minute };
    case "weekly":
      return { kind: "weekly", weekday: form.weekday, hour: form.hour, minute: form.minute };
    default:
      return { kind: "weekdays", hour: form.hour, minute: form.minute };
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function parseTimeInput(value: string): { hour: number; minute: number } | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

function formatDateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Defensive: scheduleJson is always written by our own create/update calls,
// but a list row must never crash the whole panel over one bad row.
function scheduleSummary(automaton: AutomatonSummary): string {
  try {
    return describeSchedule(parseAutomatonSchedule(automaton.scheduleJson), automaton.timezone);
  } catch {
    return "Unknown schedule";
  }
}

// A disabled automaton never fires, so its "next run" reads as "Paused"
// rather than a stale or misleading timestamp.
function nextRunLabel(automaton: AutomatonSummary): string {
  if (!automaton.enabled) {
    return automaton.disabledReason ? `Disabled: ${automaton.disabledReason}` : "Paused";
  }
  if (automaton.nextDueAt == null) return "—";
  return formatDateTime(automaton.nextDueAt);
}

function formatRunStarted(run: AutomatonRun): string {
  return formatDateTime(run.startedAt ?? run.createdAt);
}

function formatRunDuration(run: AutomatonRun): string | null {
  if (run.startedAt == null) return null;
  const end = run.finishedAt ?? Date.now();
  const totalSeconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${pad(minutes)}m`;
  if (minutes > 0) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

type DetailCache = Record<string, { automaton: AutomatonSummary; runs: AutomatonRun[] }>;

type DetailTab = "configure" | "runs";

export function AutomataPanel({
  onClose,
  closeLabel,
  selectedId,
  onSelect,
  onBackToList,
  projects,
  onOpenThread,
}: {
  onClose: () => void;
  closeLabel: string;
  /** The automaton in the URL. Selection is a route, not local state. */
  selectedId: string | null;
  onSelect: (id: string | null, mode: "push" | "replace") => void;
  onBackToList: () => void;
  projects: ProjectSummary[];
  onOpenThread: (threadId: string) => void;
}) {
  // On narrow screens the master-detail collapses into a drill-down: the list
  // is the default view and selecting an item pushes its editor into view.
  // Desktop shows both panes at once, so selecting there is not a navigation —
  // it replaces the entry instead of pushing one.
  const isDesktop = useMediaQuery("(min-width: 1024px)");

  const [automata, setAutomata] = useState<AutomatonSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [details, setDetails] = useState<DetailCache>({});
  const [creating, setCreating] = useState(false);

  // A blank form has nothing to link to, so "new" stays local state.
  const inDetail = selectedId !== null || creating;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;
  const [form, setForm] = useState<AutomatonFormState>(EMPTY_FORM);
  // A cron schedule overrides the Repeat/At fields entirely, so the Advanced
  // section must default open for a cron-scheduled automaton — otherwise its
  // real schedule stays hidden behind stale-looking Weekdays/08:00 defaults.
  const [advancedOpen, setAdvancedOpen] = useState(false);
  // Which half of the detail pane is showing. A new automaton has no runs, so
  // the blank form is never tabbed — hence the forced value below.
  const [detailTab, setDetailTab] = useState<DetailTab>("configure");
  const [busy, setBusy] = useState(false);
  const [runNowBusyId, setRunNowBusyId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  // The model row needs the workspace's usable providers, and the agent's own
  // model to name what "Agent default" actually resolves to. Failing to load it
  // only costs the model picker — the rest of the form still works.
  const [providers, setProviders] = useState<ProviderSettingsView[]>([]);
  const [agentModel, setAgentModel] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const settings = await getDefaultAgentSettings();
        if (cancelled) return;
        setProviders(settings.providers.filter((entry) => entry.usable));
        setAgentModel(settings.agent.model);
      } catch {
        // Leave the picker disabled rather than blocking the whole panel.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // The agent override picker needs the workspace's active agents;
  // failing to load it only costs the picker (it renders empty), not the panel.
  const [agents, setAgents] = useState<AgentListItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    void listAgents("active")
      .then((list) => {
        if (!cancelled) setAgents(list.map(({ id, name, description, enabled }) => ({ id, name, description, enabled })));
      })
      .catch(() => {
        // Leave the picker's list empty rather than blocking the whole panel.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // handleRunNow's await can resolve after the user has navigated away or
  // started a different run; these let it check before it navigates.
  const mountedRef = useRef(true);
  const runNowBusyIdRef = useRef<string | null>(null);
  runNowBusyIdRef.current = runNowBusyId;
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isCreatingView = creating || selectedId === null;

  const applyForm = useCallback((next: AutomatonFormState) => {
    setForm(next);
    setAdvancedOpen(Boolean(next.cronExpr.trim()));
  }, []);

  const refreshList = useCallback(async () => {
    const next = await listAutomata();
    setAutomata(next);
    return next;
  }, []);

  // The detail pane's Runs section needs the full run history (up to 20 rows),
  // which the list endpoint deliberately doesn't return — only the selected
  // automaton's detail is ever fetched, never the whole list's.
  const fetchDetail = useCallback((id: string) => {
    void getAutomaton(id).then((detail) => {
      setDetails((current) => ({ ...current, [id]: detail }));
    });
  }, []);

  // Initial load. Each row carries its own `lastRun` for the status chip; the
  // selected automaton's full detail is fetched separately, below.
  useEffect(() => {
    let active = true;
    setLoadingList(true);
    void listAutomata()
      .then((list) => {
        if (!active) return;
        setAutomata(list);
      })
      .catch((error: unknown) => {
        if (!active) return;
        toast.error(error instanceof Error ? error.message : "Couldn't load your automata.");
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });
    return () => {
      active = false;
    };
  }, []);

  // Desktop shows both panes, so an empty selection would leave half the screen
  // blank — land on the first automaton. Mobile must stay on the list: drilling
  // in is a navigation the user hasn't made yet.
  useEffect(() => {
    if (!isDesktop || selectedId || creating || loadingList) return;
    const first = automata[0];
    if (first) onSelect(first.id, "replace");
  }, [isDesktop, selectedId, creating, loadingList, automata, onSelect]);

  // The form follows the URL — a click, a Back, or a pasted link all land here.
  // Keyed on the id actually applied so refreshing the list mid-edit (a save, a
  // run) can't clobber what the user is typing.
  const appliedIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (creating || appliedIdRef.current === selectedId) return;
    const found = selectedId
      ? automata.find((automaton) => automaton.id === selectedId)
      : undefined;
    // The list is still loading — wait for it rather than applying a blank form
    // over a deep-linked automaton.
    if (selectedId && !found && loadingList) return;
    // A link to an automaton that's since been deleted: fall back to the list
    // rather than showing an editor for something that isn't there.
    if (selectedId && !found) {
      onSelect(null, "replace");
      return;
    }
    appliedIdRef.current = selectedId;
    applyForm(found ? formFromAutomaton(found) : EMPTY_FORM);
    setDetailError(null);
    // A different automaton is a different pane: open it on Configure rather
    // than dropping the user into a run history they didn't ask for.
    setDetailTab("configure");
    if (selectedId) fetchDetail(selectedId);
  }, [selectedId, automata, creating, loadingList, applyForm, fetchDetail, onSelect]);

  const openDetail = useCallback(
    (id: string) => {
      setCreating(false);
      onSelect(id, isDesktop ? "replace" : "push");
    },
    [isDesktop, onSelect],
  );

  const startNew = useCallback(() => {
    setCreating(true);
    appliedIdRef.current = undefined;
    applyForm(EMPTY_FORM);
    setDetailError(null);
    setDetailTab("configure");
    if (selectedId) onSelect(null, "replace");
  }, [applyForm, onSelect, selectedId]);

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

  const handleField = useCallback(
    <K extends keyof AutomatonFormState>(field: K, value: AutomatonFormState[K]) => {
      setForm((current) => ({ ...current, [field]: value }));
    },
    [],
  );

  const handleSave = useCallback(async () => {
    const name = form.name.trim();
    const prompt = form.prompt.trim();
    const timezone = form.timezone.trim();
    if (!name) {
      setDetailError("Give the automaton a name.");
      return;
    }
    if (!prompt) {
      setDetailError("Give the automaton something to do.");
      return;
    }
    if (!timezone) {
      setDetailError("Give the automaton a timezone.");
      return;
    }
    const overrideModel = form.modelProvider ? form.model.trim() : "";
    setBusy(true);
    setDetailError(null);
    const payload: CreateAutomatonInput = {
      name,
      prompt,
      schedule: scheduleFromForm(form),
      timezone,
      projectId: form.projectId === "none" ? null : form.projectId,
      agentId: form.agentId,
      enabled: form.enabled,
      notifyMode: form.notifyMode,
      // Half an override is no override: a provider with an empty model box
      // falls back to the agent's model rather than saving something unrunnable.
      ...(overrideModel
        ? {
            modelProvider: form.modelProvider,
            model: overrideModel,
            modelInputModalities: form.modelInputModalities,
          }
        : { modelProvider: null, model: null, modelInputModalities: null }),
    };
    // Split from the list re-read: an automaton the server saved must not be
    // reported as unsaved because the list would not reload — the form would
    // stay open over a row that already exists, and re-saving it collides.
    const result = await writeThenRefresh(
      () => (isCreatingView ? createAutomaton(payload) : updateAutomaton(selectedId!, payload)),
      refreshList,
      "Saved, but couldn't reload the automaton list.",
    );
    setBusy(false);
    if (!result.ok) {
      const message =
        result.error instanceof Error ? result.error.message : "Couldn't save the automaton.";
      setDetailError(message);
      toast.error(isCreatingView ? "Couldn't create automaton" : "Couldn't save automaton");
      return;
    }
    const saved = result.value;
    setCreating(false);
    appliedIdRef.current = saved.id;
    onSelect(saved.id, "replace");
    applyForm(formFromAutomaton(saved));
    fetchDetail(saved.id);
    toast.success(isCreatingView ? "Automaton created" : "Automaton saved");
  }, [applyForm, fetchDetail, form, isCreatingView, refreshList, selectedId]);

  const handleDelete = useCallback(async () => {
    if (!selectedId) return;
    setBusy(true);
    const result = await writeThenRefresh(
      () => archiveAutomaton(selectedId),
      refreshList,
      "Deleted, but couldn't reload the automaton list.",
    );
    setBusy(false);
    if (!result.ok) {
      toast.error(
        result.error instanceof Error ? result.error.message : "Couldn't delete the automaton.",
      );
      return;
    }
    setDetails((current) => {
      const next = { ...current };
      delete next[selectedId];
      return next;
    });
    setCreating(false);
    appliedIdRef.current = undefined;
    // Leaves no entry pointing at the deleted automaton: pops the detail entry
    // on mobile, replaces it on desktop (where it lands on the next one).
    onBackToList();
    toast.success("Automaton deleted");
  }, [onBackToList, refreshList, selectedId]);

  const handleToggleEnabled = useCallback(
    async (nextEnabled: boolean) => {
      if (!selectedId) return;
      setForm((current) => ({ ...current, enabled: nextEnabled }));
      try {
        const updated = await updateAutomaton(selectedId, { enabled: nextEnabled });
        setAutomata((current) => current.map((a) => (a.id === updated.id ? updated : a)));
        toast.success(nextEnabled ? "Automaton enabled" : "Automaton paused");
      } catch (error) {
        setForm((current) => ({ ...current, enabled: !nextEnabled }));
        toast.error(error instanceof Error ? error.message : "Couldn't update the automaton.");
      }
    },
    [selectedId],
  );

  const handleDismissRun = useCallback(
    async (threadId: string) => {
      if (!selectedId) return;
      try {
        await dismissThreadOutcome(threadId);
        fetchDetail(selectedId);
        void refreshList();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't dismiss this run.");
      }
    },
    [fetchDetail, refreshList, selectedId],
  );

  const handleRunNow = useCallback(
    async (id: string) => {
      setRunNowBusyId(id);
      try {
        const { threadId } = await runAutomatonNow(id);
        toast.success("Run started");
        // The run is started server-side regardless. Only follow the user to the
        // run thread if they are still waiting on this run — if they navigated
        // away or started another run while this was in flight, don't yank them.
        if (mountedRef.current && runNowBusyIdRef.current === id) {
          onOpenThread(threadId);
        }
        fetchDetail(id);
        void refreshList();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Couldn't run the automaton.");
      } finally {
        // Functional reset: a second run-now click may have already claimed
        // runNowBusyId for a different automaton by the time this settles.
        setRunNowBusyId((current) => (current === id ? null : current));
      }
    },
    [fetchDetail, onOpenThread, refreshList],
  );

  const selectedDetail = selectedId ? details[selectedId] : undefined;
  const selectedAutomaton = selectedId
    ? automata.find((automaton) => automaton.id === selectedId)
    : undefined;
  const runs = selectedDetail?.runs ?? [];
  const timeValue = `${pad(form.hour)}:${pad(form.minute)}`;
  // Creating hides the tab bar and the Runs pane, so the tab is forced rather
  // than trusted — a stale "runs" here would render an empty pane with no way
  // back to the form.
  const activeTab: DetailTab = isCreatingView ? "configure" : detailTab;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        {/* One back affordance: it always goes up exactly one level — to the list
            while drilled into a detail on mobile, to chats otherwise. */}
        <Button
          variant="ghost"
          size="icon"
          onClick={inMobileDetail ? backToList : onClose}
          aria-label={inMobileDetail ? "All automata" : closeLabel}
          title={inMobileDetail ? "All automata" : closeLabel}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm">Automata</div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[18rem_minmax(0,1fr)]">
        {showList && (
          <ScrollArea className="min-h-0 lg:border-border lg:border-r">
            <div className="flex items-center justify-between px-4 py-3">
              <span className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
                {loadingList
                  ? "Loading…"
                  : automata.length === 0
                    ? "No automata"
                    : automata.length === 1
                      ? "1 automaton"
                      : `${automata.length} automata`}
              </span>
              <Button size="sm" variant="outline" onClick={startNew}>
                <Plus aria-hidden />
                New
              </Button>
            </div>

            {!loadingList && automata.length === 0 && (
              <ListEmptyState icon={<ArrowsClockwise aria-hidden />}>
                An automaton runs a saved task on a schedule — a morning briefing, a weekly tidy-up
                — and files each run as a thread.
              </ListEmptyState>
            )}

            <div className="flex flex-col">
              {automata.map((automaton) => (
                <button
                  key={automaton.id}
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 border-border border-b px-4 py-3 text-left transition-colors",
                    isDesktop && automaton.id === selectedId && !creating
                      ? "bg-accent"
                      : "hover:bg-accent/60",
                  )}
                  onClick={() => openDetail(automaton.id)}
                >
                  <ArrowsClockwise
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-foreground text-sm">
                      {automaton.name}
                    </div>
                    <div className="mt-0.5 truncate text-muted-foreground text-xs">
                      {scheduleSummary(automaton)}
                    </div>
                    <div className="mt-1.5 flex items-center gap-2">
                      {automaton.lastRun ? (
                        <RunStatusChip status={automaton.lastRun.status} />
                      ) : (
                        <span className="text-muted-foreground text-xs">Never run</span>
                      )}
                      <span className="truncate text-muted-foreground text-xs">
                        {nextRunLabel(automaton)}
                      </span>
                    </div>
                  </div>
                  <CaretRight
                    aria-hidden
                    className="mt-1 size-4 shrink-0 text-muted-foreground lg:hidden"
                  />
                </button>
              ))}
            </div>
          </ScrollArea>
        )}

        {showDetail && (
          <Tabs
            value={activeTab}
            onValueChange={(value) => setDetailTab(value as DetailTab)}
            className="flex min-h-0 flex-col gap-0"
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 py-4 sm:px-6">
                {detailError && (
                  <Alert variant="destructive">
                    <AlertDescription>{detailError}</AlertDescription>
                  </Alert>
                )}

                {!isCreatingView && selectedAutomaton?.disabledReason && (
                  <Alert>
                    <AlertDescription>
                      Disabled: {selectedAutomaton.disabledReason}
                    </AlertDescription>
                  </Alert>
                )}

                <div className="flex items-start justify-between gap-3">
                  <DetailHeading
                    eyebrow="Automaton"
                    title={
                      isCreatingView ? "New automaton" : form.name.trim() || "Untitled automaton"
                    }
                  />
                  {!isCreatingView && selectedId && (
                    <div className="flex shrink-0 items-center gap-2">
                      <Switch
                        checked={form.enabled}
                        onCheckedChange={(checked) => void handleToggleEnabled(checked)}
                        aria-label="Enabled"
                      />
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => void handleRunNow(selectedId)}
                        disabled={runNowBusyId === selectedId}
                      >
                        {runNowBusyId === selectedId ? (
                          <Spinner className="size-4" />
                        ) : (
                          <Play aria-hidden />
                        )}
                        Run now
                      </Button>
                    </div>
                  )}
                </div>

                {!isCreatingView && (
                  <TabsList className="w-full sm:w-fit">
                    <TabsTrigger value="configure" className="sm:px-4">
                      Configure
                    </TabsTrigger>
                    <TabsTrigger value="runs" className="sm:px-4">
                      Runs
                    </TabsTrigger>
                  </TabsList>
                )}

                <TabsContent value="configure" className="flex flex-none flex-col gap-4">
                  <FormCard title="Task" description="What this automaton does each time it runs.">
                    <Field label="Name" htmlFor="automaton-name">
                      <Input
                        id="automaton-name"
                        value={form.name}
                        onChange={(event) => handleField("name", event.target.value)}
                        placeholder="e.g. Daily briefing"
                      />
                    </Field>
                    <Field
                      label="Prompt"
                      htmlFor="automaton-prompt"
                      hint="Sent as the first message of every run, as if you had typed it."
                    >
                      <Textarea
                        id="automaton-prompt"
                        rows={4}
                        value={form.prompt}
                        onChange={(event) => handleField("prompt", event.target.value)}
                        placeholder="What should Nadi do each time this runs?"
                      />
                    </Field>
                  </FormCard>

                  <FormCard title="Schedule" description="When it runs, in the timezone you pick.">
                    {form.cronExpr.trim() ? (
                      <p className="text-muted-foreground text-sm">
                        Using the custom cron expression below — clear it to pick a repeat and time
                        instead.
                      </p>
                    ) : (
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Repeat" htmlFor="automaton-repeat">
                          <Select
                            value={form.repeat}
                            onValueChange={(value) => {
                              const repeat = value as RepeatKind;
                              setForm((current) => ({
                                ...current,
                                repeat,
                                ...(repeat === "once" && !current.onceDate
                                  ? { onceDate: defaultOnceDate(current.timezone) }
                                  : {}),
                                ...(repeat === "once" ? { cronExpr: "" } : {}),
                              }));
                            }}
                          >
                            <SelectTrigger id="automaton-repeat" className="w-full">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="hourly">Hourly</SelectItem>
                              <SelectItem value="daily">Daily</SelectItem>
                              <SelectItem value="weekdays">Weekdays</SelectItem>
                              <SelectItem value="weekly">Weekly</SelectItem>
                              <SelectItem value="once">Once</SelectItem>
                            </SelectContent>
                          </Select>
                        </Field>
                        {form.repeat === "weekly" && (
                          <Field label="Day" htmlFor="automaton-weekday">
                            <Select
                              value={String(form.weekday)}
                              onValueChange={(value) => handleField("weekday", Number(value))}
                            >
                              <SelectTrigger id="automaton-weekday" className="w-full">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {WEEKDAY_OPTIONS.map((label, value) => (
                                  <SelectItem key={label} value={String(value)}>
                                    {label}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </Field>
                        )}
                        {form.repeat === "hourly" ? (
                          <Field label="Minute" htmlFor="automaton-minute" hint="0–59">
                            <Input
                              id="automaton-minute"
                              type="number"
                              min={0}
                              max={59}
                              value={form.minute}
                              onChange={(event) =>
                                handleField(
                                  "minute",
                                  Math.min(59, Math.max(0, Number(event.target.value) || 0)),
                                )
                              }
                              {...monoFieldProps}
                            />
                          </Field>
                        ) : form.repeat === "once" ? (
                          <>
                            <Field label="Date" htmlFor="automaton-once-date">
                              <Input
                                id="automaton-once-date"
                                type="date"
                                value={form.onceDate}
                                onChange={(event) => handleField("onceDate", event.target.value)}
                                {...monoFieldProps}
                              />
                            </Field>
                            <Field label="At" htmlFor="automaton-time">
                              <Input
                                id="automaton-time"
                                type="time"
                                value={timeValue}
                                onChange={(event) => {
                                  const parsed = parseTimeInput(event.target.value);
                                  if (!parsed) return;
                                  setForm((current) => ({
                                    ...current,
                                    hour: parsed.hour,
                                    minute: parsed.minute,
                                  }));
                                }}
                                {...monoFieldProps}
                              />
                            </Field>
                          </>
                        ) : (
                          <Field label="At" htmlFor="automaton-time">
                            <Input
                              id="automaton-time"
                              type="time"
                              value={timeValue}
                              onChange={(event) => {
                                const parsed = parseTimeInput(event.target.value);
                                if (!parsed) return;
                                setForm((current) => ({
                                  ...current,
                                  hour: parsed.hour,
                                  minute: parsed.minute,
                                }));
                              }}
                              {...monoFieldProps}
                            />
                          </Field>
                        )}
                      </div>
                    )}
                    <Field
                      label="Timezone"
                      htmlFor="automaton-timezone"
                      hint="Runs follow local wall-clock time across daylight saving changes."
                    >
                      <Input
                        id="automaton-timezone"
                        value={form.timezone}
                        onChange={(event) => handleField("timezone", event.target.value)}
                        {...monoFieldProps}
                      />
                    </Field>

                    {form.repeat !== "once" && (
                      <details
                        className="rounded-md border border-border"
                        open={advancedOpen}
                        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
                      >
                        <summary className="cursor-pointer px-3 py-2 text-muted-foreground text-xs">
                          Advanced
                        </summary>
                        <div className="border-border border-t p-3">
                          <Field
                            label="Cron expression"
                            htmlFor="automaton-cron"
                            hint="Overrides the repeat and time above."
                          >
                            <Input
                              id="automaton-cron"
                              placeholder="0 8 * * 1-5"
                              value={form.cronExpr}
                              onChange={(event) => handleField("cronExpr", event.target.value)}
                              {...monoFieldProps}
                            />
                          </Field>
                        </div>
                      </details>
                    )}
                  </FormCard>

                  <FormCard
                    title="Scope"
                    description="Optional. A scoped automaton inherits the project's instructions."
                  >
                    <Field label="Project" htmlFor="automaton-project">
                      <Select
                        value={form.projectId}
                        onValueChange={(value) => handleField("projectId", value)}
                      >
                        <SelectTrigger id="automaton-project" className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">No project</SelectItem>
                          {projects.map((project) => (
                            <SelectItem key={project.id} value={project.id}>
                              {project.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                    <Field
                      label="Agent"
                      htmlFor="automaton-agent"
                      hint="Inherit from project uses the project's default agent; an agent here overrides it."
                    >
                      <AgentOverridePicker
                        value={form.agentId}
                        agents={agents}
                        inheritLabel="Inherit from project"
                        selectedName={
                          agents.find((agent) => agent.id === form.agentId)?.name ?? undefined
                        }
                        onValueChange={(next) => handleField("agentId", next)}
                        // No "Manage agents" link here: Settings navigation
                        // isn't threaded into this panel, and the picker's prop is
                        // optional — omitting it hides the row rather than showing
                        // a dead affordance.
                        disabled={busy}
                      />
                    </Field>
                  </FormCard>

                  <FormCard
                    title="Model"
                    description="Which model this automaton runs on each time it fires."
                  >
                    <Field
                      label="Model"
                      htmlFor="automaton-model"
                      hint={
                        form.modelProvider
                          ? undefined
                          : "Follows the workspace agent's model, including any later change to it."
                      }
                      action={
                        form.modelProvider ? (
                          <button
                            type="button"
                            className="text-muted-foreground text-xs underline-offset-2 transition-colors hover:text-foreground hover:underline"
                            onClick={() =>
                              setForm((f) => ({
                                ...f,
                                modelProvider: null,
                                model: "",
                                modelInputModalities: ["text"],
                              }))
                            }
                          >
                            Use agent default
                          </button>
                        ) : null
                      }
                    >
                      <ModelPicker
                        variant="field"
                        triggerId="automaton-model"
                        triggerLabel="Automaton model"
                        // "OpenAI · Agent default (gpt-5.5)" would read as a pinned
                        // provider; with no override there is none to name.
                        hideProviderPrefix={!form.modelProvider}
                        providers={providers.map((entry) => ({
                          value: entry.provider,
                          label: entry.displayName,
                          whitelistModels: entry.whitelistModels ?? null,
                        }))}
                        // With no override the picker still needs a provider to open
                        // on; the agent's is the honest starting point.
                        provider={
                          form.modelProvider ?? (providers[0]?.provider as SettingsProvider)
                        }
                        model={
                          form.modelProvider
                            ? form.model
                            : agentModel
                              ? `Agent default (${agentModel})`
                              : "Agent default"
                        }
                        placeholder={
                          form.modelProvider
                            ? SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[form.modelProvider]
                            : "Agent default"
                        }
                        onProviderChange={(provider) =>
                          setForm((f) => ({
                            ...f,
                            modelProvider: provider,
                            model: "",
                            modelInputModalities: ["text"],
                          }))
                        }
                        onModelChange={(model) => handleField("model", model)}
                        onModelSelected={(picked) =>
                          setForm((f) => ({
                            ...f,
                            // A single-provider workspace skips the picker's provider
                            // step, so onProviderChange never fires — pin the provider
                            // on selection or the override would save as half-set.
                            modelProvider: f.modelProvider ?? providers[0]?.provider ?? null,
                            model: picked.id,
                            modelInputModalities: picked.inputModalities,
                          }))
                        }
                      />
                    </Field>
                  </FormCard>

                  <FormCard
                    title="Notifications"
                    description="How this automaton alerts you when it runs."
                  >
                    <Field label="When to notify">
                      <Select
                        value={form.notifyMode}
                        onValueChange={(v) =>
                          setForm((f) => ({
                            ...f,
                            notifyMode: v as AutomatonFormState["notifyMode"],
                          }))
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">All activity</SelectItem>
                          <SelectItem value="failures_only">
                            Only failures &amp; when it needs me
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-muted-foreground text-xs">
                        Failures-only also hides successful runs from the sidebar; they stay in the
                        Runs tab.
                      </p>
                    </Field>
                  </FormCard>
                </TabsContent>

                {/* The tab already says "Runs", so this pane leads with what a run
                    IS rather than repeating the word in a card header. */}
                <TabsContent value="runs" className="flex flex-none flex-col gap-3">
                  <p className="text-muted-foreground text-sm">
                    Each run opens as a thread you can follow up in.
                  </p>
                  {!selectedDetail ? (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm">
                      <Spinner className="size-4" label="Loading runs" />
                      Loading
                    </div>
                  ) : runs.length === 0 ? (
                    <ListEmptyState icon={<Clock aria-hidden />}>
                      No runs yet. This automaton files one here every time it fires — or use Run
                      now to start one.
                    </ListEmptyState>
                  ) : (
                    <div className="overflow-hidden rounded-lg border border-border bg-card">
                      {runs.map((run) => {
                        const duration = formatRunDuration(run);
                        const hasThread = run.threadId != null;
                        return (
                          <div
                            key={run.id}
                            className="flex items-start gap-3 border-border border-b px-4 py-2.5 last:border-b-0"
                          >
                            <div className="w-28 shrink-0 pt-0.5">
                              <RunStatusChip status={run.status} />
                            </div>
                            {/* The note explains a failure or a skip, so it wraps rather
                                than truncating — it is the most useful text in the row. */}
                            <div className="min-w-0 flex-1">
                              <div className="flex flex-wrap items-baseline gap-x-2">
                                <span className="text-foreground text-xs">
                                  {formatRunStarted(run)}
                                </span>
                                {duration && (
                                  <span className="font-mono text-muted-foreground text-xs">
                                    {duration}
                                  </span>
                                )}
                              </div>
                              {run.error && (
                                <div className="text-muted-foreground text-xs">{run.error}</div>
                              )}
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                              {(run.status === "failed" || run.status === "waiting_for_approval") &&
                                run.threadId && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => void handleDismissRun(run.threadId!)}
                                  >
                                    Dismiss
                                  </Button>
                                )}
                              {hasThread ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => onOpenThread(run.threadId!)}
                                >
                                  Open
                                </Button>
                              ) : (
                                <span className="px-3 py-1 text-muted-foreground text-xs">
                                  No thread
                                </span>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </TabsContent>
              </div>
            </ScrollArea>

            {/* The form is long enough to scroll past its own actions, so they sit
                on a bar pinned to the bottom of the pane instead. Runs is
                read-only, so it has nothing for this bar to do. */}
            {activeTab === "configure" && (
              <PaneFooter className="shrink-0">
                <FormActions>
                  {!isCreatingView && (
                    <Button
                      variant="outline"
                      className={FORM_ACTION_BUTTON}
                      onClick={() => void handleDelete()}
                      disabled={busy}
                    >
                      <Trash aria-hidden />
                      Delete
                    </Button>
                  )}
                  <Button
                    className={FORM_ACTION_BUTTON}
                    onClick={() => void handleSave()}
                    disabled={busy}
                  >
                    {busy ? <Spinner className="size-4" /> : null}
                    {isCreatingView ? "Create automaton" : "Save automaton"}
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
