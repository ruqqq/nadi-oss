import { ArrowLeft } from "../../icons";
import type { InviteQuota } from "../../invites-api";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { InvitesSection } from "./InvitesSection";

export function InvitesPanel({
  onQuotaChange,
  closeLabel = "Back to chats",
  onClose,
}: {
  onQuotaChange?: (quota: InviteQuota) => void;
  closeLabel?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-border border-b bg-card px-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label={closeLabel}
          title={closeLabel}
        >
          <ArrowLeft aria-hidden />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium text-foreground text-sm">Invites</div>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-content p-4 md:p-6">
          <InvitesSection onQuotaChange={onQuotaChange} />
        </div>
      </ScrollArea>
    </div>
  );
}
