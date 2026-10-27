/**
 * Item labels (rag-t0027): free-text subject tags such as `Physics`, `Biomes`
 * or `Creatures`.
 *
 * The server is the authority (api.md § Labels): it trims, merges duplicates
 * case-insensitively, puts each label in the project's existing casing and
 * refuses a blank label, one over {@link LABEL_MAX_CHARS} characters, one with
 * a comma or a control character, and more than {@link LABEL_MAX} on an item.
 * This module applies the same rules before a write, so the editor can say
 * what is wrong at the keyboard. Pure: the vocabulary is read by
 * `LabelEditor`'s `useProjectLabels`.
 */

import type { Item, LabelCount } from './types';

/** The longest label, in characters (the server's `MAX_LABEL_CHARS`). */
export const LABEL_MAX_CHARS = 32;

/** The most labels one item carries (the server's `MAX_LABELS`). */
export const LABEL_MAX = 10;

/** The key labels are matched by: case-insensitive. */
export function labelKey(label: string): string {
  return label.toLowerCase();
}

/** A label as the server stores it: trimmed, inner runs of whitespace one space. */
export function normaliseLabel(raw: string): string {
  return raw.trim().split(/\s+/).filter(Boolean).join(' ');
}

/** A control character, as Rust's `char::is_control` (Unicode Cc) has it. */
function isControl(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

/** What is wrong with a label, in the editor's words; `null` when nothing is. */
export function labelProblem(raw: string): string | null {
  const label = normaliseLabel(raw);
  if (label === '') {
    return 'A label needs some text.';
  }
  if ([...label].length > LABEL_MAX_CHARS) {
    return `A label is at most ${LABEL_MAX_CHARS} characters.`;
  }
  if (label.includes(',')) {
    return 'A label cannot hold a comma: add each label on its own.';
  }
  if ([...label].some(isControl)) {
    return 'A label cannot hold a control character.';
  }
  return null;
}

/** Sorted as the server sorts them: by key, then by the label itself. */
export function sortLabels(labels: readonly string[]): string[] {
  return [...labels].sort((a, b) => {
    const ka = labelKey(a);
    const kb = labelKey(b);
    if (ka !== kb) {
      return ka < kb ? -1 : 1;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/**
 * `labels` as they would be written: each normalised and in the vocabulary's
 * casing when the project has it, case-insensitive duplicates merged (the
 * first kept), invalid ones dropped, sorted. `vocabulary` is the project's
 * labels (`useProjectLabels` in `LabelEditor`).
 */
export function cleanLabels(
  labels: readonly string[],
  vocabulary: readonly LabelCount[] = [],
): string[] {
  const known = new Map(vocabulary.map((entry) => [labelKey(entry.label), entry.label]));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of labels) {
    if (labelProblem(raw) !== null) {
      continue;
    }
    const label = normaliseLabel(raw);
    const key = labelKey(label);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(known.get(key) ?? label);
    }
  }
  return sortLabels(out);
}

/** Whether two label sets are the same, order aside. */
export function sameLabels(a: readonly string[], b: readonly string[]): boolean {
  const sa = sortLabels(a);
  const sb = sortLabels(b);
  return sa.length === sb.length && sa.every((label, at) => label === sb[at]);
}

/** Whether `item` carries `label`, ignoring case. An empty label matches every item. */
export function hasLabel(item: Item, label: string): boolean {
  const key = labelKey(normaliseLabel(label));
  return key === '' || (item.labels ?? []).some((own) => labelKey(own) === key);
}

/**
 * The labels `items` carry, once each (the first casing met), sorted, with
 * `keep` added when no item carries it: a filter's options, so a label in the
 * URL is still offered (and can be cleared) when nothing in view has it.
 */
export function labelsIn(items: readonly Item[], keep = ''): string[] {
  const byKey = new Map<string, string>();
  for (const item of items) {
    for (const label of item.labels ?? []) {
      if (!byKey.has(labelKey(label))) {
        byKey.set(labelKey(label), label);
      }
    }
  }
  const kept = normaliseLabel(keep);
  if (kept !== '' && !byKey.has(labelKey(kept))) {
    byKey.set(labelKey(kept), kept);
  }
  return sortLabels([...byKey.values()]);
}
