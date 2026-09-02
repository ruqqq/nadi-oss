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
import { Button } from "@/components/ui/button";
import { Archive } from "../icons";

export function ArchiveButton({
  itemName,
  kind,
  onConfirm,
}: {
  itemName: string;
  kind: "skill" | "memory";
  onConfirm: () => void;
}) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          // Names the item, not just the kind: a page can list a dozen of these
          // (an agent's own skills and the library it inherits), and "Archive
          // skill" a dozen times tells a screen reader nothing about which.
          aria-label={`Archive ${kind} ${itemName}`}
          title={`Archive ${kind}`}
        >
          <Archive aria-hidden />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive this {kind}?</AlertDialogTitle>
          <AlertDialogDescription>
            "{itemName}" will be hidden from the agent. You can restore it from the Archived list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
