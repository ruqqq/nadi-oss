/**
 * Tracks the span of composer text that dictation owns, so Stop keeps it and
 * Cancel removes exactly it — leaving anything the user typed untouched.
 *
 * Voice APPENDS at the end of the existing text rather than inserting at the
 * caret: the textarea is read-only while recording, so an end-anchored `start`
 * never moves, which is what lets each new final rewrite the span in place.
 */
export type VoiceRange = { start: number; length: number };

export function beginVoiceRange(text: string): VoiceRange {
  return { start: text.length, length: 0 };
}

/**
 * Prefixes a single space when the text the range abuts doesn't already end in
 * whitespace, so typing `note:` then dictating gives `note: add a retry`. The
 * space belongs to the range, so Cancel removes it along with the voice text.
 */
export function separateVoiceText(text: string, range: VoiceRange, voiceText: string): string {
  if (voiceText.length === 0 || range.start === 0) return voiceText;
  const preceding = text.charAt(range.start - 1);
  return preceding === "" || /\s/.test(preceding) ? voiceText : ` ${voiceText}`;
}

/** Replaces the current voice span with `voiceText` (the hook's accumulated finals). */
export function applyVoiceText(
  text: string,
  range: VoiceRange,
  voiceText: string,
): { text: string; range: VoiceRange } {
  const separated = separateVoiceText(text, range, voiceText);
  const before = text.slice(0, range.start);
  const after = text.slice(range.start + range.length);
  return {
    text: `${before}${separated}${after}`,
    range: { start: range.start, length: separated.length },
  };
}

export function cancelVoiceRange(text: string, range: VoiceRange): string {
  return text.slice(0, range.start) + text.slice(range.start + range.length);
}
