import { Skeleton } from "../ui/skeleton";

/**
 * Placeholder shown while a conversation's history is loading (e.g. right after
 * switching threads). Keeping this render cheap lets the surrounding UI — the
 * mobile thread drawer's close animation in particular — stay responsive while
 * the real, potentially large, message list loads and renders behind it.
 */
export function ConversationSkeleton() {
  return (
    <div className="flex-1 overflow-hidden" role="status" aria-label="Loading conversation">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-4">
        <MessageBlock lines={["w-1/2"]} align="end" />
        <MessageBlock lines={["w-3/4", "w-full", "w-5/6"]} align="start" />
        <MessageBlock lines={["w-2/5"]} align="end" />
        <MessageBlock lines={["w-full", "w-11/12", "w-2/3"]} align="start" />
      </div>
    </div>
  );
}

function MessageBlock({ lines, align }: { lines: string[]; align: "start" | "end" }) {
  return (
    <div className={align === "end" ? "flex flex-col items-end gap-2" : "flex flex-col gap-2"}>
      {lines.map((width, i) => (
        <Skeleton key={i} className={`h-4 ${width}`} />
      ))}
    </div>
  );
}
