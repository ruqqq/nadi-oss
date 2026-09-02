import { useEffect, useId, useState, type FormEvent } from "react";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import type { Skill, SkillDraft } from "../skills-api";
import { Field } from "./section-ui";

/**
 * Writing or rewriting a workspace-library skill.
 *
 * The library is one shared copy, so an edit here reaches every agent that
 * carries the skill — the reason `liveOnAgentCount` exists at all. That number
 * is therefore rendered INSIDE this dialog rather than only on the row behind
 * it: the row states the reach while you are browsing, and this states it at
 * the moment you are about to change the thing.
 *
 * A dialog rather than an inline form, matching `AddModelDialog`: authoring is
 * deliberate and occasional, and the body field wants the room.
 */
export function SkillEditorDialog({
  open,
  onOpenChange,
  skill,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The skill being rewritten, or `null` to write a new one. */
  skill: Skill | null;
  /** Resolves when the write succeeded; rejects with the server's message. */
  onSave: (draft: SkillDraft) => Promise<void>;
}) {
  const idPrefix = useId();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reopening must show the skill being edited now, not what was typed last
  // time — a stale body here would be saved over the real one.
  useEffect(() => {
    if (!open) return;
    setName(skill?.name ?? "");
    setDescription(skill?.description ?? "");
    setBody(skill?.body ?? "");
    setError(null);
    setBusy(false);
  }, [open, skill]);

  const trimmedName = name.trim();
  const complete = trimmedName.length > 0 && description.trim().length > 0 && body.trim().length > 0;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!complete || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({ name: trimmedName, description: description.trim(), body });
      onOpenChange(false);
    } catch (err) {
      // The server's own sentence — a duplicate name and an unusable one are
      // different problems and the dialog stays open for either.
      setError(err instanceof Error ? err.message : "Couldn’t save the skill.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{skill ? "Edit skill" : "New skill"}</DialogTitle>
            <DialogDescription>{editorReachLine(skill)}</DialogDescription>
          </DialogHeader>

          <Field
            label="Name"
            htmlFor={`${idPrefix}-name`}
            hint="Lowercase letters, numbers, dashes and underscores. An agent's own skill of the same name takes precedence over this one."
          >
            <Input
              id={`${idPrefix}-name`}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="release_notes"
              className="font-mono text-base sm:text-sm"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
            />
          </Field>

          <Field
            label="Description"
            htmlFor={`${idPrefix}-description`}
            hint="One line. This is what the agent reads when deciding whether to load it."
          >
            <Input
              id={`${idPrefix}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Turn a merged milestone into notes someone outside the team can read."
              className="text-base sm:text-sm"
            />
          </Field>

          <Field label="Body" htmlFor={`${idPrefix}-body`} hint="Markdown. The instructions themselves.">
            <Textarea
              id={`${idPrefix}-body`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              placeholder={"# Release notes\n\nLead with what changed for the reader."}
              className="min-h-48 font-mono text-base sm:text-sm"
              autoCapitalize="off"
              spellCheck={false}
            />
          </Field>

          {error && (
            <p className="text-destructive text-xs" role="alert">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!complete || busy}>
              {skill ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * What this write will reach, said before it happens.
 *
 * On a NEW skill the reach is the rule, not a number — a library skill is live
 * on every agent from the moment it exists, and no count is known yet. On an
 * edit it is the row's own `liveOnAgentCount`, in the same conditional mood
 * `SkillsSection`'s reach line uses: `listEffective` filters on `enabled`, so a
 * switched-off skill reaches nobody until it is switched back on. An older
 * server sends no count, and a claim we cannot support is worse than none.
 */
export function editorReachLine(skill: Skill | null): string {
  if (!skill) return "Shared with every agent in this workspace, unless one has its own skill of the same name.";
  const count = skill.liveOnAgentCount;
  if (typeof count !== "number")
    return "One shared copy — this edit reaches every agent that loads it.";
  if (!skill.enabled)
    return count === 0
      ? "Switched off, and no agent would load it."
      : count === 1
        ? "Switched off — 1 agent would load this edit once it is switched back on."
        : `Switched off — ${count} agents would load this edit once it is switched back on.`;
  if (count === 0) return "No agent loads this today, so the edit reaches nobody yet.";
  return count === 1
    ? "This edit reaches 1 agent."
    : `This edit reaches all ${count} agents that load it.`;
}
