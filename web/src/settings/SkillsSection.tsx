import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ArchiveButton } from "../components/ArchiveButton";
import { SKILLS_SETTINGS_HINT } from "../settings-ui-config";
import { archiveSkill, listSkills, restoreSkill, setSkillEnabled, type Skill } from "../skills-api";
import { ArrowCounterClockwise, CaretDown } from "../icons";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { SectionHeading } from "./section-ui";

/**
 * Skills have two scopes. With no `agentId` this is the workspace LIBRARY —
 * the shared skills every agent inherits, which is what the Skills tab manages.
 * With one, it is that agent's private skills, which shadow a library skill of
 * the same name.
 */
export function SkillsSection({ agentId = null }: { agentId?: string | null } = {}) {
  const [skills, setSkills] = useState<Skill[] | null>(null); // null = loading
  const [loadError, setLoadError] = useState<Error | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(() => {
    setSkills(null);
    setLoadError(null);
    void listSkills(showArchived, agentId)
      .then(setSkills)
      .catch((err: unknown) => {
        setSkills([]);
        setLoadError(err instanceof Error ? err : new Error(String(err)));
      });
  }, [showArchived, agentId]);

  useEffect(() => {
    load();
  }, [load]);

  const onToggle = useCallback(async (skill: Skill) => {
    const next = !skill.enabled;
    setSkills((cur) => cur?.map((s) => (s.id === skill.id ? { ...s, enabled: next } : s)) ?? null);
    try {
      const updated = await setSkillEnabled(skill.id, next, agentId);
      setSkills((cur) => cur?.map((s) => (s.id === updated.id ? updated : s)) ?? null);
    } catch (err) {
      setSkills(
        (cur) => cur?.map((s) => (s.id === skill.id ? { ...s, enabled: !next } : s)) ?? null,
      );
      toast.error(err instanceof Error ? err.message : "Couldn’t update the skill.");
    }
  }, []);

  const onArchive = useCallback(async (skill: Skill) => {
    try {
      await archiveSkill(skill.id, agentId);
      setSkills((cur) => cur?.filter((s) => s.id !== skill.id) ?? null);
      toast.success(`Archived “${skill.name}”`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn’t archive the skill.");
    }
  }, []);

  const onRestore = useCallback(async (skill: Skill) => {
    try {
      await restoreSkill(skill.id, agentId);
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
          {skills.map((skill) => (
            <SkillRow
              key={skill.id}
              skill={skill}
              archivedView={showArchived}
              onToggle={onToggle}
              onArchive={onArchive}
              onRestore={onRestore}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SkillRow({
  skill,
  archivedView,
  onToggle,
  onArchive,
  onRestore,
}: {
  skill: Skill;
  archivedView: boolean;
  onToggle: (s: Skill) => void;
  onArchive: (s: Skill) => void;
  onRestore: (s: Skill) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <li>
      <Card className={cn("overflow-hidden p-0", !skill.enabled && !archivedView && "opacity-70")}>
        <div className="flex items-center gap-3 p-3">
          <span
            className={cn(
              "size-2 shrink-0 rounded-full",
              skill.enabled && !archivedView ? "bg-approve" : "bg-muted-foreground/40",
            )}
            aria-hidden="true"
          />
          <button
            className="group/expand -m-1 flex min-w-0 flex-1 items-center gap-2 rounded-md p-1 text-left transition-colors hover:bg-muted/50"
            type="button"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
            aria-controls={`skill-body-${skill.id}`}
            title={expanded ? "Hide skill body" : "Show skill body"}
          >
            <CaretDown
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 text-muted-foreground transition-transform",
                expanded && "rotate-180",
              )}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate font-medium text-sm">{skill.name}</span>
              <span className="truncate text-muted-foreground text-xs">{skill.description}</span>
            </span>
          </button>

          {archivedView ? (
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
          )}
        </div>

        {expanded && (
          <>
            <Separator />
            <div id={`skill-body-${skill.id}`} className="bg-muted/30 p-3">
              <pre className="whitespace-pre-wrap break-words font-mono text-muted-foreground text-xs">
                {skill.body}
              </pre>
            </div>
          </>
        )}
      </Card>
    </li>
  );
}
