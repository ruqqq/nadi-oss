import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { GitBranch, GithubLogo, Globe, Plus, X } from "../icons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../components/ui/command";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "../components/ui/popover";
import { Separator } from "../components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "../components/ui/sheet";
import { Spinner } from "../components/ui/spinner";
import { useMediaQuery } from "../lib/use-media-query";
import {
  getGithubSettings,
  listInstallationRepositories,
  type GithubRepo,
} from "../github-api";
import type { WorkbenchRepositoryInput } from "../workbenches-api";

// Mono config fields hold literal values (URLs, paths, branches, commands), so
// the keyboard must not autocorrect, auto-capitalize, or spell-check them.
const monoFieldProps = {
  className: "font-mono text-xs",
  autoCapitalize: "off",
  autoCorrect: "off",
  spellCheck: false,
} as const;

const BLANK_URL_REPO: WorkbenchRepositoryInput = {
  source: "url",
  name: "",
  url: "",
  checkoutPathName: "",
  defaultBranch: "main",
  rootDirectory: "",
  setupCommand: "",
  packageManager: "",
};

/** Derive a folder-safe checkout name from a git URL's basename, e.g.
 *  "https://github.com/org/repo.git" -> "repo". Empty input yields "". */
function checkoutNameFromUrl(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  return last.replace(/\.git$/i, "");
}

/**
 * Repositories staged for a workbench, controlled by the parent form (create
 * stages locally; edit seeds from the loaded workbench and saves via
 * `setWorkbenchRepositories` on Save). Renders per-repo config cards plus an
 * "Add a repository" picker (GitHub App repos + add-by-URL).
 */
export function WorkbenchRepositories({
  value,
  onChange,
}: {
  value: WorkbenchRepositoryInput[];
  onChange: (next: WorkbenchRepositoryInput[]) => void;
}) {
  const updateAt = useCallback(
    (index: number, patch: Partial<WorkbenchRepositoryInput>) => {
      onChange(value.map((repo, i) => (i === index ? { ...repo, ...patch } : repo)));
    },
    [value, onChange],
  );

  const removeAt = useCallback(
    (index: number) => {
      onChange(value.filter((_, i) => i !== index));
    },
    [value, onChange],
  );

  const attachedGithubIds = useMemo(
    () => new Set(value.map((r) => r.githubRepoId).filter((id): id is number => id !== undefined)),
    [value],
  );

  const addRepo = useCallback(
    (repo: WorkbenchRepositoryInput) => {
      onChange([...value, repo]);
    },
    [value, onChange],
  );

  return (
    <div className="space-y-3">
      {value.length === 0 ? (
        <p className="text-muted-foreground text-xs">No repositories attached yet.</p>
      ) : (
        <ul className="space-y-3">
          {value.map((repo, index) => (
            <li key={`${repo.source}:${repo.githubRepoId ?? repo.url}:${index}`}>
              <RepoCard
                repo={repo}
                onFieldChange={(patch) => updateAt(index, patch)}
                onRemove={() => removeAt(index)}
              />
            </li>
          ))}
        </ul>
      )}
      <AddRepositoryPicker
        excludedGithubIds={attachedGithubIds}
        onAddGithub={addRepo}
        onAddUrl={() => addRepo({ ...BLANK_URL_REPO })}
      />
    </div>
  );
}

