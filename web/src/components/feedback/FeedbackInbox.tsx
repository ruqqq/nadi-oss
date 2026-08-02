import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  getFeedbackReport,
  listFeedbackReports,
  markFeedbackReportSeen,
  type FeedbackReportDetailResponse,
  type FeedbackReportSummary,
} from "@/feedback-api";
import { ArrowLeft, CaretRight, ChatCircle, WarningCircle } from "@/icons";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { MessageAttachmentView } from "@/components/chat/MessageAttachmentView";
import { ScrollArea } from "@/components/ui/scroll-area";

const PAGE_SIZE = 25;

export function FeedbackInbox({
  selectedId,
  revision,
  closeLabel,
  onClose,
  onBackToList,
  onSelect,
}: {
  selectedId: string | null;
  revision: number;
  closeLabel: string;
  onClose: () => void;
  onBackToList: () => void;
  onSelect: (id: string | null, mode: "push" | "replace") => void;
}) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [reports, setReports] = useState<FeedbackReportSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [detail, setDetail] = useState<FeedbackReportDetailResponse | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  const inDetail = selectedId !== null;
  const showList = isDesktop || !inDetail;
  const showDetail = isDesktop || inDetail;

  const mergeReports = useCallback((incoming: FeedbackReportSummary[]) => {
    setReports((current) => {
      const seen = new Set<string>();
      const merged: FeedbackReportSummary[] = [];
      for (const report of [...current, ...incoming]) {
        if (seen.has(report.id)) continue;
        seen.add(report.id);
        merged.push(report);
      }
      return merged;
    });
  }, []);

  useEffect(() => {
    let active = true;
    setLoadingList(true);
    setListError(null);
    void listFeedbackReports({ limit: PAGE_SIZE })
      .then((page) => {
        if (!active) return;
        setReports(page.reports);
        setNextCursor(page.nextCursor);
      })
      .catch((error: unknown) => {
        if (active) setListError(error instanceof Error ? error.message : "Could not load feedback reports.");
      })
      .finally(() => {
        if (active) setLoadingList(false);
      });
    return () => {
      active = false;
    };
  }, [revision]);

  useEffect(() => {
    function onResume() {
      void listFeedbackReports({ limit: PAGE_SIZE })
        .then((page) => {
          setReports(page.reports);
          setNextCursor(page.nextCursor);
          setListError(null);
        })
        .catch((error: unknown) => {
          setListError(error instanceof Error ? error.message : "Could not refresh feedback reports.");
        });
    }

    window.addEventListener("pageshow", onResume);
    document.addEventListener("visibilitychange", onResume);
    window.addEventListener("online", onResume);
    return () => {
      window.removeEventListener("pageshow", onResume);
      document.removeEventListener("visibilitychange", onResume);
      window.removeEventListener("online", onResume);
    };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      return;
    }
    let active = true;
    setLoadingDetail(true);
    setDetailError(null);
    void getFeedbackReport(selectedId)
      .then((response) => {
        if (!active) return;
        setDetail(response);
        void markFeedbackReportSeen(selectedId);
        setReports((current) =>
          current.map((report) => (report.id === selectedId ? { ...report, seen: true } : report)),
        );
      })
      .catch((error: unknown) => {
        if (active) setDetailError(error instanceof Error ? error.message : "Could not load this feedback report.");
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [revision, selectedId]);

  const selectedReport = useMemo(
    () => reports.find((report) => report.id === selectedId) ?? detail?.report ?? null,
    [detail?.report, reports, selectedId],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    setListError(null);
    try {
      const page = await listFeedbackReports({ limit: PAGE_SIZE, cursor: nextCursor });
      mergeReports(page.reports);
      setNextCursor(page.nextCursor);
    } catch (error) {
      setListError(error instanceof Error ? error.message : "Could not load more feedback reports.");
    } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, mergeReports, nextCursor]);

  const backLabel = !isDesktop && inDetail ? "Back" : closeLabel;
  const back = !isDesktop && inDetail ? onBackToList : onClose;
  const openReport = (id: string) => onSelect(id, isDesktop ? "replace" : "push");

  return (
    <section className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        <Button type="button" variant="ghost" size="icon" onClick={back} aria-label={backLabel}>
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm">Feedback inbox</div>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)]">
        {showList && (
          <ScrollArea className="min-h-0 lg:border-border lg:border-r">
            <div className="flex flex-col gap-1 px-2 py-3">
              <div className="px-2 pb-2">
                <h1 className="font-display text-2xl text-foreground">Feedback inbox</h1>
                <p className="text-muted-foreground text-xs">Newest first from the admin API.</p>
              </div>
              {listError ? (
                <Alert variant="destructive" className="mx-2">
                  <WarningCircle aria-hidden />
                  <AlertDescription>{listError}</AlertDescription>
                </Alert>
              ) : null}
              {!listError && loadingList ? (
                <p className="px-2 py-6 text-center text-muted-foreground text-sm">Loading reports…</p>
              ) : null}
              {!listError && !loadingList && reports.length === 0 ? (
                <EmptyState>No feedback reports yet.</EmptyState>
              ) : null}
              {reports.map((report) => (
                <button
                  key={report.id}
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-3 rounded-md px-3 py-2.5 text-left text-sm transition-colors",
                    isDesktop && report.id === selectedId ? "bg-accent" : "hover:bg-accent/60",
                  )}
                  onClick={() => openReport(report.id)}
                >
                  <span
                    aria-label={report.seen === false ? "Unseen report" : "Seen report"}
                    className={cn(
                      "size-2 rounded-full",
                      report.seen === false ? "bg-primary" : "bg-muted-foreground/30",
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="truncate font-display font-medium text-foreground">
                      {report.title}
                    </span>
                    <span className="flex items-center gap-2 text-muted-foreground text-xs">
                      <span className="font-mono">{formatDate(report.submittedAt)}</span>
                      <Badge variant="outline" className="capitalize">
                        {report.category}
                      </Badge>
                      {report.attachmentCount > 0 ? <span>{report.attachmentCount} screenshot</span> : null}
                    </span>
                  </span>
                  <CaretRight aria-hidden className="size-4 shrink-0 text-muted-foreground lg:hidden" />
                </button>
              ))}
              {nextCursor ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mx-2 mt-2"
                  onClick={loadMore}
                  disabled={loadingMore}
                >
                  {loadingMore ? "Loading…" : "Load more reports"}
                </Button>
              ) : null}
            </div>
          </ScrollArea>
        )}

        {showDetail && (
          <ScrollArea className="min-h-0 flex-1">
            <div className="mx-auto flex w-full max-w-content flex-col gap-4 px-4 py-4 sm:px-6">
              {selectedId === null ? (
                <EmptyState>Select a feedback report to review it.</EmptyState>
              ) : detailError ? (
                <Alert variant="destructive">
                  <WarningCircle aria-hidden />
                  <AlertDescription>{detailError}</AlertDescription>
                </Alert>
              ) : loadingDetail || detail === null ? (
                <p className="py-8 text-center text-muted-foreground text-sm">Loading report…</p>
              ) : (
                <ReportDetail detail={detail} summary={selectedReport} />
              )}
            </div>
          </ScrollArea>
        )}
      </div>
    </section>
  );
}

