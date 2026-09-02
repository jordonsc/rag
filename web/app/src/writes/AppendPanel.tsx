import { useRef, useState } from 'react';
import {
  Button,
  ChipList,
  Disclosure,
  Field,
  Form,
  Icon,
  Input,
  Panel,
  Segmented,
  Select,
  Textarea,
  type ChipListHandle,
  type SelectOption,
} from '@rag/ui';

import {
  EVENT_KINDS,
  appendEvent,
  asApiError,
  type AppendBody,
  type EventKind,
  type LedgerApiError,
  type TopicRecord,
  type TopicStatus,
} from '../api';
import { kindLabel, statusOptions } from '../ledger/vocab';
import { IDENTITY_NEEDED, INDEX_LAG, useWriteGate } from './gate';
import styles from './writes.module.css';

const KIND_OPTIONS: readonly SelectOption[] = EVENT_KINDS.map((value) => ({
  value,
  label: kindLabel(value),
}));

/**
 * Status options with an explicit **leave alone** at the head.
 *
 * It has to be a real option with an empty value rather than `Select`'s
 * placeholder: the placeholder is a disabled lead, so a reader who picks a
 * status and changes their mind cannot get back to "no change". Here they can.
 */
const STATUS_OPTIONS: readonly SelectOption[] = [
  { value: '', label: 'Leave unchanged' },
  ...statusOptions(),
];

/** Order-sensitive, because `ChipList` preserves order and so does the store. */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

/**
 * The kind an event *would* be filed as, given what it amends.
 *
 * A suggestion, not a rule: it is written into the control the reader can see
 * and can be overridden by touching it, so nothing is decided behind their
 * back. The order is by consequence — a supersede is a link before it is
 * anything else, and a status move outranks a state rewrite because it is the
 * field other people's decisions are read off.
 */
function impliedKind(status: string, state: string, supersedes: string): EventKind {
  if (supersedes.trim() !== '') {
    return 'link';
  }
  if (status !== '') {
    return 'status_change';
  }
  if (state.trim() !== '') {
    return 'state_change';
  }
  return 'note';
}

export interface AppendPanelProps {
  topic: TopicRecord;
  /** Re-fetch the topic. Called after a successful append, never before. */
  onWritten: () => void;
}

/**
 * Append to a topic, and amend it in the same breath.
 *
 * **The note body is required whatever else the form does**, and that is the
 * shape of the whole feature rather than a validation detail. An amendment
 * without a rationale is the one thing this ledger is built to prevent: the
 * status field of a topic can be read off the topic, but *why* it moved exists
 * only if somebody wrote it down at the moment they moved it.
 *
 * **`summary` is absent, deliberately and permanently.** There is no
 * `set_summary` on any code path in the server, and there is no field for it
 * here. A topic framed wrongly is worth more than one tidied to match its
 * outcome — the wrong framing is evidence, and the amendment that corrects the
 * understanding belongs in the monologue where it is dated and attributed.
 *
 * The amendable fields are **pre-populated from the topic**, which matters most
 * for tags: `set_tags` replaces the set wholesale, so a form that started empty
 * would let a reader add one tag and silently delete the other four.
 */