/** One attached repo's identity header + editable config fields. */
function RepoCard({
  repo,
  onFieldChange,
  onRemove,
}: {
  repo: WorkbenchRepositoryInput;
  onFieldChange: (patch: Partial<WorkbenchRepositoryInput>) => void;
  onRemove: () => void;
}) {
  const idPrefix = useId();
  const identity = repo.source === "github" ? repo.name : repo.name || "New repository";

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <div className="flex min-w-0 items-center gap-2 p-3">
        <GitBranch aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <span
          className="min-w-0 flex-1 truncate font-mono text-sm"
          title={identity || undefined}
        >
          {identity || "New repository"}
        </span>
        <Badge variant="outline" className="shrink-0 text-[0.65rem] uppercase">
          {repo.source === "github" ? "GitHub" : "URL"}
        </Badge>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          aria-label={`Remove ${identity || "repository"}`}
          title={`Remove ${identity || "repository"}`}
        >
          <X aria-hidden className="size-3.5" />
        </Button>
      </div>
      <Separator />
      <div className="grid grid-cols-1 gap-3 bg-muted/30 p-3 min-[560px]:grid-cols-2">
        {repo.source === "url" && (
          <div className="space-y-1.5 min-[560px]:col-span-2">
            <Label htmlFor={`${idPrefix}-url`}>Git URL</Label>
            <Input
              id={`${idPrefix}-url`}
              {...monoFieldProps}
              value={repo.url}
              onChange={(event) => {
                const url = event.target.value;
                onFieldChange({
                  url,
                  // Keep the identity + checkout folder in sync with the URL
                  // until the user overrides them directly.
                  name: repo.name === "" || repo.name === checkoutNameFromUrl(repo.url) ? checkoutNameFromUrl(url) : repo.name,
                  checkoutPathName:
                    repo.checkoutPathName === "" || repo.checkoutPathName === checkoutNameFromUrl(repo.url)
                      ? checkoutNameFromUrl(url)
                      : repo.checkoutPathName,
                });
              }}
              placeholder="https://github.com/org/repo.git"
            />
          </div>
        )}
        {repo.source === "url" && (
          <Field
            id={`${idPrefix}-checkout`}
            label="Checkout folder"
            value={repo.checkoutPathName}
            onChange={(v) => onFieldChange({ checkoutPathName: v })}
            placeholder="repo"
          />
        )}
        <Field
          id={`${idPrefix}-branch`}
          label="Branch"
          value={repo.defaultBranch ?? ""}
          onChange={(v) => onFieldChange({ defaultBranch: v })}
          placeholder="main"
        />
        <Field
          id={`${idPrefix}-root`}
          label="Root directory"
          value={repo.rootDirectory ?? ""}
          onChange={(v) => onFieldChange({ rootDirectory: v })}
          placeholder="apps/web"
        />
        <Field
          id={`${idPrefix}-setup`}
          label="Setup command"
          value={repo.setupCommand ?? ""}
          onChange={(v) => onFieldChange({ setupCommand: v })}
          placeholder="pnpm install"
        />
        <Field
          id={`${idPrefix}-pm`}
          label="Package manager"
          value={repo.packageManager ?? ""}
          onChange={(v) => onFieldChange({ packageManager: v })}
          placeholder="pnpm"
        />
      </div>
    </Card>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        {...monoFieldProps}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

/** Backstop against a server that never stops saying `hasNextPage` (100 repos/page). */
const MAX_REPO_PAGES = 20;

type PickerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      hasActiveInstallations: boolean;
      repos: Array<{ repo: GithubRepo; installationId: string }>;
    };

/**
 * "Add a repository" affordance: an anchored Popover on desktop, a bottom
 * Sheet on mobile (mirrors ProjectPicker / WatcherChip). Lists every active
 * GitHub App installation's repositories merged together, plus a persistent
 * footer action to add a non-GitHub repo by URL.
 */
