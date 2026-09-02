/**
 * Joins truthy class names.
 *
 * The same three lines `@rag/ui` uses internally, restated here because the
 * package does not export it — and a consumer reaching into `@rag/ui/src/util`
 * would be depending on that package's file layout rather than on its API.
 */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

/**
 * A single-line preview of a block of prose.
 *
 * Collapses every run of whitespace — a Markdown body is mostly newlines, and a
 * table cell that keeps them renders as one word followed by a lot of nothing.
 * Truncation is on a word boundary where one is close enough to the limit,
 * because a cut mid-word reads as a rendering fault rather than as an ellipsis.
 */
export function snippet(text: string, limit = 180): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) {
    return flat;
  }
  const cut = flat.slice(0, limit);
  const space = cut.lastIndexOf(' ');
  return `${space > limit * 0.6 ? cut.slice(0, space) : cut}…`;
}
