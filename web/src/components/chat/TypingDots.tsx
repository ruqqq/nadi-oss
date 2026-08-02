/** Three dots that bounce in sequence while we wait for the first token. */
export function TypingDots() {
  return (
    <div
      className="flex items-center gap-1.5 px-1 py-1"
      role="status"
      aria-live="polite"
      aria-label="Nadi is responding"
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60"
          style={{ animationDelay: `${i * 150}ms`, animationDuration: "1s" }}
        />
      ))}
    </div>
  );
}
