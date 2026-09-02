import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArchiveButton } from "../components/ArchiveButton";
import {
  archiveSkill,
  copySkillToAgent,
  listAgentSkills,
  listSkills,
  moveSkillToLibrary,
  restoreSkill,
  setLibrarySkillExcluded,
  setSkillEnabled,
  type AgentSkills,
  type LibrarySkillForAgent,
  type Skill,
} from "../skills-api";
import { ArrowCounterClockwise, Copy, Stack } from "../icons";
import { writeThenRefresh } from "../lib/write-then-refresh";
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
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { FormCard } from "./section-ui";
import { SkillNote, SkillRow } from "./SkillRow";

/**
 * Skills as ONE agent sees them: its own, and the whole workspace library
 * annotated with why each library skill is or is not live here.
 *
 * Both groups come from a single `GET /api/agents/:id/skills` and every write
 * refetches it, because the two groups are not independent: archiving an
 * agent's skill un-shadows the library row of the same name, and a copy creates
 * the shadow. Two sections fetching separately would sit there disagreeing.
 */
export function AgentSkillsSection({
  agentId,
  otherAgentCount,
}: {
  agentId: string;
  /**
   * How many OTHER agents the workspace has — what a move to the library
   * hands the skill to. Passed in rather than fetched: the pane above already
   * holds the list, and a second `GET /api/agents` here would be a round trip
   * to re-learn a number it is looking at.
   */
  otherAgentCount: number;
}) {
  const [data, setData] = useState<AgentSkills | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Skill[] | null>(null);

  const refresh = useCallback(async () => {
    const next = await listAgentSkills(agentId);
    setData(next);
    return next;
  }, [agentId]);

  const load = useCallback(() => {
    setData(null);
    setLoadError(null);
    void refresh().catch((err: unknown) => {
      setData({ library: [], own: [] });
      setLoadError(err instanceof Error ? err : new Error(String(err)));
    });
  }, [refresh]);

  useEffect(() => {
    load();
  }, [load]);

  // The agent's archived skills are a separate listing: the agent view returns
  // only what is live, and the toggle has to be able to bring one back.
  const loadArchived = useCallback(() => {
    setArchived(null);
    void listSkills(true, agentId)
      .then(setArchived)
      .catch((err: unknown) => {
        setArchived([]);
        toast.error(err instanceof Error ? err.message : "Couldn’t load archived skills.");
      });
  }, [agentId]);

  useEffect(() => {
    if (showArchived) loadArchived();
  }, [showArchived, loadArchived]);

  /**
   * Run a write, then re-read both groups; surface the server's own message.
   *
   * `writeThenRefresh` is what keeps the two apart. A write that SUCCEEDED
   * followed by a failed re-read is not a failed write: returning `false` for
   * one rolls the caller's optimistic state back, leaving the switch reading
   * "included" for a skill the agent no longer loads — the UI stating the
   * opposite of the truth, which is the exact failure this surface exists to
   * prevent. So `false` here means the write itself was refused, and nothing
   * else can produce it.
   */
  const run = useCallback(
    async (fallback: string, action: () => Promise<unknown>) => {
      const result = await writeThenRefresh(
        action,
        refresh,
        "Saved, but couldn’t reload this agent’s skills.",
      );
      if (!result.ok) {
        toast.error(result.error instanceof Error ? result.error.message : fallback);
        return false;
      }
      return true;
    },
    [refresh],
  );

  const onSetExcluded = useCallback(
    async (skill: LibrarySkillForAgent, excluded: boolean) => {
      // Optimistic, because a switch that waits for a round trip reads as broken.
      setData((cur) =>
        cur
          ? {
              ...cur,
              library: cur.library.map((s) => (s.id === skill.id ? { ...s, excluded } : s)),
            }
          : cur,
      );
      const ok = await run("Couldn’t update the skill.", () =>
        setLibrarySkillExcluded(agentId, skill.id, excluded),
      );
      if (!ok)
        setData((cur) =>
          cur
            ? {
                ...cur,
                library: cur.library.map((s) =>
                  s.id === skill.id ? { ...s, excluded: !excluded } : s,
                ),
              }
            : cur,
        );
    },
    [agentId, run],
  );

  const onToggleOwn = useCallback(
    async (skill: Skill) => {
      const next = !skill.enabled;
      setData((cur) =>
        cur
          ? { ...cur, own: cur.own.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)) }
          : cur,
      );
      const ok = await run("Couldn’t update the skill.", () =>
        setSkillEnabled(skill.id, next, agentId),
      );
      if (!ok)
        setData((cur) =>
          cur
            ? {
                ...cur,
                own: cur.own.map((s) => (s.id === skill.id ? { ...s, enabled: !next } : s)),
              }
            : cur,
        );
    },
    [agentId, run],
  );

  const onArchiveOwn = useCallback(
    async (skill: Skill) => {
      if (await run("Couldn’t archive the skill.", () => archiveSkill(skill.id, agentId))) {
        toast.success(`Archived “${skill.name}”`);
        if (showArchived) loadArchived();
      }
    },
    [agentId, run, showArchived, loadArchived],
  );

  const onRestoreOwn = useCallback(
    async (skill: Skill) => {
      if (await run("Couldn’t restore the skill.", () => restoreSkill(skill.id, agentId))) {
        toast.success(`Restored “${skill.name}”`);
        setArchived((cur) => cur?.filter((s) => s.id !== skill.id) ?? null);
      }
    },
    [agentId, run],
  );

  const onMoveToLibrary = useCallback(
    async (skill: Skill) => {
      if (await run("Couldn’t move the skill.", () => moveSkillToLibrary(skill.id, agentId)))
        toast.success(`“${skill.name}” is now in the workspace library`);
    },
    [agentId, run],
  );

  const onCopyToAgent = useCallback(
    async (skill: Skill) => {
      if (await run("Couldn’t copy the skill.", () => copySkillToAgent(skill.id, agentId)))
        toast.success(`Copied “${skill.name}” to this agent`);
    },
    [agentId, run],
  );

  if (loadError)
    return (
      <FormCard title="Skills">
        <div className="space-y-3">
          <Alert variant="destructive">
            <AlertDescription>Couldn’t load skills. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      </FormCard>
    );

  const ownList = showArchived ? archived : (data?.own ?? null);

  return (
    <>
      <FormCard
        title="This agent’s skills"
        description="Only this agent loads these. One here takes the place of a library skill with the same name."
      >
        <section aria-label="This agent’s skills" className="space-y-4">
          <ButtonGroup aria-label="Filter this agent’s skills">
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={!showArchived}
              className={cn(!showArchived && "bg-accent text-accent-foreground")}
              onClick={() => setShowArchived(false)}
            >
              Active
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={showArchived}
              className={cn(showArchived && "bg-accent text-accent-foreground")}
              onClick={() => setShowArchived(true)}
            >
              Archived
            </Button>
          </ButtonGroup>

          {ownList === null ? (
            <SkillSkeletons label="Loading this agent’s skills" />
          ) : ownList.length === 0 ? (
            <EmptyState
              title={showArchived ? "Nothing archived here" : "No skills of its own yet"}
              hint={
                showArchived
                  ? "Skills you archive on this agent will show up here."
                  : "Ask this agent to write one in chat, or copy one down from the library below."
              }
            />
          ) : (
            <ul className="space-y-3">
              {ownList.map((skill) => (
                <SkillRow
                  key={skill.id}
                  skill={skill}
                  live={skill.enabled && !showArchived}
                  dimmed={!skill.enabled && !showArchived}
                  trailing={
                    showArchived ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onRestoreOwn(skill)}
                        aria-label={`Restore ${skill.name}`}
                      >
                        <ArrowCounterClockwise aria-hidden /> Restore
                      </Button>
                    ) : (
                      <>
                        <Switch
                          checked={skill.enabled}
                          onCheckedChange={() => onToggleOwn(skill)}
                          aria-label={
                            skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`
                          }
                        />
                        <ArchiveButton
                          itemName={skill.name}
                          kind="skill"
                          onConfirm={() => onArchiveOwn(skill)}
                        />
                      </>
                    )
                  }
                  footer={
                    showArchived ? null : (
                      <MoveToLibraryButton
                        skillName={skill.name}
                        otherAgentCount={otherAgentCount}
                        onConfirm={() => onMoveToLibrary(skill)}
                      />
                    )
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </FormCard>

      <FormCard
        title="From the workspace library"
        description="Shared with every agent. Switch one off to leave it out of this agent; edit it in Settings → Skills, where the edit reaches everyone."
      >
        <section aria-label="From the workspace library" className="space-y-4">
          {data === null ? (
            <SkillSkeletons label="Loading the workspace library" />
          ) : data.library.length === 0 ? (
            <EmptyState
              title="The library is empty"
              hint="Move one of this agent’s skills up, or write one in Settings → Skills, to share it with every agent."
            />
          ) : (
            <ul className="space-y-3">
              {data.library.map((skill) => (
                <LibraryRow
                  key={skill.id}
                  skill={skill}
                  ownName={data.own.find((s) => s.id === skill.shadowedByOwnSkillId)?.name}
                  onSetExcluded={onSetExcluded}
                  onCopy={onCopyToAgent}
                />
              ))}
            </ul>
          )}
        </section>
      </FormCard>
    </>
  );
}

/**
 * A library skill as this agent sees it. Three things can keep it from reaching
 * the model and they are NOT interchangeable, so the row names the one that
 * applies: the agent's own skill wins on the name, this agent opted out, or the
 * skill is switched off for everyone. The dot is the honest summary — it is lit
 * only when none of them apply, which is exactly `listEffective`'s rule.
 */
function LibraryRow({
  skill,
  ownName,
  onSetExcluded,
  onCopy,
}: {
  skill: LibrarySkillForAgent;
  ownName: string | undefined;
  onSetExcluded: (s: LibrarySkillForAgent, excluded: boolean) => void;
  onCopy: (s: Skill) => void;
}) {
  const shadowed = skill.shadowedByOwnSkillId !== null;
  const live = skill.enabled && !skill.excluded && !shadowed;

  const notes: string[] = [];
  if (shadowed)
    notes.push(`Shadowed by this agent’s own ${ownName ?? skill.name}`);
  else if (skill.excluded) notes.push("Left out of this agent");
  if (!skill.enabled) notes.push("Switched off in the library, so no agent loads it");

  return (
    <SkillRow
      skill={skill}
      live={live}
      dimmed={!live}
      notes={notes.map((note) => (
        <SkillNote key={note}>{note}</SkillNote>
      ))}
      trailing={
        // A shadowed row is inert: the agent's own skill of that name already
        // decides the matter, so an "included here" switch would promise a
        // change it cannot make.
        shadowed ? null : (
          <Switch
            checked={!skill.excluded}
            onCheckedChange={(next) => onSetExcluded(skill, !next)}
            aria-label={
              skill.excluded
                ? `Use ${skill.name} on this agent`
                : `Exclude ${skill.name} from this agent`
            }
          />
        )
      }
      footer={
        // Copying makes a private twin that shadows this row — impossible while
        // one already does, so the action is simply absent there.
        shadowed ? null : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onCopy(skill)}
            aria-label={`Copy ${skill.name} to this agent`}
          >
            <Copy aria-hidden /> Copy to this agent
          </Button>
        )
      }
    />
  );
}

/**
 * Promoting a private skill into the shared library, behind a confirm.
 *
 * It shipped as a bare one-click ghost button beside an archive that asks for
 * confirmation and a delete that makes you type the agent's name — the least
 * guarded gesture on the page doing the widest thing on it. Three consequences,
 * none of them visible from the button:
 *
 * 1. **Reach.** Every agent in the workspace loads it, except any that already
 *    has its own skill of that name (own beats library — `listEffective`).
 * 2. **Egress.** The row keeps its `network_domains` (`moveToLibrary` re-points
 *    `agent_id` and nothing else), and `listEnabledSkillDomains` resolves over
 *    the EFFECTIVE set, so those hosts join every carrying agent's sandbox
 *    allowlist (`src/agent/compute-tools.ts:371-420`). Stated conditionally
 *    because it only bites where the sandbox is restricted at all: with the
 *    workspace's network restriction off, `allowedHosts` is `null` and
 *    `unionAllowlistWithSkillDomains` returns `null` unchanged.
 * 3. **No way back.** Nothing moves a skill OUT of the library; recovery is
 *    copy-to-agent then archive the library row, and the id changes.
 */
function MoveToLibraryButton({
  skillName,
  otherAgentCount,
  onConfirm,
}: {
  skillName: string;
  otherAgentCount: number;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Move ${skillName} to the workspace library`}
        >
          <Stack aria-hidden /> Move to library
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move “{skillName}” to the workspace library?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>{moveReachLine(skillName, otherAgentCount)}</p>
              <p>
                Any sandbox hosts it opens open for those agents too, and it stops being archived
                along with this agent.
              </p>
              <p>
                There is no move back: returning it here means copying it down and archiving the
                library copy.
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Move to library</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * The reach, before the move rather than after it.
 *
 * A count of OTHER agents, not of carriers: exclusions and same-named private
 * skills on other agents are not visible from this page, so the honest shape is
 * the rule plus the population, with the shadowing caveat named. With no other
 * agents the number would read as "this does nothing", which is wrong — the
 * library is what every agent added later inherits.
 */
export function moveReachLine(skillName: string, otherAgentCount: number): string {
  if (otherAgentCount <= 0)
    return `This workspace has no other agents yet, but every agent added later loads “${skillName}” from the library.`;
  const others =
    otherAgentCount === 1 ? "The 1 other agent" : `All ${otherAgentCount} other agents`;
  return `${others} in this workspace will load it, except any that already has its own skill called “${skillName}”.`;
}

function SkillSkeletons({ label }: { label: string }) {
  return (
    <ul className="space-y-3" aria-busy="true" aria-label={label}>
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
  );
}

function EmptyState({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="rounded-lg border border-border border-dashed py-10 text-center">
      <p className="text-muted-foreground text-sm">{title}</p>
      <p className="mx-auto mt-1 max-w-prose px-4 text-muted-foreground text-xs">{hint}</p>
    </div>
  );
}
