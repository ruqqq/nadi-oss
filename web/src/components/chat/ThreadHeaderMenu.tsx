import { Browser, DotsThreeVertical, Info } from "../../icons";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

export function ThreadHeaderMenu({
  onOpenArtifacts,
  onOpenDetails,
}: {
  onOpenArtifacts: () => void;
  onOpenDetails: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Thread actions"
          title="Thread actions"
        >
          <DotsThreeVertical aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onSelect={onOpenArtifacts}>
          <Browser aria-hidden />
          Artifacts & downloads
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={onOpenDetails}>
          <Info aria-hidden />
          Thread details
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
