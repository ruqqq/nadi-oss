import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArchiveButton } from "../components/ArchiveButton";
import { SKILLS_SETTINGS_HINT } from "../settings-ui-config";
import { archiveSkill, listSkills, restoreSkill, setSkillEnabled, type Skill } from "../skills-api";
import { ArrowCounterClockwise } from "../icons";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SectionHeading } from "./section-ui";
import { SkillNote, SkillRow } from "./SkillRow";

/**
 * The workspace LIBRARY — the shared skills every agent inherits.
 *
 * This section is library-scope only. An agent's own skills, and the library as
 * that agent sees it, are `AgentSkillsSection`: both groups there come from one
 * `GET /api/agents/:id/skills`, because archiving an agent's skill un-shadows a
 * library row and two independently-fetching sections would disagree about it.
 */
export function SkillsSection() {
  const [skills, setSkills] = useState<Skill[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    setSkills(null);
    setLoadError(null);
    void listSkills(showArchived)
      .then(setSkills)
      .catch((err: unknown) => {
        setSkills([]);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [showArchived]);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = useCallback(async (skill: Skill) => {
    const next = !skill.enabled;
    setSkills((cur) => cur?.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)) ?? null);
    try {
      const updated = await setSkillEnabled(skill.id, next);
      // The server does not recompute the reach count on a write, so keep the
      // one we were listed with rather than dropping the line mid-interaction.
      setSkills(
        (cur) =>
          cur?.map((s) =>
            s.id === updated.id ? { ...updated, liveOnAgentCount: s.liveOnAgentCount } : s,
          ) ?? null,
      );
    } catch (err) {
      setSkills(
        (cur) => cur?.map((s) => (s.id === skill.id ? { ...s, enabled: !next } : s)) ?? null,
      );
      toast.error(err instanceof Error ? err.message : "Couldn’t update the skill.");
    }
  }, []);

  const onArchive = useCallback(async (skill: Skill) => {
    try {
      await archiveSkill(skill.id);
      setSkills((cur) => cur?.filter((s) => s.id !== skill.id) ?? null);
      toast.success(`Archived “${skill.name}”`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t archive the skill.");
    }
  }, []);

  const onRestore = useCallback(async (skill: Skill) => {
    try {
      await restoreSkill(skill.id);
      setSkills((cur) => cur?.filter((s) => s.id !== skill.id) ?? null);
      toast.success(`Restored “${skill.name}”`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t restore the skill.");
    }
  }, []);

  return (
    <section aria-label="Skills" className="space-y-4">
      <SectionHeading title="Skills" description={SKILLS_SETTINGS_HINT} />

      <ButtonGroup aria-label="Filter skills">
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

      {skills === null ? (
        <ul className="space-y-3" aria-busy="true" aria-label="Loading skills">
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
            <AlertDescription>Couldn’t load skills. {loadError.message}</AlertDescription>
          </Alert>
          <Button variant="outline" onClick={load}>
            Retry
          </Button>
        </div>
      ) : skills.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed py-10 text-center">
          <p className="text-muted-foreground text-sm">
            {showArchived ? "No archived skills" : "No skills yet"}
          </p>
          <p className="mt-1 text-muted-foreground text-xs">
            {showArchived
              ? "Skills you archive will show up here."
              : "Ask the agent to create one in chat."}
          </p>
        </div>
      ) : (
        <ul className="space-y-3">
          {skills.map((skill) => {
            const reach = showArchived ? null : reachLine(skill);
            return (
            <SkillRow
              key={skill.id}
              skill={skill}
              live={skill.enabled && !showArchived}
              dimmed={!skill.enabled && !showArchived}
              notes={reach ? <SkillNote>{reach}</SkillNote> : null}
              trailing={
                showArchived ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRestore(skill)}
                    aria-label={`Restore ${skill.name}`}
                  >
                    <ArrowCounterClockwise aria-hidden /> Restore
                  </Button>
                ) : (
                  <>
                    <Switch
                      checked={skill.enabled}
                      onCheckedChange={() => onToggle(skill)}
                      aria-label={skill.enabled ? `Disable ${skill.name}` : `Enable ${skill.name}`}
                    />
                    <ArchiveButton
                      itemName={skill.name}
                      kind="skill"
                      onConfirm={() => onArchive(skill)}
                    />
                  </>
                )
              }
            />
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * How far this library skill reaches — deliberately still a count while the
 * skill is switched off, because the off state is reversible and collapsing the
 * number to zero would hide the blast radius exactly when someone is deciding
 * whether to edit it. `listEffective` filters on `enabled`, so a disabled skill
 * resolves for NOBODY; the conditional mood is what keeps the line honest, and
 * it is only safe because the switch sits on the same row.
 *
 * Absent on an older server, and on the archived tab, where it means nothing —
 * we render no line at all rather than a confident zero.
 */
function reachLine(skill: Skill): string | null {
  const count = skill.liveOnAgentCount;
  if (typeof count !== "number") return null;
  if (skill.enabled) {
    if (count === 0) return "Not live on any agent";
    return count === 1 ? "Live on 1 agent" : `Live on ${count} agents`;
  }
  if (count === 0) return "Switched off — no agent would load it";
  return count === 1
    ? "Switched off — 1 agent would load it"
    : `Switched off — ${count} agents would load it`;
}