export function AppendPanel({ topic, onWritten }: AppendPanelProps) {
  const gate = useWriteGate();

  const [body, setBody] = useState('');
  const [kindChoice, setKindChoice] = useState<EventKind | null>(null);
  const [amending, setAmending] = useState(false);
  const [status, setStatus] = useState('');
  const [state, setState] = useState('');
  const [supersedes, setSupersedes] = useState('');
  // `null` means untouched — the topic's own value is what the control shows
  // and what the form will leave alone. Anything else is an intended change.
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [tagsDraft, setTagsDraft] = useState<string[] | null>(null);
  // Reaches into `ChipList` on submit for a tag typed but not entered. Without
  // it the append would quietly save a tag set the reader can see they typed.
  const chips = useRef<ChipListHandle>(null);

  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);
  const [saved, setSaved] = useState(false);

  const title = titleDraft ?? topic.title;
  const tags = tagsDraft ?? topic.tags;
  const kind = kindChoice ?? impliedKind(status, state, supersedes);

  const supersedesId = supersedes.trim();
  const bodyError = body.trim() === '' ? 'A note is required — say why.' : undefined;
  const titleError =
    titleDraft !== null && titleDraft.trim() === ''
      ? 'A topic must keep a title. Restore it or leave it alone.'
      : undefined;
  const supersedesError =
    supersedesId === topic.topic_id ? 'A topic cannot supersede itself.' : undefined;
  const invalid = [bodyError, titleError, supersedesError].some((message) => message !== undefined);

  const changesTitle = titleDraft !== null && title.trim() !== topic.title;

  const reset = () => {
    setBody('');
    setKindChoice(null);
    setStatus('');
    setState('');
    setSupersedes('');
    setTitleDraft(null);
    setTagsDraft(null);
    setTouched(false);
    setAmending(false);
  };

  const submit = () => {
    setTouched(true);
    setSaved(false);
    if (gate.fields === null) {
      // Not a refusal: the prompt *is* the response to pressing this.
      gate.prompt();
      return;
    }
    if (invalid || busy) {
      // An invalid amendment can be folded out of sight, and a reader staring
      // at a form that will not save needs to see the reason.
      if (titleError !== undefined || supersedesError !== undefined) {
        setAmending(true);
      }
      return;
    }

    // The chip box may hold a tag that was typed and never entered. Commit it
    // and use what comes back: the state React is about to set is not readable
    // from here, so the payload is built from the returned array rather than
    // from `tags`. With nothing pending this is the current set unchanged, and
    // `sameTags` then decides — as before — whether `set_tags` is sent at all.
    const finalTags = chips.current?.commit() ?? tags;
    const changesTags = !sameTags(finalTags, topic.tags);

    const payload: AppendBody = {
      ...gate.fields,
      body: body.trim(),
      kind,
      ...(status === '' ? {} : { set_status: status as TopicStatus }),
      // Trimmed, like the note and the title either side of it. An untrimmed
      // state carries the textarea's trailing newlines into `current_state`
      // and from there into the topic's indexed text.
      ...(state.trim() === '' ? {} : { set_state: state.trim() }),
      ...(changesTitle ? { set_title: title.trim() } : {}),
      ...(changesTags ? { set_tags: finalTags } : {}),
      ...(supersedesId === '' ? {} : { supersedes: supersedesId }),
    };

    setBusy(true);
    setError(null);
    appendEvent(topic.topic_id, payload)
      .then(() => {
        setBusy(false);
        setSaved(true);
        reset();
        // The server decides the event id, the timestamp, the status the topic
        // ends up in and what `supersedes` did to the other topic. None of that
        // is predictable here, so the record is re-read rather than patched.
        onWritten();
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <Panel
      header="Add to this topic"
      actions={
        <span className={styles.panelNote}>
          {topic.archived ? 'Archived — appending will not put it back in search' : 'Append-only'}
        </span>
      }
    >
      <Form
        onSubmit={submit}
        actions={
          <div className={styles.commit}>
            <div className={styles.commitSay} aria-live="polite">
              {error !== null && (
                <p className={styles.failed} role="alert">
                  <Icon name="triangle-alert" size={14} />
                  <span>
                    {error.message}
                    {error.status === 422 && error.detail !== '' && (
                      <span className={styles.detail}> {error.detail}</span>
                    )}
                  </span>
                </p>
              )}
              {saved && error === null && (
                <p className={styles.saved}>
                  <Icon name="circle-check" size={14} />
                  <span>{INDEX_LAG}</span>
                </p>
              )}
              {!gate.ready && <span className={styles.gate}>{IDENTITY_NEEDED}</span>}
            </div>
            <Button type="submit" variant="primary" loading={busy}>
              {gate.ready ? 'Append' : 'Set your email'}
            </Button>
          </div>
        }
      >
        <Field
          label="Note"
          help="Markdown. This is the entry a later reader gets, so say what changed and why — an amendment with no reason attached is the failure the ledger exists to prevent."
          error={touched ? bodyError : undefined}
        >
          <Textarea
            value={body}
            onChange={(value) => {
              setBody(value);
              // The confirmation belongs to the entry that was saved. Once a
              // new one is being written it is describing something else.
              setSaved(false);
            }}
            rows={6}
            placeholder="What happened, and what it means for this topic."
            invalid={touched && bodyError !== undefined}
          />
        </Field>

        <Field
          label="Filed as"
          help={
            kindChoice === null
              ? 'Follows what you amend below. Pick one to override it.'
              : 'Chosen by hand — it will no longer follow the amendments below.'
          }
        >
          <Segmented
            value={kind}
            onChange={(value) => setKindChoice(value as EventKind)}
            options={KIND_OPTIONS}
            label="Event kind"
          />
        </Field>

        <Disclosure
          title="Amend the topic"
          description="Optional. Anything set here is recorded on this entry, so the history says what changed as well as why. The summary is not amendable and is not here: it is the original framing, and it stays wrong on purpose when it was wrong."
          open={amending}
          onToggle={setAmending}
        >
          <Field
            label="Status"
            help="Moves the topic's lifecycle status and records the move on this entry."
          >
            <Select value={status} onChange={setStatus} options={STATUS_OPTIONS} />
          </Field>

          <Field
            label="Current state"
            help="Replaces the topic's current state wholesale. Keep it a concise statement of where things stand — a state that has grown into a dossier is a sign the next finding wanted a topic of its own."
          >
            <Textarea
              value={state}
              onChange={setState}
              rows={4}
              placeholder="Left blank, the current state is untouched."
            />
          </Field>

          <Field
            label="Title"
            help="The topic's handle. References between topics are by id, so retitling breaks nothing."
            error={touched ? titleError : undefined}
          >
            <Input
              value={title}
              onChange={setTitleDraft}
              invalid={touched && titleError !== undefined}
            />
          </Field>

          <Field
            label="Tags"
            help="Replaces the tag set wholesale — what is in the box is what the topic will have, and an empty box clears it. The current tags are loaded in for that reason."
          >
            <ChipList
              values={tags}
              onChange={setTagsDraft}
              placeholder="Add a tag and press Enter"
              handleRef={chips}
            />
          </Field>

          <Field
            label="Supersedes"
            help="The id of an older topic this one replaces."
            error={touched ? supersedesError : undefined}
          >
            <Input
              value={supersedes}
              onChange={setSupersedes}
              placeholder="e.g. rag-0007"
              spellCheck={false}
              invalid={touched && supersedesError !== undefined}
            />
          </Field>

          {supersedesId !== '' && supersedesError === undefined && (
            <p className={styles.consequence}>
              <Icon name="triangle-alert" size={14} />
              <span>
                On save, <code>{supersedesId}</code> is flipped to <strong>Superseded</strong> and
                the two are linked in both directions. That is a change to the other topic, and
                nothing here undoes it.
              </span>
            </p>
          )}
        </Disclosure>
      </Form>
    </Panel>
  );
}
