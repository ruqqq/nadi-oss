import { CircleNotch } from "@/icons";
import { cn } from "@/lib/utils";

/** Inline loading indicator. Use in buttons and small states instead of "Loading" text. */
export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <CircleNotch
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "status" : undefined}
      className={cn("size-4 shrink-0 animate-spin", className)}
    />
  );
}
