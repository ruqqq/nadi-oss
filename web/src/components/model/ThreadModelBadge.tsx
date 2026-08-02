/**
 * Read-only chip showing the model a thread is running. Mirrors the
 * composer-variant {@link ModelPicker} trigger's container so it can later be
 * swapped for the interactive picker in the same footer slot with no relayout.
 * The model id is shown raw (the picker shows the same string); it truncates
 * under tight width, with the full value in the title/aria-label.
 */
export function ThreadModelBadge({ model }: { model: string }) {
  return (
    <div
      className="flex h-8 min-w-0 max-w-[min(60vw,16rem)] items-center gap-1.5 rounded-md px-2 font-medium text-muted-foreground text-sm"
      title={model}
      aria-label={`Model: ${model}`}
    >
      <span className="truncate">{model}</span>
    </div>
  );
}