function AddRepositoryPicker({
  excludedGithubIds,
  onAddGithub,
  onAddUrl,
}: {
  excludedGithubIds: Set<number>;
  onAddGithub: (repo: WorkbenchRepositoryInput) => void;
  onAddUrl: () => void;
}) {
  const [open, setOpen] = useState(false);
  const isMobile = useMediaQuery("(max-width: 640px)");
  const [state, setState] = useState<PickerState>({ status: "idle" });

  useEffect(() => {
    if (!open) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const settings = await getGithubSettings();
      const active = settings.installations.filter((i) => i.status === "active");
      const perInstallation = await Promise.all(
        active.map(async (inst) => {
          try {
            // The list endpoint keys on the NUMERIC GitHub installation id; the
            // string row id (`inst.id`) is only the FK we stamp onto the saved
            // repo as `sourceInstallationId` below.
            //
            // GitHub caps this at 100 repos per page. Search is client-side over
            // whatever we loaded, so stopping at page 1 makes repo 101 simply
            // unfindable — walk every page.
            const collected: GithubRepo[] = [];
            for (let page = 1; page <= MAX_REPO_PAGES; page++) {
              const { repositories, hasNextPage } = await listInstallationRepositories(
                String(inst.installationId),
                page,
              );
              collected.push(...repositories);
              if (!hasNextPage) break;
            }
            return collected.map((repo) => ({ repo, installationId: inst.id }));
          } catch {
            // One installation failing to list shouldn't blank the whole picker.
            return [];
          }
        }),
      );
      if (cancelled) return;
      setState({
        status: "ready",
        hasActiveInstallations: active.length > 0,
        repos: perInstallation.flat(),
      });
    })().catch((err: unknown) => {
      if (cancelled) return;
      setState({
        status: "error",
        message: err instanceof Error ? err.message : "Couldn't load GitHub repositories.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open]);

  const handleSelectGithub = (repo: GithubRepo, installationId: string) => {
    onAddGithub({
      source: "github",
      name: repo.fullName,
      url: repo.cloneUrl,
      githubRepoId: repo.id,
      sourceInstallationId: installationId,
      checkoutPathName: repo.name,
      defaultBranch: repo.defaultBranch,
      rootDirectory: "",
      setupCommand: "",
      packageManager: "",
    });
    setOpen(false);
  };

  const handleAddUrl = () => {
    onAddUrl();
    setOpen(false);
  };

  const availableRepos =
    state.status === "ready" ? state.repos.filter(({ repo }) => !excludedGithubIds.has(repo.id)) : [];

  const body = (
    <div className="flex flex-col gap-2">
      {state.status === "loading" && (
        <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground text-xs">
          <Spinner className="size-4" />
          Loading GitHub repositories…
        </div>
      )}
      {state.status === "error" && (
        <Alert variant="destructive">
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
      )}
      {state.status === "ready" && !state.hasActiveInstallations && (
        <p className="rounded-md border border-border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
          Connect GitHub in Connections to attach repos from a GitHub App installation.
        </p>
      )}
      {state.status === "ready" && state.hasActiveInstallations && (
        <Command className="bg-transparent">
          <CommandInput placeholder="Search repositories…" />
          <CommandList className="max-h-64">
            <RepoResults repos={availableRepos} onSelect={handleSelectGithub} />
          </CommandList>
        </Command>
      )}
      <Separator />
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start gap-1.5"
        onClick={handleAddUrl}
      >
        <Globe aria-hidden />
        Add a non-GitHub repo by URL
      </Button>
    </div>
  );

  const trigger = (
    <Button type="button" variant="outline" size="sm" className="w-full sm:w-auto">
      <Plus aria-hidden />
      Add a repository
    </Button>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetTrigger asChild>{trigger}</SheetTrigger>
        <SheetContent
          side="bottom"
          className="flex max-h-[70vh] flex-col gap-0 p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader className="shrink-0 border-b py-4 pr-12 pl-5 text-left">
            <SheetTitle className="text-base">Add a repository</SheetTitle>
          </SheetHeader>
          <div className="min-h-0 flex-1 overflow-y-auto p-3">{body}</div>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-3">
        {body}
      </PopoverContent>
    </Popover>
  );
}

/** cmdk filters CommandItems against the CommandInput query automatically. */
function RepoResults({
  repos,
  onSelect,
}: {
  repos: Array<{ repo: GithubRepo; installationId: string }>;
  onSelect: (repo: GithubRepo, installationId: string) => void;
}) {
  if (repos.length === 0) {
    return <CommandEmpty>No repositories found</CommandEmpty>;
  }
  return (
    <CommandGroup>
      {repos.map(({ repo, installationId }) => (
        <CommandItem
          key={repo.id}
          value={repo.fullName}
          onSelect={() => onSelect(repo, installationId)}
        >
          <GithubLogo aria-hidden />
          <span className="truncate">{repo.fullName}</span>
        </CommandItem>
      ))}
    </CommandGroup>
  );
}
