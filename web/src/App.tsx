/**
 * Nadi — mobile-first chat SPA
 *
 * Uses Agents SDK client hooks, behind the seam in `thread-chat-seam.ts`:
 *   useAgent       from "agents/react"
 *   useAgentChat   from "@cloudflare/think/react"
 *
 * Auth assumption (MVP):
 *   The Worker gates /agents/* on a session cookie (NT3 Better Auth).
 *   For production the SPA is served from the same origin as the Worker,
 *   so the session cookie is automatically present.
 *   For local dev with cross-origin (Vite on :5173, Worker on :8787):
 *     1. Set VITE_AGENT_HOST=http://localhost:8787 in web/.env.local
 *     2. Uncomment the `host` option in `useThreadAgent` (thread-chat-seam.ts)
 *     3. The Worker must CORS-allow the Vite origin for WebSocket upgrade
 */

import {
  Suspense,
  createContext,
  lazy,
  use,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { CSSProperties } from "react";
import type { FileUIPart, UIMessage } from "ai";
import { applyArchivedCompactions } from "./lib/archived-compaction";
import { peekAutomatonNudge, takeAutomatonNudge } from "./lib/automaton-nudge";
import {
  backToHere,
  cameFrom,
  canStepBack,
  closeLabel,
  nextRouteState,
  readBackTo,
} from "./lib/app-history";
import { useLeftEdgeDrawerDrag } from "./lib/use-edge-swipe";
import { useProgressiveList } from "./lib/use-progressive-list";

/** The rail's width — shared by the pinned sidebar, the drawer, and the drag. */
const RAIL_WIDTH_PX = 288; // w-72
// How often to re-probe /api/bootstrap while the server is not known reachable.
const REPROBE_INTERVAL_MS = 15_000;
import { pushPath, replacePath } from "./lib/panel-navigation";
import { type PanelKind, panelListPath, panelPath, parsePanelRoute } from "./lib/panel-routes";
import {
  isSettingsPath,
  parseSettingsTab,
  settingsPath,
  takeMcpReturnPath,
  type SettingsTab,
} from "./lib/settings-routes";
import { toast } from "sonner";
import {
  getSession,
  requestEmailOtp,
  signInWithEmailOtp,
  signOut,
  SignInNotAllowedError,
  type AuthSession,
} from "./auth-api";
import {
  claimInvite,
  listInvites,
  previewInvite,
  type InvitePreview,
  type InviteQuota,
} from "./invites-api";
import { useDocumentTitle } from "./lib/use-document-title";
import { DEFAULT_APP_NAME, getBootstrap } from "./bootstrap-api";
import {
  purgeCachedBootstrap,
  readCachedBootstrap,
  writeCachedBootstrap,
} from "./lib/bootstrap-cache";
import { maybeRenewSession } from "./lib/session-renewal";
import { isNetworkFailure, type Reachability } from "./lib/offline-state";
import { resolveRefreshedThreadsPage } from "./lib/thread-refresh";
import { fetchThreadHistory, fetchThreadHistoryDetailed } from "./lib/thread-history-fetch";
import { purgeCachedHistory, writeCachedHistory } from "./lib/thread-history-cache";
import { shouldPersistSettledMessages } from "./lib/thread-history-cache-policy";
import { OfflineProvider, useOffline } from "./lib/use-offline";
import { ProjectPicker } from "./components/projects/ProjectPicker";
import { WorkbenchPicker } from "./components/workbenches/WorkbenchPicker";
import { AutomataPanel } from "./components/automata/AutomataPanel";
import { InvitesPanel } from "./components/invites/InvitesPanel";
import { ProjectsPanel } from "./components/projects/ProjectsPanel";
// Route-level splits: Settings and Onboarding are full-screen panels the large
// majority of sessions never open, so they load on demand behind Suspense.
const Settings = lazy(() => import("./Settings").then((m) => ({ default: m.Settings })));
const Onboarding = lazy(() => import("./Onboarding").then((m) => ({ default: m.Onboarding })));
const Landing = lazy(() => import("./landing/Landing").then((m) => ({ default: m.Landing })));
const FeedbackInbox = lazy(() =>
  import("./components/feedback/FeedbackInbox").then((m) => ({ default: m.FeedbackInbox })),
);
import {
  getDefaultAgentSettings,
  isSettingsProvider,
  type AgentSettingsResponse,
  type ModelInputModality,
  type ProviderModelSearchResult,
  type ProviderSettingsView,
  type ReasoningControl,
  type ReasoningEffort,
  type SettingsProvider,
} from "./settings-api";
import { getUserPreferences } from "./user-preferences-api";
import { deriveNeedsOnboarding, isOnboardingForced, parseOnboardingStep } from "./lib/onboarding";
import { detectInstallPlatform } from "./lib/install-platform";
import {
  compactThread as compactThreadApi,
  archiveThread as archiveThreadApi,
  deleteThread as deleteThreadApi,
  getThreadCompactionStatus,
  getThreadOrNull,
  listThreads,
  markThreadSeen,
  moveThreadToProject,
  renameThread,
  setThreadRecentDismissed,
  switchThreadWorkbench,
  updateThreadReasoningEffort,
  type ThreadSummary,
  fetchArchivedSummaries,
} from "./threads-api";
import { createProject, listProjects, type ProjectSummary } from "./projects-api";
import { listWorkbenches, type WorkbenchSummary } from "./workbenches-api";
import {
  getBrowserNotifications,
  saveBrowserPushSubscription,
  updateBrowserNotificationSettings,
  type BrowserNotificationsResponse,
} from "./notifications-api";
import {
  FeedbackRateLimitError,
  getOrCreateFeedbackThread,
  sendFeedbackMessage,
  submitFeedbackDraft,
  type FeedbackDiagnostics,
  type FeedbackDraftView,
} from "./feedback-api";
import { historyFetchTargetForThread, isReadOnlyThread } from "./thread-runtime-routing";
import {
  useRealThreadChat,
  useThreadAgent,
  type ThreadAgent,
  type ThreadChatApi,
} from "./thread-chat-seam";
import {
  ArrowLeft,
  ArrowsClockwise,
  ChatCircle,
  Gear,
  SignOut,
  Plus,
  List,
  MagnifyingGlass,
  CaretRight,
  DotsThree,
  DotsThreeVertical,
  Archive,
  Eye,
  Trash,
  Robot,
  UserPlus,
  FolderSimple,
  X,
  Bell,
  BellRinging,
  WifiSlash,
  XCircle,
} from "./icons";
import { BrandMark } from "./components/BrandMark";
import { ThreadHistoryErrorBoundary } from "./components/ThreadHistoryErrorBoundary";
import { threadHistoryKey, useThreadHistoryPromise } from "./lib/thread-history";
// ChatLog is the sole gateway into the streamdown + Shiki message-rendering
// stack (the single largest slice of the old index chunk). Split it so the app
// shell — sidebar, composer, empty state — paints without it; ConversationSkeleton
// is the Suspense fallback, matching how threads load elsewhere.
const ChatLog = lazy(() =>
  import("./components/chat/ChatLog").then((m) => ({ default: m.ChatLog })),
);
import { ConversationSkeleton } from "./components/chat/ConversationSkeleton";
import { ConversationFallback } from "./components/chat/ConversationFallback";
import { Composer, type ComposerHandle } from "./components/chat/Composer";
import { NEW_CHAT_SUGGESTIONS, PromptSuggestions } from "./components/chat/PromptSuggestions";
import { ThreadArtifactsSheet } from "./components/chat/ThreadArtifactsSheet";
import { ThreadDetailsSheet } from "./components/chat/ThreadDetailsSheet";
import { ThreadHeaderMenu } from "./components/chat/ThreadHeaderMenu";
import { ThreadIndicator } from "./components/chat/ThreadIndicator";
import { ShowMoreRow } from "./components/chat/ShowMoreRow";
import { ThreadNavButton } from "./components/chat/ThreadNavButton";
import { railToggleIndicator } from "./components/chat/ThreadIndicator";
import { ThreadRowMenu } from "./components/chat/ThreadRowMenu";
import { PendingFirstMessage, PendingReplyDots } from "./components/chat/PendingFirstMessage";
import { PendingThreadConversation } from "./components/chat/PendingThreadConversation";
import {
  isRetryable,
  needsFirstMessageResync,
  pendingForThread,
  settled,
  shouldSettleFirstMessage,
  withStatus,
  type PendingFirstMessage as PendingFirstMessageState,
} from "./lib/pending-first-message";
import { QueuedMessageStrip } from "./components/chat/QueuedMessageStrip";
import { ATTACHMENT_ACCEPT } from "./lib/attachment-accept";
import { buildUploadAttachments, compressToDataUrlAttachments } from "./lib/attachment-upload";
import { cn } from "./lib/utils";
import { bindWorkspace, resetPostHog, setPostHogConsent, track } from "./lib/posthog";
import { usePostHogPrivacySync } from "./lib/use-posthog-privacy-sync";
import {
  canUseWorkspaceTelemetry,
  deriveInitialConsentWorkspaceId,
} from "./lib/workspace-telemetry";
import {
  displayableQueuedMessages,
  mergeQueuedMessages,
  type QueuedMessage,
} from "./lib/queued-messages";
import { SteeringMessageStrip } from "./components/chat/SteeringMessageStrip";
import {
  activeSteeringMessages,
  addSteer,
  deriveSteeringChips,
  removeSteer,
  withCancelling,
  type SteeringChip,
  type SteeringMessage,
} from "./lib/steering-messages";
import { usePendingSteers } from "./lib/use-pending-steers";
import { useToolServers } from "./lib/use-tool-servers";
import { useSubagentEvents } from "./lib/use-subagent-events";
import { useBackgroundWork } from "./lib/use-background-work";
import { subagentResultsByRunId } from "./lib/completion-line";
import { BackgroundTasksRow } from "./components/chat/BackgroundTasksRow";
import { BackgroundTasksSheet } from "./components/chat/BackgroundTasksSheet";
import { FeedbackDraftCard } from "./components/feedback/FeedbackDraftCard";
import { FeedbackFallbackForm } from "./components/feedback/FeedbackFallbackForm";
import { collectFeedbackDiagnostics } from "./lib/feedback-diagnostics";
import { markFeedbackDraftSubmitted, submittedFeedbackDraftIds } from "./lib/feedback-ui-state";
import { useOnResume, useAgentConnectionRecovery } from "./lib/use-connection-recovery";
import { shouldRecoverOnResume } from "./lib/connection-recovery";
import { useSocketConnected } from "./lib/use-socket-connected";
import { computeThreadReadiness } from "./lib/thread-readiness";
import { debounce } from "./lib/debounce";
import { useWideLayout } from "./lib/use-wide-layout";
import { useFinePointer } from "./lib/use-fine-pointer";
import { LONG_PRESS_MS, useLongPress } from "./lib/use-long-press";
import { isCompactCommand } from "./lib/composer-submit";
import {
  canStartNewChat,
  deriveNewChatModelState,
  emptyNewChatModelState,
  selectNewChatModelModalities,
  selectNewChatModelReasoning,
  selectNewChatProvider,
  typeNewChatModel,
} from "./lib/new-chat-model";
import {
  availableEffortOptions,
  dialModelFor,
  reasoningControlsForThreadModel,
  shouldOfferEffortControl,
} from "./lib/reasoning-effort";
import { EffortDial } from "./components/model/EffortDial";
import {
  manualCompactionNoticeForResult,
  parseCompactionSessionEvent,
  runManualThreadCompaction,
  shouldApplyCompactionStatus,
  shouldQueueSubmitForThreadState,
  type CompactionNotice,
} from "./lib/thread-compaction";
import { applyUserEvent, mergeThreadsExcluding, parseUserEvent } from "./lib/thread-events";
import { removeThreadsFromCachedBootstrap } from "./lib/bootstrap-cache";
import { findInactiveThreadIds } from "./lib/thread-reconciliation";
import { useThreadQuery } from "./lib/use-thread-query";
import { hasOlderChats, isSearchEmpty } from "./lib/rail-search";
import { isThreadListEmpty, THREAD_PAGE_SIZE } from "./lib/thread-list-state";
import { shouldMarkThreadSeen } from "./lib/thread-seen";
import {
  claimPendingThreadNavigation,
  clearPendingThreadNavigation,
} from "./lib/pending-navigation";
import {
  EMPTY_NOTICE_STATE,
  type ThreadNoticeState,
  threadActivityNotice,
  threadNoticeState,
} from "./lib/thread-activity-notice";
import { showThreadActivityToast } from "./lib/thread-activity-toast";
/**
 * How long after a launch or a resume to keep looking for a notification tap's
 * target thread. Covers the worker waking up after the page does — the resume
 * ordering — without polling indefinitely.
 */
const CLAIM_RETRY_DELAYS_MS = [250, 750, 1_500, 3_000, 5_000];
import {
  SIDEBAR_RECENT_THREAD_LIMIT,
  sidebarRailThreads,
  visibleRailThreads,
} from "./lib/thread-dismissal";
import { awaitsAssistantReply, isConversationComplete } from "./lib/message-state";
import { mergeResyncedHistory } from "./lib/history-merge";
/** How long a thread may promise an inbound reply with nothing to show for it. */
const PENDING_REPLY_WINDOW_MS = 5_000;
import { threadMatchesProjectFilter, type ProjectThreadFilter } from "./lib/project-thread-filter";
import { openUserHubSocket, setUserHubPresence } from "./lib/user-hub-socket";
import { isUserActive, trackUserActivity } from "./lib/user-activity";
import {
  createNewThread,
  liveNewThreadSendPort,
  uploadAndSendFirstMessage,
} from "./lib/new-thread-send";
import {
  classifyBrowserNotificationSupport,
  ensurePushSubscription,
  getExistingPushSubscription,
  recoverPushSubscription,
} from "./lib/browser-notifications";
import { Button } from "./components/ui/button";
import { ButtonGroup } from "./components/ui/button-group";
import { Input } from "./components/ui/input";
import { Label } from "./components/ui/label";
import { Alert, AlertDescription } from "./components/ui/alert";
import { ModelPicker } from "./components/model/ModelPicker";
import { ThreadModelBadge } from "./components/model/ThreadModelBadge";
import { ComposerModelPicker, type ModelTuple } from "./components/model/ComposerModelPicker";
import { toModelPickerProviders } from "./lib/model-picker";
import {
  buildModelSwitchMetadata,
  type PendingModelSwitchValue,
} from "./lib/model-switch-metadata";
import { Spinner } from "./components/ui/spinner";
import { ScrollArea } from "./components/ui/scroll-area";
import { Separator } from "./components/ui/separator";
import { Skeleton } from "./components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "./components/ui/sheet";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/ui/alert-dialog";
import { Badge } from "./components/ui/badge";
import { SETTINGS_PROVIDER_MODEL_PLACEHOLDERS } from "./settings-ui-config";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";

// ------------------------------------------------------------------ //
// Shared chrome                                                       //
// ------------------------------------------------------------------ //

/** The signed-in heartbeat / activity light. Green (--approve) when active. */
function StatusDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "size-2 shrink-0 rounded-full transition-colors",
        active
          ? "bg-approve shadow-[0_0_0_3px_color-mix(in_srgb,var(--approve)_22%,transparent)]"
          : "bg-muted-foreground/40",
      )}
      role="status"
      aria-label={label}
      title={label}
    />
  );
}

/** Topbar shell — back/menu slot + brand wordmark + breadcrumb + right actions. */
function Topbar({
  leading,
  breadcrumb,
  actions,
}: {
  leading?: ReactNode;
  breadcrumb: ReactNode;
  actions?: ReactNode;
}) {
  const offline = useOffline();
  return (
    // The shell pads itself out of the safe area, but this bar is chrome: its
    // surface should still reach the screen edge. So it escapes that padding by
    // exactly the inset and re-applies it to its own content — full-bleed card,
    // controls clear of the notch.
    //
    // It escapes only the edges it actually touches. On `wide` the pinned rail
    // owns the left edge and already sits inside the shell's padding, so the
    // left escape is reset there — otherwise the bar would overlap the rail by
    // the inset. No shipping device is both `wide` and notched, so this is
    // correctness by construction rather than by coincidence.
    <header className="-ml-[env(safe-area-inset-left)] -mr-[env(safe-area-inset-right)] flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card pl-[calc(0.75rem+env(safe-area-inset-left))] pr-[calc(0.75rem+env(safe-area-inset-right))] wide:ml-0 wide:pl-3">
      {leading}
      <div className="flex min-w-0 flex-1 items-baseline gap-2 text-muted-foreground text-sm">
        {breadcrumb}
      </div>
      {offline && (
        <span
          role="status"
          aria-label="Offline — you can read, but not make changes"
          title="Offline — you can read, but not make changes"
          className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-muted px-2 py-1 text-muted-foreground text-xs"
        >
          <WifiSlash aria-hidden className="size-3.5 shrink-0" />
          <span className="hidden sm:inline">Offline</span>
        </span>
      )}
      {actions}
    </header>
  );
}

