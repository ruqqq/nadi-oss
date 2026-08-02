import { useState } from "react";
import type { FileUIPart } from "ai";
import type { FeedbackDraftView, FeedbackReportFields } from "@/feedback-api";
import { createManualFeedbackDraft } from "@/feedback-api";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";

export function FeedbackFallbackForm({
  threadId,
  screenshots,
  initialNarrative = "",
  onDraft,
}: {
  threadId: string;
  screenshots: FileUIPart[];
  initialNarrative?: string;
  onDraft: (draft: FeedbackDraftView) => void;
}) {
  const [category, setCategory] = useState<FeedbackReportFields["category"]>("bug");
  const [title, setTitle] = useState("");
  const [narrative, setNarrative] = useState(initialNarrative);
  const [reproductionSteps, setReproductionSteps] = useState("");
  const [expectedBehavior, setExpectedBehavior] = useState("");
  const [actualBehavior, setActualBehavior] = useState("");
  const [frequency, setFrequency] = useState("");
  const [impact, setImpact] = useState("");
  const [selectedAttachmentIds, setSelectedAttachmentIds] = useState(() =>
    screenshots.flatMap(attachmentIdFromScreenshot),
  );
  const [submitting, setSubmitting] = useState(false);
  const valid = title.trim().length > 0 && narrative.trim().length > 0;

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const draft = await createManualFeedbackDraft({
        threadId,
        fields: {
          category,
          title: title.trim(),
          narrative: narrative.trim(),
          reproductionSteps:
            category === "bug"
              ? reproductionSteps
                  .split(/\r?\n/)
                  .map((step) => step.trim())
                  .filter(Boolean)
              : [],
          expectedBehavior:
            category === "bug" || category === "feature" ? optionalField(expectedBehavior) : null,
          actualBehavior: category === "bug" ? optionalField(actualBehavior) : null,
          frequency: category === "bug" ? optionalField(frequency) : null,
          impact: optionalField(impact),
        },
        attachmentIds: selectedAttachmentIds,
      });
      onDraft(draft);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="m-3 space-y-3 rounded-lg border bg-card p-4">
      <div>
        <h2 className="font-display text-xl">Submit without interview</h2>
        <p className="text-muted-foreground text-sm">
          If the feedback agent is unavailable, draft the report manually. You will still confirm
          before sending.
        </p>
      </div>
      <div className="grid gap-3">
        <div className="grid gap-1.5">
          <Label>Category</Label>
          <Select
            value={category}
            onValueChange={(value) => setCategory(value as FeedbackReportFields["category"])}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="bug">Bug</SelectItem>
              <SelectItem value="feature">Feature</SelectItem>
              <SelectItem value="general">General</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="feedback-fallback-title">Title</Label>
          <Input
            id="feedback-fallback-title"
            value={title}
            onChange={(e) => setTitle(e.currentTarget.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="feedback-fallback-narrative">What happened?</Label>
          <Textarea
            id="feedback-fallback-narrative"
            value={narrative}
            onChange={(e) => setNarrative(e.currentTarget.value)}
          />
        </div>
        {category === "bug" ? (
          <>
            <div className="grid gap-1.5">
              <Label htmlFor="feedback-fallback-steps">Reproduction steps</Label>
              <Textarea
                id="feedback-fallback-steps"
                placeholder="One step per line"
                value={reproductionSteps}
                onChange={(e) => setReproductionSteps(e.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="feedback-fallback-expected">Expected behavior</Label>
              <Textarea
                id="feedback-fallback-expected"
                value={expectedBehavior}
                onChange={(e) => setExpectedBehavior(e.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="feedback-fallback-actual">Actual behavior</Label>
              <Textarea
                id="feedback-fallback-actual"
                value={actualBehavior}
                onChange={(e) => setActualBehavior(e.currentTarget.value)}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="feedback-fallback-frequency">Frequency</Label>
              <Input
                id="feedback-fallback-frequency"
                value={frequency}
                onChange={(e) => setFrequency(e.currentTarget.value)}
              />
            </div>
          </>
        ) : category === "feature" ? (
          <div className="grid gap-1.5">
            <Label htmlFor="feedback-fallback-expected">Desired behavior</Label>
            <Textarea
              id="feedback-fallback-expected"
              value={expectedBehavior}
              onChange={(e) => setExpectedBehavior(e.currentTarget.value)}
            />
          </div>
        ) : null}
        <div className="grid gap-1.5">
          <Label htmlFor="feedback-fallback-impact">Impact</Label>
          <Textarea
            id="feedback-fallback-impact"
            value={impact}
            onChange={(e) => setImpact(e.currentTarget.value)}
          />
        </div>
        {screenshots.length > 0 ? (
          <fieldset className="space-y-2 rounded-md border border-border p-3">
            <legend className="px-1 font-medium text-sm">Screenshots</legend>
            <div className="space-y-2">
              {screenshots.map((shot, index) => {
                const attachmentId = attachmentIdFromScreenshot(shot)[0];
                const filename = shot.filename ?? `Screenshot ${index + 1}`;
                if (!attachmentId) {
                  return (
                    <p key={`${filename}-${index}`} className="text-muted-foreground text-sm">
                      {filename} will be shown for review but is missing an uploaded attachment ID.
                    </p>
                  );
                }
                const inputId = `feedback-fallback-shot-${index}`;
                return (
                  <label key={attachmentId} htmlFor={inputId} className="flex items-center gap-2 text-sm">
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={selectedAttachmentIds.includes(attachmentId)}
                      onChange={(event) => {
                        setSelectedAttachmentIds((current) =>
                          event.currentTarget.checked
                            ? [...new Set([...current, attachmentId])]
                            : current.filter((id) => id !== attachmentId),
                        );
                      }}
                    />
                    Include {filename}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ) : null}
      </div>
      <Button type="button" onClick={() => void submit()} disabled={!valid || submitting}>
        {submitting ? "Creating draft…" : "Create draft"}
      </Button>
    </div>
  );
}

function attachmentIdFromScreenshot(shot: FileUIPart): string[] {
  const id = (shot as { attachmentId?: unknown }).attachmentId;
  return typeof id === "string" ? [id] : [];
}

function optionalField(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
