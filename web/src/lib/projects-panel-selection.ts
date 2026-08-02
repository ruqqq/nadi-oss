export function nextPanelSelection(
  selectedId: string | null,
  availableIds: string[],
  preserveEmptySelection = false,
): string | null {
  if (availableIds.length === 0) return null;
  if (selectedId === null) return preserveEmptySelection ? null : (availableIds[0] ?? null);
  return availableIds.includes(selectedId) ? selectedId : (availableIds[0] ?? null);
}