function ProjectThreadFilterSelect({
  value,
  projects,
  onValueChange,
  disabled,
}: {
  value: ProjectThreadFilter;
  projects: ProjectSummary[];
  onValueChange: (value: ProjectThreadFilter) => void;
  disabled?: boolean;
}) {
  return (
    <Select value={value} onValueChange={(next) => onValueChange(next)} disabled={disabled}>
      <SelectTrigger className="w-full min-w-0 gap-2">
        <FolderSimple aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <SelectValue placeholder="All chats" />
      </SelectTrigger>
      <SelectContent align="start">
        <SelectItem value="all">All chats</SelectItem>
        <SelectItem value="unassigned">Unassigned</SelectItem>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ThreadProjectBadge({ thread }: { thread: Pick<ThreadSummary, "projectName"> }) {
  if (!thread.projectName) return null;
  return (
    <Badge variant="outline" className="max-w-full gap-1 overflow-hidden">
      <FolderSimple aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{thread.projectName}</span>
    </Badge>
  );
}

function ThreadAutomatonBadge({ thread }: { thread: Pick<ThreadSummary, "automatonName"> }) {
  if (!thread.automatonName) return null;
  return (
    <Badge variant="outline" className="max-w-full gap-1 overflow-hidden">
      <ArrowsClockwise aria-hidden className="size-3 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate">{thread.automatonName}</span>
    </Badge>
  );
}

// ------------------------------------------------------------------ //
// Sign-in gate                                                        //
// ------------------------------------------------------------------ //

const INVITE_TOKEN_KEY = "nadi.inviteToken";

/**
 * Invite links are `/invite/<token>`. Pull the token out on first paint, keep it
 * in sessionStorage, and clean the URL so a refresh doesn't replay it.
 */
function takeInviteToken(): string | null {
  if (typeof sessionStorage === "undefined") return null;
  const fromUrl = window.location.pathname.match(/^\/invite\/([^/]+)\/?$/)?.[1];
  if (fromUrl) {
    sessionStorage.setItem(INVITE_TOKEN_KEY, fromUrl);
    window.history.replaceState(null, "", "/");
    return fromUrl;
  }
  return sessionStorage.getItem(INVITE_TOKEN_KEY);
}

/**
 * Is an invite waiting to be redeemed? Read-only twin of {@link takeInviteToken}
 * — the routing gate has to ask this *before* AuthGate mounts, and must not
 * consume the token or rewrite the URL by doing so. Someone arriving on an
 * invite link is here to accept it, so they go straight to the gate and never
 * see the landing page.
 */
function hasPendingInvite(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  if (/^\/invite\/[^/]+\/?$/.test(window.location.pathname)) return true;
  return sessionStorage.getItem(INVITE_TOKEN_KEY) !== null;
}

function AuthGate({ onSignedIn }: { onSignedIn: (session: AuthSession) => void }) {
  const [email, setEmail] = useState("");
  const [otp, setOtp] = useState("");
  const [step, setStep] = useState<"email" | "otp">("email");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteToken] = useState<string | null>(takeInviteToken);
  const [invite, setInvite] = useState<InvitePreview | null>(null);
  // The email we put on the waiting list, if that's how this ended.
  const [waitlisted, setWaitlisted] = useState<string | null>(null);

  useEffect(() => {
    if (!inviteToken) return;
    void previewInvite(inviteToken)
      .then(setInvite)
      .catch(() => setInvite({ valid: false }));
  }, [inviteToken]);

  const submitEmail = useCallback(async () => {
    const trimmed = email.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);

    // Bind the invite to this email first, so the OTP gate lets it through. A
    // link already claimed by this same email is a no-op, so retries work.
    if (inviteToken && invite?.valid) {
      try {
        await claimInvite(inviteToken, trimmed);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not accept that invite.");
        setBusy(false);
        return;
      }
    }

    try {
      await requestEmailOtp(trimmed);
      sessionStorage.removeItem(INVITE_TOKEN_KEY);
      setStep("otp");
    } catch (err) {
      // Joining the waiting list arrives as a 403, because there is no code to
      // send — but it is what we asked this person to do, so it gets a
      // confirmation, not an error. Everything else here really is a failure.
      if (err instanceof SignInNotAllowedError && err.waitlisted) {
        setWaitlisted(trimmed);
        return;
      }
      // The gate's other 403 message is written for the user (the inviter is out
      // of invites) — show it verbatim.
      setError(
        err instanceof SignInNotAllowedError ? err.message : "Could not send a sign-in code.",
      );
    } finally {
      setBusy(false);
    }
  }, [busy, email, invite, inviteToken]);

  const submitOtp = useCallback(async () => {
    const trimmedEmail = email.trim();
    const trimmedOtp = otp.trim();
    if (!trimmedEmail || !trimmedOtp || busy) return;
    setBusy(true);
    setError(null);
    try {
      await signInWithEmailOtp({ email: trimmedEmail, otp: trimmedOtp });
      onSignedIn(await getSession());
    } catch {
      setError("Could not verify that code.");
    } finally {
      setBusy(false);
    }
  }, [busy, email, onSignedIn, otp]);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (step === "email") void submitEmail();
    else void submitOtp();
  };

  // The stranger's path ends here, and it ended the way we asked it to. No form
  // to retry, no red: the next move is ours, so say so and say who we'll write to.
  if (waitlisted !== null) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background p-6">
        <main className="w-full max-w-sm" aria-label="Waiting list">
          <div className="flex items-center gap-2">
            <span className="font-display font-semibold text-2xl">nadi</span>
            <span className="rounded-full border border-border px-2 py-0.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
              Beta
            </span>
          </div>
          <div className="mt-8 space-y-1">
            <p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
              Waiting list
            </p>
            <h1 className="font-display font-semibold text-3xl">You’re on the list.</h1>
          </div>
          <p className="mt-4 border-primary border-l-2 pl-3 text-muted-foreground text-sm">
            Nadi is in private beta, so it’s invite-only for now. We’ll write to{" "}
            <span className="text-foreground">{waitlisted}</span> when there’s room.
          </p>
          <p className="mt-4 text-muted-foreground text-xs">
            If someone you know is already here, an invite from them gets you in sooner.{" "}
            <a href="/about" className="underline underline-offset-2 hover:text-foreground">
              What is Nadi?
            </a>
          </p>
        </main>
      </div>
    );
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <main className="w-full max-w-sm" aria-label="Sign in">
        <div className="flex items-center gap-2">
          <span className="font-display font-semibold text-2xl">nadi</span>
          <span className="rounded-full border border-border px-2 py-0.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
            Beta
          </span>
        </div>
        {invite?.valid ? (
          // Arriving from an invite link, the page's job isn't "sign in" — it's
          // "someone vouched for you." Lead with that rather than boxing it in
          // an alert.
          <>
            <div className="mt-8 space-y-1">
              <p className="font-medium text-muted-foreground text-xs uppercase tracking-widest">
                Invitation
              </p>
              <h1 className="font-display font-semibold text-3xl">Join Nadi</h1>
            </div>
            <p className="mt-4 border-primary border-l-2 pl-3 text-muted-foreground text-sm">
              {invite.inviterEmail ? (
                <>
                  <span className="font-mono text-foreground">{invite.inviterEmail}</span> invited
                  you.
                </>
              ) : (
                "You've been invited."
              )}{" "}
              Enter your email and we’ll send you a sign-in code.
            </p>
            <p className="mt-4 text-muted-foreground text-xs">
              Nadi is in private beta. Invites are how people get in.{" "}
              {/* The invite token lives in sessionStorage, not the URL, so reading
                  the landing page and coming back doesn't lose the invitation. */}
              <a href="/about" className="underline underline-offset-2 hover:text-foreground">
                What is Nadi?
              </a>
            </p>
          </>
        ) : (
          <>
            <div className="mt-6 space-y-1">
              <h1 className="font-semibold text-xl">Sign in</h1>
              <p className="text-muted-foreground text-sm">
                Use an email code to open your workspace.
              </p>
            </div>

            {invite !== null && (
              <Alert className="mt-6" variant="destructive">
                <AlertDescription>
                  {/* One <p>: sibling nodes would each become their own block
                      and break the sentence apart. */}
                  <p>That invite link is invalid or has already been used.</p>
                </AlertDescription>
              </Alert>
            )}

            {/* Explains the gate rather than just enforcing it: people arriving
                at a closed door deserve to know why it's closed. */}
            <p className="mt-4 text-muted-foreground text-xs">
              Nadi is in private beta, so it’s invite-only for now. Without an invite you can still
              enter your email — we’ll add you to the waiting list.{" "}
              <a href="/about" className="underline underline-offset-2 hover:text-foreground">
                What is Nadi?
              </a>
            </p>
          </>
        )}

        <div className="mt-6 space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="auth-email">Email</Label>
            <Input
              id="auth-email"
              type="email"
              inputMode="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={busy || step === "otp"}
            />
          </div>

          {step === "otp" && (
            <div className="space-y-1.5">
              <Label htmlFor="auth-otp">Code</Label>
              <Input
                id="auth-otp"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                value={otp}
                onChange={(e) => setOtp(e.target.value)}
                onKeyDown={handleKeyDown}
                disabled={busy}
              />
            </div>
          )}

          {error !== null && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}

          <Button
            className="w-full"
            onClick={step === "email" ? submitEmail : submitOtp}
            disabled={
              busy || email.trim().length === 0 || (step === "otp" && otp.trim().length === 0)
            }
            aria-busy={busy}
          >
            {busy ? (
              <Spinner label={step === "email" ? "Sending code" : "Signing in"} />
            ) : step === "email" ? (
              invite?.valid ? (
                "Accept invite"
              ) : (
                "Send code"
              )
            ) : (
              "Sign in"
            )}
          </Button>

          {step === "otp" && (
            <Button
              variant="ghost"
              className="w-full"
              onClick={() => {
                setStep("email");
                setOtp("");
                setError(null);
              }}
              disabled={busy}
            >
              Use a different email
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}

// ------------------------------------------------------------------ //
// Thread navigation                                                   //
// ------------------------------------------------------------------ //

// All chats holds every active chat already; this caps what gets built into the
// DOM at once, not what is fetched.
const ALL_CHATS_PAGE_SIZE = 25;
// THREAD_PAGE_SIZE (the shared active-threads array's own fetch page size —
// the initial rail load and the rail's server-backed search; the array grows
// by merging pages in, never by replacing, see refreshActiveThreads) lives in
// lib/thread-list-state.ts — ProjectsPanel needs it too.
// The rail debounces search input before issuing a server fetch; the local
// filter over the shared array stays instant regardless.
const RAIL_SEARCH_DEBOUNCE_MS = 250;

function ThreadRow({
  thread,
  active,
  disabled,
  narrowLayout,
  projects,
  onSelect,
  onMoveThread,
  onCreateProject,
  onMarkThreadRead,
  onDismissThread,
}: {
  thread: ThreadSummary;
  active: boolean;
  disabled: boolean;
  /** Drawer rail vs pinned sidebar — not the same as touch vs pointer. */
  narrowLayout: boolean;
  projects: ProjectSummary[];
  onSelect: (threadId: string) => void;
  onMoveThread: (threadId: string, projectId: string | null) => void;
  onCreateProject: (threadId: string, name: string) => Promise<void>;
  onMarkThreadRead: (threadId: string) => void;
  onDismissThread: (thread: ThreadSummary) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const finePointer = useFinePointer();
  const touchPrimary = !finePointer;
  // Touch has no hover to reveal the ⋮, so the row itself is the trigger.
  const { pressing, handlers } = useLongPress({
    onLongPress: () => setMenuOpen(true),
    enabled: touchPrimary && !disabled,
  });

  return (
    <div
      className={cn(
        // Tailwind v4 sets the standalone `scale` property, not `transform` —
        // transitioning `transform` here would let the press-in snap instantly.
        "group relative min-w-0 origin-center rounded-md bg-card transition-[scale,background-color] ease-out",
        // The press-in runs for exactly the hold, so the motion IS the wait:
        // the row sinks under the finger and the menu arrives as it lands. The
        // tint carries the same signal for reduced motion, which gets no sink.
        pressing && "bg-accent/60 motion-safe:scale-[0.97]",
      )}
      // Tied to the timer's own constant: a press-in that outran the menu (or
      // finished early and sat still) would be a worse signal than none.
      // Releasing snaps back — only the wait should feel slow.
      style={
        touchPrimary ? { transitionDuration: pressing ? `${LONG_PRESS_MS}ms` : "150ms" } : undefined
      }
      role="listitem"
      // Long-pressing a row must open its menu, not select the text under the
      // finger or raise the browser's own menu. Pointer users get right-click
      // instead — including on a narrow desktop window or PWA.
      {...(touchPrimary
        ? handlers
        : {
            onContextMenu: (event) => {
              if (disabled) return;
              event.preventDefault();
              setMenuOpen(true);
            },
          })}
    >
      <button
        className={cn(
          // The active row keeps a left spine so it reads as "you are here"
          // even where the accent fill is subtle.
          "relative flex w-full min-w-0 max-w-full items-center gap-1 rounded-md py-2 pl-3 text-left transition-colors",
          // The ⋮ lives in a reserved right gutter when there is room for it.
          // Touch-primary narrow layouts reach the menu by long press instead.
          "pr-3",
          (!narrowLayout || finePointer) && "pr-10",
          active
            ? "bg-accent before:absolute before:top-2 before:bottom-2 before:left-0.5 before:w-0.5 before:rounded-full before:bg-primary"
            : "hover:bg-accent/60",
        )}
        // The active row stays enabled: disabling it drops the chat you are
        // actually in out of the tab order. aria-current carries the state,
        // and re-selecting it is a no-op.
        disabled={disabled}
        aria-current={active ? "page" : undefined}
        onClick={() => {
          if (active) return;
          onSelect(thread.threadId);
        }}
        type="button"
      >
        {/* The status gutter holds its width whether or not there is a marker,
            so every title in the rail starts on the same line. Sized for the
            attention halo — the widest mark. */}
        <span className="flex w-4 shrink-0 items-center justify-center">
          <ThreadIndicator thread={thread} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
          <span className="flex w-full min-w-0 items-center gap-1.5">
            <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
              {thread.title}
            </span>
            <ThreadProjectBadge thread={thread} />
            <ThreadAutomatonBadge thread={thread} />
          </span>
          {/* One subtitle: id · date, always. `lastMessagePreview` used to be
              empty for every thread, so this read as the meta line and the
              preview branch was dead. The search projector then started filling
              the column and silently turned the whole rail into a preview list.
              The column stays populated — search matches on it and reports
              `matchedIn: "preview"` — it just isn't what the rail shows. */}
          <span className="w-full truncate text-muted-foreground text-xs">
            {formatThreadMeta(thread)}
          </span>
        </span>
      </button>

      {/* On touch-primary layouts the menu is opened by long press and this
          only anchors it, so the box must not swallow taps meant for the row. */}
      <div className={cn("absolute top-1.5 right-2", touchPrimary && "pointer-events-none")}>
        <ThreadRowMenu
          thread={thread}
          disabled={disabled}
          touchPrimary={touchPrimary}
          narrowLayout={narrowLayout}
          projects={projects}
          open={menuOpen}
          onOpenChange={setMenuOpen}
          onMove={(projectId) => onMoveThread(thread.threadId, projectId)}
          onCreateProject={(name) => onCreateProject(thread.threadId, name)}
          onMarkRead={() => onMarkThreadRead(thread.threadId)}
          onDismiss={() => onDismissThread(thread)}
        />
      </div>
    </div>
  );
}

/**
 * Case-insensitive match over the text a user can actually see on a row.
 *
 * LOAD-BEARING COUPLING: the rail search never calls `loadMore` — only page
 * one (THREAD_PAGE_SIZE) of a query's server results ever lands in the
 * shared array. If a query matched more than that, `exhausted` would never
 * fire and `isSearchEmpty` could never settle. That's harmless today only
 * because the server's `q` param matches the same three fields this
 * predicate does (title / lastMessagePreview / project name) — so a page-one
 * fetch is guaranteed to contain a local match whenever one exists at all.
 * If the server's `q` matching and this predicate ever diverge, the rail can
 * show a stuck "Searching…" or a wrong empty state for a query that has real
 * matches beyond page one.
 */
function threadMatchesQuery(thread: ThreadSummary, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  return (
    thread.title.toLowerCase().includes(needle) ||
    thread.lastMessagePreview.toLowerCase().includes(needle) ||
    (thread.projectName?.toLowerCase().includes(needle) ?? false)
  );
}

function ThreadList({
  threads,
  threadsNextCursor,
  onThreadsLoaded,
  activeThreadId,
  disabled,
  loading,
  projects,
  onSelectThread,
  onOpenAllChats,
  onMoveThread,
  onCreateProject,
  onMarkThreadRead,
  onDismissThread,
}: {
  threads: ThreadSummary[];
  threadsNextCursor: string | null;
  onThreadsLoaded: (threads: ThreadSummary[]) => void;
  activeThreadId: string | null;
  disabled: boolean;
  /** The first thread load hasn't landed — show skeletons, not "No chats yet". */
  loading: boolean;
  projects: ProjectSummary[];
  onSelectThread: (threadId: string) => void;
  onOpenAllChats: () => void;
  onMoveThread: (threadId: string, projectId: string | null) => void;
  onCreateProject: (threadId: string, name: string) => Promise<void>;
  onMarkThreadRead: (threadId: string) => void;
  onDismissThread: (thread: ThreadSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const narrowLayout = !useWideLayout();

  const searching = query.trim().length > 0;
  // The rendered list is ALWAYS a local filter over the shared array — never
  // the search query's own fetched page. Local hits appear instantly on every
  // keystroke; the debounced server fetch below only fills in older chats the
  // shared array hasn't loaded yet, by merging into that same array.
  const matches = useMemo(
    () => (searching ? threads.filter((thread) => threadMatchesQuery(thread, query)) : threads),
    [threads, query, searching],
  );
  // Dismissal is a RAIL concern and nothing else: the shared array keeps every
  // dismissed thread, so All chats, search, and the projects panel still show
  // them. Applied before the cap so a dismissed row frees its slot rather than
  // spending one invisibly.
  const railMatches = useMemo(
    () => visibleRailThreads(matches, { searching, activeThreadId }),
    [matches, searching, activeThreadId],
  );
  // Search spans every loaded chat; the unsearched list stays capped at the
  // recent window, with the remainder named rather than silently dropped.
  const visible = searching ? railMatches : sidebarRailThreads(matches, activeThreadId);

  // Debounce the query into the server fetch only — the local `matches` above
  // stays keyed on the raw `query` so typing feels instant.
  const trimmedQuery = query.trim();
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(trimmedQuery), RAIL_SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [trimmedQuery]);

  const searchQueryActive = debouncedQuery.length > 0;
  const {
    loading: searchLoading,
    exhausted: searchExhausted,
    error: searchError,
  } = useThreadQuery({
    key: `rail-search:${debouncedQuery}`,
    fetchPage: (cursor) =>
      listThreads(fetch, "active", "all", {
        q: debouncedQuery,
        limit: THREAD_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }).catch((error: unknown) => {
        // A network failure throws the platform's raw TypeError (listThreads
        // only routes non-OK responses through errorFromResponse); render a
        // human, action-specific message instead of "Failed to fetch".
        if (isNetworkFailure(error)) {
          throw new Error("Search needs a connection. Reconnect and try again.");
        }
        throw error;
      }),
    // Merge into the SHARED array — App owns it. The rendered list above then
    // picks these up for free via its local filter.
    onPage: (page) => onThreadsLoaded(page),
    enabled: searchQueryActive,
  });
  // "No chats match" must key off the search having SETTLED, never an array
  // length alone — a partial page mid-fetch would render a confident lie.
  // `exhausted`/`loading` are keyed on the DEBOUNCED query while `matches` is
  // keyed on the raw one — while they disagree (mid-debounce), the previous
  // query's settled state must not be read as this query's answer.
  const searchEmpty = isSearchEmpty({
    searching,
    loading: searchLoading,
    exhausted: searchExhausted,
    matchCount: matches.length,
    queryUnsettled: debouncedQuery !== trimmedQuery,
  });
  const showOlderChatsLink =
    !searching &&
    hasOlderChats({
      threadsNextCursor,
      threadCount: threads.length,
      recentLimit: SIDEBAR_RECENT_THREAD_LIMIT,
    });

  return (
    // Only the rows scroll. Search stays pinned above them so it can't be
    // scrolled out of reach when the list is long.
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-3 pb-2">
        <div className="relative">
          <MagnifyingGlass
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-9 pl-8"
          />
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-0.5 px-2 pb-2" role="list" aria-label="Chats">
          {loading && threads.length === 0 && (
            <div className="flex flex-col gap-2 px-3 py-2" aria-hidden>
              {[0, 1, 2, 3, 4].map((row) => (
                <div key={row} className="flex flex-col gap-1.5">
                  <Skeleton className="h-3.5 w-3/4" />
                  <Skeleton className="h-3 w-full" />
                </div>
              ))}
            </div>
          )}

          {!loading && threads.length === 0 && (
            <div className="px-3 py-6 text-muted-foreground text-sm">No chats yet</div>
          )}

          {threads.length > 0 &&
            searching &&
            visible.length === 0 &&
            (searchError && debouncedQuery === trimmedQuery ? (
              // A rejected fetch clears `loading` without ever setting
              // `exhausted` (see useThreadQuery) — without this branch the
              // spinner below would latch forever with no way to see or
              // retry the failure. Gated on the query having settled (same as
              // searchEmpty below): otherwise a stale error from a PREVIOUS
              // query would render as this query's answer while its own
              // fetch is still in flight mid-debounce.
              <div className="px-3 py-6 text-destructive text-sm">{searchError.message}</div>
            ) : searchEmpty ? (
              <div className="px-3 py-6 text-muted-foreground text-sm">
                No chats match “{query.trim()}”
              </div>
            ) : (
              // Still waiting on the debounce or the server fill — showing "no
              // match" here would render a confident lie about a query that
              // simply hasn't settled yet.
              <div className="flex items-center gap-2 px-3 py-6 text-muted-foreground text-sm">
                <Spinner className="size-3.5" />
                Searching…
              </div>
            ))}

          {visible.map((thread) => (
            <ThreadRow
              key={thread.threadId}
              thread={thread}
              active={thread.threadId === activeThreadId}
              disabled={disabled}
              narrowLayout={narrowLayout}
              projects={projects}
              onSelect={onSelectThread}
              onMoveThread={onMoveThread}
              onCreateProject={onCreateProject}
              onMarkThreadRead={onMarkThreadRead}
              onDismissThread={onDismissThread}
            />
          ))}

          {/* The cap says its own name. A list that just stops reads as data loss.
              Unnumbered on purpose: there is no COUNT query behind this, so a
              number here would be a guess dressed up as data. */}
          {showOlderChatsLink && (
            <button
              type="button"
              className="mt-1 flex w-full items-center justify-between gap-2 rounded-md border border-border border-dashed px-3 py-2 text-left text-muted-foreground text-xs transition-colors hover:border-solid hover:bg-accent/60 hover:text-foreground disabled:opacity-50"
              onClick={onOpenAllChats}
              disabled={disabled}
            >
              <span className="min-w-0 truncate">Older chats</span>
              <CaretRight aria-hidden className="size-3.5 shrink-0" />
            </button>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

/** One destination in the rail's nav. `current` is the one you are looking at. */
function RailDestination({
  icon,
  label,
  count,
  current,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  count?: string | undefined;
  current: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={current ? "page" : undefined}
      className={cn(
        "relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-left text-sm transition-colors disabled:opacity-50",
        current
          ? "bg-accent font-medium text-foreground before:absolute before:top-2 before:bottom-2 before:left-0.5 before:w-0.5 before:rounded-full before:bg-primary"
          : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {count !== undefined && (
        <span className="shrink-0 font-mono text-muted-foreground text-xs tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

/** Inner rail content — shared by the desktop sidebar and the mobile Sheet. */
export function RailContent({
  threads,
  threadsNextCursor,
  onThreadsLoaded,
  activeThreadId,
  allChatsActive,
  panelKind,
  disabled,
  loading,
  creating,
  projects,
  onNewThread,
  onSelectThread,
  onOpenAllChats,
  onMarkThreadRead,
  onDismissThread,
  onMoveThread,
  onCreateProject,
  onCloseDrawer,
  user,
  onOpenProjects,
  onOpenAutomata,
  onOpenInvites,
  inviteQuota,
  onOpenFeedback,
  feedbackAdminEnabled,
  onOpenFeedbackInbox,
  onOpenSettings,
  onSignOut,
}: {
  threads: ThreadSummary[];
  /** The shared array's own next-page cursor, or null once it is exhausted.
   *  Drives the overflow link — the only place that needs to know "is there
   *  more", since there is no COUNT query to say how much. */
  threadsNextCursor: string | null;
  /** A page fetched by the rail's own search merges into the shared array
   *  through here — it must never keep its own copy. */
  onThreadsLoaded: (threads: ThreadSummary[]) => void;
  activeThreadId: string | null;
  allChatsActive: boolean;
  /** Which panel is open, so the rail can say where you are. */
  panelKind: PanelKind | null;
  disabled: boolean;
  loading: boolean;
  creating: boolean;
  projects: ProjectSummary[];
  onNewThread: () => void;
  onSelectThread: (threadId: string) => void;
  onOpenAllChats: () => void;
  onMarkThreadRead: (threadId: string) => void;
  onDismissThread: (thread: ThreadSummary) => void;
  onMoveThread: (threadId: string, projectId: string | null) => void;
  onCreateProject: (threadId: string, name: string) => Promise<void>;
  onCloseDrawer?: () => void;
  user: SessionUser;
  onOpenProjects: () => void;
  onOpenAutomata: () => void;
  onOpenInvites: () => void;
  inviteQuota: InviteQuota | null;
  onOpenFeedback: () => void;
  feedbackAdminEnabled: boolean;
  onOpenFeedbackInbox: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const invitesLeft =
    inviteQuota === null
      ? undefined
      : inviteQuota.limit === null
        ? "\u221e"
        : String(Math.max(inviteQuota.limit - inviteQuota.used, 0));

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The rail opens on the brand: an anchor to orient against, and the one
          place the drawer's close button reads as "close" rather than "clear the
          filter". The lockup goes home the way a logo usually does — here home is
          a new chat, the same thing the button below it does. Explicit
          aria-label because the mark's alt and the wordmark would otherwise name
          the button "Nadi Nadi". */}
      <div className="flex shrink-0 items-center gap-2.5 px-3">
        {/* The row's vertical padding lives on the button, not the row: same
            52px row, but the tap target is the whole height rather than the
            28px mark. */}
        <button
          type="button"
          onClick={onNewThread}
          aria-label="New chat"
          className="flex min-w-0 flex-1 items-center gap-2.5 rounded-md py-3 text-left transition-opacity hover:opacity-70"
        >
          <BrandMark className="size-7 shrink-0 rounded-[7px]" />
          <span className="min-w-0 flex-1 truncate font-display font-semibold text-base">Nadi</span>
        </button>
        {onCloseDrawer && (
          <Button
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 wide:hidden"
            onClick={onCloseDrawer}
            aria-label="Close menu"
            title="Close menu"
          >
            <X aria-hidden />
          </Button>
        )}
      </div>

      {/* The primary action, at the top and the only filled button in the rail. */}
      <div className="shrink-0 px-3 pb-2">
        <Button
          className="w-full"
          onClick={onNewThread}
          disabled={creating}
          aria-busy={creating}
          type="button"
        >
          {creating ? <Spinner className="size-4" /> : <Plus aria-hidden className="size-4" />}
          New chat
        </Button>
      </div>

      {/* ThreadList owns the scrolling: only its rows scroll, so search stays
          pinned above and the destinations stay put below. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <ThreadList
          threads={threads}
          threadsNextCursor={threadsNextCursor}
          onThreadsLoaded={onThreadsLoaded}
          activeThreadId={activeThreadId}
          disabled={disabled}
          loading={loading}
          projects={projects}
          onSelectThread={onSelectThread}
          onOpenAllChats={onOpenAllChats}
          onMoveThread={onMoveThread}
          onCreateProject={onCreateProject}
          onMarkThreadRead={onMarkThreadRead}
          onDismissThread={onDismissThread}
        />
      </div>

      <Separator />
      <nav className="flex flex-col gap-0.5 p-2" aria-label="Destinations">
        <RailDestination
          icon={<List aria-hidden className="size-4 shrink-0" />}
          label="All chats"
          current={allChatsActive}
          disabled={disabled && !allChatsActive}
          onClick={onOpenAllChats}
        />
        <RailDestination
          icon={<Robot aria-hidden className="size-4 shrink-0" />}
          label="Automata"
          current={panelKind === "automata"}
          onClick={onOpenAutomata}
        />
        <RailDestination
          icon={<FolderSimple aria-hidden className="size-4 shrink-0" />}
          label="Projects"
          current={panelKind === "projects"}
          onClick={onOpenProjects}
        />
        <RailDestination
          icon={<UserPlus aria-hidden className="size-4 shrink-0" />}
          label="Invites"
          count={invitesLeft}
          current={panelKind === "invites"}
          onClick={onOpenInvites}
        />
      </nav>
      <Separator />
      <UserMenu
        user={user}
        onOpenFeedback={onOpenFeedback}
        feedbackAdminEnabled={feedbackAdminEnabled}
        onOpenFeedbackInbox={onOpenFeedbackInbox}
        onOpenSettings={onOpenSettings}
        onSignOut={onSignOut}
      />
    </div>
  );
}

// ------------------------------------------------------------------ //
// Chat root                                                           //
// ------------------------------------------------------------------ //

function ThreadStatusView({
  threadId,
  error,
  creating,
  onNewThread,
  leading,
}: {
  threadId: string | null;
  error: Error | null;
  creating: boolean;
  onNewThread: () => void;
  leading: React.ReactNode;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        leading={leading}
        breadcrumb={<span className="truncate">{threadId ?? "chats"}</span>}
        actions={
          <>
            <Button
              variant="ghost"
              size="icon"
              onClick={onNewThread}
              disabled={creating}
              aria-busy={creating}
              aria-label="Start new chat"
              title="Start new chat"
            >
              {creating ? <Spinner /> : <Plus aria-hidden />}
            </Button>
            <StatusDot active={!error} label={error ? "Idle" : "Loading"} />
          </>
        }
      />

      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        <main
          className="flex flex-1 items-center justify-center p-6"
          role="log"
          aria-live="polite"
          aria-label="Conversation"
        >
          {error ? (
            <div className="w-full max-w-sm space-y-3" role="alert">
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
              <Button
                variant="outline"
                className="w-full"
                onClick={onNewThread}
                disabled={creating}
              >
                New chat
              </Button>
            </div>
          ) : (
            <Spinner className="size-5 text-muted-foreground" label="Loading chat" />
          )}
        </main>

        <Composer onSend={() => undefined} disabled safeAreaBottom />
      </div>
    </div>
  );
}

export function ChatApp({
  consentWorkspaceId,
  user,
  initialProjects,
  initialThreads,
  initialThreadsNextCursor,
  onActiveWorkspaceChange,
  onSignOut,
  voiceEnabled,
  backgroundWorkEnabled,
  workbenchNetworkAllowlistEnabled = false,
  feedbackAdminEnabled = false,
  threadChat,
}: {
  consentWorkspaceId: string | null;
  user: SessionUser;
  initialProjects: ProjectSummary[];
  initialThreads: ThreadSummary[];
  initialThreadsNextCursor: string | null;
  onActiveWorkspaceChange: (workspaceId: string | null) => void;
  onSignOut: () => void;
  voiceEnabled: boolean;
  backgroundWorkEnabled: boolean;
  workbenchNetworkAllowlistEnabled?: boolean;
  feedbackAdminEnabled?: boolean;
  threadChat?: ThreadChatImpl;
}) {
  const [routePath, setRoutePath] = useState(() => window.location.pathname);
  const [chatsView, setChatsView] = useState<"active" | "archived">(getChatsViewFromLocation);
  const [routeThreadId, setRouteThreadId] = useState<string | null>(() => getThreadIdFromPath());
  const [threads, setThreads] = useState<ThreadSummary[]>(initialThreads);
  const threadsRef = useRef(initialThreads);
  const pendingArchiveIdsRef = useRef(new Set<string>());
  const inactiveThreadIdsRef = useRef(new Set<string>());
  const excludedThreadIds = useCallback(
    () => new Set([...pendingArchiveIdsRef.current, ...inactiveThreadIdsRef.current]),
    [],
  );
  const confirmInactiveThreads = useCallback((threadIds: Iterable<string>) => {
    const ids = [...threadIds];
    if (ids.length === 0) return;
    for (const id of ids) {
      pendingArchiveIdsRef.current.delete(id);
      inactiveThreadIdsRef.current.add(id);
    }
    setThreads((current) =>
      current.filter((thread) => !inactiveThreadIdsRef.current.has(thread.threadId)),
    );
    removeThreadsFromCachedBootstrap(ids);
  }, []);
  useEffect(() => {
    threadsRef.current = threads;
  }, [threads]);
  // What each thread's outcome/attention looked like the last time we saw it,
  // so the socket handler can tell a real transition from a re-broadcast. Kept
  // here rather than read off `threadsRef` alone because that ref only catches
  // up on render: two events landing in the same tick would both diff against
  // the pre-first-event state and announce the same thing twice.
  const threadNoticeStateRef = useRef(new Map<string, ThreadNoticeState>());
  // Opening a thread lives further down the component; a ref keeps this effect
  // from depending on declaration order.
  const openThreadFromNoticeRef = useRef<(threadId: string) => void>(() => {});
  // Same reason, for the reverse: leaving a thread that no longer exists. Both
  // the hub-socket handler and the reconcile pass need it, and neither can
  // depend on route state without being rebuilt on every navigation.
  const leaveThreadIfOpenRef = useRef<(threadId: string) => void>(() => {});
  // The routed thread id, readable from those same callbacks. `activeThreadRef`
  // only carries a RESOLVED thread, so it is null in the window between
  // navigating and the summary loading — exactly when a stale route matters.
  const routeThreadIdRef = useRef<string | null>(routeThreadId);
  useEffect(() => {
    routeThreadIdRef.current = routeThreadId;
  }, [routeThreadId]);
  // The cursor from the shared array's own most recent page-one fetch. Only the
  // rail's overflow link reads this — it is what turns "unknowable count" into
  // "there is definitely more" without a COUNT query.
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null>(
    initialThreadsNextCursor,
  );
  // A page fetched by a surface OTHER than refreshActiveThreads (currently: the
  // rail's server-backed search) merges in through here — never a replace.
  const mergeThreadsPage = useCallback(
    (page: ThreadSummary[]) => {
      setThreads((current) => mergeThreadsExcluding(current, page, excludedThreadIds()));
    },
    [excludedThreadIds],
  );
  const [projects, setProjects] = useState<ProjectSummary[]>(initialProjects);
  const [workbenches, setWorkbenches] = useState<WorkbenchSummary[]>([]);
  const [inviteQuota, setInviteQuota] = useState<InviteQuota | null>(null);
  const [feedbackThread, setFeedbackThread] = useState<ThreadSummary | null>(null);
  const [feedbackThreadError, setFeedbackThreadError] = useState<Error | null>(null);
  const [newChatProjectId, setNewChatProjectId] = useState<"none" | string>("none");
  // The new chat's workbench override. "none" = inherit the selected project's
  // default workbench. Chosen here at start; frozen once the thread exists.
  const [newChatWorkbenchId, setNewChatWorkbenchId] = useState<"none" | string>("none");
  const [hubSocket, setHubSocket] = useState<ReturnType<typeof openUserHubSocket> | null>(null);
  const [browserNotifications, setBrowserNotifications] = useState<
    (BrowserNotificationsResponse & { deviceSubscribed: boolean }) | null
  >(null);
  const [browserNotificationsBusy, setBrowserNotificationsBusy] = useState(false);
  const [browserNotificationPromptError, setBrowserNotificationPromptError] = useState<
    string | null
  >(null);
  const [dismissedNotificationPromptKey, setDismissedNotificationPromptKey] = useState<
    string | null
  >(null);
  const [notificationPromptNow, setNotificationPromptNow] = useState(() => Date.now());
  const [threadReloadNonce, setThreadReloadNonce] = useState(0);
  const [feedbackInboxRevision, setFeedbackInboxRevision] = useState(0);
  const browserNotificationSupport = classifyBrowserNotificationSupport({
    Notification: typeof Notification === "undefined" ? undefined : Notification,
    PushManager: typeof PushManager === "undefined" ? undefined : PushManager,
    navigator: typeof navigator === "undefined" ? undefined : navigator,
  });

  useEffect(() => {
    const socket = openUserHubSocket((raw) => {
      const event = parseUserEvent(raw);
      if (!event) return;
      if (event.type === "feedback.report.created") {
        setFeedbackInboxRevision((revision) => revision + 1);
        return;
      }
      if (event.type === "thread.archived") {
        confirmInactiveThreads([event.thread.threadId]);
      } else if (event.type === "thread.deleted") {
        confirmInactiveThreads([event.threadId]);
        // Dropping it from the rail is not enough when it is the thread on
        // screen. Nothing else clears the route — unlike `thread.archived`
        // below, a deletion has no summary to swap in — so ThreadChat keeps a
        // socket dialing a thread the server no longer has, retrying forever
        // behind a composer stuck on "Connecting…".
        leaveThreadIfOpenRef.current(event.threadId);
      }

      // The in-app half of a push notification. The server declines to send an
      // OS one while this client is visible, so this is what tells the user a
      // thread they are not looking at finished, failed, or is waiting on them.
      // Computed here rather than inside setThreads: a state updater must stay
      // pure, and StrictMode runs it twice.
      if (event.type === "thread.updated" && !excludedThreadIds().has(event.thread.threadId)) {
        const threadId = event.thread.threadId;
        const previous =
          threadNoticeStateRef.current.get(threadId) ??
          threadNoticeState(threadsRef.current.find((thread) => thread.threadId === threadId));
        const notice = threadActivityNotice({
          previous,
          next: event.thread,
          activeThreadId: activeThreadRef.current?.threadId ?? null,
          preview: event.preview,
        });
        threadNoticeStateRef.current.set(
          threadId,
          threadNoticeState(event.thread) ?? EMPTY_NOTICE_STATE,
        );
        if (notice) {
          showThreadActivityToast(notice, (id) => openThreadFromNoticeRef.current(id));
        }
      }
      setThreads((current) => {
        // The rail carries no project filter, but it still owes the server's
        // automaton visibility rule: a quiet `failures_only` run is hidden by
        // the list query, so applyUserEvent must drop it live too — merging
        // unconditionally left it in the rail until a hard refresh.
        if (event.type === "thread.created" || event.type === "thread.updated") {
          if (excludedThreadIds().has(event.thread.threadId)) return current;
        }
        return applyUserEvent(current, event);
      });
      if (event.type === "thread.archived") {
        setActiveThread((current) =>
          current && current.threadId === event.thread.threadId ? event.thread : current,
        );
      } else if (event.type === "thread.updated" || event.type === "thread.created") {
        setActiveThread((current) =>
          current && current.threadId === event.thread.threadId ? event.thread : current,
        );
      }
    });
    setHubSocket(socket);
    return () => {
      socket.close();
      setHubSocket(null);
    };
  }, [confirmInactiveThreads, excludedThreadIds]);

  useAgentConnectionRecovery(hubSocket);

  useEffect(() => {
    void Promise.all([getBrowserNotifications(), getExistingPushSubscription()])
      .then(async ([settings, subscription]) => {
        setBrowserNotifications({ ...settings, deviceSubscribed: Boolean(subscription) });
        // Push subscriptions belong to the service worker registration that
        // created them, and this app moved push from a standalone /push-sw.js
        // onto its single app worker — which drops the old subscription. If
        // this browser had push and no longer has a subscription, re-subscribe
        // and re-register it with the server, silently (see
        // recoverPushSubscription: it only fires where permission is already
        // granted, so it never prompts).
        if (subscription || !settings.browserPushEnabled || !settings.vapidPublicKey) return;
        const recovered = await recoverPushSubscription(settings.vapidPublicKey);
        if (!recovered) return;
        await saveBrowserPushSubscription(recovered);
        setBrowserNotifications({ ...settings, deviceSubscribed: true });
      })
      .catch(() => {});
  }, []);

  const [activeThread, setActiveThread] = useState<ThreadSummary | null>(null);
  const [threadError, setThreadError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);
  // A new thread's first message while it is still being delivered. Bound to its
  // threadId — the whole point — so it can only ever render, and retry, against
  // the thread it was written for. <ThreadChat> shows it as an optimistic bubble
  // until the real message arrives. The thread-binding rules live in
  // lib/pending-first-message.ts, where they are tested.
  const [pendingFirstMessage, setPendingFirstMessage] = useState<PendingFirstMessageState | null>(
    null,
  );
  // The conversation projected while POST /api/threads is still in flight.
  // It has no thread binding yet, so it must never mount ThreadChat or any of
  // its server-backed history, socket, or queue machinery.
  const [pendingThreadCreation, setPendingThreadCreation] = useState<{
    messageId: string;
    text: string;
    files: FileUIPart[];
    provider: SettingsProvider;
    model: string;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [threadPanelOpen, setThreadPanelOpen] = useState(false);
  const [draft, setDraft] = useState(false);
  // Typed text from the hero composer, retained while its pending conversation
  // is projected so creation failure can restore it for retry.
  const [draftText, setDraftText] = useState<string | null>(null);
  // Staged attachments captured at submit, kept alongside draftText so creation
  // failure can restore them to the composer.
  const [draftFiles, setDraftFiles] = useState<FileUIPart[]>([]);
  // One-shot post-onboarding nudge. PEEKED here — the new-chat view that shows
  // it only mounts once the thread fetch resolves, so consuming at mount would
  // silently throw the nudge away on a transient failure. It is cleared when it
  // is actually rendered (`onNudgeShown`), and the in-memory state below is what
  // keeps a second new chat in the same session from showing it again.
  const [nudgePrompt, setNudgePrompt] = useState<string | null>(() =>
    typeof localStorage === "undefined" ? null : peekAutomatonNudge(localStorage),
  );
  // Seed the new-chat provider/model from the synchronously-cached bootstrap
  // settings (localStorage) so the composer is usable immediately on load and
  // offline — with the last-known selected provider — instead of waiting on the
  // /api/settings refresh below. Falls back to empty only on a first run with no
  // cache yet.
  const [newChatSeed] = useState(() => {
    const cachedSettings = readCachedBootstrap()?.settings ?? null;
    return cachedSettings ? deriveNewChatModelState(cachedSettings) : emptyNewChatModelState();
  });
  const [newChatProviders, setNewChatProviders] = useState(newChatSeed.providers);
  const [newChatAnyUsable, setNewChatAnyUsable] = useState(newChatSeed.anyUsableProvider);
  const [newChatProvider, setNewChatProvider] = useState(newChatSeed.provider);
  const [newChatModel, setNewChatModel] = useState(newChatSeed.model);
  const [newChatModelInputModalities, setNewChatModelInputModalities] = useState(
    newChatSeed.modelInputModalities,
  );
  const [agentShowReasoning, setAgentShowReasoning] = useState(true);
  const [newChatReasoningEffort, setNewChatReasoningEffort] = useState(newChatSeed.reasoningEffort);
  const [newChatModelSupportsReasoning, setNewChatModelSupportsReasoning] = useState(
    newChatSeed.modelSupportsReasoning,
  );
  const [newChatReasoningControls, setNewChatReasoningControls] = useState(
    newChatSeed.modelReasoningControls,
  );

  // Mirror of the chosen provider, read inside the settings refetch below. A ref
  // rather than a dependency so re-reading settings doesn't re-run every time
  // the user changes provider.
  const newChatProviderRef = useRef(newChatProvider);
  useEffect(() => {
    newChatProviderRef.current = newChatProvider;
  }, [newChatProvider]);

  // Re-read on mount and every time Settings closes. The model whitelist is
  // edited in Settings but consumed here, and Settings is a route rather than a
  // page load — without this the composer keeps offering the pre-edit list until
  // a hard refresh. Keying on `settingsActive` (rather than notifying from
  // Settings) also picks up edits this app never saw: another tab, or an agent
  // changing provider config through a tool.
  const inSettings = isSettingsPath(routePath);
  useEffect(() => {
    if (inSettings) return;
    let active = true;
    void getDefaultAgentSettings()
      .then((settings) => {
        if (!active) return;
        const state = deriveNewChatModelState(settings);
        setNewChatProviders(state.providers);
        setNewChatAnyUsable(state.anyUsableProvider);
        setNewChatReasoningEffort(state.reasoningEffort);

        // The provider/model the user picked for the chat they're composing is
        // NOT clobbered on every return from Settings — only when the edit they
        // just made took that provider away.
        const picked = newChatProviderRef.current;
        const stillOffered =
          picked !== null && state.providers.some((entry) => entry.provider === picked);
        if (!stillOffered) {
          setNewChatProvider(state.provider);
          setNewChatModel(state.model);
          setNewChatModelInputModalities(state.modelInputModalities);
          setNewChatModelSupportsReasoning(state.modelSupportsReasoning);
        }
      })
      .catch(() => {
        // Offline or settings unreachable: keep the cached-seeded provider/model
        // so the composer stays usable rather than resetting to unconfigured.
      });
    return () => {
      active = false;
    };
  }, [inSettings]);

  // Display preference, not agent config: it loads on its own rather than
  // riding the settings fetch, so a settings failure never hides thinking.
  // Keyed on `inSettings` for the same reason as the fetch above — the toggle
  // lives in Settings but is consumed here, and Settings is a route, not a page
  // load, so a mount-only read would never see the edit.
  useEffect(() => {
    if (inSettings) return;
    let active = true;
    void getUserPreferences()
      .then((prefs) => {
        if (active) setAgentShowReasoning(prefs.showReasoning);
      })
      .catch(() => {
        // Previous value (default true) already stands; a failed preference
        // read must not blank the chat.
      });
    return () => {
      active = false;
    };
  }, [inSettings]);

  useEffect(() => {
    if (initialProjects.length > 0) {
      setProjects(initialProjects);
      return;
    }
    let active = true;
    void listProjects("active")
      .then((listedProjects) => {
        if (active) setProjects(listedProjects);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [initialProjects]);

  useEffect(() => {
    if (newChatProjectId === "none") return;
    if (projects.some((project) => project.id === newChatProjectId)) return;
    setNewChatProjectId("none");
  }, [newChatProjectId, projects]);

  // Drop a workbench override that no longer exists (archived/removed) back to
  // "inherit", so the picker never points at a stale id.
  useEffect(() => {
    if (newChatWorkbenchId === "none") return;
    if (workbenches.some((workbench) => workbench.id === newChatWorkbenchId)) return;
    setNewChatWorkbenchId("none");
  }, [newChatWorkbenchId, workbenches]);

  useEffect(() => {
    let active = true;
    void listWorkbenches("active")
      .then((listedWorkbenches) => {
        if (active) setWorkbenches(listedWorkbenches);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    setNotificationPromptNow(Date.now());
    if (activeThread?.activityStatus !== "running" || !activeThread.currentTurnStartedAt) return;
    const remaining = activeThread.currentTurnStartedAt + 12_000 - Date.now();
    if (remaining <= 0) return;
    const id = window.setTimeout(() => setNotificationPromptNow(Date.now()), remaining);
    return () => window.clearTimeout(id);
  }, [activeThread?.activityStatus, activeThread?.currentTurnStartedAt, activeThread?.threadId]);

  // Seeded at mount: opening the app is itself an interaction, so a user who
  // has not moved the mouse yet still counts as present.
  const lastInteractionAtRef = useRef(Date.now());
  useEffect(() => {
    // A visible tab is not a present user: one left frontmost on a desk used to
    // heartbeat `visible` forever and silence push on every device. Interaction
    // is tracked into a ref — pointermove and scroll fire far too often to hold
    // in state. See lib/user-activity.ts.
    const stopTrackingActivity = trackUserActivity(lastInteractionAtRef);

    const sendPresence = () => {
      const visible = document.visibilityState === "visible";
      setUserHubPresence(hubSocket, {
        activeThreadId: activeThread?.threadId ?? routeThreadId,
        visible,
        active: isUserActive({
          visible,
          lastInteractionAt: lastInteractionAtRef.current,
          now: Date.now(),
        }),
      });
    };

    sendPresence();
    const interval = window.setInterval(sendPresence, 30_000);
    document.addEventListener("visibilitychange", sendPresence);
    window.addEventListener("focus", sendPresence);
    hubSocket?.addEventListener?.("open", sendPresence);

    return () => {
      stopTrackingActivity();
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", sendPresence);
      window.removeEventListener("focus", sendPresence);
      hubSocket?.removeEventListener?.("open", sendPresence);
    };
  }, [activeThread?.threadId, hubSocket, routeThreadId]);

  const newChatAttachmentAccept = ATTACHMENT_ACCEPT;
  const activeThreadAttachmentAccept = ATTACHMENT_ACCEPT;

  // Mirror of activeThread for the load effect to read without a stale closure.
  const activeThreadRef = useRef<ThreadSummary | null>(activeThread);
  useEffect(() => {
    activeThreadRef.current = activeThread;
  }, [activeThread]);

  const consentWorkspaceIdRef = useRef<string | null>(consentWorkspaceId);
  useEffect(() => {
    consentWorkspaceIdRef.current = consentWorkspaceId;
  }, [consentWorkspaceId]);

  const activeWorkspaceIdRef = useRef<string | null>(null);
  const switchActiveWorkspace = useCallback(
    (workspaceId: string | null) => {
      if (activeWorkspaceIdRef.current === workspaceId) return;
      if (workspaceId !== consentWorkspaceIdRef.current) {
        setPostHogConsent(false);
      }
      activeWorkspaceIdRef.current = workspaceId;
      onActiveWorkspaceChange(workspaceId);
    },
    [onActiveWorkspaceChange],
  );

  useEffect(() => {
    switchActiveWorkspace(activeThread?.workspaceId ?? null);
  }, [activeThread?.workspaceId, switchActiveWorkspace]);

  const setResolvedActiveThread = useCallback(
    (thread: ThreadSummary | null) => {
      // Route effects use this ref as their synchronous ownership check. Keep
      // it in lockstep with the setter so a create -> navigate handoff cannot
      // observe the old active thread between scheduling and passive effects.
      activeThreadRef.current = thread;
      const workspaceId = thread?.workspaceId ?? null;
      if (workspaceId !== consentWorkspaceIdRef.current) {
        setPostHogConsent(false);
      }
      activeWorkspaceIdRef.current = workspaceId;
      onActiveWorkspaceChange(workspaceId);
      setActiveThread(thread);
    },
    [onActiveWorkspaceChange],
  );

  const applyUpdatedThread = useCallback((updated: ThreadSummary) => {
    setThreads((current) => mergeThreadsExcluding(current, [updated], excludedThreadIds()));
    setActiveThread((current) =>
      current && current.threadId === updated.threadId ? updated : current,
    );
  }, []);

  /**
   * Housekeeping that opening a thread implies. Both writes are gated, so
   * opening an ordinary, already-read thread still sends nothing.
   *
   * Un-dismissing is the second one: the rail is "what I'm working on", and you
   * just worked on this. It also gives Dismiss a recovery path that does not
   * depend on catching the undo toast.
   */
  const markThreadOpened = useCallback(
    (thread: ThreadSummary) => {
      if (thread.unreadOutcome) {
        void markThreadSeen(thread.threadId)
          .then(applyUpdatedThread)
          .catch(() => {});
      }
      if (thread.recentDismissedAt != null) {
        void setThreadRecentDismissed(thread.threadId, false)
          .then(applyUpdatedThread)
          .catch(() => {});
      }
    },
    [applyUpdatedThread],
  );
  // The rail's shared array is page one, growing on demand — not every active
  // chat anymore. This fetches page one and MERGES it into the shared array
  // (never replaces): a replace would discard whatever other pages this array
  // had already grown to hold (e.g. from the rail's search, or from All chats
  // paging further), snapping the rail back down to page size the next time
  // any caller of this (thread open, resume, etc.) ran. Project filtering is a
  // view concern of All chats, which narrows this list locally — it must never
  // narrow the fetch, or the rail would silently lose chats with nothing on
  // screen to explain why.
  const refreshActiveThreads = useCallback(async () => {
    const result = await resolveRefreshedThreadsPage({
      list: () => listThreads(fetch, "active", "all", { limit: THREAD_PAGE_SIZE }),
    });
    // Only a real fetch carries a cursor; the offline fallback leaves it
    // untouched rather than clobbering it with a stale "no more pages" guess.
    if (result.nextCursor !== undefined) setThreadsNextCursor(result.nextCursor);
    // The merge base MUST be the value React hands the updater, not
    // threadsRef — an in-flight refresh reading the ref can lose a page
    // another setThreads call already scheduled but hasn't committed yet.
    // Merge-never-replace also means a thread archived/deleted on another
    // device while the socket was down is never dropped from this array by a
    // refresh — it lingers as a ghost row until its own event arrives. That
    // degrades gracefully (selecting it hits getThreadOrNull and shows "no
    // longer available") and is an accepted consequence of this design, not
    // an oversight.
    setThreads((current) => mergeThreadsExcluding(current, result.threads, excludedThreadIds()));
    // Callers only use this return value for synchronous, read-only lookups
    // (e.g. "is the routed thread in the just-fetched page") — never fed back
    // into setThreads — so approximating it from threadsRef here is safe and
    // avoids relying on React's setState updater running synchronously.
    return mergeThreadsExcluding(threadsRef.current, result.threads, excludedThreadIds());
  }, [excludedThreadIds]);

  const reconcileActiveThreads = useCallback(async () => {
    const ids = threadsRef.current
      .map((thread) => thread.threadId)
      .filter((id) => !inactiveThreadIdsRef.current.has(id));
    // The thread on screen, even when it is not in the rail — which is exactly
    // the case that used to be missed. A deletion this tab did not witness
    // (offline, or before the socket connected) removed it from the list, and
    // `confirmInactiveThreads` removes it too, so the one thread that most
    // needs checking was the one never sent.
    //
    // Gated to match the server's filter (active, non-feedback), because
    // reconcile reports anything else as inactive: sending an archived thread —
    // legitimately viewable read-only from the archived tab — would evict the
    // user from a thread that is perfectly fine.
    const open = activeThreadRef.current;
    if (
      open &&
      open.archivedAt === null &&
      open.kind === "regular" &&
      !inactiveThreadIdsRef.current.has(open.threadId) &&
      !ids.includes(open.threadId)
    ) {
      ids.push(open.threadId);
    }
    const inactive = await findInactiveThreadIds(ids);
    confirmInactiveThreads(inactive);
    for (const id of inactive) leaveThreadIfOpenRef.current(id);
  }, [confirmInactiveThreads]);

  useEffect(() => {
    if (!hubSocket) return;
    const reconcile = () => void reconcileActiveThreads().catch(() => {});
    hubSocket.addEventListener("open", reconcile);
    return () => hubSocket.removeEventListener("open", reconcile);
  }, [hubSocket, reconcileActiveThreads]);

  // Synchronous guard against double-submit creating two threads (state lags).
  const creatingRef = useRef(false);

  useEffect(() => {
    const onPopState = () => {
      setRoutePath(window.location.pathname);
      setChatsView(getChatsViewFromLocation());
      setRouteThreadId(getThreadIdFromPath());
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
    };
  }, []);

  // The active conversation's messages self-heal via the agent socket
  // (useAgentConnectionRecovery in ThreadChat), but the thread rail only loads
  // on mount/route change. Refetch it on resume so titles and threads created
  // elsewhere don't stay stale after the tab was backgrounded.
  useOnResume(() => {
    void (async () => {
      try {
        try {
          await reconcileActiveThreads();
        } catch {
          // Reconciliation is best-effort; still refresh the active page.
        }
        // refreshActiveThreads already wrote the merge into `threads` via a
        // functional update; `listed` here is for the read-only lookups below
        // only — writing it back with a plain setThreads would reintroduce
        // the stale-ref clobber this whole helper exists to avoid.
        const listed = await refreshActiveThreads();
        const active = activeThreadRef.current;
        const fresh = active ? listed.find((t) => t.threadId === active.threadId) : undefined;
        if (active && fresh) {
          const changed =
            fresh.title !== active.title ||
            fresh.activityStatus !== active.activityStatus ||
            fresh.unreadOutcome !== active.unreadOutcome;
          if (changed) {
            setActiveThread((current) =>
              current && current.threadId === fresh.threadId ? { ...current, ...fresh } : current,
            );
          }
        }
        // A turn that finished while we were backgrounded set an unread outcome
        // the frozen socket never delivered, and the route effect only marks
        // seen on navigation — so clear it here for the thread we resumed onto.
        if (fresh && shouldMarkThreadSeen(fresh, document.visibilityState === "visible")) {
          markThreadOpened(fresh);
        }
      } catch {
        // Best-effort; the socket path is the primary recovery.
      }
    })();
  });

  // Viewing a thread is what clears its unread marker. The route effect only
  // fires that on navigation, so a thread that goes unread while it's the open,
  // visible thread — a PWA resume, or a live update landing mid-view — would
  // otherwise keep its indicator until re-selected. Mark it seen here instead.
  useEffect(() => {
    if (!activeThread) return;
    if (!shouldMarkThreadSeen(activeThread, document.visibilityState === "visible")) return;
    markThreadOpened(activeThread);
  }, [activeThread, markThreadOpened]);

  // `backTo` marks a thread opened from a place worth returning to (a run in
  // Automata). Only those entries get a stamp — every other thread keeps the
  // unstamped state it has always had, so the rail toggle stays the control.
  const navigateToThread = useCallback(
    (threadId: string, mode: "push" | "replace", backTo?: string) => {
      const path = `/threads/${encodeURIComponent(threadId)}`;
      if (window.location.pathname !== path) {
        const state = backTo
          ? nextRouteState(window.history.state, window.location.pathname, backTo)
          : null;
        if (mode === "push") window.history.pushState(state, "", path);
        else window.history.replaceState(state, "", path);
      }
      setRoutePath(path);
      setRouteThreadId(threadId);
    },
    [],
  );

  // Published for the hub-socket handler above, which fires the in-app activity
  // toast and needs to open a thread from it.
  openThreadFromNoticeRef.current = (threadId: string) => navigateToThread(threadId, "push");

  // Published for the hub-socket handler and the reconcile pass: send the user
  // out of `threadId` if that is what they are looking at, and do nothing
  // otherwise. Deliberately the same landing as the load path's "not found"
  // branch below, so a thread that dies while open and one that is already gone
  // when opened behave identically.
  leaveThreadIfOpenRef.current = (threadId: string) => {
    const openThreadId = activeThreadRef.current?.threadId ?? routeThreadIdRef.current;
    if (openThreadId !== threadId) return;
    toast.error("This chat is no longer available.");
    window.history.replaceState(null, "", "/chats");
    setRoutePath("/chats");
    setRouteThreadId(null);
    setResolvedActiveThread(null);
    setDraft(true);
  };

  // Take the thread a notification tap points at, if one is waiting, and open
  // it. This — not the postMessage below — is what makes a tap land on the
  // thread: the worker writes the record before it focuses anything, so it is
  // there whether this app instance was just launched by the tap, restored from
  // the background, or already open. See lib/pending-navigation.ts.
  const claimPendingNavigation = useCallback(() => {
    void claimPendingThreadNavigation().then((threadId) => {
      if (threadId) navigateToThread(threadId, "push");
    });
  }, [navigateToThread]);

  // Claiming once is never enough: the page and the worker race, in both
  // directions and with no ordering guarantee.
  //
  //  - Launch: the tap starts the app AND fires `notificationclick`, so a fast
  //    boot can look before the worker has written the record.
  //  - Resume (the case that stayed broken): the OS foregrounds the app first
  //    and wakes the worker after, so the resume signal reliably arrives BEFORE
  //    the record exists — and with no remount, a one-shot claim never looks
  //    again.
  //
  // So every trigger opens a short re-check window instead. Each tick is a
  // cheap read that no-ops once the record is claimed or the window closes, and
  // a new trigger replaces the window rather than stacking onto it.
  const claimTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const openClaimWindow = useCallback(() => {
    for (const timer of claimTimersRef.current) clearTimeout(timer);
    claimPendingNavigation();
    claimTimersRef.current = CLAIM_RETRY_DELAYS_MS.map((delay) =>
      setTimeout(claimPendingNavigation, delay),
    );
  }, [claimPendingNavigation]);

  useEffect(() => {
    openClaimWindow();
    return () => {
      for (const timer of claimTimersRef.current) clearTimeout(timer);
    };
  }, [openClaimWindow]);

  // The resume case: the app was alive in the background when the tap landed,
  // so nothing re-mounts and the mount effect never re-runs.
  useOnResume(() => {
    openClaimWindow();
  });

  // Listen for soft-navigate messages from the service worker (push notification
  // taps). Prefer this over client.navigate() which forces a full page reload.
  // Only the already-foregrounded case is reliably served by this: a message
  // sent while the page is still booting is dropped (the container flushes its
  // buffer at `load`, and this listener mounts behind the session probe), which
  // is why the claim above exists. See push-notification-thread-routing-design spec.
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const handler = (event: MessageEvent) => {
      const data = event.data as { type?: unknown; threadId?: unknown } | null;
      if (data?.type === "navigate-thread" && typeof data.threadId === "string") {
        navigateToThread(data.threadId, "push");
        // We just handled this tap; drop the record so the next resume cannot
        // replay it after the user has moved on.
        void clearPendingThreadNavigation();
      }
    };
    navigator.serviceWorker.addEventListener("message", handler);
    // addEventListener alone does not start the flow — without this, messages
    // buffered before `load` are only released by the load event itself.
    navigator.serviceWorker.startMessages();
    return () => navigator.serviceWorker.removeEventListener("message", handler);
  }, [navigateToThread]);
  useEffect(() => {
    // The active thread already matches the route — e.g. createAndSend just
    // populated it before navigating. Tearing it down to refetch would unmount
    // <ThreadChat> and kill its socket for nothing, so make this a no-op.
    // Other navigations (selectThread, popstate, initial
    // load, delete-then-navigate) leave activeThread pointing elsewhere, so the
    // ref mismatches the route and the load below still runs.
    if (routeThreadId && activeThreadRef.current?.threadId === routeThreadId) {
      markThreadOpened(activeThreadRef.current);
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    setThreadError(null);
    setResolvedActiveThread(null);

    void (async () => {
      try {
        const listedThreads = await refreshActiveThreads();
        if (!active) return;

        if (routeThreadId) {
          const listedThread =
            listedThreads.find((thread) => thread.threadId === routeThreadId) ??
            (await getThreadOrNull(routeThreadId));
          if (!active) return;
          if (listedThread === null) {
            toast.error("This chat is no longer available.");
            window.history.replaceState(null, "", "/chats");
            setRoutePath("/chats");
            setRouteThreadId(null);
            setDraft(true);
            return;
          }
          // Only merge active threads into the sidebar list. Opening an archived
          // thread (e.g. from the archived tab) must render read-only without
          // popping it back into the active rail.
          if (listedThread.archivedAt == null) {
            setThreads((current) =>
              mergeThreadsExcluding(current, [listedThread], excludedThreadIds()),
            );
          }
          setResolvedActiveThread(listedThread);
          markThreadOpened(listedThread);
          setDraft(false);
          return;
        }

        if (routePath === "/chats") {
          setDraft(false);
          return;
        }

        // Settings is a route with no thread, like the panels below. Without
        // this it falls through to the "/" rewrite, which wipes the settings
        // history entry (and its depth stamp) — so the back button then leaves
        // to /chats instead of returning to whatever opened Settings.
        if (isSettingsPath(routePath)) {
          setDraft(false);
          return;
        }

        // Every panel route, list *and* detail. Matching only the list paths
        // sent "/automata/xyz" down the fall-through below, which rewrote the
        // URL to "/" — so a panel that selected an item (the master-detail
        // default) lost its place on reload and on PWA relaunch.
        if (parsePanelRoute(routePath) !== null) {
          setDraft(false);
          return;
        }

        // No thread in the route ("/"): always show the empty new-chat state
        // with the freshly loaded thread list in the rail. We intentionally do
        // NOT auto-navigate to the most recent thread.
        setDraft(true);
        window.history.replaceState(null, "", "/");
      } catch (error) {
        if (active) setThreadError(error instanceof Error ? error : new Error(String(error)));
      } finally {
        if (active) setLoading(false);
      }
    })();

    return () => {
      active = false;
    };
  }, [
    markThreadOpened,
    navigateToThread,
    refreshActiveThreads,
    reconcileActiveThreads,
    routePath,
    routeThreadId,
    setResolvedActiveThread,
  ]);

  const startNewThread = useCallback(() => {
    // New is non-destructive (it only opens a local draft) and must stay
    // available while the current thread's turn is still streaming. Only guard
    // against the brief in-flight thread creation to avoid a double-create.
    if (creating) return;
    setThreadError(null);
    setDraftText(null);
    setDraftFiles([]);
    setResolvedActiveThread(null);
    setDraft(true);
    setThreadPanelOpen(false);
    window.history.replaceState(null, "", "/");
    setRoutePath("/");
    setRouteThreadId(null);
  }, [creating]);

  const handleRenameThread = useCallback((threadId: string, title: string) => {
    void renameThread(threadId, title)
      .then((updated) => {
        setActiveThread((current) =>
          current && current.threadId === threadId ? updated : current,
        );
        setThreads((current) => mergeThreadsExcluding(current, [updated], excludedThreadIds()));
      })
      .catch((error: unknown) => {
        setThreadError(error instanceof Error ? error : new Error(String(error)));
      });
  }, []);

  const handleThreadReasoningEffort = useCallback((threadId: string, effort: ReasoningEffort) => {
    void updateThreadReasoningEffort(threadId, effort)
      .then((updated) => {
        setActiveThread((current) =>
          current && current.threadId === threadId ? updated : current,
        );
        setThreads((current) => mergeThreadsExcluding(current, [updated], excludedThreadIds()));
      })
      .catch((error: unknown) => {
        setThreadError(error instanceof Error ? error : new Error(String(error)));
        toast.error("Couldn't update thinking effort");
      });
  }, []);

  /**
   * Deliver the first message into a thread that already exists, tracking it as
   * an optimistic bubble. `sending` disables that thread's composer so the first
   * message is genuinely first; `failed` leaves the bubble retryable. Success
   * does NOT clear the state — <ThreadChat> clears it once the real message
   * arrives over the socket, so the bubble never blinks out into an empty thread.
   */
  const deliverFirstMessage = useCallback(
    async (threadId: string, text: string, files: FileUIPart[], messageId: string) => {
      try {
        await uploadAndSendFirstMessage(liveNewThreadSendPort, {
          threadId,
          text,
          files,
          messageId,
        });
        setPendingFirstMessage((current) => withStatus(current, threadId, "sent"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setPendingFirstMessage((current) => withStatus(current, threadId, "failed"));
        // The thread exists and is on screen (or one tap away in the rail) with a
        // retryable bubble, so the toast is a nudge, not the only channel.
        toast.error(`Your message wasn't sent: ${message}`);
      }
    },
    [],
  );

  const retryFirstMessage = useCallback(() => {
    setPendingFirstMessage((current) => {
      if (!isRetryable(current) || current === null) return current;
      void deliverFirstMessage(current.threadId, current.text, current.files, current.messageId);
      return withStatus(current, current.threadId, "sending");
    });
  }, [deliverFirstMessage]);

  const settleFirstMessage = useCallback((threadId: string) => {
    setPendingFirstMessage((current) => settled(current, threadId));
  }, []);

  const createAndSend = useCallback(
    (text: string, files: FileUIPart[]) => {
      // Ref guard: two synchronous submits must not create two threads (the
      // `creating` state lags a render behind).
      if (creatingRef.current) return;
      const selectedProvider = newChatProvider;
      if (
        selectedProvider === null ||
        !canStartNewChat({ provider: selectedProvider, model: newChatModel })
      ) {
        setThreadError(new Error("Configure a usable provider and model before starting a chat."));
        return;
      }
      creatingRef.current = true;
      setCreating(true);
      setThreadError(null);
      // Preserve the submitted content for the pending projection and for retry
      // if thread creation fails.
      setDraftText(text);
      setDraftFiles(files);
      const messageId = `msg_${crypto.randomUUID()}`;
      setPendingThreadCreation({
        messageId,
        text,
        files,
        provider: selectedProvider,
        model: newChatModel,
      });
      const selectedProjectId =
        newChatProjectId !== "none" && projects.some((project) => project.id === newChatProjectId)
          ? newChatProjectId
          : undefined;
      // An explicit workbench overrides the project's default; "none" inherits it.
      const selectedWorkbenchId =
        newChatWorkbenchId !== "none" &&
        workbenches.some((workbench) => workbench.id === newChatWorkbenchId)
          ? newChatWorkbenchId
          : undefined;
      // Two phases. The pending projection covers the create POST. Once it
      // resolves the thread really exists, so the same message id is handed to
      // the real thread and delivery continues in the background.
      void createNewThread(liveNewThreadSendPort, {
        provider: selectedProvider,
        model: newChatModel,
        modelInputModalities: newChatModelInputModalities,
        reasoningEffort: newChatReasoningEffort,
        modelSupportsReasoning: newChatModelSupportsReasoning,
        ...(selectedProjectId ? { projectId: selectedProjectId } : {}),
        ...(selectedWorkbenchId ? { workbenchId: selectedWorkbenchId } : {}),
      })
        .then((thread) => {
          setThreads((current) => mergeThreadsExcluding(current, [thread], excludedThreadIds()));
          setDraftText(null);
          setDraftFiles([]);
          setPendingFirstMessage({
            threadId: thread.threadId,
            messageId,
            text,
            files,
            status: "sending",
          });
          setPendingThreadCreation(null);

          // Only follow the user into the new thread if they haven't navigated
          // away in the meantime — the message is delivered either way.
          if (window.location.pathname === "/") {
            setResolvedActiveThread(thread);
            setDraft(false);
            navigateToThread(thread.threadId, "push");
          }
          if (canUseWorkspaceTelemetry({ consentWorkspaceId, workspaceId: thread.workspaceId })) {
            bindWorkspace(thread.workspaceId);
            track("thread_created", { source: thread.source });
          }

          // Bound to thread.threadId — not to whatever thread is selected when
          // this resolves, and not to a mounted component.
          void deliverFirstMessage(thread.threadId, text, files, messageId);
        })
        .catch((error: unknown) => {
          // Creation itself failed: there is no thread and nothing was sent, so
          // the user is still on the hero composer. NewChatView keeps the draft
          // and shows the error inline for retry.
          setPendingThreadCreation(null);
          setThreadError(error instanceof Error ? error : new Error(String(error)));
        })
        .finally(() => {
          creatingRef.current = false;
          setCreating(false);
        });
    },
    [
      navigateToThread,
      consentWorkspaceId,
      newChatProjectId,
      newChatWorkbenchId,
      newChatModel,
      newChatModelInputModalities,
      newChatProvider,
      newChatReasoningEffort,
      newChatModelSupportsReasoning,
      projects,
      workbenches,
      setResolvedActiveThread,
    ],
  );

  // `backTo` is passed by the surface the thread was picked from, never derived
  // from the current path: the rail is a drawer over whatever screen is showing,
  // so where you are says nothing about where you came from.
  const selectThread = useCallback(
    (threadId: string, backTo?: string) => {
      // Switching mid-stream is allowed: unmounting <ThreadChat> only closes the
      // socket. The Agents SDK keeps the turn running in the DO and persists the
      // full reply (cancelOnClientAbort defaults to false), so reopening the
      // thread later shows the completed answer. Switching while a new thread is
      // being created is allowed too: creation/send is bound to that thread and
      // completes over plain HTTP regardless of what is mounted.
      if (threadId === routeThreadId) return;
      // Switch urgently (NOT in a transition): a transition keeps the previous
      // thread on screen until the new one's history has fetched, which reads as
      // a freeze and hides the skeleton. Committing now mounts <ThreadChat>, whose
      // cheap initial render is the skeleton — so the drawer closes cleanly and
      // the skeleton shows while history loads. Set the thread optimistically from
      // the list we already have so the load effect is a no-op (no null-flash).
      const known = threads.find((thread) => thread.threadId === threadId);
      if (known) {
        setResolvedActiveThread(known);
        setDraft(false);
      }
      navigateToThread(threadId, "push", backTo);
      setThreadPanelOpen(false);
      if (known) markThreadOpened(known);
    },
    [markThreadOpened, navigateToThread, routeThreadId, setResolvedActiveThread, threads],
  );

  // Opening a thread from a screen the user navigated to — All chats, a
  // project — leaves that screen behind, so it becomes the way back. The rail
  // has its own path (plain selectThread): it's a drawer over whatever is
  // showing, so it is never where you came from. The search matters here: All
  // chats keeps ?view=archived, and Back must land on the list actually read.
  const openThreadFromCurrentScreen = useCallback(
    (threadId: string) => selectThread(threadId, backToHere(window.location)),
    [selectThread],
  );

  const enableBrowserNotifications = useCallback(async () => {
    if (browserNotificationsBusy) return;
    if (!browserNotificationSupport.supported) {
      throw new Error("Push notifications are not supported in this browser.");
    }
    if (!browserNotifications?.vapidPublicKey) {
      throw new Error("Browser notifications are not configured for this workspace yet.");
    }

    setBrowserNotificationsBusy(true);
    setBrowserNotificationPromptError(null);
    try {
      const subscription = await ensurePushSubscription(browserNotifications.vapidPublicKey);
      await saveBrowserPushSubscription(subscription);
      const next = await updateBrowserNotificationSettings({ browserPushEnabled: true });
      setBrowserNotifications({ ...next, deviceSubscribed: true });
      toast.success("Browser notifications enabled");
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not enable browser notifications.";
      setBrowserNotificationPromptError(message);
      throw error instanceof Error ? error : new Error(message);
    } finally {
      setBrowserNotificationsBusy(false);
    }
  }, [browserNotificationSupport, browserNotifications, browserNotificationsBusy]);

  const openAllChats = useCallback(() => {
    // "All chats" always lands on the active tab, clearing any ?view=archived.
    if (window.location.pathname + window.location.search !== "/chats") {
      window.history.pushState(null, "", "/chats");
    }
    setRoutePath("/chats");
    setChatsView("active");
    setRouteThreadId(null);
    setResolvedActiveThread(null);
    setDraft(false);
    setThreadPanelOpen(false);
  }, [setResolvedActiveThread]);

  // Toggle between the active and archived tabs, recording each in history so the
  // browser back button returns to the previous tab.
  const showArchivedChats = useCallback((archived: boolean) => {
    const target = archived ? "/chats?view=archived" : "/chats";
    if (window.location.pathname + window.location.search !== target) {
      window.history.pushState(null, "", target);
    }
    setRoutePath("/chats");
    setChatsView(archived ? "archived" : "active");
  }, []);

  const markThreadRead = useCallback(
    (threadId: string) => {
      void markThreadSeen(threadId)
        .then(applyUpdatedThread)
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn't mark this chat as read");
        });
    },
    [applyUpdatedThread],
  );

  /**
   * Remove a thread from the rail. No optimistic removal and no rollback: the
   * server's updated thread is what hides the row, so a failed request simply
   * leaves the rail as it was and says so.
   */
  const dismissThread = useCallback(
    (thread: ThreadSummary) => {
      // Same landing as archive/delete of the open thread: the rail is no
      // longer showing this chat, so staying on it would leave you reading
      // something you just asked to put away.
      const leavingOpenThread =
        thread.threadId === (activeThread?.threadId ?? routeThreadId);
      void setThreadRecentDismissed(thread.threadId, true)
        .then((updated) => {
          applyUpdatedThread(updated);
          if (leavingOpenThread) startNewThread();
          // Name where the chat went. A row that vanishes with no explanation
          // reads as deletion, which is the one thing this action is not.
          toast.success("Dismissed", {
            description: "Still in All chats.",
            action: {
              label: "Undo",
              onClick: () => {
                void setThreadRecentDismissed(thread.threadId, false)
                  .then(applyUpdatedThread)
                  .catch((error: unknown) => {
                    toast.error(
                      error instanceof Error ? error.message : "Couldn't restore this chat",
                    );
                  });
              },
            },
          });
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : "Couldn't dismiss this chat");
        });
    },
    [activeThread, applyUpdatedThread, routeThreadId, startNewThread],
  );

  const archiveThread = useCallback(
    (threadId: string) => {
      if (creating) return;
      setThreadError(null);

      // Optimistically drop the thread from the UI, remembering where it sat so
      // we can restore it if the delete fails on the server.
      const activeId = activeThread?.threadId ?? routeThreadId;
      let removed: ThreadSummary | undefined;
      let removedIndex = -1;
      pendingArchiveIdsRef.current.add(threadId);
      setThreads((current) => {
        removedIndex = current.findIndex((thread) => thread.threadId === threadId);
        if (removedIndex === -1) return current;
        removed = current[removedIndex];
        return current.filter((thread) => thread.threadId !== threadId);
      });

      // Archiving the thread you are reading lands on a new chat, not on whichever
      // thread happens to be next in the list — that one is someone else's context.
      if (threadId === activeId) startNewThread();

      void archiveThreadApi(threadId)
        .then((archived) => {
          confirmInactiveThreads([threadId]);
          setActiveThread((current) =>
            current && current.threadId === archived.threadId ? archived : current,
          );
          toast.success("Chat archived");
        })
        .catch((error: unknown) => {
          pendingArchiveIdsRef.current.delete(threadId);
          // Roll back: put the thread back where it was.
          setThreads((current) => {
            if (
              !removed ||
              inactiveThreadIdsRef.current.has(threadId) ||
              current.some((thread) => thread.threadId === threadId)
            ) {
              return current;
            }
            const restored = [...current];
            restored.splice(Math.max(removedIndex, 0), 0, removed);
            return restored;
          });
          setThreadError(error instanceof Error ? error : new Error(String(error)));
          toast.error("Couldn't archive chat");
        });
    },
    [activeThread, confirmInactiveThreads, creating, routeThreadId, startNewThread],
  );

  const deleteThread = useCallback(
    (threadId: string) => {
      if (creating) return;
      setThreadError(null);

      // Optimistically drop the thread from the UI, remembering where it sat so
      // we can restore it if the delete fails on the server. Unlike archive this
      // is permanent, so there is no read-only copy to keep.
      const activeId = activeThread?.threadId ?? routeThreadId;
      let removed: ThreadSummary | undefined;
      let removedIndex = -1;
      // Keep deletes out of concurrent refresh/search merges until the server
      // confirms the inactive transition, just like archive optimism.
      pendingArchiveIdsRef.current.add(threadId);
      setThreads((current) => {
        removedIndex = current.findIndex((thread) => thread.threadId === threadId);
        if (removedIndex === -1) return current;
        removed = current[removedIndex];
        return current.filter((thread) => thread.threadId !== threadId);
      });

      if (threadId === activeId) startNewThread();

      void deleteThreadApi(threadId)
        .then(() => {
          confirmInactiveThreads([threadId]);
          setActiveThread((current) => (current && current.threadId === threadId ? null : current));
          toast.success("Chat deleted");
        })
        .catch((error: unknown) => {
          pendingArchiveIdsRef.current.delete(threadId);
          // Roll back: put the thread back where it was.
          setThreads((current) => {
            if (
              !removed ||
              inactiveThreadIdsRef.current.has(threadId) ||
              current.some((thread) => thread.threadId === threadId)
            ) {
              return current;
            }
            const restored = [...current];
            restored.splice(Math.max(removedIndex, 0), 0, removed);
            return restored;
          });
          setThreadError(error instanceof Error ? error : new Error(String(error)));
          toast.error("Couldn't delete chat");
        });
    },
    [activeThread, confirmInactiveThreads, creating, routeThreadId, startNewThread],
  );

  const moveThread = useCallback((threadId: string, nextProjectId: string | null) => {
    void moveThreadToProject(threadId, nextProjectId)
      .then((updated) => {
        setActiveThread((current) =>
          current && current.threadId === threadId ? updated : current,
        );
        // Moving a chat between projects never removes it from the rail — the
        // rail is unfiltered, so the chat just wears a different badge.
        setThreads((current) => mergeThreadsExcluding(current, [updated], excludedThreadIds()));
        // A move is filing, not re-provisioning: the chat keeps the sandbox and
        // secrets it already has. Say so, or the badge implies otherwise.
        toast.success(nextProjectId ? "Chat moved" : "Removed from project", {
          description: nextProjectId
            ? "Keeps its own sandbox and secrets. Start a new chat to use this project's."
            : "Keeps its own sandbox and secrets.",
        });
      })
      .catch((error: unknown) => {
        setThreadError(error instanceof Error ? error : new Error(String(error)));
        toast.error("Couldn't move chat");
      });
  }, []);

  // Switching a LIVE thread's workbench is deferred server-side: the response
  // carries the new intent (workbenchId/workbenchName) but keeps
  // resourceProfile pinned to the old workbench until the agent saves its
  // work and the switch commits (workbenchSwitchPending flips back to false).
  // If no sandbox was live, the server applies it immediately instead.
  const switchWorkbench = useCallback(async (threadId: string, workbenchId: string | null) => {
    try {
      const updated = await switchThreadWorkbench(threadId, workbenchId);
      setActiveThread((current) => (current && current.threadId === threadId ? updated : current));
      setThreads((current) => mergeThreadsExcluding(current, [updated], excludedThreadIds()));
      toast.success(
        updated.workbenchSwitchPending ? "Switching workbench…" : "Workbench switched",
        updated.workbenchSwitchPending
          ? { description: "The agent will save its work before the switch completes." }
          : undefined,
      );
    } catch (error) {
      setThreadError(error instanceof Error ? error : new Error(String(error)));
      toast.error("Couldn't switch workbench");
    }
  }, []);

  // Create a project (name only) and merge it into the list. Toast-free so
  // callers can compose it with their own follow-up (assign / move) and toast.
  const createProjectInList = useCallback(async (name: string): Promise<ProjectSummary> => {
    const project = await createProject({ name });
    setProjects((current) =>
      current.some((entry) => entry.id === project.id) ? current : [project, ...current],
    );
    return project;
  }, []);

  // Quick-add from the composer: create a project and assign the pending new
  // chat to it. Rejects so the picker keeps the typed name for retry.
  const handleCreateProject = useCallback(
    async (name: string) => {
      try {
        const project = await createProjectInList(name);
        setNewChatProjectId(project.id);
        toast.success("Project created");
      } catch (error) {
        toast.error("Couldn't create project");
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    [createProjectInList],
  );

  // Quick-add from an open thread: create a project and move the thread into
  // it in one step (moveThread surfaces its own success/failure toast).
  const createProjectForThread = useCallback(
    async (threadId: string, name: string) => {
      try {
        const project = await createProjectInList(name);
        moveThread(threadId, project.id);
      } catch (error) {
        toast.error("Couldn't create project");
        throw error instanceof Error ? error : new Error(String(error));
      }
    },
    [createProjectInList, moveThread],
  );

  // Opening a panel records the path it was opened from, so its close button can
  // return there (the thread you were reading) instead of dumping you on /chats.
  const openPanel = useCallback(
    (kind: PanelKind) => {
      const path = panelListPath(kind);
      pushPath(window.history, window.location, path);
      setResolvedActiveThread(null);
      setRoutePath(path);
      setRouteThreadId(null);
      setDraft(false);
      setThreadPanelOpen(false);
    },
    [setResolvedActiveThread],
  );

  const openProjects = useCallback(() => openPanel("projects"), [openPanel]);
  const openAutomata = useCallback(() => openPanel("automata"), [openPanel]);

  // Settings is a panel too, but its second path segment is a tab rather than a
  // selected item, so it routes through settings-routes instead of PanelKind.
  // Clearing the active thread is also what drops telemetry consent to null (see
  // switchActiveWorkspace) — the same way the other panels do.
  const openSettings = useCallback(
    (tab?: SettingsTab) => {
      const path = tab ? settingsPath(tab) : "/settings";
      pushPath(window.history, window.location, path);
      setResolvedActiveThread(null);
      setRoutePath(path);
      setRouteThreadId(null);
      setDraft(false);
      setThreadPanelOpen(false);
    },
    [setResolvedActiveThread],
  );

  // Replace, not push: a tab is a view of Settings, not a level of it. Pushing
  // would make Back walk through tabs instead of leaving.
  const selectSettingsTab = useCallback((tab: SettingsTab) => {
    const path = settingsPath(tab);
    replacePath(window.history, window.location, path);
    setRoutePath(path);
  }, []);

  // Sub-routing within a Settings tab (e.g. the Workbenches master-detail).
  // Settings.tsx owns the path computation; this just applies it.
  const navigateSettingsPath = useCallback((path: string, mode: "push" | "replace") => {
    if (mode === "push") pushPath(window.history, window.location, path);
    else replacePath(window.history, window.location, path);
    setRoutePath(path);
  }, []);

  // Drilling into an item, and stepping back out of it. Selection lives in the
  // URL, so the browser's Back button and the panel's back arrow do the same
  // thing at every level.
  const selectPanelItem = useCallback(
    (kind: PanelKind, id: string | null, mode: "push" | "replace") => {
      const path = panelPath(kind, id);
      if (mode === "push") pushPath(window.history, window.location, path);
      else replacePath(window.history, window.location, path);
      setRoutePath(path);
    },
    [],
  );

  // Out of the panel entirely. Prefer the browser's own history so Back and this
  // button stay in lockstep; a deep link has nothing behind it, so fall back to
  // the chats list.
  const closePanel = useCallback(() => {
    if (canStepBack(window.history.state)) {
      window.history.back();
      return;
    }
    openAllChats();
  }, [openAllChats]);

  // All Chats is itself the fallback the panels close to, so it can't close to
  // itself — a deep link into it goes back to the composer.
  const closeAllChats = useCallback(() => {
    if (canStepBack(window.history.state)) {
      window.history.back();
      return;
    }
    startNewThread();
  }, [startNewThread]);

  // Back to the panel's list. Pop the detail entry when we pushed one (a mobile
  // drill-down), so Back doesn't land on a duplicate list entry afterwards.
  // On desktop the detail *is* the list's entry, so stepping back would leave
  // the panel — replace instead.
  const returnToPanelList = useCallback((kind: PanelKind) => {
    const listPath = panelListPath(kind);
    if (cameFrom(window.history.state, listPath)) {
      window.history.back();
      return;
    }
    replacePath(window.history, window.location, listPath);
    setRoutePath(listPath);
  }, []);

  // Load the invite count up front so the sidebar shows it without the user
  // having to open the panel. Best-effort: a failure just leaves the count off.
  useEffect(() => {
    void listInvites()
      .then((res) => setInviteQuota(res.quota))
      .catch(() => {});
  }, []);

  const openInvites = useCallback(() => openPanel("invites"), [openPanel]);

  const openFeedback = useCallback(() => {
    pushPath(window.history, window.location, "/feedback");
    setResolvedActiveThread(null);
    setRoutePath("/feedback");
    setRouteThreadId(null);
    setDraft(false);
    setThreadPanelOpen(false);
  }, [setResolvedActiveThread]);

  const openFeedbackInbox = useCallback(() => {
    pushPath(window.history, window.location, "/admin/feedback");
    setResolvedActiveThread(null);
    setRoutePath("/admin/feedback");
    setRouteThreadId(null);
    setDraft(false);
    setThreadPanelOpen(false);
  }, [setResolvedActiveThread]);

  // A run thread is opened from the automaton that produced it, so its topbar
  // offers the way back rather than the rail toggle.
  const openAutomatonRunThread = useCallback(
    (threadId: string) => navigateToThread(threadId, "push", backToHere(window.location)),
    [navigateToThread],
  );

  // The browser's own history, so Back and this button stay in lockstep. Safe
  // without a fallback: readBackTo only reports a stamp on an entry that has one
  // of ours behind it, and that entry is the one the stamp names — so the button
  // only exists when this lands somewhere. Re-navigating instead would be worse
  // than useless here: /chats?view=archived isn't a routePath, so synthesizing
  // the parent would drop the archived list back to the active one.
  const goBackFromThread = useCallback(() => {
    window.history.back();
  }, []);

  // Loading the initial thread list blocks navigation; creating a new thread does
  // not — creation/send is bound to that thread and safe to navigate away from.
  const navigationDisabled = loading;
  const activeThreadId = activeThread?.threadId ?? routeThreadId;
  const allChatsActive = routePath === "/chats";
  const panelRoute = useMemo(() => parsePanelRoute(routePath), [routePath]);
  const settingsActive = isSettingsPath(routePath);
  const feedbackActive = routePath === "/feedback";
  const feedbackInboxActive = panelRoute?.kind === "feedback-inbox";

  useEffect(() => {
    if (!feedbackInboxActive || feedbackAdminEnabled) return;
    replacePath(window.history, window.location, "/");
    setResolvedActiveThread(null);
    setRoutePath("/");
    setRouteThreadId(null);
    setDraft(true);
    setThreadPanelOpen(false);
  }, [feedbackAdminEnabled, feedbackInboxActive, setResolvedActiveThread]);

  // Drag in from the left edge to open the rail — it follows the finger. The
  // two-column layout has the rail pinned, so the gesture only exists where the
  // drawer is. And the panels and All Chats navigate with a back arrow rather
  // than the rail, so there is nothing there for the gesture to open.
  const railIsDrawer = !useWideLayout();
  const railIsReachable = !panelRoute && !settingsActive && !feedbackActive && !allChatsActive;
  useLeftEdgeDrawerDrag({
    enabled: railIsDrawer && railIsReachable,
    isOpen: threadPanelOpen,
    widthPx: RAIL_WIDTH_PX,
    onOpenChange: setThreadPanelOpen,
  });
  // Reading history.state during render is safe here: every navigation stamps the
  // entry before it calls setRoutePath, and popstate re-renders too — so the
  // label is recomputed against the entry currently on screen.
  const panelCloseLabel = useMemo(() => closeLabel(window.history.state), [routePath]);
  const notificationPromptKey =
    activeThread?.activityStatus === "running" && activeThread.currentTurnStartedAt
      ? `${activeThread.threadId}:${activeThread.currentTurnStartedAt}`
      : null;

  useEffect(() => {
    setBrowserNotificationPromptError(null);
  }, [notificationPromptKey]);

  useEffect(() => {
    if (!feedbackActive) return;
    let active = true;
    setFeedbackThreadError(null);
    void getOrCreateFeedbackThread()
      .then((thread) => {
        if (active) setFeedbackThread(thread);
      })
      .catch((error) => {
        if (active)
          setFeedbackThreadError(error instanceof Error ? error : new Error(String(error)));
      });
    return () => {
      active = false;
    };
  }, [feedbackActive]);

  const submitFeedbackMessage = useCallback(
    async (threadId: string, text: string, files: FileUIPart[]) => {
      const message: UIMessage = {
        id: crypto.randomUUID(),
        role: "user",
        parts: [...(text ? [{ type: "text" as const, text }] : []), ...files],
      };
      await sendFeedbackMessage({ threadId, message });
    },
    [],
  );

  const showBrowserNotificationPrompt =
    Boolean(activeThread) &&
    activeThread?.activityStatus === "running" &&
    typeof activeThread.currentTurnStartedAt === "number" &&
    notificationPromptNow - activeThread.currentTurnStartedAt >= 12_000 &&
    browserNotificationSupport.supported &&
    browserNotificationSupport.permission !== "denied" &&
    (browserNotifications?.browserPushEnabled === false ||
      browserNotifications?.deviceSubscribed === false) &&
    browserNotifications.vapidPublicKey !== null &&
    notificationPromptKey !== dismissedNotificationPromptKey;

  // What the rail is holding while it is a drawer and out of sight. The same
  // recent window the unsearched sidebar renders — dismissed threads and
  // anything past the cap live in All chats, so they must not badge a toggle
  // that then shows nothing of them.
  const railToggleBadge = useMemo(
    () => railToggleIndicator(sidebarRailThreads(threads, activeThreadId)),
    [threads, activeThreadId],
  );

  // Read fresh on every render rather than memoised on routePath: pushState
  // doesn't re-render on its own, so the stamp is only ever correct as of now.
  const threadBackTo = readBackTo(window.history.state);
  const threadNav = (
    <ThreadNavButton
      backTo={threadBackTo}
      onBack={goBackFromThread}
      onToggleThreads={() => setThreadPanelOpen((open) => !open)}
      badge={railToggleBadge}
    />
  );

  const rail = (
    <RailContent
      threads={threads}
      threadsNextCursor={threadsNextCursor}
      onThreadsLoaded={mergeThreadsPage}
      activeThreadId={activeThreadId}
      allChatsActive={allChatsActive}
      panelKind={panelRoute?.kind ?? null}
      disabled={navigationDisabled}
      loading={loading}
      creating={creating}
      projects={projects}
      onNewThread={startNewThread}
      onSelectThread={selectThread}
      onOpenAllChats={openAllChats}
      onMoveThread={moveThread}
      onCreateProject={createProjectForThread}
      onMarkThreadRead={markThreadRead}
      onDismissThread={dismissThread}
      onCloseDrawer={() => setThreadPanelOpen(false)}
      user={user}
      onOpenProjects={openProjects}
      onOpenAutomata={openAutomata}
      onOpenInvites={openInvites}
      inviteQuota={inviteQuota}
      onOpenFeedback={openFeedback}
      feedbackAdminEnabled={feedbackAdminEnabled}
      onOpenFeedbackInbox={openFeedbackInbox}
      onOpenSettings={openSettings}
      onSignOut={onSignOut}
    />
  );

  return (
    <MaybeThreadChatProvider value={threadChat}>
      <div className="flex h-dvh flex-col bg-background pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
        <div className="flex min-h-0 flex-1">
          {/* Desktop sidebar */}
          <aside
            className="hidden w-72 shrink-0 border-border border-r bg-card wide:flex wide:flex-col"
            aria-label="Chat navigation"
          >
            {rail}
          </aside>

          {/* Mobile drawer */}
          <Sheet open={threadPanelOpen} onOpenChange={setThreadPanelOpen}>
            <SheetContent
              side="left"
              showCloseButton={false}
              // data-rail scopes the drag styles to this sheet; --rail-width keeps the
              // gesture and the CSS agreeing on how wide "fully open" is.
              data-rail=""
              style={{ "--rail-width": `${RAIL_WIDTH_PX}px` } as CSSProperties}
              // Portalled to <body>, so it sits outside the shell's safe-area
              // padding and has to clear the notch itself. Padding, not width: the
              // drag gesture and --rail-width agree on 18rem, and growing the
              // sheet would desync them.
              className="w-72 bg-card p-0 pl-[env(safe-area-inset-left)]"
            >
              <SheetHeader className="sr-only">
                <SheetTitle>Chats</SheetTitle>
              </SheetHeader>
              {rail}
            </SheetContent>
          </Sheet>

          <main className="flex min-w-0 flex-1 flex-col">
            {allChatsActive ? (
              <AllChatsView
                threads={threads}
                onThreadsLoaded={mergeThreadsPage}
                projects={projects}
                disabled={navigationDisabled}
                showArchived={chatsView === "archived"}
                onShowArchivedChange={showArchivedChats}
                onSelectThread={openThreadFromCurrentScreen}
                onArchiveThread={archiveThread}
                onDeleteThread={deleteThread}
                onMarkThreadRead={markThreadRead}
                onBack={closeAllChats}
              />
            ) : panelRoute?.kind === "projects" ? (
              <ProjectsPanel
                projects={projects}
                threads={threads}
                onThreadsLoaded={mergeThreadsPage}
                onProjectsChange={setProjects}
                selectedId={panelRoute.selectedId}
                onSelect={(id, mode) => selectPanelItem("projects", id, mode)}
                onBackToList={() => returnToPanelList("projects")}
                onSelectThread={openThreadFromCurrentScreen}
                onManageWorkbenches={() => openSettings("workbenches")}
                closeLabel={panelCloseLabel}
                onClose={closePanel}
              />
            ) : panelRoute?.kind === "automata" ? (
              <AutomataPanel
                projects={projects}
                selectedId={panelRoute.selectedId}
                onSelect={(id, mode) => selectPanelItem("automata", id, mode)}
                onBackToList={() => returnToPanelList("automata")}
                onOpenThread={openAutomatonRunThread}
                closeLabel={panelCloseLabel}
                onClose={closePanel}
              />
            ) : panelRoute?.kind === "invites" ? (
              <InvitesPanel
                onQuotaChange={setInviteQuota}
                closeLabel={panelCloseLabel}
                onClose={closePanel}
              />
            ) : feedbackActive ? (
              feedbackThread ? (
                <ThreadChatConnected
                  thread={feedbackThread}
                  consentWorkspaceId={consentWorkspaceId}
                  backgroundWorkEnabled={false}
                  historyReloadNonce={threadReloadNonce}
                  projects={[]}
                  leading={<BackButtonLike label={panelCloseLabel} onClick={closePanel} />}
                  attachmentAccept="image/png,image/jpeg,image/webp,image/gif"
                  maxFiles={5}
                  composerPlaceholder="Tell Nadi what happened…"
                  feedbackMode
                  onFeedbackSend={submitFeedbackMessage}
                  voiceEnabled={false}
                  onRetryHistory={() => setThreadReloadNonce((n) => n + 1)}
                />
              ) : (
                <FeedbackPanel
                  closeLabel={panelCloseLabel}
                  onClose={closePanel}
                  error={feedbackThreadError}
                />
              )
            ) : feedbackInboxActive ? (
              feedbackAdminEnabled ? (
                <Suspense
                  fallback={
                    <div className="flex min-h-0 flex-1 items-center justify-center">
                      <Spinner className="size-6 text-muted-foreground" label="Loading" />
                    </div>
                  }
                >
                  <FeedbackInbox
                    selectedId={panelRoute.selectedId}
                    revision={feedbackInboxRevision}
                    closeLabel={panelCloseLabel}
                    onClose={closePanel}
                    onBackToList={() => returnToPanelList("feedback-inbox")}
                    onSelect={(id, mode) => selectPanelItem("feedback-inbox", id, mode)}
                  />
                </Suspense>
              ) : null
            ) : settingsActive ? (
              // A panel-sized fallback, not FullScreenLoader: this renders beside the
              // sidebar, so a min-h-dvh box would overflow the shell.
              <Suspense
                fallback={
                  <div className="flex min-h-0 flex-1 items-center justify-center">
                    <Spinner className="size-6 text-muted-foreground" label="Loading" />
                  </div>
                }
              >
                <Settings
                  consentWorkspaceId={consentWorkspaceId}
                  voiceEnabled={voiceEnabled}
                  workbenchNetworkAllowlistEnabled={workbenchNetworkAllowlistEnabled}
                  tab={parseSettingsTab(routePath)}
                  onTabChange={selectSettingsTab}
                  routePath={routePath}
                  onNavigate={navigateSettingsPath}
                  closeLabel={panelCloseLabel}
                  onClose={closePanel}
                />
              </Suspense>
            ) : activeThread ? (
              isReadOnlyThread(activeThread) ? (
                <LegacyArchiveThread
                  key={activeThread.threadId}
                  thread={activeThread}
                  projects={projects}
                  showReasoning={agentShowReasoning}
                  leading={threadNav}
                  onDeleteThread={deleteThread}
                />
              ) : (
                // ThreadChat suspends while it loads the thread's message history, so
                // React would otherwise hold the previous thread on screen for the
                // whole fetch. ThreadChatConnected owns the Suspense boundary (and
                // the agent socket, which must be opened outside it — see its doc
                // comment). Keyed by threadId so each switch is a fresh boundary that
                // shows the fallback immediately, and so a failed thread doesn't
                // poison the next one opened.
                <ThreadChatConnected
                  key={activeThread.threadId}
                  onRetryHistory={() => setThreadReloadNonce((n) => n + 1)}
                  consentWorkspaceId={consentWorkspaceId}
                  backgroundWorkEnabled={backgroundWorkEnabled}
                  thread={activeThread}
                  historyReloadNonce={threadReloadNonce}
                  projects={projects}
                  providers={newChatProviders}
                  showReasoning={agentShowReasoning}
                  leading={threadNav}
                  pendingFirstMessage={pendingFirstMessage}
                  onRetryFirstMessage={retryFirstMessage}
                  onSettleFirstMessage={settleFirstMessage}
                  onRename={handleRenameThread}
                  onReasoningEffortChange={handleThreadReasoningEffort}
                  onMoveThread={moveThread}
                  onCreateProjectForThread={createProjectForThread}
                  onArchiveThread={archiveThread}
                  onDeleteThread={deleteThread}
                  workbenches={workbenches}
                  onSwitchWorkbench={switchWorkbench}
                  attachmentAccept={activeThreadAttachmentAccept}
                  voiceEnabled={voiceEnabled}
                  browserNotificationPrompt={
                    showBrowserNotificationPrompt
                      ? {
                          busy: browserNotificationsBusy,
                          error: browserNotificationPromptError,
                          onDismiss: () => {
                            if (notificationPromptKey) {
                              setDismissedNotificationPromptKey(notificationPromptKey);
                            }
                          },
                          onEnable: () => enableBrowserNotifications(),
                        }
                      : null
                  }
                />
              )
            ) : pendingThreadCreation && routePath === "/" ? (
              <PendingNewThreadView
                leading={threadNav}
                text={pendingThreadCreation.text}
                files={pendingThreadCreation.files}
                provider={pendingThreadCreation.provider}
                model={pendingThreadCreation.model}
              />
            ) : draft ? (
              <NewChatView
                onCreateAndSend={createAndSend}
                leading={threadNav}
                creating={creating}
                error={threadError}
                seedText={draftText}
                seedFiles={draftFiles}
                providers={newChatProviders}
                anyUsableProvider={newChatAnyUsable}
                projects={projects}
                provider={newChatProvider}
                model={newChatModel}
                projectId={newChatProjectId}
                onProviderChange={(nextProvider) => {
                  const state = selectNewChatProvider(nextProvider, {
                    providers: newChatProviders,
                    anyUsableProvider: newChatAnyUsable,
                    provider: newChatProvider,
                    model: newChatModel,
                    modelInputModalities: newChatModelInputModalities,
                    reasoningEffort: newChatReasoningEffort,
                    modelSupportsReasoning: newChatModelSupportsReasoning,
                    modelReasoningControls: newChatReasoningControls,
                  });
                  setNewChatProvider(state.provider);
                  setNewChatModel(state.model);
                  setNewChatModelInputModalities(state.modelInputModalities);
                  setNewChatModelSupportsReasoning(state.modelSupportsReasoning);
                  setNewChatReasoningControls(state.modelReasoningControls);
                }}
                onModelChange={(nextModel) => {
                  const state = typeNewChatModel(nextModel, {
                    providers: newChatProviders,
                    anyUsableProvider: newChatAnyUsable,
                    provider: newChatProvider,
                    model: newChatModel,
                    modelInputModalities: newChatModelInputModalities,
                    reasoningEffort: newChatReasoningEffort,
                    modelSupportsReasoning: newChatModelSupportsReasoning,
                    modelReasoningControls: newChatReasoningControls,
                  });
                  setNewChatModel(state.model);
                  setNewChatModelInputModalities(state.modelInputModalities);
                  setNewChatModelSupportsReasoning(state.modelSupportsReasoning);
                  setNewChatReasoningControls(state.modelReasoningControls);
                }}
                onModelSelected={(selectedModel) => {
                  const state = selectNewChatModelModalities(selectedModel.inputModalities, {
                    providers: newChatProviders,
                    anyUsableProvider: newChatAnyUsable,
                    provider: newChatProvider,
                    model: newChatModel,
                    modelInputModalities: newChatModelInputModalities,
                    reasoningEffort: newChatReasoningEffort,
                    modelSupportsReasoning: newChatModelSupportsReasoning,
                    modelReasoningControls: newChatReasoningControls,
                  });
                  setNewChatModelInputModalities(state.modelInputModalities);
                  const withReasoning = selectNewChatModelReasoning(
                    selectedModel.reasoning,
                    state,
                    selectedModel.reasoningControls,
                  );
                  setNewChatModelSupportsReasoning(withReasoning.modelSupportsReasoning);
                  setNewChatReasoningControls(withReasoning.modelReasoningControls);
                }}
                reasoningEffort={newChatReasoningEffort}
                onReasoningEffortChange={setNewChatReasoningEffort}
                modelSupportsReasoning={newChatModelSupportsReasoning}
                modelReasoningControls={newChatReasoningControls}
                onProjectChange={setNewChatProjectId}
                onCreateProject={handleCreateProject}
                workbenchId={newChatWorkbenchId}
                workbenches={workbenches}
                onWorkbenchChange={setNewChatWorkbenchId}
                onManageWorkbenches={() => openSettings("workbenches")}
                attachmentAccept={newChatAttachmentAccept}
                modelInputModalities={newChatModelInputModalities}
                voiceEnabled={voiceEnabled}
                nudgePrompt={nudgePrompt}
                onNudgeShown={() => {
                  if (typeof localStorage !== "undefined") takeAutomatonNudge(localStorage);
                }}
                onDismissNudge={() => setNudgePrompt(null)}
              />
            ) : (
              <ThreadStatusView
                threadId={routeThreadId}
                error={threadError}
                creating={creating}
                onNewThread={startNewThread}
                leading={threadNav}
              />
            )}
          </main>
        </div>
      </div>
    </MaybeThreadChatProvider>
  );
}

function MaybeThreadChatProvider({
  value,
  children,
}: {
  value?: ThreadChatImpl;
  children: ReactNode;
}) {
  if (!value) return <>{children}</>;
  return <ThreadChatImplContext.Provider value={value}>{children}</ThreadChatImplContext.Provider>;
}

function ArchiveThreadDialog({
  thread,
  onOpenChange,
  onConfirm,
}: {
  thread: ThreadSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (threadId: string) => void;
}) {
  return (
    <AlertDialog open={thread !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive chat?</AlertDialogTitle>
          <AlertDialogDescription>
            {thread ? `“${thread.title}” will move out of active chats and become read-only.` : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            onClick={() => {
              if (thread) onConfirm(thread.threadId);
            }}
          >
            Archive
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DeleteThreadDialog({
  thread,
  onOpenChange,
  onConfirm,
}: {
  thread: ThreadSummary | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (threadId: string) => void;
}) {
  return (
    <AlertDialog open={thread !== null} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete chat?</AlertDialogTitle>
          <AlertDialogDescription>
            {thread
              ? `“${thread.title}” and its messages will be permanently deleted. This can't be undone.`
              : ""}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={() => {
              if (thread) onConfirm(thread.threadId);
            }}
          >
            Delete
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// Exported for the preview harness (preview.html?screen=all-chats), like
// RailContent — a long list is the thing worth looking at here, and the harness
// is the only place to get one without a backend.
export function AllChatsView({
  threads,
  onThreadsLoaded,
  projects,
  disabled,
  showArchived,
  onShowArchivedChange,
  onSelectThread,
  onArchiveThread,
  onDeleteThread,
  onMarkThreadRead,
  onBack,
}: {
  threads: ThreadSummary[];
  onThreadsLoaded: (threads: ThreadSummary[]) => void;
  projects: ProjectSummary[];
  disabled: boolean;
  showArchived: boolean;
  onShowArchivedChange: (archived: boolean) => void;
  onSelectThread: (threadId: string) => void;
  onArchiveThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onMarkThreadRead: (threadId: string) => void;
  /** All Chats is a destination you go to, so it goes back — it never opens the rail. */
  onBack: () => void;
}) {
  const [pendingArchive, setPendingArchive] = useState<ThreadSummary | null>(null);
  const [pendingDelete, setPendingDelete] = useState<ThreadSummary | null>(null);
  // The filter lives here, not in ChatApp. It is a view concern of this screen:
  // the rail must keep showing every chat regardless of what is selected here,
  // and it has no filter control of its own to explain a narrowed list.
  const [projectFilter, setProjectFilter] = useState<ProjectThreadFilter>("all");

  // A project deleted out from under the filter falls back to showing everything.
  useEffect(() => {
    if (projectFilter === "all" || projectFilter === "unassigned") return;
    if (projects.some((project) => project.id === projectFilter)) return;
    setProjectFilter("all");
  }, [projectFilter, projects]);

  // The active half merges into the SHARED array — App owns it. It seeds from
  // that array for free (it IS page one of (active, all)), so a filter of
  // "all" with the array already populated renders instantly, no spinner.
  const activeQuery = useThreadQuery({
    key: `all-chats-active:${projectFilter}`,
    fetchPage: (cursor) =>
      listThreads(fetch, "active", projectFilter, {
        limit: THREAD_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }).catch((err: unknown) => {
        // A network failure throws the platform's raw TypeError (listThreads
        // only routes non-OK responses through errorFromResponse); render a
        // human, action-specific message instead of "Failed to fetch".
        if (isNetworkFailure(err)) {
          throw new Error("You're offline. Reconnect to load chats.");
        }
        throw err;
      }),
    onPage: (page) => onThreadsLoaded(page),
    enabled: !showArchived,
  });

  // Archived threads are fetched separately and lazily: the live `threads` prop
  // is the active set, and the thread.archived socket event removes threads from
  // it, so an archived view needs its own source. Local state ONLY — the rail
  // renders the shared array unfiltered, so a merged archived page would
  // surface archived chats there.
  const [archived, setArchived] = useState<ThreadSummary[] | null>(null);

  // The archived query's own key change already refetches on a filter change,
  // but that lands asynchronously — clear the rows right away so the previous
  // filter's archived chats don't render under the new one in the meantime.
  useEffect(() => {
    setArchived(null);
  }, [projectFilter]);

  const archivedQuery = useThreadQuery({
    key: `all-chats-archived:${projectFilter}`,
    fetchPage: (cursor) =>
      listThreads(fetch, "archived", projectFilter, {
        limit: THREAD_PAGE_SIZE,
        ...(cursor ? { cursor } : {}),
      }).catch((err: unknown) => {
        // A network failure throws the platform's raw TypeError (listThreads
        // only routes non-OK responses through errorFromResponse); render a
        // human, action-specific message instead of "Failed to fetch".
        if (isNetworkFailure(err)) {
          throw new Error("You're offline. Reconnect to load archived chats.");
        }
        throw err;
      }),
    onPage: (page, { reset }) =>
      setArchived((current) => (reset ? page : [...(current ?? []), ...page])),
    enabled: showArchived,
  });

  const query = showArchived ? archivedQuery : activeQuery;

  // Archiving is only offered on the active tab, so the archived query is
  // `enabled: false` here and `reload()` would issue no fetch (it resets
  // cursor/exhausted, then bails — see use-thread-query.ts). It also leaves
  // the cached rows alone, so clear them directly: the next archived-tab open
  // then refetches from a spinner rather than rendering the stale set that is
  // missing this thread.
  const handleArchive = (threadId: string) => {
    onArchiveThread(threadId);
    setArchived(null);
  };

  // Deleting is permanent. Drop it from the cached archived set too so it does
  // not linger when the archived tab is reopened.
  const handleDelete = (threadId: string) => {
    onDeleteThread(threadId);
    setArchived((current) =>
      current === null ? current : current.filter((t) => t.threadId !== threadId),
    );
  };

  // The rendered list is a LOCAL FILTER over the shared array for the active
  // half — never over a fetched page — so live socket updates keep working.
  // See ThreadList's search (App.tsx above) for the same shape.
  const visibleThreads = showArchived
    ? (archived ?? [])
    : threads.filter((thread) => threadMatchesProjectFilter(thread, projectFilter));
  // Rebuilt inline above, so its identity changes every render — the reset has
  // to name the view instead, or the list would snap back to page one forever.
  const paged = useProgressiveList(visibleThreads, {
    pageSize: ALL_CHATS_PAGE_SIZE,
    resetKey: `${showArchived ? "archived" : "active"}:${projectFilter}`,
  });

  // The budget reveals a page of rows at a time; once it has nothing left to
  // reveal but the server has more, fetch the next page. `loadMore` guards on
  // loading/exhausted itself. Every server page for a filter matches that
  // filter, but that alone doesn't guarantee NOVELTY: `onPage` merges by id
  // (mergeThreadsPage / the archived append), and the rail's server-backed
  // search can advance the shared array ahead of this query's own cursor —
  // so a page can be 100% duplicates and add zero visible rows, leaving both
  // `paged.hasMore` AND `visibleThreads.length` unchanged. `query.loading` is
  // the one thing that DOES move on every page, no-op or not (it flips
  // true→false when the fetch resolves), so it's what re-evaluates this
  // effect after a duplicate page lands. The loop still converges: `loadMore`
  // bails once `exhaustedRef` is set (use-thread-query.ts), so a run of
  // duplicate pages keeps fetching until the query is actually exhausted
  // instead of stalling silently.
  //
  // `query.error === null` is a required guard, not decoration: a failed
  // fetch never sets `exhausted` (see use-thread-query.ts's error branch), so
  // without it a failure with an empty/short list would re-trigger `loadMore`
  // on every `query.loading` flip from the auto-retry itself — an unthrottled
  // retry storm that also starves the error row (loading flickers true again
  // before the caller ever sees `error` render). The tradeoff: this effect
  // itself never clears `error` and never fires `loadMore` again once it's
  // set, so paging is dead until something does. Nothing here does that
  // automatically — the Retry buttons on the error surfaces below call
  // `query.reload()` directly, which is what actually clears `error` and
  // restarts the fetch loop.
  useEffect(() => {
    if (!paged.hasMore && query.hasMore && query.error === null) query.loadMore();
  }, [paged.hasMore, query.hasMore, query.error, query.loading, query.loadMore]);

  const listEmpty = isThreadListEmpty({
    count: visibleThreads.length,
    loading: query.loading,
    exhausted: query.exhausted,
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        leading={
          <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back" title="Back">
            <ArrowLeft aria-hidden />
          </Button>
        }
        breadcrumb={<span className="truncate text-foreground">All chats</span>}
      />
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto flex w-full max-w-content flex-col gap-3 p-4 sm:p-6">
          <div className="space-y-1">
            <h1 className="font-semibold text-2xl text-foreground">All chats</h1>
            <p className="text-muted-foreground text-sm">
              {showArchived
                ? "Archived conversations are read-only."
                : "Browse active conversations, newest first."}
            </p>
          </div>

          <ButtonGroup aria-label="Filter chats">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={!showArchived}
              className={cn(!showArchived && "bg-accent text-accent-foreground")}
              onClick={() => onShowArchivedChange(false)}
            >
              Active
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={showArchived}
              className={cn(showArchived && "bg-accent text-accent-foreground")}
              onClick={() => onShowArchivedChange(true)}
            >
              Archived
            </Button>
          </ButtonGroup>
          <div className="max-w-xs">
            <ProjectThreadFilterSelect
              value={projectFilter}
              projects={projects}
              onValueChange={setProjectFilter}
              disabled={disabled}
            />
          </div>

          {query.error !== null && visibleThreads.length === 0 ? (
            // Only the full-screen box: a non-empty list must never be wiped
            // by a failed page fetch (e.g. a mid-scroll loadMore while
            // offline) — that would blank already-rendered chats and lose
            // scroll position. A failure with rows on screen degrades to the
            // inline error row below the list instead.
            //
            // `query.reload()` is the only thing that clears `error` short of
            // a key/enabled change — without a button wired to it here, the
            // "reconnect" copy above promises a recovery path that doesn't
            // exist. Safe to call unconditionally: this box only renders on
            // the currently-visible half (active or archived), which is
            // always `enabled` by construction (see `query` above).
            <div className="flex flex-col items-center gap-3 rounded-lg border border-border bg-card p-6 text-center text-destructive text-sm">
              {query.error.message}
              <Button variant="outline" size="sm" onClick={() => query.reload()}>
                Try again
              </Button>
            </div>
          ) : listEmpty ? (
            <div className="rounded-lg border border-border bg-card p-6 text-muted-foreground text-sm">
              {showArchived
                ? "Nothing archived yet."
                : projectFilter === "all"
                  ? "No chats yet."
                  : "No chats in this project."}
            </div>
          ) : visibleThreads.length === 0 ? (
            <div
              className="flex items-center gap-2 rounded-lg border border-border bg-card p-6 text-muted-foreground text-sm"
              aria-busy="true"
            >
              <Spinner
                className="size-4"
                label={showArchived ? "Loading archived chats" : "Loading chats"}
              />
              {showArchived ? "Loading archived chats…" : "Loading chats…"}
            </div>
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card" role="list">
              {paged.visible.map((thread) => {
                return (
                  <div
                    key={thread.threadId}
                    className="flex min-w-0 items-center border-border border-b transition-colors last:border-b-0 hover:bg-accent/60"
                    role="listitem"
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 flex-col gap-1 px-4 py-3 text-left disabled:opacity-50"
                      disabled={disabled}
                      onClick={() => onSelectThread(thread.threadId)}
                    >
                      <span className="flex w-full min-w-0 items-center gap-1.5">
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground text-sm">
                          {thread.title}
                        </span>
                        <ThreadIndicator thread={thread} />
                      </span>
                      {thread.projectName && (
                        <div className="flex w-full min-w-0">
                          <ThreadProjectBadge thread={thread} />
                        </div>
                      )}
                      <span className="flex w-full min-w-0 items-center gap-1 text-muted-foreground text-xs">
                        {showArchived && <Archive aria-hidden className="size-3 shrink-0" />}
                        <span className="truncate">
                          {showArchived ? formatArchivedMeta(thread) : formatThreadMeta(thread)}
                        </span>
                      </span>
                      {/* No preview line — the meta line above is the subtitle.
                          See ThreadRow: the projector filling `lastMessagePreview`
                          lit this up; it is a search input, not a display field. */}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="mr-2 size-8 shrink-0 text-muted-foreground hover:text-foreground"
                          disabled={disabled}
                          aria-label={`Actions for ${thread.title}`}
                          title={`Actions for ${thread.title}`}
                        >
                          <DotsThreeVertical aria-hidden className="size-5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-48">
                        {!showArchived && thread.unreadOutcome != null && (
                          <DropdownMenuItem
                            onSelect={() => onMarkThreadRead(thread.threadId)}
                          >
                            <Eye aria-hidden />
                            Mark as read
                          </DropdownMenuItem>
                        )}
                        {!showArchived && (
                          <DropdownMenuItem onSelect={() => setPendingArchive(thread)}>
                            <Archive aria-hidden />
                            Archive
                          </DropdownMenuItem>
                        )}
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setPendingDelete(thread)}
                        >
                          <Trash aria-hidden />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                );
              })}
              {paged.hasMore && (
                <ShowMoreRow
                  remaining={paged.remaining}
                  noun="chat"
                  onShowMore={paged.showMore}
                  sentinelRef={paged.sentinelRef}
                />
              )}
              {query.error !== null ? (
                // Alongside ShowMoreRow, not instead of it: the active query's
                // page-one fetch fires on mount regardless of the render
                // budget, so a failure can land while the budget still has
                // cached rows left to reveal (`paged.hasMore` true) — gating
                // this on `!paged.hasMore` left that case with a "Show more"
                // button and no indication the fetch behind it had failed.
                // The list stays on screen either way; only this row reports
                // the failure so a mid-scroll page fetch failing (e.g. going
                // offline) doesn't wipe rows already rendered. Retry calls
                // `query.reload()` the same as the full-screen box above —
                // without it this row was a permanent latch: nothing but a
                // key/enabled change (filter, Active<->Archived, or leaving
                // and re-entering the screen) ever cleared `error`.
                <div className="flex items-center justify-between gap-2 px-4 py-3 text-destructive text-sm">
                  {query.error.message}
                  <Button variant="ghost" size="xs" onClick={() => query.reload()}>
                    <ArrowsClockwise aria-hidden />
                    Retry
                  </Button>
                </div>
              ) : (
                !paged.hasMore &&
                query.loading && (
                  <div className="flex items-center gap-2 px-4 py-3 text-muted-foreground text-sm">
                    <Spinner className="size-3.5" />
                    Loading more…
                  </div>
                )
              )}
            </div>
          )}
        </main>
      </ScrollArea>

      <ArchiveThreadDialog
        thread={pendingArchive}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        onConfirm={(threadId) => {
          handleArchive(threadId);
          setPendingArchive(null);
        }}
      />

      <DeleteThreadDialog
        thread={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        onConfirm={(threadId) => {
          handleDelete(threadId);
          setPendingDelete(null);
        }}
      />
    </div>
  );
}

// Exported for the preview harness (preview.html?screen=new-chat-width), like
// AllChatsView — the composer's reading-column width is the thing worth looking
// at, and it only reads true against the real component.
export function NewChatView({
  onCreateAndSend,
  leading,
  creating,
  error,
  seedText,
  seedFiles,
  providers,
  anyUsableProvider,
  projects,
  provider,
  model,
  projectId,
  onProviderChange,
  onModelChange,
  onModelSelected,
  reasoningEffort,
  onReasoningEffortChange,
  modelSupportsReasoning,
  modelReasoningControls,
  onProjectChange,
  onCreateProject,
  workbenchId,
  workbenches,
  onWorkbenchChange,
  onManageWorkbenches,
  attachmentAccept,
  modelInputModalities,
  voiceEnabled,
  nudgePrompt,
  onNudgeShown,
  onDismissNudge,
}: {
  onCreateAndSend: (text: string, files: FileUIPart[]) => void;
  leading: React.ReactNode;
  creating: boolean;
  error: Error | null;
  seedText: string | null;
  seedFiles: FileUIPart[];
  providers: ProviderSettingsView[];
  /** Distinguishes "no credentials" from "no models turned on" in the empty state. */
  anyUsableProvider: boolean;
  projects: ProjectSummary[];
  provider: SettingsProvider | null;
  model: string;
  projectId: "none" | string;
  onProviderChange: (provider: SettingsProvider) => void;
  onModelChange: (model: string) => void;
  /** The whole record, not just modalities: the composer needs `reasoning` to
   *  decide whether to offer the thinking control. */
  onModelSelected: (model: ProviderModelSearchResult) => void;
  reasoningEffort: ReasoningEffort;
  onReasoningEffortChange: (effort: ReasoningEffort) => void;
  modelSupportsReasoning: boolean | null;
  modelReasoningControls: ReasoningControl[] | undefined;
  onProjectChange: (projectId: "none" | string) => void;
  onCreateProject: (name: string) => Promise<void>;
  workbenchId: "none" | string;
  workbenches: WorkbenchSummary[];
  onWorkbenchChange: (workbenchId: "none" | string) => void;
  onManageWorkbenches: () => void;
  attachmentAccept?: string;
  modelInputModalities: ModelInputModality[];
  voiceEnabled?: boolean;
  /** One-shot post-onboarding prompt seeded into the composer, or null. */
  nudgePrompt: string | null;
  /** Fired the first time the nudge actually reaches the screen, so the stored
   *  one-shot is consumed at render rather than at app mount. */
  onNudgeShown: () => void;
  onDismissNudge: () => void;
}) {
  const canSend = canStartNewChat({ provider, model });
  const offline = useOffline();
  const composerRef = useRef<ComposerHandle | null>(null);
  const [nudgeVisible, setNudgeVisible] = useState(nudgePrompt !== null);
  // The seeded text is not a gesture, so it must not raise the software
  // keyboard — on a phone that would cover the callout explaining the text.
  const [suppressAutoFocus] = useState(nudgePrompt !== null);
  const seededRef = useRef(false);
  useEffect(() => {
    if (nudgePrompt === null || seededRef.current) return;
    seededRef.current = true;
    composerRef.current?.replaceText(nudgePrompt, { focus: false });
    onNudgeShown();
  }, [nudgePrompt, onNudgeShown]);

  const dismissNudge = useCallback(() => {
    setNudgeVisible(false);
    onDismissNudge();
  }, [onDismissNudge]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        leading={leading}
        breadcrumb={<span className="truncate text-foreground">New chat</span>}
      />
      {/* Empty state fills the message area; the composer is pinned to the
          bottom (same position and width as an active thread) so activating the
          chat swaps content in place without shifting the composer. A flex-1
          spacer pushes the heading and starters down so they cluster just above
          the composer, left-aligned to the composer container (px-3 mirrors the
          composer's m-3 / project tab's mx-3); pb-6 keeps a little air below the
          block before the project tab. */}
      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        <div className="min-h-0 flex-1" />
        <div className="flex flex-col items-start gap-4 px-3 pb-6">
          <h1 className="font-display font-semibold text-2xl text-foreground">
            What can Nadi help you with?
          </h1>
          {/* Starters answer the heading directly. Picking one drops its prompt
              into the composer below — a running start for the trip, a complete
              sentence for the rest. */}
          <PromptSuggestions
            suggestions={NEW_CHAT_SUGGESTIONS}
            onPick={(prompt) => composerRef.current?.replaceText(prompt)}
            disabled={creating}
          />
          {error && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                Couldn&apos;t start the thread: {error.message} Your message was kept below — try
                sending again.
              </AlertDescription>
            </Alert>
          )}
          {/* Offline, this would blame provider config for a network problem and
              point at Settings, which is read-only offline — the offline banner
              plus the composer hint below already explain the real situation. */}
          {providers.length === 0 && !offline && (
            <Alert role="status">
              <AlertDescription>
                {/* Two different dead ends reach this line. Blaming provider
                    config when the real cause is a workspace that unticked every
                    model sends the user to the wrong page. */}
                {anyUsableProvider
                  ? "No models are turned on. Choose some in Settings → Providers before starting a chat."
                  : "Configure a usable provider in Settings before starting a chat."}
              </AlertDescription>
            </Alert>
          )}
          {nudgeVisible && nudgePrompt !== null && (
            <div
              className="relative w-full rounded-lg border border-border bg-card p-3 pr-9"
              role="status"
            >
              <p className="text-sm">
                Your agent can work on a schedule. Send this to set up your first one.
              </p>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute top-1.5 right-1.5"
                onClick={dismissNudge}
                aria-label="Dismiss"
              >
                <XCircle aria-hidden />
              </Button>
            </div>
          )}
        </div>
        {/* Project context docks as an extension of the composer: left-aligned
            to the card's edge (mx-3 mirrors the Composer's m-3) and sitting
            directly on top of it, so the outline trigger reads as a context tab
            on the input rather than a stray centered pill. */}
        <div className="mx-3 -mb-1 flex min-w-0 gap-2">
          <ProjectPicker
            value={projectId}
            projects={projects}
            onValueChange={onProjectChange}
            onCreateProject={onCreateProject}
            disabled={creating}
            compact
          />
          <WorkbenchPicker
            value={workbenchId}
            workbenches={workbenches}
            emptyLabel="Inherit"
            onValueChange={onWorkbenchChange}
            onManageWorkbenches={onManageWorkbenches}
            disabled={creating}
            compact
          />
        </div>
        {/* Re-seed the Composer with the preserved text while creating (input
            stays visible but disabled) and on failure (for retry). The key
            forces a remount so the uncontrolled textarea picks up defaultValue.
            While creating, the remounted Composer clears its own attachment
            previews, so we mirror the captured files as read-only chips beside
            the + button via previewFiles. */}
        <Composer
          key={seedText ?? "new"}
          controlRef={composerRef}
          onSend={(text, files) => {
            dismissNudge();
            onCreateAndSend(text, files);
          }}
          onDraftChange={(text) => {
            if (nudgeVisible && text !== nudgePrompt) dismissNudge();
          }}
          uploadAttachments={canSend && attachmentAccept ? compressToDataUrlAttachments : undefined}
          attachmentAccept={canSend ? attachmentAccept : undefined}
          modelInputModalities={modelInputModalities}
          previewFiles={creating ? seedFiles : []}
          disabled={creating || !canSend}
          sendBlocked={offline}
          statusHint={offline ? "Offline — reconnect to start a chat" : undefined}
          status={creating ? "submitted" : undefined}
          defaultValue={seedText ?? undefined}
          safeAreaBottom
          voiceEnabled={voiceEnabled}
          autoFocus={canSend && !suppressAutoFocus}
          footerTrailing={
            provider && (
              <>
                {shouldOfferEffortControl({ provider, modelSupportsReasoning }) && (
                  <EffortDial
                    triggerId="new-chat-effort"
                    effort={reasoningEffort}
                    options={availableEffortOptions(modelReasoningControls)}
                    onEffortChange={onReasoningEffortChange}
                    disabled={creating}
                  />
                )}
                <ModelPicker
                  variant="composer"
                  triggerId="new-chat-model"
                  triggerLabel="New chat model"
                  providers={toModelPickerProviders(providers)}
                  provider={provider}
                  model={model}
                  placeholder={SETTINGS_PROVIDER_MODEL_PLACEHOLDERS[provider]}
                  disabled={creating}
                  onProviderChange={onProviderChange}
                  onModelChange={onModelChange}
                  onModelSelected={onModelSelected}
                />
              </>
            )
          }
        />
      </div>
    </div>
  );
}

function PendingNewThreadView({
  leading,
  text,
  files,
  provider,
  model,
}: {
  leading: React.ReactNode;
  text: string;
  files: FileUIPart[];
  provider?: SettingsProvider;
  model?: string;
}) {
  // Same trigger, wrapped instead of the plain badge, so this footer slot
  // reads identically whether the composer is live or (as here) disabled
  // while the thread is still being created — no relayout on the swap. It
  // can't be operated: the picker's own `disabled` blocks the popover, and
  // there is no thread yet to carry a pending switch.
  const tuple: ModelTuple | null = provider && model ? { provider, model } : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        leading={leading}
        breadcrumb={<span className="truncate text-foreground">New chat</span>}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        {/* Same body + disabled composer as the history-loading skeleton, so the
            optimistic bubble keeps its place as the surface swaps under it. The
            message is in flight (the thread is being created), so it reads as
            "Sending…" — and the typing dots sit under it immediately, before
            any stream exists. */}
        <PendingThreadConversation text={text} files={files} status="sending" />
        <Composer
          onSend={() => {}}
          disabled
          sendBlocked
          safeAreaBottom
          footerTrailing={
            tuple ? (
              <ComposerModelPicker value={tuple} providers={[]} disabled onSelect={() => {}} />
            ) : model ? (
              <ThreadModelBadge model={model} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

function LegacyArchiveThread({
  thread,
  projects,
  showReasoning = true,
  leading,
  onDeleteThread,
}: {
  thread: ThreadSummary;
  projects: ProjectSummary[];
  /** Per-user display preference — same source as live threads. */
  showReasoning?: boolean;
  leading: React.ReactNode;
  onDeleteThread?: (threadId: string) => void;
}) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const toolServers = useToolServers();

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(undefined);
    // The archive holds the RAW transcript, so nothing was destroyed — but it should
    // still READ like the live thread did, with each compacted span behind a
    // "Thread compacted" divider. Fold the stored summaries back in at render time.
    void Promise.all([
      fetchThreadHistory(historyFetchTargetForThread(thread)),
      thread.archivedAt == null
        ? Promise.resolve([])
        : fetchArchivedSummaries(thread.threadId).catch(() => []),
    ])
      .then(([fresh, summaries]) => {
        if (active) setMessages(applyArchivedCompactions(fresh, summaries));
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err : new Error(String(err)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [thread]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" key={thread.threadId}>
      <Topbar
        leading={leading}
        breadcrumb={
          <>
            <button
              type="button"
              className="min-w-0 truncate text-left text-foreground hover:underline"
              onClick={() => setDetailsOpen(true)}
              title="Thread details"
            >
              {thread.title}
            </button>
            <ThreadProjectBadge thread={thread} />
          </>
        }
        actions={
          <ThreadHeaderMenu
            onOpenArtifacts={() => setArtifactsOpen(true)}
            onOpenDetails={() => setDetailsOpen(true)}
          />
        }
      />

      <ThreadDetailsSheet
        open={detailsOpen}
        onOpenChange={setDetailsOpen}
        thread={thread}
        projects={projects}
        onDeleteThread={onDeleteThread}
      />
      <ThreadArtifactsSheet
        open={artifactsOpen}
        onOpenChange={setArtifactsOpen}
        threadId={thread.threadId}
      />

      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        {loading ? (
          <main
            className="flex flex-1 items-center justify-center p-6"
            role="log"
            aria-live="polite"
            aria-label="Archived conversation"
          >
            <Spinner className="size-5 text-muted-foreground" label="Loading chat" />
          </main>
        ) : (
          <Suspense fallback={<ConversationSkeleton />}>
            <ChatLog
              messages={messages}
              addToolApprovalResponse={() => undefined}
              busy={false}
              showTyping={false}
              readOnly
              error={error}
              servers={toolServers}
              showReasoning={showReasoning}
              emptyTitle="No archived messages"
              emptyDescription="This thread has no persisted messages."
            />
          </Suspense>
        )}

        <div className="shrink-0 border-border border-t bg-card px-4 py-3 text-center text-muted-foreground text-sm standalone:pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
          Archived thread
        </div>
      </div>
    </div>
  );
}

/** Suspense fallback for ThreadChat: real topbar (title already known) over a
 *  conversation skeleton, shown while the thread's history is loading. */
function ThreadChatSkeleton({
  title,
  threadId,
  leading,
  provider,
  model,
  statusHint,
  pendingBubble,
  onRetryFirstMessage,
}: {
  title: string;
  threadId: string;
  leading: React.ReactNode;
  provider?: SettingsProvider;
  model?: string;
  statusHint?: string;
  /** The optimistic first message, when this skeleton is the history-loading
   *  fallback for a thread the user just created. Keeps the bubble on screen
   *  instead of replacing it with generic placeholder bars. */
  pendingBubble?: {
    text: string;
    files: FileUIPart[];
    status: "sending" | "sent" | "failed";
  } | null;
  onRetryFirstMessage?: () => void;
}) {
  // Same rationale as PendingNewThreadView: wrap in the picker purely to keep
  // the footer slot's geometry identical to the live composer. It renders
  // disabled — history/socket aren't up yet, so there is nothing to switch.
  const tuple: ModelTuple | null = provider && model ? { provider, model } : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Topbar
        leading={leading}
        breadcrumb={
          <>
            <span className="min-w-0 truncate text-foreground">{title}</span>
            <span className="shrink-0 font-mono text-xs">{shortThreadId(threadId)}</span>
          </>
        }
      />
      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        {pendingBubble ? (
          <PendingThreadConversation
            text={pendingBubble.text}
            files={pendingBubble.files}
            status={pendingBubble.status}
            onRetry={onRetryFirstMessage}
          />
        ) : (
          <ConversationSkeleton />
        )}
        {/* Disabled shell so the composer's bottom anchor stays fixed while the
            thread history loads and the socket connects — no jump into the live UI. */}
        <Composer
          onSend={() => {}}
          disabled
          sendBlocked
          statusHint={statusHint}
          safeAreaBottom
          footerTrailing={
            tuple ? (
              <ComposerModelPicker value={tuple} providers={[]} disabled onSelect={() => {}} />
            ) : model ? (
              <ThreadModelBadge model={model} />
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

/**
 * The injectable half of the thread-chat seam.
 *
 * Two hooks, not one — the dial (`useThreadAgent`) must run in a component that
 * does NOT suspend, so it cannot be folded into the chat hook. See the doc on
 * `ThreadChatConnected` below and the one in `thread-chat-seam.ts`.
 *
 * Production always gets `realThreadChatImpl`. The dev-only mock entry point
 * supplies its own pair via `<App threadChat={…} />`; nothing under `mocks/` is
 * imported from here, which `scripts/check-mock-isolation.mjs` enforces.
 */
export interface ThreadChatImpl {
  useThreadAgent: (thread: ThreadSummary) => ThreadAgent;
  useThreadChat: (agent: ThreadAgent, initialMessages: UIMessage[]) => ThreadChatApi;
}

const realThreadChatImpl: ThreadChatImpl = {
  useThreadAgent,
  useThreadChat: useRealThreadChat,
};

const ThreadChatImplContext = createContext<ThreadChatImpl>(realThreadChatImpl);

interface ThreadChatProps {
  agent: ThreadAgent;
  consentWorkspaceId: string | null;
  backgroundWorkEnabled: boolean;
  thread: ThreadSummary;
  historyReloadNonce: number;
  projects: ProjectSummary[];
  /** Used to resolve per-model effort options for the composer dial. */
  providers?: ProviderSettingsView[];
  /**
   * Per-user display preference — not agent or thread state. Thinking effort
   * is per-thread; whether reasoning text is shown follows Settings.
   */
  showReasoning?: boolean;
  leading: React.ReactNode;
  pendingFirstMessage?: PendingFirstMessageState | null;
  onRetryFirstMessage?: () => void;
  onSettleFirstMessage?: (threadId: string) => void;
  onRename?: (threadId: string, title: string) => void;
  onReasoningEffortChange?: (threadId: string, effort: ReasoningEffort) => void;
  onMoveThread?: (threadId: string, projectId: string | null) => void;
  onCreateProjectForThread?: (threadId: string, name: string) => Promise<void>;
  onArchiveThread?: (threadId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  workbenches?: WorkbenchSummary[];
  onSwitchWorkbench?: (threadId: string, workbenchId: string | null) => Promise<void> | void;
  attachmentAccept?: string;
  maxFiles?: number;
  composerPlaceholder?: string;
  feedbackMode?: boolean;
  onFeedbackSend?: (threadId: string, text: string, files: FileUIPart[]) => Promise<void>;
  voiceEnabled?: boolean;
  browserNotificationPrompt?: {
    busy: boolean;
    error: string | null;
    onDismiss: () => void;
    onEnable: () => Promise<void>;
  } | null;
}

/**
 * Owns the agent WebSocket, deliberately OUTSIDE the history Suspense boundary.
 *
 * partysocket's `useStableSocket` creates its socket with `startClosed: true`
 * and only calls `socket.reconnect()` from a `useEffect`. Effects run on commit
 * — and `ThreadChat` suspends on the history promise, so a render that suspends
 * is discarded and never commits. A `useAgent()` inside `ThreadChat` therefore
 * did not begin connecting until `/get-messages` had already resolved, making
 * the two strictly serial: `history + WS connect` (each paying its own ~660ms
 * auth chain) before `everConnected` cleared the skeleton.
 *
 * This component doesn't suspend, so it commits immediately and the socket dials
 * while history is still in flight. Reveal becomes max(history, socket) instead
 * of the sum, and the WS wakes the DO concurrently with the history fetch, so a
 * cold `onStart` is paid once — overlapped — rather than twice back to back.
 */
function ThreadChatConnected({
  onRetryHistory,
  ...props
}: Omit<ThreadChatProps, "agent"> & { onRetryHistory: () => void }) {
  const { thread, historyReloadNonce, leading, pendingFirstMessage, onRetryFirstMessage } = props;
  const { useThreadAgent: useThreadAgentImpl } = useContext(ThreadChatImplContext);
  const agent = useThreadAgentImpl(thread);

  // A freshly-created thread carries its first message optimistically. Show it in
  // the history-loading fallback so the bubble the user saw while the thread was
  // being created stays put instead of blinking into placeholder bars.
  const pendingBubble =
    pendingFirstMessage && pendingFirstMessage.threadId === thread.threadId
      ? {
          text: pendingFirstMessage.text,
          files: pendingFirstMessage.files,
          status: pendingFirstMessage.status,
        }
      : null;

  // The history fetch can reject (e.g. offline) and that rejection propagates
  // past Suspense, so the error boundary wraps it from the outside.
  // threadReloadNonce is folded into the Suspense key so "Try again" actually
  // remounts and refetches.
  return (
    <ThreadHistoryErrorBoundary
      threadId={thread.threadId}
      onRetry={onRetryHistory}
      fallbackHeader={
        <Topbar
          leading={leading}
          breadcrumb={
            <>
              <span className="min-w-0 truncate text-foreground">{thread.title}</span>
              <span className="shrink-0 font-mono text-xs">{shortThreadId(thread.threadId)}</span>
            </>
          }
        />
      }
    >
      <Suspense
        key={`${thread.threadId}:${historyReloadNonce}`}
        fallback={
          <ThreadChatSkeleton
            title={thread.title}
            threadId={thread.threadId}
            leading={leading}
            provider={isSettingsProvider(thread.provider) ? thread.provider : undefined}
            model={thread.model}
            pendingBubble={pendingBubble}
            onRetryFirstMessage={onRetryFirstMessage}
          />
        }
      >
        <ThreadChat agent={agent} {...props} />
      </Suspense>
    </ThreadHistoryErrorBoundary>
  );
}

function ThreadChat({
  agent,
  consentWorkspaceId,
  backgroundWorkEnabled,
  thread,
  historyReloadNonce,
  projects,
  providers = [],
  showReasoning = true,
  leading,
  pendingFirstMessage,
  onRetryFirstMessage,
  onSettleFirstMessage,
  onRename,
  onReasoningEffortChange,
  onMoveThread,
  onCreateProjectForThread,
  onArchiveThread,
  onDeleteThread,
  workbenches,
  onSwitchWorkbench,
  attachmentAccept,
  maxFiles,
  composerPlaceholder,
  feedbackMode = false,
  onFeedbackSend,
  voiceEnabled,
  browserNotificationPrompt,
}: ThreadChatProps) {
  // Read before the `use()` below: this component suspends, and a suspended
  // render is replayed from the top, so the hook must not sit behind the
  // suspending call in an order that could vary between attempts.
  const { useThreadChat: useThreadChatImpl } = useContext(ThreadChatImplContext);

  // Fetch history ourselves instead of letting useAgentChat's default
  // getInitialMessages drive it: that default caches the fetch promise in a
  // module-level Map keyed by the agent's address and never evicts a promise
  // that rejected during render (e.g. offline), so the thread stays wedged for
  // the rest of the SPA session. `getInitialMessages: null` disables that
  // fetch/cache entirely; useThreadHistoryPromise replaces it with a cache
  // keyed by `${threadId}:${reloadNonce}` — still module-level (a per-mount
  // cache is discarded on every suspend-retry, which turns the suspend into an
  // infinite refetch loop), but "Try again" bumps the nonce and so refetches.
  const initialHistory = use(
    useThreadHistoryPromise(threadHistoryKey(thread.threadId, historyReloadNonce), () =>
      fetchThreadHistoryDetailed(historyFetchTargetForThread(thread), {
        threadId: thread.threadId,
        // The one caller that may answer from cache: this is the load that
        // decides whether the thread renders at all offline.
        fallbackToCache: true,
      }),
    ),
  );
  const initialMessages = initialHistory.messages;

  const {
    messages,
    setMessages,
    sendMessage,
    addToolApprovalResponse,
    status,
    isStreaming,
    error,
    stop,
  } = useThreadChatImpl(agent, initialMessages);

  // Keep the offline cache tracking what the user actually saw. The HTTP
  // snapshot alone would miss every turn that streamed in over the socket
  // afterwards — including the one just watched, which reads as data loss.
  //
  // Debounced, and gated on the turn having settled: a half-streamed assistant
  // message must never be persisted as though it were complete.
  //
  // Suppressed entirely while the load that seeded this thread was degraded (a
  // 500/401/garbage body). That load rendered an empty thread on a live socket,
  // so persisting the turns the user goes on to send would write a 2-message
  // transcript over the good 40-message cache — the cache would destroy the
  // history it exists to protect. A successful resync below clears this.
  const [historyDegraded, setHistoryDegraded] = useState(initialHistory.degraded);
  const persistHistory = useMemo(
    () =>
      debounce((threadId: string, settled: typeof messages) => {
        void writeCachedHistory(threadId, settled);
      }, 1_000),
    [],
  );
  useEffect(() => {
    if (historyDegraded) return;
    if (!shouldPersistSettledMessages(isStreaming, messages.length)) return;
    persistHistory(thread.threadId, messages);
  }, [historyDegraded, isStreaming, messages, persistHistory, thread.threadId]);
  // flush, not cancel: a pending write is already settled and carries its own
  // threadId, so dropping it on unmount would lose the last turn the user
  // watched — which is the whole reason this effect exists.
  useEffect(() => () => persistHistory.flush(), [persistHistory]);

  // Thread readiness: the UI must not present as interactive before the live
  // pipeline (history + WebSocket) is up, and the composer's action path must be
  // gated while the socket reconnects or history reloads. useAgentChat already
  // suspends until history loads (the keyed Suspense boundary); this adds the
  // socket dimension on top.
  const socketConnected = useSocketConnected(agent);
  const [everConnected, setEverConnected] = useState(false);
  useEffect(() => {
    if (socketConnected) setEverConnected(true);
  }, [socketConnected]);
  // Safety valve on the "a reply is coming" promise: never leave a thread
  // twitching typing dots forever when no reply is actually on its way.
  //
  // It restarts on every socket transition, because the window it guards
  // recurs. The gap this covers is "socket is up but the SDK's chunk replay
  // hasn't started yet", which happens on every reconnect — the one-shot
  // `connectTimedOut` this replaces only ever armed before the FIRST connect,
  // leaving later resumes with no valve at all. Each reconnect earns one fresh
  // window because each reconnect might bring a replay.
  const [pendingReplyExpired, setPendingReplyExpired] = useState(false);
  useEffect(() => {
    setPendingReplyExpired(false);
    const id = window.setTimeout(() => setPendingReplyExpired(true), PENDING_REPLY_WINDOW_MS);
    return () => window.clearTimeout(id);
  }, [socketConnected]);
  const [historyReloading, setHistoryReloading] = useState(false);

  const subagentRuns = useSubagentEvents(agent);

  const {
    rows: backgroundWorkRows,
    refresh: refreshBackgroundWork,
    readOutput: readBackgroundWorkOutput,
    cancel: cancelBackgroundWork,
    clearFinished: clearFinishedBackgroundWork,
  } = useBackgroundWork(agent, messages, backgroundWorkEnabled);

  // The sheet's "Result" for a finished subagent, from the SAME transcript the
  // inline completion line renders — no extra RPC, since the completion body is
  // already in history keyed by run id. Memoized on `messages` because it walks
  // the whole transcript, and reuses the `subagentRuns` subscription ChatLog
  // reads rather than opening a second one.
  const subagentResults = useMemo(
    () => subagentResultsByRunId(messages, subagentRuns.runsById),
    [messages, subagentRuns.runsById],
  );
  const resultFor = useCallback((id: string) => subagentResults[id], [subagentResults]);

  const trackThreadEvent = useCallback(
    (event: string, props?: Record<string, unknown>) => {
      if (canUseWorkspaceTelemetry({ consentWorkspaceId, workspaceId: thread.workspaceId })) {
        track(event, props);
      }
    },
    [consentWorkspaceId, thread.workspaceId],
  );

  const trackedAddToolApprovalResponse = useCallback(
    (response: Parameters<typeof addToolApprovalResponse>[0]) => {
      trackThreadEvent("tool_approval", { decision: response.approved ? "allow" : "deny" });
      return addToolApprovalResponse(response);
    },
    [addToolApprovalResponse, trackThreadEvent],
  );

  const feedbackIdempotencyKeysRef = useRef(new Map<string, string>());
  const composerControlRef = useRef<ComposerHandle | null>(null);
  const [submittedFeedbackDrafts, setSubmittedFeedbackDrafts] = useState<Set<string>>(() =>
    submittedFeedbackDraftIds(thread.threadId),
  );
  const submitFeedbackDraftFromCard = useCallback(
    async (draft: FeedbackDraftView, diagnostics: FeedbackDiagnostics) => {
      let idempotencyKey = feedbackIdempotencyKeysRef.current.get(draft.id);
      if (!idempotencyKey) {
        idempotencyKey = crypto.randomUUID();
        feedbackIdempotencyKeysRef.current.set(draft.id, idempotencyKey);
      }
      await submitFeedbackDraft({ draftId: draft.id, idempotencyKey, diagnostics });
      feedbackIdempotencyKeysRef.current.delete(draft.id);
      markFeedbackDraftSubmitted(thread.threadId, draft.id);
      setSubmittedFeedbackDrafts(submittedFeedbackDraftIds(thread.threadId));
    },
    [thread.threadId],
  );

  const keepEditingFeedbackDraft = useCallback(() => {
    composerControlRef.current?.focus();
  }, []);

  // Workspace MCP servers, for mapping namespaced tool keys to friendly names.
  const toolServers = useToolServers();

  // Always reach the latest agent without re-subscribing effects on every render.
  const agentRef = useRef(agent);
  agentRef.current = agent;

  // Same reason for `thread` and `setMessages`: a new `thread` object identity
  // arrives on every activity/unread/last-seen update to the active thread. If
  // `syncThreadHistory` closed over them directly, its identity would change on
  // each such update and re-fire every effect that depends on it — the
  // compaction-status fetch, its poller, the WS listener, connection recovery —
  // producing a storm of duplicate /compact/status calls on a single open.
  const threadRef = useRef(thread);
  threadRef.current = thread;
  const setMessagesRef = useRef(setMessages);
  setMessagesRef.current = setMessages;
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  const syncThreadHistory = useCallback(async () => {
    setHistoryReloading(true);
    try {
      const fresh = await fetchThreadHistory(historyFetchTargetForThread(threadRef.current));
      if (fresh.length > 0) {
        // Merged, not assigned. Mid-turn the server's history stops at the user
        // message, so a plain assign deletes the assistant bubble the user is
        // watching and it only returns when the SDK replays the buffered chunks
        // — a content flash that reads as data loss. `fresh` still wins for
        // everything it knows about; see mergeResyncedHistory.
        setMessagesRef.current(mergeResyncedHistory(messagesRef.current, fresh));
        // A real transcript reached us, so the messages are trustworthy again:
        // this is the recovery path out of a degraded load, and the only one.
        setHistoryDegraded(false);
      }
    } finally {
      setHistoryReloading(false);
    }
  }, []);

  // Load the saved draft once per thread, then seed the composer (via remount key).
  const [draftSeed, setDraftSeed] = useState<string | null>(null);
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const previousQueuedCountRef = useRef(0);
  const refreshQueuedMessages = useCallback(async () => {
    if (feedbackMode) {
      setQueuedMessages([]);
      return;
    }
    const rows = (await agentRef.current.call("listQueuedUserMessages", [])) as QueuedMessage[];
    setQueuedMessages((current) => mergeQueuedMessages(current, rows));
  }, [feedbackMode, thread.threadId]);

  // Self-heal the conversation across tab background/resume. partysocket has no
  // visibility/online listener or heartbeat, so a frozen tab can strand a
  // half-open socket. Critically, a reconnect alone does NOT resync messages:
  // the SDK only sends history over HTTP /get-messages (once, on mount) or
  // broadcasts a finished turn to *live* sockets — a backgrounded tab misses
  // the broadcast. So on resume we reconnect (restore liveness / unstick a
  // frozen mid-turn stream) AND refetch the authoritative message history.
  useAgentConnectionRecovery(agent, () => {
    void syncThreadHistory()
      .catch(() => {
        // Best-effort; the next live broadcast or a manual reload still recovers.
      })
      .finally(() => {
        setResumeCompleted(true);
        void refreshQueuedMessages().catch(() => {});
      });
  });

  useEffect(() => {
    setDraftSeed(null);
    setSubmittedFeedbackDrafts(submittedFeedbackDraftIds(thread.threadId));
    let active = true;
    (agentRef.current.call("getDraft", []) as Promise<unknown>)
      .then((text) => {
        if (active) setDraftSeed(typeof text === "string" ? text : "");
      })
      .catch(() => {
        if (active) setDraftSeed("");
      });
    return () => {
      active = false;
    };
  }, [thread.threadId]);

  // Picking a model is pure client state — no server hydration. Reset on
  // thread change so a switched-to thread doesn't inherit a stale pick, and
  // a hard refresh honestly reverts the picker to the thread's actual model
  // (there is nothing server-side to hydrate: picking does no I/O until the
  // message that asserts it is actually sent).
  const [pendingModel, setPendingModel] = useState<PendingModelSwitchValue | null>(null);
  useEffect(() => {
    setPendingModel(null);
  }, [thread.threadId]);

  useEffect(() => {
    void refreshQueuedMessages().catch(() => {});
  }, [refreshQueuedMessages]);

  useEffect(() => {
    if (feedbackMode || queuedMessages.length === 0) return;
    const id = window.setInterval(() => {
      void refreshQueuedMessages().catch(() => {});
    }, 1500);
    return () => window.clearInterval(id);
  }, [feedbackMode, queuedMessages.length, refreshQueuedMessages]);

  useEffect(() => {
    const previous = previousQueuedCountRef.current;
    previousQueuedCountRef.current = queuedMessages.length;
    if (previous > 0 && queuedMessages.length === 0) {
      void syncThreadHistory().catch(() => {});
    }
  }, [queuedMessages.length, syncThreadHistory]);

  // Debounced persistence; flush the pending write when the thread changes/unmounts.
  const saveDraft = useMemo(
    () =>
      debounce((text: string) => {
        void (agentRef.current.call("setDraft", [text]) as Promise<unknown>).catch(() => {});
      }, 500),
    [thread.threadId],
  );
  useEffect(() => () => saveDraft.flush(), [saveDraft]);

  // "busy" covers both the initial submitted state and active streaming
  const busy = isStreaming || status === "submitted";

  // Track whether a background-resume sync just completed so we can suppress
  // stale TypingDots (see push-notification-thread-routing-design spec).
  const [resumeCompleted, setResumeCompleted] = useState(false);

  // Reset whenever a new turn starts
  useEffect(() => {
    if (status === "submitted") setResumeCompleted(false);
  }, [status]);

  const offline = useOffline();

  const readiness = computeThreadReadiness({
    socketConnected,
    everConnected,
    historyReloading,
    pendingReplyExpired,
    offline,
    streamActive: isStreaming || status === "submitted",
    awaitingReply: awaitsAssistantReply(messages),
  });
  const readinessHint =
    readiness.reason === "offline"
      ? "Offline — reconnect to send"
      : readiness.reason === "connecting"
        ? "Connecting…"
        : readiness.reason === "reconnecting"
          ? "Reconnecting…"
          : readiness.reason === "reloading"
            ? "Reloading…"
            : undefined;
  const [compactionPhase, setCompactionPhase] = useState<"idle" | "compacting">("idle");
  const [compactionNotice, setCompactionNotice] = useState<CompactionNotice>("none");
  const [feedbackFallback, setFeedbackFallback] = useState<{
    threadId: string;
    text: string;
    files: FileUIPart[];
  } | null>(null);
  const [feedbackManualDraft, setFeedbackManualDraft] = useState<FeedbackDraftView | null>(null);
  const [feedbackManualDiagnostics, setFeedbackManualDiagnostics] =
    useState<FeedbackDiagnostics | null>(null);
  const [feedbackManualSubmitting, setFeedbackManualSubmitting] = useState(false);
  const [feedbackManualSubmitted, setFeedbackManualSubmitted] = useState(false);
  const compactionPhaseRef = useRef(compactionPhase);
  const manualCompactionInFlightRef = useRef(false);
  useEffect(() => {
    compactionPhaseRef.current = compactionPhase;
  }, [compactionPhase]);

  useEffect(() => {
    compactionPhaseRef.current = "idle";
    setCompactionPhase("idle");
    setCompactionNotice("none");
    // Wait for the socket before asking. /compact/status resolves through
    // getAgentByName, so it wakes and then queues on the SAME single-threaded DO
    // as the WebSocket upgrade and the history fetch. Firing it during the cold
    // open put a ~660ms auth chain + a DO round-trip ahead of the upgrade, and
    // the initial skeleton clears on `everConnected` — so it delayed the render
    // it can't possibly inform. Nothing is interactive before the socket opens,
    // and the WS listener below carries every phase change once it is, so the
    // only thing this fetch adds is the already-compacting-on-open case — which
    // is just as correct a beat later, off the critical path.
    if (!everConnected) return;
    let active = true;
    getThreadCompactionStatus(thread.threadId)
      .then((status) => {
        if (!active) return;
        const previous = compactionPhaseRef.current;
        if (
          !shouldApplyCompactionStatus({
            currentPhase: previous,
            incomingPhase: status.phase,
            manualCompactionInFlight: manualCompactionInFlightRef.current,
          })
        ) {
          return;
        }
        compactionPhaseRef.current = status.phase;
        setCompactionPhase(status.phase);
        if (status.phase === "idle" && previous === "compacting") {
          void syncThreadHistory().catch(() => {});
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [everConnected, syncThreadHistory, thread.threadId]);

  useEffect(() => {
    if (compactionPhase !== "compacting") return;
    let active = true;
    const poll = () => {
      getThreadCompactionStatus(thread.threadId)
        .then((status) => {
          if (!active) return;
          const previous = compactionPhaseRef.current;
          if (
            !shouldApplyCompactionStatus({
              currentPhase: previous,
              incomingPhase: status.phase,
              manualCompactionInFlight: manualCompactionInFlightRef.current,
            })
          ) {
            return;
          }
          compactionPhaseRef.current = status.phase;
          setCompactionPhase(status.phase);
          if (status.phase === "idle" && previous === "compacting") {
            void syncThreadHistory().catch(() => {});
          }
        })
        .catch(() => {});
    };
    const id = window.setInterval(poll, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [compactionPhase, syncThreadHistory, thread.threadId]);

  useEffect(() => {
    const socket = agent as unknown as {
      addEventListener?: (type: "message", listener: (event: MessageEvent) => void) => void;
      removeEventListener?: (type: "message", listener: (event: MessageEvent) => void) => void;
    };
    if (typeof socket.addEventListener !== "function") return;

    const onMessage = (event: MessageEvent) => {
      if (typeof event.data !== "string") return;
      const session = parseCompactionSessionEvent(event.data);
      if (!session) return;

      const previous = compactionPhaseRef.current;
      compactionPhaseRef.current = session.phase;
      setCompactionPhase(session.phase);
      if (session.phase === "compacting") {
        setCompactionNotice("none");
      }
      if (session.phase === "idle" && previous === "compacting") {
        void syncThreadHistory().catch(() => {});
      }
    };

    socket.addEventListener("message", onMessage);
    return () => {
      socket.removeEventListener?.("message", onMessage);
    };
  }, [agent, syncThreadHistory]);

  // The strip renders a pure derivation of the queue mirror, NOT a separate
  // piece of state: every non-terminal submission whose user message has not
  // yet entered the conversation. Status alone cannot decide visibility — the
  // SDK flips a submission to "running" the instant its drain loop claims it
  // (at submit time), while the turn still waits behind the active one — so
  // the arrival of the message in the stream is the only "turn started"
  // signal. Once it arrives the row hides for good: message ids only grow, so
  // the 1500ms poll can never resurrect a hidden row (the old flicker), and
  // the active turn never double-renders in both conversation and strip.
  const messageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);

  // The optimistic bubble is gated on "is this its thread" and "has THIS exact
  // message arrived" (see lib/pending-first-message.ts). "The thread has
  // messages" is not a delivery signal: a socket that connects mid-turn resumes
  // the assistant's stream without ever receiving the user message that started
  // it, so an assistant-only transcript must not hide the bubble or settle the
  // pending state — that made the sent text vanish from the conversation.
  const bubble = pendingForThread(pendingFirstMessage ?? null, thread.threadId, messageIds);
  const sendingFirstMessage =
    pendingFirstMessage?.threadId === thread.threadId && pendingFirstMessage.status === "sending";
  useEffect(() => {
    if (shouldSettleFirstMessage(pendingFirstMessage ?? null, thread.threadId, messageIds)) {
      onSettleFirstMessage?.(thread.threadId);
    }
  }, [messageIds, onSettleFirstMessage, pendingFirstMessage, thread.threadId]);

  // Backstop for the missed apply-time broadcast: delivery is confirmed ("sent")
  // but the message never reached this client — the initial history snapshot
  // predated it and the socket connected mid-turn. Poll the authoritative
  // history (silently — syncThreadHistory would gate the composer via the
  // readiness "reloading" state) until the message shows up; the settle effect
  // then clears the pending state and this effect unsubscribes.
  useEffect(() => {
    if (!needsFirstMessageResync(pendingFirstMessage ?? null, thread.threadId, messageIds)) return;
    const messageId = pendingFirstMessage?.messageId;
    let active = true;
    const fetchOnce = () => {
      fetchThreadHistory(historyFetchTargetForThread(thread))
        .then((fresh) => {
          // Adopt the snapshot only once it contains the awaited message, so a
          // still-stale fetch can't clobber an in-flight assistant stream.
          if (active && fresh.some((message) => message.id === messageId)) setMessages(fresh);
        })
        .catch(() => {});
    };
    fetchOnce();
    const id = window.setInterval(fetchOnce, 1500);
    return () => {
      active = false;
      window.clearInterval(id);
    };
  }, [messageIds, pendingFirstMessage, setMessages, thread]);
  const queuedStripItems = useMemo(
    () =>
      displayableQueuedMessages(
        queuedMessages,
        messageIds,
        bubble ? new Set([bubble.messageId]) : undefined,
      ),
    [bubble, queuedMessages, messageIds],
  );

  // ── Steering messages (interject the running turn) ──────────────────────
  const [steeringMessages, setSteeringMessages] = useState<SteeringMessage[]>([]);
  // Drop steers once they settle into the transcript (ids only grow → no
  // flicker back), keeping local state bounded.
  useEffect(() => {
    setSteeringMessages((cur) => {
      const next = activeSteeringMessages(cur, messageIds);
      return next.length === cur.length ? cur : next;
    });
  }, [messageIds]);
  const {
    pendingKeys: pendingSteerKeys,
    seenKeys: seenSteerKeys,
    refresh: refreshSteers,
  } = usePendingSteers(agent, true, steeringMessages.length > 0);
  const steeringChips = useMemo(
    () => deriveSteeringChips(steeringMessages, pendingSteerKeys, seenSteerKeys, messageIds),
    [steeringMessages, pendingSteerKeys, seenSteerKeys, messageIds],
  );
  // Rehydrate steering chips from the durable buffer on mount / thread switch:
  // local state is lost on a full reload, but the steers themselves survive in
  // the server buffer. Only still-buffered (Steering) steers restore — a drained
  // (Sent) one reappears when its turn settles into the transcript. Clear first
  // so a previous thread's chips never leak into this one.
  useEffect(() => {
    setSteeringMessages([]);
    let cancelled = false;
    void (
      agentRef.current.call("listPendingSteers", []) as Promise<
        { clientMessageId: string; text: string }[]
      >
    )
      .then((rows) => {
        if (cancelled || !Array.isArray(rows) || rows.length === 0) return;
        setSteeringMessages((cur) => {
          let next = cur;
          for (const r of rows) {
            next = addSteer(next, {
              clientMessageId: r.clientMessageId,
              text: r.text,
              createdAt: Date.now(),
            });
          }
          return next;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [thread.threadId]);

  // Rename / move / archive / delete + metadata live in the detail sheet now,
  // so the top bar stays uncluttered.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [artifactsOpen, setArtifactsOpen] = useState(false);
  const [backgroundTasksOpen, setBackgroundTasksOpen] = useState(false);

  // Show typing dots as the last item for the whole assistant turn, so the
  // "still working" signal persists across tool runs, reasoning, and text.
  // showPendingReply covers the gap before the first connect: history says a
  // turn is mid-flight, and the socket that will stream it isn't open yet.
  const streamTyping =
    readiness.showPendingReply ||
    ((isStreaming || status === "submitted") &&
      !(resumeCompleted && isStreaming && isConversationComplete(messages)));
  // The optimistic first-message bubble renders BELOW ChatLog, so its typing
  // dots must sit under the bubble — not inside the log (which would paint
  // them above it). Cover the create → deliver → stream-start gap here.
  const showOptimisticTyping = !!bubble && bubble.status !== "failed";
  const showTyping = streamTyping && !bubble;

  // The thread's actual committed model. Kept separate from `pendingModel`
  // even though only one of the two is ever displayed (see
  // ComposerModelPicker's "no pending affordance" doc) — Task 10's transcript
  // divider needs this as the switch's `from` value once it lands.
  const committedModel: ModelTuple | null = isSettingsProvider(thread.provider)
    ? { provider: thread.provider, model: thread.model }
    : null;

  // The EffortDial must reflect the model the NEXT message actually runs on,
  // not the one the thread is currently pinned to. Reading thread.{provider,
  // model,modelSupportsReasoning} directly here (a Task 9 gap, not a Task 9
  // bug — the plan never routed pendingModel through the dial) leaves the
  // dial showing the old model's controls after a switch is picked but
  // before it commits on the next send: a user can set an effort value the
  // new model doesn't support, or miss one it does.
  const dialModel = dialModelFor(thread, pendingModel);

  // Picking a model does NO I/O — it only sets local state. The choice
  // takes effect on the NEXT send, which stamps it onto the outgoing
  // message's `metadata` (see `handleSend` below); the server is the only
  // party that validates it, at commit time. A page refresh honestly loses
  // an unsent pick — see the reset effect above.
  const handleModelSwitchSelect = useCallback(
    (tuple: ModelTuple, picked: ProviderModelSearchResult) => {
      setPendingModel({
        provider: tuple.provider,
        model: tuple.model,
        ...(picked.inputModalities ? { modelInputModalities: picked.inputModalities } : {}),
        // Tri-state: only an explicit true/false is a real claim about
        // reasoning support. `undefined` means unknown and must NOT be
        // coerced to false (that would withhold reasoning from a model that
        // can do it) or collapsed away with `??`/truthiness.
        ...(typeof picked.reasoning === "boolean"
          ? { modelSupportsReasoning: picked.reasoning }
          : {}),
      });
    },
    [],
  );

  const handleSend = useCallback(
    async (text: string, files: FileUIPart[], opts?: { steer?: boolean }) => {
      if (feedbackMode) {
        try {
          await onFeedbackSend?.(thread.threadId, text, files);
          saveDraft.cancel();
          void (agentRef.current.call("setDraft", [""]) as Promise<unknown>).catch(() => {});
        } catch (error) {
          if (error instanceof FeedbackRateLimitError) {
            toast.error(
              `You can send more feedback in ${formatDuration(error.retryAfterSeconds)}.`,
            );
          } else {
            setFeedbackFallback({ threadId: thread.threadId, text, files });
            setFeedbackManualDraft(null);
            setFeedbackManualDiagnostics(null);
            setFeedbackManualSubmitted(false);
            toast.error("Couldn't send feedback. Your draft was kept.");
          }
          throw error;
        }
        return;
      }
      if (isCompactCommand(text)) {
        if (compactionPhase === "compacting") {
          toast.info("Compaction is already running.");
          return;
        }
        compactionPhaseRef.current = "compacting";
        setCompactionPhase("compacting");
        setCompactionNotice("none");
        manualCompactionInFlightRef.current = true;
        saveDraft.cancel();
        void (agentRef.current.call("setDraft", [""]) as Promise<unknown>).catch(() => {});
        void runManualThreadCompaction({
          threadId: thread.threadId,
          compactThread: compactThreadApi,
          toast,
        })
          .then((result) => {
            if (result.compacted) void syncThreadHistory().catch(() => {});
            setCompactionNotice(manualCompactionNoticeForResult(result));
            trackThreadEvent("thread_compacted", {
              thread_id: thread.threadId,
              source: "manual",
              compacted: result.compacted,
            });
          })
          .catch(() => {})
          .finally(() => {
            manualCompactionInFlightRef.current = false;
            compactionPhaseRef.current = "idle";
            setCompactionPhase("idle");
          });
        return;
      }

      const hasContent = text.trim().length > 0 || files.length > 0;
      if (hasContent) setCompactionNotice("none");

      // NOTE: the client does NOT write the `data-model-switch` marker. It
      // used to, and that made the marker conditional on this exact code path
      // running: an automaton run and the feedback branch both bypass this
      // function, and two queued sends drew two dividers for one switch (only
      // the last of them ever runs). The server writes it from the commit it
      // actually performs (`recordCommittedModelSwitch`), which is the only
      // place that knows what committed.
      //
      // What the client DOES attach: the REQUEST, in `metadata` — a distinct
      // channel from the marker part above. `pendingModel` is pure local
      // state (see `handleModelSwitchSelect`), so this is the ONLY place it
      // ever reaches the server: riding on the message that commits it.
      // Built by `buildModelSwitchMetadata` (in `./lib/model-switch-metadata`)
      // so `test/unit/web/model-switch-parity.test.ts` can feed the object
      // this code path actually constructs through the server's real
      // `readModelSwitchRequest`. Mirrors `src/agent/model-switch-request.ts`'s
      // `ModelSwitchRequest` server-side (see that file's doc for why this
      // REQUEST channel stays distinct from the server-written
      // `data-model-switch` MARKER part).
      const modelSwitchMetadata = buildModelSwitchMetadata(pendingModel);

      // Steer: interject the running turn (see the user-steering-message spec).
      // Meaningful only while a turn is in flight; text-only (no attachment
      // support), so a steer carrying files falls through to the queue path,
      // which preserves them.
      const shouldSteer =
        Boolean(opts?.steer) && busy && text.trim().length > 0 && files.length === 0;
      if (shouldSteer) {
        const clientMessageId = crypto.randomUUID();
        setSteeringMessages((cur) =>
          addSteer(cur, { clientMessageId, text, createdAt: Date.now() }),
        );
        try {
          await agentRef.current.call("steer", [text, clientMessageId]);
        } catch {
          toast.error("Couldn't steer the message. Please try again.");
          setSteeringMessages((cur) => removeSteer(cur, clientMessageId));
          return;
        }
        void refreshSteers().catch(() => {});
        trackThreadEvent("steer_message_sent", { thread_id: thread.threadId, length: text.length });
        saveDraft.cancel();
        void (agentRef.current.call("setDraft", [""]) as Promise<unknown>).catch(() => {});
        return;
      }

      const shouldQueue = shouldQueueSubmitForThreadState({
        busy,
        manualCompacting: compactionPhase === "compacting",
        hasContent,
      });

      if (shouldQueue) {
        const message: UIMessage = {
          id: crypto.randomUUID(),
          role: "user",
          parts: [...(text ? [{ type: "text" as const, text }] : []), ...files],
          ...(modelSwitchMetadata ? { metadata: modelSwitchMetadata } : {}),
        };
        try {
          // The server merges every waiting message into one batch submission
          // (flushed together as a single turn at the next opportunity) and
          // returns the authoritative full row list.
          const rows = (await agentRef.current.call("submitQueuedUserMessage", [
            { message, clientMessageId: message.id },
          ])) as QueuedMessage[];
          setQueuedMessages((current) => mergeQueuedMessages(current, rows));
          // The switch now rides on the queued message itself (its
          // `metadata`), so the queue strip's own row is the only echo of it
          // from here — keep showing it via `thread`/history once it commits
          // rather than this local pick.
          setPendingModel(null);
        } catch {
          toast.error("Couldn't queue the message. Please try again.");
          return;
        }
        trackThreadEvent("queued_message_sent", {
          thread_id: thread.threadId,
          length: text.length,
          files: files.length,
        });
        saveDraft.cancel();
        void (agentRef.current.call("setDraft", [""]) as Promise<unknown>).catch(() => {});
        return;
      }

      sendMessage({
        text,
        files,
        ...(modelSwitchMetadata ? { metadata: modelSwitchMetadata } : {}),
      });
      trackThreadEvent("message_sent", {
        thread_id: thread.threadId,
        length: text.length,
        files: files.length,
      });
      // Optimistic clear: sendMessage is fire-and-forget app-wide, and ThreadChat
      // keeps no failed-send restore, so we clear the saved draft on submit.
      saveDraft.cancel();
      void (agentRef.current.call("setDraft", [""]) as Promise<unknown>).catch(() => {});
      // The turn this starts commits the switch server-side
      // (`commitPendingModelSwitch`, reading it off the message just sent) —
      // the local pick has done its job.
      setPendingModel(null);
    },
    [
      busy,
      compactionPhase,
      pendingModel,
      refreshSteers,
      saveDraft,
      sendMessage,
      syncThreadHistory,
      thread.threadId,
      trackThreadEvent,
      feedbackMode,
      onFeedbackSend,
    ],
  );

  const cancelSteeringMessage = useCallback(
    async (chip: SteeringChip) => {
      // Server-confirmed cancel: don't remove the chip optimistically (a
      // disappearing chip would falsely read as "cancelled" when the agent
      // already picked it up). Show "cancelling" until the server rules.
      setSteeringMessages((cur) => withCancelling(cur, chip.clientMessageId, true));
      try {
        const res = (await agentRef.current.call("cancelSteer", [chip.clientMessageId])) as {
          cancelled: boolean;
          restoredText?: string;
        };
        if (res.cancelled) {
          composerControlRef.current?.prefillIfEmpty(res.restoredText ?? chip.text);
          setSteeringMessages((cur) => removeSteer(cur, chip.clientMessageId));
        } else {
          // Too-late: the agent already has it. Clear the flag; the poll flips
          // the chip to Sent.
          setSteeringMessages((cur) => withCancelling(cur, chip.clientMessageId, false));
          void refreshSteers().catch(() => {});
        }
      } catch {
        setSteeringMessages((cur) => withCancelling(cur, chip.clientMessageId, false));
      }
    },
    [refreshSteers],
  );

  const cancelQueuedMessage = useCallback(
    (item: QueuedMessage) => {
      // Give the removed message's text back to the user instead of dropping
      // it — but only into an empty composer, never over in-progress input.
      composerControlRef.current?.prefillIfEmpty(item.text ?? item.textPreview);
      // Optimistic removal keys on clientMessageId — a batch rebuild changes
      // submissionId, clientMessageId is the stable per-message identity.
      setQueuedMessages((current) =>
        current.filter((row) => row.clientMessageId !== item.clientMessageId),
      );
      void (
        agentRef.current.call("cancelQueuedUserMessage", [
          item.submissionId,
          item.clientMessageId,
        ]) as Promise<QueuedMessage[]>
      )
        .then((rows) => {
          setQueuedMessages((current) => mergeQueuedMessages(current, rows));
        })
        .catch(() => {
          void refreshQueuedMessages().catch(() => {});
        });
    },
    [refreshQueuedMessages],
  );

  // The transcript renders as soon as history resolves — it deliberately does
  // NOT wait for the socket, which made every thread open feel as slow as its
  // slower half. Painting early misrepresents nothing: `sendBlocked` gates the
  // composer's action path the instant the socket is down and the footer says
  // why, and the socket never re-pushes history (getInitialMessages: null), so
  // connecting cannot rewrite what's on screen. Where history stops mid-turn,
  // `showPendingReply` runs the typing dots until the socket takes over.
  // (ThreadChatSkeleton is still the Suspense fallback while history loads.)
  return (
    <div className="flex min-h-0 flex-1 flex-col" key={thread.threadId}>
      {feedbackMode ? (
        <Topbar
          leading={leading}
          breadcrumb={<span className="truncate text-foreground">Send feedback</span>}
        />
      ) : (
        <>
          <Topbar
            leading={leading}
            breadcrumb={
              <>
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-foreground hover:underline"
                  onClick={() => setDetailsOpen(true)}
                  title="Thread details"
                >
                  {thread.title}
                </button>
                <ThreadProjectBadge thread={thread} />
              </>
            }
            actions={
              <ThreadHeaderMenu
                onOpenArtifacts={() => setArtifactsOpen(true)}
                onOpenDetails={() => setDetailsOpen(true)}
              />
            }
          />

          <ThreadDetailsSheet
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
            thread={thread}
            projects={projects}
            workbenches={workbenches}
            onRename={onRename}
            onMoveThread={onMoveThread}
            onCreateProjectForThread={onCreateProjectForThread}
            onArchiveThread={onArchiveThread}
            onDeleteThread={onDeleteThread}
            onSwitchWorkbench={onSwitchWorkbench}
          />
          <ThreadArtifactsSheet
            open={artifactsOpen}
            onOpenChange={setArtifactsOpen}
            threadId={thread.threadId}
          />
        </>
      )}

      {/* Reading column: cap the width on wide screens and center it, so the
          thread never sprawls edge-to-edge. The Topbar stays full-bleed. */}
      <div className="mx-auto flex min-h-0 w-full max-w-content flex-1 flex-col">
        {/* A lazy child of ChatLog can suspend here. The fallback choice —
            and why it must never be `null` — lives in ConversationFallback. */}
        <Suspense fallback={<ConversationFallback hasPendingBubble={!!bubble} />}>
          <ChatLog
            messages={messages}
            addToolApprovalResponse={trackedAddToolApprovalResponse}
            busy={busy}
            showTyping={showTyping}
            hasPendingBubble={!!bubble}
            compactionPhase={compactionPhase}
            compactionNotice={compactionNotice}
            error={error}
            servers={toolServers}
            showReasoning={showReasoning}
            subagentRuns={subagentRuns}
            onFeedbackDraftSubmit={feedbackMode ? submitFeedbackDraftFromCard : undefined}
            onFeedbackDraftEdit={feedbackMode ? keepEditingFeedbackDraft : undefined}
            submittedFeedbackDraftIds={feedbackMode ? submittedFeedbackDrafts : undefined}
          />
        </Suspense>

        {bubble && (
          <PendingFirstMessage
            text={bubble.text}
            files={bubble.files}
            status={bubble.status}
            onRetry={onRetryFirstMessage}
          />
        )}
        {showOptimisticTyping && <PendingReplyDots />}

        {!feedbackMode && (
          <QueuedMessageStrip items={queuedStripItems} onCancel={cancelQueuedMessage} />
        )}

        {!feedbackMode && (
          <SteeringMessageStrip items={steeringChips} onCancel={cancelSteeringMessage} />
        )}

        {!feedbackMode && (
          <BackgroundTasksRow
            enabled={backgroundWorkEnabled}
            rows={backgroundWorkRows}
            onOpen={() => setBackgroundTasksOpen(true)}
          />
        )}

        <BackgroundTasksSheet
          open={backgroundTasksOpen}
          onOpenChange={setBackgroundTasksOpen}
          rows={backgroundWorkRows}
          readOutput={readBackgroundWorkOutput}
          cancel={cancelBackgroundWork}
          clearFinished={clearFinishedBackgroundWork}
          onChanged={() => void refreshBackgroundWork()}
          resultFor={resultFor}
        />

        {browserNotificationPrompt && (
          <BrowserNotificationPrompt
            busy={browserNotificationPrompt.busy}
            error={browserNotificationPrompt.error}
            onDismiss={browserNotificationPrompt.onDismiss}
            onEnable={browserNotificationPrompt.onEnable}
          />
        )}

        {feedbackMode && feedbackFallback && !feedbackManualDraft ? (
          <FeedbackFallbackForm
            threadId={feedbackFallback.threadId}
            screenshots={feedbackFallback.files}
            initialNarrative={feedbackFallback.text}
            onDraft={(draft) => {
              setFeedbackManualDraft(draft);
              setFeedbackManualDiagnostics(collectFeedbackDiagnostics());
            }}
          />
        ) : null}

        {feedbackMode && feedbackFallback && feedbackManualDraft && feedbackManualDiagnostics ? (
          <div className="px-3">
            <FeedbackDraftCard
              draft={feedbackManualDraft}
              diagnostics={feedbackManualDiagnostics}
              screenshots={feedbackFallback.files}
              submitting={feedbackManualSubmitting}
              submitted={feedbackManualSubmitted}
              onKeepEditing={() => composerControlRef.current?.focus()}
              onSubmit={async () => {
                setFeedbackManualSubmitting(true);
                try {
                  await submitFeedbackDraftFromCard(feedbackManualDraft, feedbackManualDiagnostics);
                  setFeedbackManualSubmitted(true);
                } finally {
                  setFeedbackManualSubmitting(false);
                }
              }}
            />
          </div>
        ) : null}

        <Composer
          key={`${thread.threadId}:${draftSeed === null ? "loading" : "ready"}`}
          controlRef={composerControlRef}
          onSend={handleSend}
          onStop={stop}
          onDraftChange={saveDraft}
          uploadAttachments={attachmentAccept ? buildUploadAttachments(thread.threadId) : undefined}
          attachmentAccept={attachmentAccept}
          maxFiles={maxFiles}
          modelInputModalities={thread.modelInputModalities ?? ["text"]}
          disabled={
            draftSeed === null ||
            // Hold the composer until the first message has actually landed, so a
            // second send can't overtake it and invert the conversation.
            sendingFirstMessage
          }
          sendBlocked={readiness.sendBlocked}
          statusHint={sendingFirstMessage ? "Sending…" : readinessHint}
          allowBusySend={!feedbackMode}
          allowSteer={!feedbackMode}
          defaultValue={draftSeed ?? undefined}
          status={isStreaming ? "streaming" : status === "submitted" ? "submitted" : undefined}
          safeAreaBottom
          voiceEnabled={voiceEnabled}
          placeholder={composerPlaceholder}
          footerTrailing={
            feedbackMode ? undefined : (
              <>
                {shouldOfferEffortControl({
                  provider: isSettingsProvider(dialModel.provider) ? dialModel.provider : null,
                  modelSupportsReasoning: dialModel.modelSupportsReasoning,
                }) &&
                  onReasoningEffortChange && (
                    <EffortDial
                      triggerId={`thread-effort-${thread.threadId}`}
                      effort={thread.reasoningEffort}
                      options={availableEffortOptions(
                        reasoningControlsForThreadModel(
                          providers,
                          dialModel.provider,
                          dialModel.model,
                        ),
                      )}
                      onEffortChange={(effort) => onReasoningEffortChange(thread.threadId, effort)}
                      disabled={draftSeed === null || sendingFirstMessage}
                    />
                  )}
                {(() => {
                  // Pending, when this thread has one, always wins over the
                  // committed model — see ComposerModelPicker's doc: the two
                  // render identically, so there is nothing else to signal
                  // here beyond which value is current.
                  const displayModel = pendingModel ?? committedModel;
                  return displayModel ? (
                    <ComposerModelPicker
                      value={displayModel}
                      providers={toModelPickerProviders(providers)}
                      disabled={draftSeed === null || sendingFirstMessage}
                      currentUsageTokens={thread.lastContextTokens}
                      onSelect={handleModelSwitchSelect}
                    />
                  ) : (
                    <ThreadModelBadge model={thread.model} />
                  );
                })()}
              </>
            )
          }
        />
      </div>
    </div>
  );
}

function BrowserNotificationPrompt({
  busy,
  error,
  onDismiss,
  onEnable,
}: {
  busy: boolean;
  error: string | null;
  onDismiss: () => void;
  onEnable: () => Promise<void>;
}) {
  return (
    <div className="shrink-0 border-border border-t bg-card px-4 py-3">
      <div className="mx-auto flex w-full max-w-content flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-foreground text-sm">
            <BellRinging aria-hidden className="size-4 text-primary" />
            <span className="font-medium">Keep this thread in reach</span>
          </div>
          <p className="text-muted-foreground text-sm">
            Turn on browser notifications so long-running work can call you back.
          </p>
          {error && <p className="text-reject text-sm">{error}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" onClick={onDismiss} disabled={busy}>
            Not now
          </Button>
          <Button
            type="button"
            onClick={() => {
              void onEnable();
            }}
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? <Spinner className="size-4" /> : <Bell aria-hidden className="size-4" />}
            Enable
          </Button>
        </div>
      </div>
    </div>
  );
}

function getThreadIdFromPath(): string | null {
  const match = window.location.pathname.match(/^\/threads\/([^/]+)$/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

/** The All Chats tab (active vs archived) lives in the URL so back/forward work. */
function getChatsViewFromLocation(): "active" | "archived" {
  return new URLSearchParams(window.location.search).get("view") === "archived"
    ? "archived"
    : "active";
}

/** Finishing or skipping a forced replay strips the param, so a refresh doesn't
 * drop you straight back into setup. */
function clearForcedOnboarding(): void {
  if (!isOnboardingForced(window.location.search)) return;
  const url = new URL(window.location.href);
  url.searchParams.delete("onboarding");
  url.searchParams.delete("step");
  window.history.replaceState(null, "", url.toString());
}

/**
 * Returning from an MCP OAuth consent redirect lands on the app root; restore
 * the screen the user left. MUST run before any state initializer that reads
 * `window.location` — `computeOnboarding` reads `search` for `onboarding=force`,
 * and useState initializers run in declaration order, so restoring later leaves
 * the wizard resolved to "done" and the user stranded in chat.
 *
 * Returns the pathname only. `path` state is matched against pathname routes
 * elsewhere; handing it a value with a query string breaks every route check.
 */
function restoreMcpReturnPath(): string {
  const stored = typeof sessionStorage === "undefined" ? null : takeMcpReturnPath(sessionStorage);
  if (stored === null) return window.location.pathname;
  window.history.replaceState(null, "", stored);
  return new URL(stored, window.location.origin).pathname;
}

function formatThreadMeta(thread: ThreadSummary): string {
  const updated = new Date(thread.updatedAt);
  const formatted = Number.isNaN(updated.getTime())
    ? shortThreadId(thread.threadId)
    : updated.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${shortThreadId(thread.threadId)} · ${formatted}`;
}

function formatArchivedMeta(thread: ThreadSummary): string {
  if (thread.archivedAt == null) return formatThreadMeta(thread);
  const archived = new Date(thread.archivedAt);
  const formatted = Number.isNaN(archived.getTime())
    ? shortThreadId(thread.threadId)
    : archived.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `Archived ${formatted}`;
}

function shortThreadId(threadId: string): string {
  if (threadId === "default") return "default";
  if (threadId.length <= 12) return threadId;
  return `${threadId.slice(0, 8)}...${threadId.slice(-4)}`;
}

function formatDuration(seconds: number): string {
  const clamped = Math.max(0, Math.ceil(seconds));
  if (clamped < 60) return `${clamped} second${clamped === 1 ? "" : "s"}`;
  const minutes = Math.ceil(clamped / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

// ------------------------------------------------------------------ //
// App root                                                            //
// ------------------------------------------------------------------ //

type OnboardingState =
  | { status: "loading" }
  | { status: "needed"; settings: AgentSettingsResponse }
  | { status: "done" };

/** Full-screen brand loading state — shared by the "computing onboarding" phase
 *  and the Suspense fallbacks for the lazily-loaded Settings/Onboarding routes. */
function FullScreenLoader({ label }: { label: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6">
      <BrandMark className="size-14 rounded-[12px]" />
      <div className="font-display font-semibold text-2xl">nadi</div>
      <Spinner className="size-6 text-muted-foreground" label={label} />
    </div>
  );
}

/**
 * Resolve the onboarding state from a signed-in user's settings + threads.
 * `null` settings (user owns no workspace with a default agent) falls open to
 * the app rather than trapping them in setup — the wizard needs settings to
 * render, so `?onboarding=force` can't override that.
 */
function computeOnboarding(
  settings: AgentSettingsResponse | null,
  threads: ThreadSummary[],
): OnboardingState {
  if (!settings) return { status: "done" };
  const needed =
    isOnboardingForced(window.location.search) ||
    deriveNeedsOnboarding({
      providers: settings.providers,
      threadCount: threads.length,
    });
  return needed ? { status: "needed", settings } : { status: "done" };
}

export default function App({
  threadChat = realThreadChatImpl,
}: { threadChat?: ThreadChatImpl } = {}) {
  // Synchronous read — this is why the cache lives in localStorage. Having the
  // payload during the FIRST render is what makes the shell paint with no
  // spinner and no network wait.
  const [cachedBootstrap] = useState(readCachedBootstrap);

  // Declaration order is load-bearing — see restoreMcpReturnPath.
  const [path, setPath] = useState(restoreMcpReturnPath);

  const [session, setSession] = useState<AuthSession | null>(cachedBootstrap?.session ?? null);
  const [onboarding, setOnboarding] = useState<OnboardingState>(() =>
    cachedBootstrap
      ? computeOnboarding(cachedBootstrap.settings, cachedBootstrap.threads)
      : { status: "loading" },
  );
  const [bootstrapProjects, setBootstrapProjects] = useState<ProjectSummary[]>(
    cachedBootstrap?.projects ?? [],
  );
  const [bootstrapThreads, setBootstrapThreads] = useState<ThreadSummary[]>(
    cachedBootstrap?.threads ?? [],
  );
  const [bootstrapThreadsNextCursor, setBootstrapThreadsNextCursor] = useState<string | null>(
    cachedBootstrap?.threadsNextCursor ?? null,
  );
  // Defaulted rather than cache-versioned: an entry written before appName
  // existed simply falls back, which is cheaper than invalidating everyone's
  // cache and making one launch slow.
  const [appName, setAppName] = useState(cachedBootstrap?.appName ?? DEFAULT_APP_NAME);
  const [voiceEnabled, setVoiceEnabled] = useState(cachedBootstrap?.voiceEnabled ?? false);
  const [backgroundWorkEnabled, setBackgroundWorkEnabled] = useState(
    cachedBootstrap?.backgroundWorkEnabled ?? false,
  );
  const [workbenchNetworkAllowlistEnabled, setWorkbenchNetworkAllowlistEnabled] = useState(
    cachedBootstrap?.workbenchNetworkAllowlistEnabled ?? false,
  );
  const [workersAiEnabled, setWorkersAiEnabled] = useState(
    cachedBootstrap?.workersAiEnabled ?? false,
  );
  const [feedbackAdminEnabled, setFeedbackAdminEnabled] = useState(
    cachedBootstrap?.feedbackAdminEnabled ?? false,
  );
  const [consentWorkspaceId, setConsentWorkspaceId] = useState<string | null>(() =>
    cachedBootstrap
      ? deriveInitialConsentWorkspaceId({
          defaultWorkspaceId: cachedBootstrap.settings?.workspace.id ?? null,
          pathThreadId: getThreadIdFromPath(),
          threads: cachedBootstrap.threads,
        })
      : null,
  );
  // What the last bootstrap probe proved about the server. Feeds
  // OfflineProvider, and distinguishes "offline" from "signed out".
  const [reachability, setReachability] = useState<Reachability>("unknown");
  // Cold launch, offline, and no cache: we genuinely cannot know who the user
  // is. Neither the app nor AuthGate is honest, so we say so.
  const [unreachable, setUnreachable] = useState(false);

  usePostHogPrivacySync({ session, consentWorkspaceId });

  // Guards against two concurrent revalidations (mount + an `online` burst)
  // clobbering each other — only the most recently *started* call is allowed
  // to apply its result. `mountedRef` additionally stops either from touching
  // state after unmount.
  const revalidateSeqRef = useRef(0);
  const mountedRef = useRef(true);
  // The `true` assignment is load-bearing, not redundant: StrictMode mounts,
  // runs the cleanup, then re-runs this effect. Without it the ref stays false
  // after the remount and every bootstrap result below is discarded, hanging
  // dev-mode launch on the splash forever.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // One startup round trip: /api/bootstrap returns the session and, when signed
  // in, the settings + threads needed to decide onboarding — so first paint no
  // longer waits on get-session and then a second settings+threads hop.
  // Re-run from the resume signals and the re-probe below so a launch-time
  // failure (offline banner) doesn't pin the app offline forever — one trigger
  // with no fallback is what latched the banner on permanently.
  const revalidateBootstrap = useCallback(() => {
    const seq = ++revalidateSeqRef.current;
    void getBootstrap()
      .then((data) => {
        if (!mountedRef.current || revalidateSeqRef.current !== seq) return;
        // The server replied — we are online, whatever it said.
        setReachability("reachable");
        setUnreachable(false);
        setSession(data.session);

        if (data.session.authenticated) {
          // Roll the session forward. Bootstrap runs on launch and on every
          // resume, which is exactly when renewal should be considered; the ping
          // dedupes itself to twice a day and never blocks or touches auth
          // state. Without it nothing reaches Better Auth's refresh, and the
          // session expires under a user who opens the app daily.
          void maybeRenewSession();
          writeCachedBootstrap(data);
          setBootstrapProjects(data.projects);
          setBootstrapThreads(data.threads);
          setBootstrapThreadsNextCursor(data.threadsNextCursor);
          setAppName(data.appName);
          setVoiceEnabled(data.voiceEnabled);
          setBackgroundWorkEnabled(data.backgroundWorkEnabled);
          setWorkbenchNetworkAllowlistEnabled(data.workbenchNetworkAllowlistEnabled);
          setWorkersAiEnabled(data.workersAiEnabled);
          setFeedbackAdminEnabled(data.feedbackAdminEnabled);
          setOnboarding(computeOnboarding(data.settings, data.threads));
          const pathThreadId = getThreadIdFromPath();
          const derivedConsentWorkspaceId = deriveInitialConsentWorkspaceId({
            defaultWorkspaceId: data.settings?.workspace.id ?? null,
            pathThreadId,
            threads: data.threads,
          });
          setConsentWorkspaceId(derivedConsentWorkspaceId);
          // A deep-linked thread outside the (now capped) bootstrap page isn't
          // in `data.threads`, so the derivation above resolves null and
          // telemetry consent silently drops. Fall back to fetching that one
          // thread, exactly as the route effect does — telemetry fails closed,
          // so this is a lost-analytics fix, not a privacy one. Guarded by the
          // same seq/mounted checks so a stale probe can't apply.
          if (derivedConsentWorkspaceId === null && pathThreadId) {
            void getThreadOrNull(pathThreadId)
              .then((thread) => {
                if (!mountedRef.current || revalidateSeqRef.current !== seq) return;
                if (thread) setConsentWorkspaceId(thread.workspaceId);
              })
              .catch(() => {
                // A failed lookup just leaves consent unresolved (telemetry
                // stays off). No user-facing surface; nothing to report.
              });
          }
        } else {
          // Genuinely signed out (HTTP 200). Drop the cached workspace — it is
          // another session's content, and it must not survive on this device.
          purgeCachedBootstrap();
          void purgeCachedHistory();
          setBootstrapProjects([]);
          setBootstrapThreads([]);
          setBackgroundWorkEnabled(false);
          setWorkbenchNetworkAllowlistEnabled(false);
          setFeedbackAdminEnabled(false);
          setOnboarding({ status: "done" });
          setConsentWorkspaceId(null);
        }
      })
      .catch((error: unknown) => {
        if (!mountedRef.current || revalidateSeqRef.current !== seq) return;
        if (!isNetworkFailure(error)) {
          // A real server error (bootstrap_failed_5xx): the server REPLIED, so
          // it is reachable. Not an offline signal; fall back to the sign-in
          // screen as before.
          setReachability("reachable");
          setSession({ authenticated: false });
          setConsentWorkspaceId(null);
          return;
        }
        // Could not reach the server. Keep whatever cached shell we booted with
        // rather than lying that the user is signed out.
        setReachability("unreachable");
        if (!cachedBootstrap) setUnreachable(true);
      });
  }, [cachedBootstrap]);

  useEffect(() => {
    revalidateBootstrap();
  }, [revalidateBootstrap]);

  // visibilitychange + pageshow + online, the same set ThreadChat recovers on:
  // `online` alone is not guaranteed to fire, and a missed edge used to latch
  // the app offline forever. Gated like ThreadChat so sub-second visibility
  // flickers (and the initial-load signal) don't cause a revalidate storm.
  useOnResume((hiddenMs) => {
    if (!shouldRecoverOnResume(hiddenMs, 1_000)) return;
    revalidateBootstrap();
  });

  // A "reachable" verdict must not outlive a known disconnect: drop back to
  // "unknown" so `!browserOnline` shows the banner at once, and so the re-probe
  // below resumes.
  useEffect(() => {
    const onOffline = () => setReachability("unknown");
    window.addEventListener("offline", onOffline);
    return () => window.removeEventListener("offline", onOffline);
  }, []);

  // Last-resort re-probe: self-heals with NO event at all (the observed
  // failure), since every event-driven trigger above can be missed. 15s is long
  // enough to be negligible load on a bootstrap-sized GET, short enough that a
  // user who wanders back to a latched tab doesn't notice. Stops once reachable.
  useEffect(() => {
    if (reachability === "reachable") return;
    const id = setInterval(revalidateBootstrap, REPROBE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [reachability, revalidateBootstrap]);

  // The wizard's steps are addressable, so it pushes one history entry per
  // forward step — and those entries outlive it. Every one of them has pathname
  // "/", so `setPath` below is a no-op and a Back after setup looks broken; worse,
  // they still carry `onboarding=force`, so reloading on one reopens the wizard
  // and finishing it arms a second nudge. Once onboarding is done these entries
  // are dead: rewrite each as it is popped (so a reload can never re-force
  // setup) and keep going back, which is what the wizard's own pushes displaced.
  const onboardingDoneRef = useRef(onboarding.status === "done");
  useEffect(() => {
    onboardingDoneRef.current = onboarding.status === "done";
  }, [onboarding.status]);
  useEffect(() => {
    const onPop = () => {
      if (onboardingDoneRef.current && isOnboardingForced(window.location.search)) {
        clearForcedOnboarding();
        // Bounded: only a wizard entry can trigger this, and there are finitely
        // many. With nothing behind, `back()` is a no-op and the loop ends with
        // a URL that no longer re-forces setup.
        window.history.back();
        return;
      }
      setPath(window.location.pathname);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Signing in through AuthGate is the other path to an authenticated session
  // (the cold-start path is covered by bootstrap above). Set the session, then
  // re-run bootstrap so every workspace-derived setting is applied through the
  // same guarded path as startup and resume.
  const handleSignedIn = useCallback(
    (next: AuthSession) => {
      setSession(next);
      if (!next.authenticated) {
        setConsentWorkspaceId(null);
        return;
      }
      // /signin is a signed-out-only route: ChatApp doesn't know it, and leaving
      // it in the URL would strand a fresh session on an unknown path. Replace
      // rather than push so Back doesn't return to the gate.
      if (window.location.pathname === "/signin") {
        window.history.replaceState(null, "", "/");
        setPath("/");
      }
      setOnboarding({ status: "loading" });
      setConsentWorkspaceId(null);
      revalidateBootstrap();
    },
    [revalidateBootstrap],
  );

  const navigate = useCallback((to: string, mode: "push" | "replace" = "push") => {
    if (window.location.pathname !== to) {
      if (mode === "push") window.history.pushState(null, "", to);
      else window.history.replaceState(window.history.state, "", to);
    }
    setPath(to);
  }, []);

  const handleSignOut = useCallback(() => {
    void signOut().finally(() => {
      // .finally, not .then — sign-out must clear this device even if the POST
      // itself failed (e.g. offline, where appFetch rejects it outright).
      purgeCachedBootstrap();
      void purgeCachedHistory();
      resetPostHog();
      setPostHogConsent(false);
      setConsentWorkspaceId(null);
      navigate("/");
      setBootstrapProjects([]);
      setBootstrapThreads([]);
      setBackgroundWorkEnabled(false);
      setWorkbenchNetworkAllowlistEnabled(false);
      setFeedbackAdminEnabled(false);
      setSession({ authenticated: false });
    });
  }, [navigate]);

  // Hoisted above the early returns because a hook cannot be called
  // conditionally, and the title has to be decided on every branch — including
  // the loader and the unreachable screen — not just the one that renders the
  // app shell. `session === null` means "still loading", which is not the
  // landing page unless the path says so.
  const showsLanding =
    path === "/about" ||
    (session !== null && !session.authenticated && path === "/" && !hasPendingInvite());
  useDocumentTitle(showsLanding ? null : appName);

  if (unreachable) {
    return (
      <OfflineProvider reachability={reachability}>
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6 text-center">
          <div className="font-display text-2xl font-semibold">nadi</div>
          <p className="max-w-sm text-muted-foreground text-sm">
            Can't reach Nadi. Check your connection and try again.
          </p>
          <Button onClick={() => window.location.reload()}>Try again</Button>
        </div>
      </OfflineProvider>
    );
  }

  if (session === null) {
    return (
      <OfflineProvider reachability={reachability}>
        <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-background p-6">
          <BrandMark className="size-14 rounded-[12px]" />
          <div className="font-display font-semibold text-2xl">nadi</div>
          <Spinner className="size-6 text-muted-foreground" label="Loading" />
        </div>
      </OfflineProvider>
    );
  }

  // /about is the landing page's stable address: it renders whatever your session
  // is, so it can be linked and shown without signing out first. Root shows the
  // same page, but only to signed-out visitors with nothing better to do here —
  // a pending invite, a deep link, or an explicit /signin all mean this person
  // came to get in, not to be sold to.
  if (showsLanding) {
    return (
      <OfflineProvider reachability={reachability}>
        <Suspense fallback={<FullScreenLoader label="Loading" />}>
          <Landing
            onSignIn={() => navigate(session.authenticated ? "/" : "/signin")}
            signedIn={session.authenticated}
          />
        </Suspense>
      </OfflineProvider>
    );
  }

  if (!session.authenticated) {
    return (
      <OfflineProvider reachability={reachability}>
        <AuthGate onSignedIn={handleSignedIn} />
      </OfflineProvider>
    );
  }

  if (onboarding.status === "loading") {
    return (
      <OfflineProvider reachability={reachability}>
        <FullScreenLoader label="Loading" />
      </OfflineProvider>
    );
  }

  if (onboarding.status === "needed") {
    return (
      <OfflineProvider reachability={reachability}>
        <Suspense fallback={<FullScreenLoader label="Loading" />}>
          <Onboarding
            user={session.user}
            settings={onboarding.settings}
            workersAiEnabled={workersAiEnabled}
            initialStep={parseOnboardingStep(window.location.search) ?? undefined}
            installed={detectInstallPlatform() === "installed"}
            onComplete={() => {
              clearForcedOnboarding();
              setOnboarding({ status: "done" });
            }}
          />
        </Suspense>
      </OfflineProvider>
    );
  }

  return (
    <ThreadChatImplContext.Provider value={threadChat}>
      <OfflineProvider reachability={reachability}>
        <ChatApp
          consentWorkspaceId={consentWorkspaceId}
          user={session.user}
          initialProjects={bootstrapProjects}
          initialThreads={bootstrapThreads}
          initialThreadsNextCursor={bootstrapThreadsNextCursor}
          voiceEnabled={voiceEnabled}
          backgroundWorkEnabled={backgroundWorkEnabled}
          workbenchNetworkAllowlistEnabled={workbenchNetworkAllowlistEnabled}
          feedbackAdminEnabled={feedbackAdminEnabled}
          onActiveWorkspaceChange={setConsentWorkspaceId}
          onSignOut={handleSignOut}
        />
      </OfflineProvider>
    </ThreadChatImplContext.Provider>
  );
}

type SessionUser = { id: string; email?: string; name?: string | null };

function initialsFor(email: string): string {
  const local = email.split("@")[0] || email;
  const parts = local.split(/[.\-_]+/).filter(Boolean);
  const initials =
    parts.length >= 2
      ? `${(parts[0] ?? "").charAt(0)}${(parts[1] ?? "").charAt(0)}`
      : local.slice(0, 2);
  return initials.toUpperCase() || "··";
}

function BackButtonLike({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button type="button" variant="ghost" size="icon" onClick={onClick} aria-label={label}>
      <ArrowLeft aria-hidden />
    </Button>
  );
}

function FeedbackPanel({
  closeLabel,
  onClose,
  error,
}: {
  closeLabel: string;
  onClose: () => void;
  error?: Error | null;
}) {
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <Topbar
        leading={<BackButtonLike label={closeLabel} onClick={onClose} />}
        breadcrumb={<span className="truncate text-foreground">Send feedback</span>}
      />
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-3 p-6 text-center">
        <ChatCircle className="mx-auto size-8 text-muted-foreground" aria-hidden />
        <h1 className="font-display text-2xl">Send feedback</h1>
        <p className="text-muted-foreground text-sm">
          Tell the Nadi feedback agent what happened. It will ask follow-up questions before
          submitting a report.
        </p>
        {error ? (
          <p className="text-reject text-sm">{error.message}</p>
        ) : (
          <Spinner className="mx-auto size-5" />
        )}
      </div>
    </section>
  );
}

function UserMenu({
  user,
  onOpenFeedback,
  feedbackAdminEnabled,
  onOpenFeedbackInbox,
  onOpenSettings,
  onSignOut,
}: {
  user: SessionUser;
  onOpenFeedback: () => void;
  feedbackAdminEnabled: boolean;
  onOpenFeedbackInbox: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}) {
  const email = user.email ?? "signed in";
  const [confirmSignOut, setConfirmSignOut] = useState(false);

  return (
    <div className="flex w-full items-center gap-2.5 px-4 py-3 standalone:pb-[calc(0.75rem_+_env(safe-area-inset-bottom))]">
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-secondary font-medium text-secondary-foreground text-xs"
        aria-hidden="true"
      >
        {initialsFor(email)}
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground text-sm">{email}</span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* The visible affordance for the account menu — a kebab at the end of
              the email row, so it reads as "there's more here" rather than the
              whole row being a mystery target. */}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-8 shrink-0 text-muted-foreground hover:text-foreground"
            aria-label={`Account menu for ${email}`}
          >
            <DotsThree aria-hidden className="size-5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" side="top" className="w-56">
          <DropdownMenuItem onSelect={onOpenFeedback}>
            <ChatCircle aria-hidden />
            <span>Send feedback</span>
          </DropdownMenuItem>
          {feedbackAdminEnabled ? (
            <DropdownMenuItem onSelect={onOpenFeedbackInbox}>
              <Bell aria-hidden />
              <span>Feedback inbox</span>
            </DropdownMenuItem>
          ) : null}
          {/* Wrap so Radix's select Event isn't passed as the `tab` argument —
              openSettings(tab?) would otherwise route to /settings/[object Event]. */}
          <DropdownMenuItem onSelect={() => onOpenSettings()}>
            <Gear aria-hidden />
            <span>Settings</span>
          </DropdownMenuItem>
          {/* Confirm before actually signing out — the menu closes and the
              AlertDialog (rendered as a sibling below) takes over. */}
          <DropdownMenuItem onSelect={() => setConfirmSignOut(true)}>
            <SignOut aria-hidden />
            <span>Sign out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmSignOut} onOpenChange={setConfirmSignOut}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Sign out?</AlertDialogTitle>
            <AlertDialogDescription>
              You’ll need to sign in again to get back to your chats on this device.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={onSignOut}>Sign out</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
