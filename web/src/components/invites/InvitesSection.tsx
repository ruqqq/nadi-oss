import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  createInviteLink,
  inviteEmail,
  inviteUrl,
  listInvites,
  revokeInvite,
  type Invite,
  type InviteQuota,
  type InvitesResponse,
} from "../../invites-api";
import { INVITES_SETTINGS_HINT } from "../../settings-ui-config";
import { Check, Copy, Plus, Trash } from "../../icons";
import { cn } from "@/lib/utils";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function InvitesSection({
  onQuotaChange,
}: {
  /** Keeps the sidebar's invite count in step with what this panel shows. */
  onQuotaChange?: (quota: InviteQuota) => void;
}) {
  const [data, setData] = useState<InvitesResponse | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [creating, setCreating] = useState(false);

  const load = useCallback(() => {
    setData(null);
    setLoadError(null);
    void listInvites()
      .then(setData)
      .catch((err: unknown) => {
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    if (data) onQuotaChange?.(data.quota);
  }, [data, onQuotaChange]);

  const onCreateLink = async () => {
    setCreating(true);
    try {
      const invite = await createInviteLink();
      setData((cur) => (cur ? { ...cur, invites: [invite, ...cur.invites] } : cur));
      await navigator.clipboard?.writeText(inviteUrl(invite.token ?? "")).catch(() => {});
      toast.success("Invite link created and copied to your clipboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t create an invite link.");
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (invite: Invite) => {
    const previous = data;
    setData((cur) =>
      cur ? { ...cur, invites: cur.invites.filter((i) => i.id !== invite.id) } : cur,
    );
    try {
      await revokeInvite(invite.id);
      toast.success("Invite revoked");
    } catch (err) {
      setData(previous);
      toast.error(err instanceof Error ? err.message : "Couldn’t revoke the invite.");
    }
  };

  const onInviteFromWaitingList = async (email: string) => {
    const previous = data;
    setData((cur) =>
      cur ? { ...cur, waitingList: cur.waitingList.filter((w) => w.email !== email) } : cur,
    );
    try {
      const invite = await inviteEmail(email);
      setData((cur) => (cur ? { ...cur, invites: [invite, ...cur.invites] } : cur));
      toast.success(`Invited ${email} — they can sign in now`);
    } catch (err) {
      setData(previous);
      toast.error(err instanceof Error ? err.message : `Couldn’t invite ${email}.`);
    }
  };

  if (loadError) {
    return (
      <section className="space-y-4">
        <SectionHeading />
        <div className="space-y-3" role="alert">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load invites. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      </section>
    );
  }

  if (data === null) {
    return (
      <section className="space-y-4">
        <SectionHeading />
        <ul className="space-y-3" aria-busy="true" aria-label="Loading invites">
          {[0, 1, 2].map((i) => (
            <Card key={i} className="flex flex-row items-center gap-3 p-3">
              <Skeleton className="size-2 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="size-8 shrink-0 rounded-md" />
            </Card>
          ))}
        </ul>
      </section>
    );
  }

  const { invites, quota, isSuperuser, waitingList } = data;
  const atLimit = quota.limit !== null && quota.used >= quota.limit;

  return (
    <section className="space-y-8">
      <div className="space-y-4">
        <SectionHeading />

        <div className="flex flex-wrap items-center justify-between gap-3">
          <QuotaMeter quota={quota} />
          <Button size="sm" onClick={onCreateLink} disabled={creating || atLimit}>
            <Plus aria-hidden />
            Create invite link
          </Button>
        </div>

        {atLimit && (
          <Alert>
            <AlertDescription>
              You’ve used all {quota.limit} of your invites. Revoke one that hasn’t been used yet to
              free up a slot.
            </AlertDescription>
          </Alert>
        )}

        {invites.length === 0 ? (
          <div className="rounded-lg border border-border border-dashed py-10 text-center">
            <p className="text-muted-foreground text-sm">No invites yet</p>
            <p className="mt-1 text-muted-foreground text-xs">
              Create a link and send it to whoever you want to bring in.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {invites.map((invite) => (
              <InviteRow key={invite.id} invite={invite} onRevoke={onRevoke} />
            ))}
          </ul>
        )}
      </div>

      {isSuperuser && (
        <>
          <Separator />
          <div className="space-y-4">
            <div className="space-y-1">
              <h2 className="font-display font-semibold text-lg">Waiting list</h2>
              <p className="text-muted-foreground text-sm">
                People who tried to sign in without an invite. Inviting one lets them in
                immediately.
              </p>
            </div>

            {waitingList.length === 0 ? (
              <div className="rounded-lg border border-border border-dashed py-10 text-center">
                <p className="text-muted-foreground text-sm">Nobody’s waiting</p>
              </div>
            ) : (
              <ul className="space-y-3">
                {waitingList.map((entry) => (
                  <li key={entry.email}>
                    <Card className="flex flex-row flex-wrap items-center gap-3 p-3">
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate font-mono text-sm">{entry.email}</span>
                        <span className="text-muted-foreground text-xs">
                          {formatDate(entry.createdAt)}
                          {entry.attempts > 1 && ` · ${entry.attempts} attempts`}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => void onInviteFromWaitingList(entry.email)}
                      >
                        Invite
                      </Button>
                    </Card>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The quota is a small countable set, so show it as the set: one mark per slot,
 * filled as it's spent. A bar or a big number would abstract away the one thing
 * a person actually wants to know — how many people they can still bring in.
 */
function QuotaMeter({ quota }: { quota: InviteQuota }) {
  if (quota.limit === null) {
    return (
      <p className="flex items-baseline gap-2 text-muted-foreground text-sm">
        <span className="font-display font-semibold text-foreground text-xl leading-none">∞</span>
        Unlimited invites
      </p>
    );
  }

  const remaining = Math.max(0, quota.limit - quota.used);
  return (
    <p
      className="flex items-center gap-2.5 text-muted-foreground text-sm"
      aria-label={`${remaining} of ${quota.limit} invites left`}
    >
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: quota.limit }, (_, i) => (
          <span
            key={i}
            className={cn(
              "size-2.5 rounded-full border",
              i < quota.used
                ? "border-primary bg-primary"
                : "border-muted-foreground/40 bg-transparent",
            )}
          />
        ))}
      </span>
      <span>
        <span className="font-medium text-foreground">{remaining}</span>{" "}
        {remaining === 1 ? "invite" : "invites"} left
      </span>
    </p>
  );
}

function SectionHeading() {
  return (
    <div className="space-y-1">
      <h2 className="font-display font-semibold text-lg">Invites</h2>
      <p className="text-muted-foreground text-sm">{INVITES_SETTINGS_HINT}</p>
    </div>
  );
}

function InviteRow({
  invite,
  onRevoke,
}: {
  invite: Invite;
  onRevoke: (invite: Invite) => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const accepted = invite.status === "accepted";

  const onCopy = async () => {
    if (!invite.token) return;
    try {
      await navigator.clipboard.writeText(inviteUrl(invite.token));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error("Couldn’t copy the link. Select and copy it manually.");
    }
  };

  const label =
    invite.status === "pending"
      ? "Link not used yet"
      : accepted
        ? `${invite.email} joined`
        : `Opened by ${invite.email} — not signed in yet`;

  return (
    <li>
      <Card className="flex flex-row flex-wrap items-center gap-3 p-3">
        <span
          className={cn(
            "size-2 shrink-0 rounded-full",
            accepted
              ? "bg-approve"
              : invite.status === "claimed"
                ? "bg-gate"
                : "bg-muted-foreground/40",
          )}
          aria-hidden="true"
        />

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-sm">{label}</span>
          {invite.token && !accepted ? (
            <span className="truncate font-mono text-muted-foreground text-xs">
              {inviteUrl(invite.token)}
            </span>
          ) : (
            <span className="text-muted-foreground text-xs">
              {formatDate(invite.acceptedAt ?? invite.claimedAt ?? invite.createdAt)}
            </span>
          )}
        </div>

        {invite.token && !accepted && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy invite link"
            title="Copy invite link"
            onClick={() => void onCopy()}
          >
            {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
          </Button>
        )}

        {!accepted && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="ghost" size="icon" aria-label="Revoke invite" title="Revoke invite">
                <Trash aria-hidden />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Revoke this invite?</AlertDialogTitle>
                <AlertDialogDescription>
                  {invite.status === "claimed"
                    ? `${invite.email} won’t be able to sign in. This frees up the slot.`
                    : "The link will stop working for anyone who has it."}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => void onRevoke(invite)}>Revoke</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </Card>
    </li>
  );
}