function ReportDetail({
  detail,
  summary,
}: {
  detail: FeedbackReportDetailResponse;
  summary: FeedbackReportSummary | null;
}) {
  const report = detail.report;
  return (
    <>
      <div>
        <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.18em]">
          Feedback report
        </p>
        <h1 className="font-display text-2xl text-foreground">{report.title}</h1>
        <p className="mt-1 font-mono text-muted-foreground text-xs">
          {formatDate(report.submittedAt)} · {report.id}
        </p>
      </div>

      <DetailCard title="Report">
        <p>{report.fields.narrative}</p>
        {report.fields.reproductionSteps.length > 0 ? (
          <ol className="list-decimal space-y-1 pl-5">
            {report.fields.reproductionSteps.map((step, index) => (
              <li key={`${step}:${index}`}>{step}</li>
            ))}
          </ol>
        ) : null}
        <Field label="Expected behavior" value={report.fields.expectedBehavior} />
        <Field label="Actual behavior" value={report.fields.actualBehavior} />
        <Field label="Frequency" value={report.fields.frequency} />
        <Field label="Impact" value={report.fields.impact} />
      </DetailCard>

      <DetailCard title="Transcript">
        {detail.transcript.length > 0 ? (
          detail.transcript.map((message, index) => (
            <div key={messageKey(message, index)} className="rounded-md border border-border bg-background p-3">
              <p className="font-mono text-muted-foreground text-xs">{messageRole(message)}</p>
              <p className="mt-1 text-sm">{messageText(message)}</p>
            </div>
          ))
        ) : (
          <p className="text-muted-foreground">No transcript was included.</p>
        )}
      </DetailCard>

      <DetailCard title="Screenshots">
        {detail.attachments.length > 0 ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {detail.attachments.map((attachment) => (
              <MessageAttachmentView
                key={attachment.id}
                data={{
                  type: "file",
                  mediaType: "image/png",
                  filename: attachment.id,
                  url: attachment.url,
                }}
              />
            ))}
          </div>
        ) : (
          <p className="text-muted-foreground">No screenshots attached.</p>
        )}
      </DetailCard>

      <DetailCard title="Diagnostics">
        <dl className="grid gap-2 text-sm sm:grid-cols-2">
          <Diagnostic label="Browser" value={`${report.diagnostics.browser} · ${report.diagnostics.os}`} />
          <Diagnostic
            label="Viewport"
            value={`${report.diagnostics.viewport.width}×${report.diagnostics.viewport.height}`}
          />
          <Diagnostic label="Route" value={report.diagnostics.route} />
          <Diagnostic label="Build" value={report.diagnostics.build} />
          <Diagnostic label="Theme" value={report.diagnostics.theme} />
          <Diagnostic label="Online" value={report.diagnostics.online ? "yes" : "no"} />
        </dl>
      </DetailCard>

      {summary ? (
        <p className="font-mono text-muted-foreground text-xs">Thread {summary.threadId}</p>
      ) : null}
    </>
  );
}

function DetailCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4 text-card-foreground">
      <h2 className="mb-3 font-medium text-foreground text-sm">{title}</h2>
      <div className="space-y-3 text-sm">{children}</div>
    </section>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center text-muted-foreground text-sm">
      <ChatCircle aria-hidden className="size-6" />
      <p>{children}</p>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div>
      <p className="font-medium text-muted-foreground text-xs uppercase tracking-[0.12em]">{label}</p>
      <p>{value}</p>
    </div>
  );
}

function Diagnostic({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

function formatDate(value: number): string {
  return new Date(value).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function messageKey(message: unknown, index: number): string {
  if (message && typeof message === "object" && "id" in message && typeof message.id === "string") {
    return message.id;
  }
  return `message-${index}`;
}

function messageRole(message: unknown): string {
  if (message && typeof message === "object" && "role" in message && typeof message.role === "string") {
    return message.role;
  }
  return "message";
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object" || !("parts" in message) || !Array.isArray(message.parts)) {
    return JSON.stringify(message);
  }
  return message.parts
    .map((part) => {
      if (part && typeof part === "object" && "text" in part && typeof part.text === "string") {
        return part.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
