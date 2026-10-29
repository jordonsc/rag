/**
 * The label editor (rag-t0027) on Add item and the item page's Edit: the item's labels as removable chips, an entry box that suggests the
 * project's labels as you type, and the project's most used labels as one-click
 * additions.
 */

import { useEffect, useState, type RefObject } from 'react';
import { ChipList, Icon, type ChipListHandle } from '@rag/ui';

import { isAbort } from '../api';
import { listLabels } from './api';
import {
  cleanLabels,
  LABEL_MAX,
  LABEL_MAX_CHARS,
  labelKey,
  labelProblem,
  normaliseLabel,
} from './labels';
import styles from './tracker.module.css';
import type { LabelCount } from './types';

/**
 * A project's label vocabulary, for an editor's suggestions: read each time
 * `enabled` turns on (a dialog opening), so labels added since are offered.
 * Empty while it loads and when it cannot be read: the suggestions are a
 * help, and a failed read must not stop a write.
 */
export function useProjectLabels(project: string, enabled = true): LabelCount[] {
  const [labels, setLabels] = useState<LabelCount[]>([]);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    const controller = new AbortController();
    listLabels(project, controller.signal)
      .then((response) => setLabels(response.labels))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLabels([]);
        }
      });
    return () => controller.abort();
  }, [project, enabled]);
  return labels;
}

/** How many of the project's labels are offered as one-click additions. */
export const QUICK_LABELS = 8;

/** The project's labels by use, most used first (ties by name), none already chosen. */
export function offeredLabels(
  vocabulary: readonly LabelCount[],
  chosen: readonly string[],
): string[] {
  const have = new Set(chosen.map(labelKey));
  return [...vocabulary]
    .filter((entry) => !have.has(labelKey(entry.label)))
    .sort((a, b) => b.count - a.count || labelKey(a.label).localeCompare(labelKey(b.label)))
    .map((entry) => entry.label);
}

/**
 * Apply what the reader typed to `values`: each comma-separated part is a
 * label (so `Physics, Biomes` adds two), put in the project's casing, merged
 * with what is there case-insensitively. Answers the new set, or the first
 * problem with what was typed.
 */
export function addTyped(
  values: readonly string[],
  typed: readonly string[],
  vocabulary: readonly LabelCount[],
): { labels: string[] } | { problem: string } {
  const parts = typed.flatMap((entry) => entry.split(',')).map(normaliseLabel);
  for (const part of parts.filter((p) => p !== '')) {
    const problem = labelProblem(part);
    if (problem !== null) {
      return { problem: `“${part}”: ${problem}` };
    }
  }
  const labels = cleanLabels([...values, ...parts.filter((p) => p !== '')], vocabulary);
  if (labels.length > LABEL_MAX) {
    return { problem: `A ticket carries at most ${LABEL_MAX} labels.` };
  }
  return { labels };
}

export interface LabelEditorProps {
  values: readonly string[];
  onChange: (values: string[]) => void;
  /** The project's labels ({@link useProjectLabels}). */
  vocabulary: readonly LabelCount[];
  /** Where a form reaches the entry box's pending text on submit. */
  handleRef?: RefObject<ChipListHandle | null>;
  /** What is wrong with the last entry, for the surrounding `Field`'s error. */
  onProblem: (problem: string | undefined) => void;
  disabled?: boolean;
  id?: string;
  'aria-describedby'?: string;
}

/**
 * The labels as chips with an entry box (the design system's `ChipList`),
 * suggesting the project's labels while typing, then up to
 * {@link QUICK_LABELS} of the project's most used labels as buttons that add
 * one. An entry in another casing takes the project's (`physics` becomes
 * `Physics`), and a comma separates labels.
 */
export function LabelEditor({
  values,
  onChange,
  vocabulary,
  handleRef,
  onProblem,
  disabled = false,
  id,
  'aria-describedby': describedBy,
}: LabelEditorProps) {
  const offered = offeredLabels(vocabulary, values);
  const change = (next: string[]) => {
    // A removal: the chip went, nothing new to check.
    if (next.length <= values.length) {
      onProblem(undefined);
      onChange(next);
      return;
    }
    const typed = next.filter((value) => !values.includes(value));
    const result = addTyped(values, typed, vocabulary);
    if ('problem' in result) {
      onProblem(result.problem);
      return;
    }
    onProblem(undefined);
    onChange(result.labels);
  };
  return (
    <div className={styles.labelEditor}>
      <ChipList
        values={values}
        onChange={change}
        suggestions={offered}
        maxItems={LABEL_MAX}
        maxLength={LABEL_MAX_CHARS * 4}
        placeholder="Frontend, Docs…"
        disabled={disabled}
        {...(handleRef === undefined ? {} : { handleRef })}
        {...(id === undefined ? {} : { id })}
        {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
      />
      {offered.length > 0 && values.length < LABEL_MAX && (
        <span className={styles.labelQuick}>
          {offered.slice(0, QUICK_LABELS).map((label) => (
            <button
              key={label}
              type="button"
              className={styles.labelAdd}
              aria-label={`Add label ${label}`}
              disabled={disabled}
              onClick={() => change([...values, label])}
            >
              <Icon name="plus" size={11} />
              {label}
            </button>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * The labels a form sends on submit: `values` plus whatever is still typed in
 * the entry box (committed through `handle`, so a label typed and not yet
 * added is not lost), checked as {@link addTyped} checks them.
 */
export function submittedLabels(
  handle: ChipListHandle | null,
  values: readonly string[],
  vocabulary: readonly LabelCount[],
): { labels: string[] } | { problem: string } {
  const all = handle?.commit() ?? [...values];
  const typed = all.filter((value) => !values.includes(value));
  return typed.length === 0 ? { labels: [...values] } : addTyped(values, typed, vocabulary);
}
