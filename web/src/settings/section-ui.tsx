import type { ReactNode } from "react";
import { Label } from "../components/ui/label";
import { cn } from "../lib/utils";

/**
 * Shared building blocks for the Settings tabs, so every tab reads as one
 * system: an editorial section heading, titled field-group cards, labelled
 * fields, and a consistently-placed action row. Prefer these over hand-rolling
 * the same markup per section.
 */

/** Top-of-tab heading: an editorial `font-display` title with an optional
 *  one-line purpose hint, optional uppercase eyebrow, optional leading icon,
 *  and an optional trailing action (e.g. a "New" / "Connect" button). */
export function SectionHeading({
  title,
  description,
  icon,
  eyebrow,
  action,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        {eyebrow && (
          <div className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
            {eyebrow}
          </div>
        )}
        <h2 className="flex items-center gap-1.5 font-display font-semibold text-foreground text-lg">
          {icon}
          {title}
        </h2>
        {description && <p className="text-muted-foreground text-sm">{description}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/** Heading for a detail pane: an entity name (font-display, truncated to one
 *  line) with an optional uppercase type/status eyebrow. Distinct from
 *  SectionHeading — which titles a whole tab — by its larger, truncating title. */
export function DetailHeading({ eyebrow, title }: { eyebrow?: string; title: string }) {
  return (
    <div className="min-w-0">
      {eyebrow && (
        <div className="font-medium text-[0.7rem] text-muted-foreground uppercase tracking-wide">
          {eyebrow}
        </div>
      )}
      <h2 className="mt-0.5 truncate font-display font-semibold text-foreground text-xl">{title}</h2>
    </div>
  );
}

/** A titled group of related fields, so each concern reads as its own card. An
 *  optional `action` sits on the title row (e.g. a link to where the data is
 *  managed). */
export function FormCard({
  title,
  description,
  action,
  children,
  className,
}: {
  title: string;
  description?: string;
  /** Optional control on the title row, e.g. a link to where the data is managed. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("overflow-hidden rounded-lg border border-border bg-card", className)}>
      <div className="flex items-start justify-between gap-2 border-border border-b px-4 py-3">
        <div className="min-w-0">
          <h3 className="font-medium text-foreground text-sm">{title}</h3>
          {description && <p className="mt-0.5 text-muted-foreground text-xs">{description}</p>}
        </div>
        {action}
      </div>
      <div className="space-y-4 p-4">{children}</div>
    </section>
  );
}

/** A labelled field with optional one-line helper text. An optional `action`
 *  sits on the label row (e.g. a reset-to-default link). */
export function Field({
  label,
  htmlFor,
  hint,
  action,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  /** Optional control on the label row, e.g. a reset-to-default link. */
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      {action ? (
        <div className="flex min-h-5 items-center justify-between gap-2">
          <Label htmlFor={htmlFor}>{label}</Label>
          {action}
        </div>
      ) : (
        <Label htmlFor={htmlFor}>{label}</Label>
      )}
      {children}
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </div>
  );
}

/** The standard action row for a form: primary action(s) at the bottom,
 *  right-aligned and auto-width on desktop, full-width and stacked on mobile so
 *  they stay thumb-friendly. Put the primary (right-most) button last. */
export function FormActions({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Button sizing for use inside FormActions: full-width on mobile, natural
 *  width on desktop. The 44px mobile height clears the touch-target floor (the
 *  Button base 36px is fine for a pointer, tight for a thumb); desktop keeps the
 *  denser height. */
export const FORM_ACTION_BUTTON = "h-11 w-full sm:h-9 sm:w-auto";

/**
 * The bar a detail form's actions sit on, pinned below the scrolling body so a
 * long form never scrolls past its own Save. As a `shrink-0` sibling of the
 * scroll area (or the shell's footer slot), it owns the safe-area inset once —
 * a `sticky` bar inside the scroller would instead float above an installed
 * PWA's home indicator. Put a `<FormActions>` inside; `contentClassName` caps
 * the row to the form's own width so the primary button lines up with the
 * fields above it.
 */
export function PaneFooter({
  children,
  className,
  contentClassName,
}: {
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}) {
  return (
    <div
      className={cn(
        "border-border border-t bg-card px-4 py-3 standalone:pb-[calc(0.75rem_+_env(safe-area-inset-bottom))] sm:px-6",
        className,
      )}
    >
      <div className={cn("mx-auto w-full max-w-content", contentClassName)}>{children}</div>
    </div>
  );
}
