import { useRef, useState } from 'react';
import {
  Button,
  ChipList,
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
import { useNavigate } from 'react-router';

import {
  asApiError,
  createTopic,
  type CreateBody,
  type LedgerApiError,
  type TopicStatus,
  type TopicType,
} from '../api';
import { REPO_NAME_ERROR, isRepoName, topicPath } from '../ledger/ids';
import { defaultStatus, statusLabel, statusOptions, typeHint, typeOptions } from '../ledger/vocab';
import { IDENTITY_NEEDED, useCreateGate } from '../writes';
import writeStyles from '../writes/writes.module.css';
import styles from './create.module.css';

const TYPE_OPTIONS: readonly SelectOption[] = typeOptions();

/**
 * Create a topic — the only place a `summary` is ever written.
 *
 * Two things this form is trying to get right, both of which are about what
 * ends up in the ledger rather than about the form:
 *
 * * **`summary` is fixed at this moment and never revised.** There is no
 *   `set_summary` anywhere in the system, so what is typed here is what a
 *   reader sees in a year — including, deliberately, when it turns out to have
 *   been the wrong framing. The field says so before it is filled in, not after.
 * * **One topic is one decision or one finding.** The failure mode this
 *   replaces is a single sprawling topic that accretes every fact about a
 *   project until nothing can be retrieved from it. Several small topics beat
 *   one large one, and the form says so where the choice is being made.
 */
export function CreateView() {
  const navigate = useNavigate();
  const gate = useCreateGate();

  const [type, setType] = useState<TopicType>('decision');
  const [repo, setRepo] = useState('');
  const [title, setTitle] = useState('');
  const [summary, setSummary] = useState('');
  const [initialState, setInitialState] = useState('');
  const [status, setStatus] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  // A tag typed but not yet entered is still a tag the reader meant. `ChipList`
  // commits it on blur, and this is the belt to that pair of braces: pressing
  // Create must not be the thing that discards it.
  const chips = useRef<ChipListHandle>(null);

  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<LedgerApiError | null>(null);

  const fallback = defaultStatus(type);
  const statusChoices: readonly SelectOption[] = [
    { value: '', label: `Default for a ${type}: ${statusLabel(fallback)}` },
    ...statusOptions(),
  ];

  const trimmedRepo = repo.trim();
  const repoError =
    trimmedRepo === ''
      ? 'Required: it becomes the first half of the topic id.'
      : !isRepoName(trimmedRepo)
        ? REPO_NAME_ERROR
        : undefined;
  const titleError = title.trim() === '' ? 'Required.' : undefined;
  const summaryError =
    summary.trim() === '' ? 'Required — it is the framing, and it is fixed.' : undefined;
  // The server would take a blank one: the field is required to be *present*,
  // not to be non-empty. It should not be blank all the same, because the store
  // seeds the monologue with it — a topic created without one opens with an
  // empty first entry, which reads as a rendering fault rather than as silence.
  const stateError = initialState.trim() === '' ? 'Required — it opens the history.' : undefined;
  const invalid = [repoError, titleError, summaryError, stateError].some(
    (message) => message !== undefined,
  );

  const submit = () => {
    setTouched(true);
    if (gate.fields === null) {
      gate.prompt();
      return;
    }
    if (invalid || busy) {
      return;
    }

    const finalTags = chips.current?.commit() ?? tags;

    const payload: CreateBody = {
      ...gate.fields,
      type,
      repo: trimmedRepo,
      title: title.trim(),
      summary: summary.trim(),
      initial_state: initialState.trim(),
      ...(status === '' ? {} : { status: status as TopicStatus }),
      ...(finalTags.length === 0 ? {} : { tags: finalTags }),
    };

    setBusy(true);
    setError(null);
    createTopic(payload)
      .then((topic) => {
        setBusy(false);
        // The id is the server's to mint — `{repo}-l{seq:04}`, and the sequence
        // is per project — so the only way to land on the new topic is to be
        // told what it is called. Straight to it by id, never to a search: the
        // vector index has not seen it yet and will not for a few minutes.
        navigate(topicPath(topic.topic_id));
      })
      .catch((cause: unknown) => {
        setBusy(false);
        setError(asApiError(cause));
      });
  };

  return (
    <div className={styles.view}>
      <Panel header="New topic">
        <p className={styles.guidance}>
          <Icon name="info" size={14} />
          <span>
            <strong>One topic is one decision or one finding.</strong> Several small topics are
            worth more than one that grows: they are what a search can actually return, and a topic
            that has to be read whole to find the part that matters is a topic nobody reads. If a
            second, distinct thing turns up while writing this, it wants its own.
          </span>
        </p>

        <Form
          onSubmit={submit}
          actions={
            <div className={writeStyles.commit}>
              <div className={writeStyles.commitSay} aria-live="polite">
                {error !== null && (
                  <p className={writeStyles.failed} role="alert">
                    <Icon name="triangle-alert" size={14} />
                    <span>
                      {error.message}
                      {error.status === 422 && error.detail !== '' && (
                        <span className={writeStyles.detail}> {error.detail}</span>
                      )}
                    </span>
                  </p>
                )}
                <span className={writeStyles.gate}>
                  {gate.ready
                    ? 'Readable at its own id the moment it is created; search finds it 30 seconds to 3 minutes later.'
                    : IDENTITY_NEEDED}
                </span>
              </div>
              <Button type="submit" variant="primary" loading={busy}>
                {gate.ready ? 'Create topic' : 'Set your email'}
              </Button>
            </div>
          }
        >
          <Field label="Type" help={typeHint(type)}>
            <Segmented
              value={type}
              onChange={(value) => setType(value as TopicType)}
              options={TYPE_OPTIONS}
              label="Topic type"
            />
          </Field>

          <Field
            label="Project"
            help={
              <>
                The repository this belongs to. It is interpolated straight into the id the server
                mints —{' '}
                <code className={styles.preview}>
                  {trimmedRepo === '' ? 'project' : trimmedRepo}-l0001
                </code>{' '}
                — so it is part of how the topic will be quoted for the rest of its life.
              </>
            }
            error={touched ? repoError : undefined}
          >
            <Input
              value={repo}
              onChange={setRepo}
              placeholder="e.g. rag"
              spellCheck={false}
              invalid={touched && repoError !== undefined}
            />
          </Field>

          <Field
            label="Title"
            help="The handle. Amendable later — references between topics are by id, so a retitle breaks nothing."
            error={touched ? titleError : undefined}
          >
            <Input
              value={title}
              onChange={setTitle}
              placeholder="What this is about, in a line"
              invalid={touched && titleError !== undefined}
            />
          </Field>

          <Field
            label="Summary"
            help="The original framing — what the problem looked like before the answer was known. Markdown. There is no way to edit this afterwards, on any path, deliberately: a topic framed wrongly is worth more than one tidied to match its outcome. Corrections belong in the history, dated and attributed."
            error={touched ? summaryError : undefined}
          >
            <Textarea
              value={summary}
              onChange={setSummary}
              rows={5}
              placeholder="The question being answered, or the thing that went wrong."
              invalid={touched && summaryError !== undefined}
            />
          </Field>

          <Field
            label="Current state"
            help="Where it stands right now. A concise status, not a dossier — it is replaced wholesale by later entries, and one that keeps growing means the next finding wanted a topic of its own. It also seeds the history, so the log is never empty."
            error={touched ? stateError : undefined}
          >
            <Textarea
              value={initialState}
              onChange={setInitialState}
              rows={4}
              placeholder="e.g. Proposed; not yet implemented."
              invalid={touched && stateError !== undefined}
            />
          </Field>

          <Field
            label="Status"
            help="Leave it on the default unless this topic starts somewhere unusual — a decision already accepted, an incident already resolved."
          >
            <Select value={status} onChange={setStatus} options={statusChoices} />
          </Field>

          <Field
            label="Tags"
            help="Retrieval handles. Amendable later, and replaced wholesale when they are."
          >
            <ChipList
              values={tags}
              onChange={setTags}
              placeholder="Add a tag and press Enter"
              handleRef={chips}
            />
          </Field>
        </Form>
      </Panel>
    </div>
  );
}
