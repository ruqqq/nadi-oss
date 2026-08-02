import { useCallback, useEffect, useState } from "react";
import { cn } from "../lib/utils";
import { ArrowSquareOut, GithubLogo, Trash } from "../icons";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { GITHUB_SETTINGS_HINT } from "../settings-ui-config";
import { SectionHeading } from "./section-ui";
import {
  GITHUB_CONNECT_PATH,
  disconnectGithubInstallation,
  getGithubSettings,
  type GithubInstallation,
  type GithubSettings,
} from "../github-api";

export function ConnectionsSection() {
  const [state, setState] = useState<GithubSettings | null>(null);
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    getGithubSettings()
      .then(setState)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err : new Error(String(err))));
  }, []);

  useEffect(() => load(), [load]);

  const disconnect = async (installationId: number) => {
    setBusyId(installationId);
    try {
      await disconnectGithubInstallation(installationId);
      load();
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Connections" className="space-y-4">
      <SectionHeading
        icon={<GithubLogo aria-hidden className="size-4 text-muted-foreground" />}
        title="GitHub"
        description={GITHUB_SETTINGS_HINT}
        action={
          state?.configured ? (
            <Button asChild variant="outline" size="sm">
              <a href={GITHUB_CONNECT_PATH}>
                <GithubLogo aria-hidden />
                Connect
              </a>
            </Button>
          ) : undefined
        }
      />

      {state === null && !loadError ? (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading installations">
          {[0, 1].map((i) => (
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
            <AlertDescription>Couldn’t load GitHub settings. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : !state?.configured ? (
        <Alert role="status">
          <AlertDescription>
            GitHub App is not configured for this deployment. An operator must register a GitHub App
            and set the credentials before repositories can be connected.
          </AlertDescription>
        </Alert>
      ) : state.installations.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed py-10 text-center">
          <p className="text-muted-foreground text-sm">No GitHub installations yet</p>
          <p className="mt-1 text-muted-foreground text-xs">
            Connect the app to let this workspace’s sandboxes reach its repositories.
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {state.installations.map((inst) => (
            <li key={inst.installationId}>
              <InstallationCard
                installation={inst}
                busy={busyId === inst.installationId}
                onDisconnect={() => disconnect(inst.installationId)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function InstallationCard({
  installation,
  busy,
  onDisconnect,
}: {
  installation: GithubInstallation;
  busy: boolean;
  onDisconnect: () => void;
}) {
  const active = installation.status === "active";
  return (
    <Card className="flex flex-row items-center gap-3 p-3">
      <GithubLogo aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="truncate font-mono text-sm">{installation.accountLogin}</span>
        <span className="flex items-center gap-1.5 truncate text-muted-foreground text-xs">
          <span
            className={cn("size-2 shrink-0 rounded-full", active ? "bg-approve" : "bg-reject")}
            aria-hidden="true"
          />
          {active ? "Active" : installation.status}
          {" · "}
          {installation.repositorySelection === "all" ? "All repositories" : "Selected repositories"}
        </span>
      </div>
      <Button asChild variant="ghost" size="icon-sm" aria-label="Manage on GitHub">
        <a
          href={`https://github.com/settings/installations/${installation.installationId}`}
          target="_blank"
          rel="noreferrer"
        >
          <ArrowSquareOut aria-hidden />
        </a>
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onDisconnect}
        disabled={busy}
        aria-label={`Disconnect ${installation.accountLogin}`}
      >
        <Trash aria-hidden />
      </Button>
    </Card>
  );
}
