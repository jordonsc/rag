/**
 * The phase on a ticket's row and page (spec:roadmap D29, RM-47): a chip linked
 * to its phase, reading the phase's title.
 *
 * **The title is not on the ticket.** R6's boolean keeps listing the queue free
 * of a join, and the chip must not undo it with one read a row, so a page holds
 * every phase's title from one `useRoadmap` read, here, and a chip looks its id
 * up. A chip with no title in hand (the read has not landed, or failed, or there
 * is no provider) reads the id, which is still a link.
 *
 * `enabled` is whether the page has any ticket with a phase to name: without one
 * nothing is read, so a project with no roadmap pays nothing for it. `omit` is a
 * phase that need not be named, because the page is that phase's own.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Icon, Select } from '@rag/ui';
import { Link } from 'react-router';

import { cx } from '../util';
import { phasePath } from './paths';
import styles from './tracker.module.css';
import type { Item, Roadmap } from './types';
import { useRoadmap } from './useRoadmap';
import { readVelocityWindow } from './velocity';

type Titles = ReadonlyMap<string, string>;

const NONE: Titles = new Map();

interface Held {
  titles: Titles;
  omit: string | null;
}

const PhaseTitles = createContext<Held>({ titles: NONE, omit: null });

/** Every phase's title in a roadmap's answer, whichever list it is in. */
export function phaseTitleMap(roadmap: Roadmap): Titles {
  return new Map(
    [...roadmap.released, ...roadmap.planned, ...roadmap.complete, ...roadmap.archived].map(
      (phase) => [phase.id, phase.title],
    ),
  );
}

/** The phases `items` name, once each, in id order, with `keep` added (a filter's options). */
export function phasesIn(items: readonly Item[], keep = ''): string[] {
  const ids = new Set(items.flatMap((item) => (item.phase ? [item.phase] : [])));
  if (keep !== '') {
    ids.add(keep);
  }
  return [...ids].sort();
}

/** The read, apart from the provider so that a page with no phase to name makes none. */
function TitleReader({
  project,
  viewKey,
  onRead,
}: {
  project: string;
  viewKey: number | string | null;
  onRead: (titles: Titles) => void;
}) {
  // A title is the same in either window: the widget's choice is as good as any.
  const [window] = useState(readVelocityWindow);
  const { roadmap } = useRoadmap(project, window, viewKey);
  useEffect(() => {
    if (roadmap !== null) {
      onRead(phaseTitleMap(roadmap));
    }
  }, [roadmap, onRead]);
  return null;
}

export interface PhaseTitlesProviderProps {
  project: string;
  /** Whether anything on the page has a phase to name. */
  enabled?: boolean;
  /** Read again when this changes: the page's view of its tickets. */
  viewKey?: number | string | null;
  /** A phase whose chip draws nothing: the page is its own. */
  omit?: string | null;
  children: ReactNode;
}

export function PhaseTitlesProvider({
  project,
  enabled = true,
  viewKey = null,
  omit = null,
  children,
}: PhaseTitlesProviderProps) {
  const [titles, setTitles] = useState<Titles>(NONE);
  const held = useMemo(() => ({ titles, omit }), [titles, omit]);
  return (
    <PhaseTitles.Provider value={held}>
      {enabled && <TitleReader project={project} viewKey={viewKey} onRead={setTitles} />}
      {children}
    </PhaseTitles.Provider>
  );
}

/** A phase's name on this page: its title, or its id with none in hand. */
export function usePhaseName(phase: string): string {
  return useContext(PhaseTitles).titles.get(phase) ?? phase;
}

/**
 * A ticket's phase, linked to its page. A click stays on the chip, so a clickable
 * row under it does not open the ticket as well.
 */
export function PhaseChip({ project, phase }: { project: string; phase: string }) {
  const { omit } = useContext(PhaseTitles);
  const name = usePhaseName(phase);
  if (phase === omit) {
    return null;
  }
  return (
    <Link
      to={phasePath(project, phase)}
      className={cx(styles.chip, styles.chipLink)}
      title={name === phase ? `Phase ${phase}` : `Phase ${phase}: ${name}`}
      onClick={(event: MouseEvent) => event.stopPropagation()}
    >
      <Icon name="map" size={12} />
      <span>{name}</span>
    </Link>
  );
}

/**
 * The queue page's phase filter: a select of the phases its tickets name, by
 * title. Inside the provider, which is what knows the titles.
 */
export function PhaseFilter({
  phases,
  value,
  onChange,
  className,
}: {
  phases: readonly string[];
  value: string;
  onChange: (phase: string) => void;
  className?: string;
}) {
  const { titles } = useContext(PhaseTitles);
  const options = [
    { value: '', label: 'All phases' },
    ...phases.map((id) => ({ value: id, label: titles.get(id) ?? id })),
  ];
  return (
    <span className={className}>
      <Select value={value} onChange={onChange} options={options} aria-label="Phase" />
    </span>
  );
}
