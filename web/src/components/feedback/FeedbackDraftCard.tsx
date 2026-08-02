import type { FileUIPart } from "ai";
import type { FeedbackDiagnostics, FeedbackDraftView } from "@/feedback-api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MessageAttachmentView } from "@/components/chat/MessageAttachmentView";
import { cn } from "@/lib/utils";

export function FeedbackDraftCard({
  draft,
  diagnostics,
  screenshots,
  submitting,
  submitted,
  onKeepEditing,
  onSubmit,
}: {
  draft: FeedbackDraftView;
  diagnostics: FeedbackDiagnostics;
  screenshots: FileUIPart[];
  submitting: boolean;
  submitted: boolean;
  onKeepEditing: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const fields = draft.fields;
  const visibleScreenshots = screenshots.filter((shot) => {
    const attachmentId = (shot as { attachmentId?: unknown }).attachmentId;
    return typeof attachmentId !== "string" || draft.attachmentIds.includes(attachmentId);
  });
  const hasDetails =
    fields.reproductionSteps.length > 0 ||
    fields.expectedBehavior ||
    fields.actualBehavior ||
    fields.frequency ||
    fields.impact;

  return (
    <Card className="my-3 max-w-2xl border-gate/30 bg-card">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="font-mono uppercase">
            {fields.category}
          </Badge>
          {submitted ? (
            <Badge className="bg-approve text-approve-foreground">Sent</Badge>
          ) : null}
        </div>
        <CardTitle className="font-display text-2xl">{fields.title}</CardTitle>
        <p className="text-muted-foreground text-sm">{fields.narrative}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {hasDetails ? (
          <div className="grid gap-3 text-sm">
            {fields.reproductionSteps.length > 0 ? (
              <section>
                <h3 className="mb-1 font-medium text-foreground">Steps to reproduce</h3>
                <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
                  {fields.reproductionSteps.map((step, index) => (
                    <li key={`${index}:${step}`}>{step}</li>
                  ))}
                </ol>
              </section>
            ) : null}
            <Detail label="Expected" value={fields.expectedBehavior} />
            <Detail label="Actual" value={fields.actualBehavior} />
            <Detail label="Frequency" value={fields.frequency} />
            <Detail label="Impact" value={fields.impact} />
          </div>
        ) : null}

        <section>
          <h3 className="mb-2 font-medium text-foreground text-sm">Diagnostic snapshot</h3>
          <div className="grid gap-1 rounded-md border bg-muted/30 p-3 font-mono text-muted-foreground text-xs">
            <span>{diagnostics.browser} · {diagnostics.os}</span>
            <span>{diagnostics.route}</span>
            <span>
              {diagnostics.viewport.width}×{diagnostics.viewport.height} · {diagnostics.theme} ·{" "}
              {diagnostics.online ? "online" : "offline"}
            </span>
            <span>build {diagnostics.build}</span>
          </div>
        </section>

        {visibleScreenshots.length > 0 ? (
          <section>
            <h3 className="mb-2 font-medium text-foreground text-sm">Screenshots</h3>
            <div className="flex flex-wrap gap-2">
              {visibleScreenshots.map((shot, index) => (
                <MessageAttachmentView key={`${shot.url}:${index}`} data={shot} />
              ))}
            </div>
          </section>
        ) : null}
      </CardContent>
      <CardFooter className={cn("flex flex-wrap gap-2", submitted && "text-approve")}>
        {submitted ? (
          <span className="font-medium text-sm">Sent to the Nadi team</span>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onKeepEditing} disabled={submitting}>
              Keep editing
            </Button>
            <Button type="button" onClick={() => void onSubmit()} disabled={submitting}>
              {submitting ? "Submitting…" : "Submit feedback"}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <section>
      <h3 className="mb-1 font-medium text-foreground">{label}</h3>
      <p className="text-muted-foreground">{value}</p>
    </section>
  );
}
