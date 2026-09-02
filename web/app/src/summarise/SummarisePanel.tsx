import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  Drawer,
  ErrorState,
  Field,
  Icon,
  Select,
  Spinner,
  Textarea,
  useFormat,
  type SelectOption,
} from '@rag/ui';

import {
  asApiError,
  getInfo,
  isAbort,
  listPrompts,
  summariseTopic,
  type InfoResponse,
  type LedgerApiError,
  type PromptsResponse,
  type SavedPrompt,
  type SummariseResponse,
} from '../api';
import { Markdown } from '../markdown/Markdown';
import { BUILT_IN, PromptChooser } from './PromptChooser';
import styles from './summarise.module.css';

/**
 * Said wherever summarising is unavailable, in the same words both times.
 *
 * There are two ways to meet this condition — `/info` says `summarise_ready:
 * false` before anything is pressed, or the endpoint answers 503 after — and
 * they are the same fact: the server holds no Anthropic key. A reader who saw
 * two different sentences would reasonably wonder whether they were two
 * different faults.
 *
 * **It is not an error.** Nothing has failed; a feature was never switched on,
 * and every other thing this viewer does still works. So it is drawn as a
 * notice, not as a red alert.
 */
export const NOT_CONFIGURED =
  'Summarising is switched off on this server. It needs an ANTHROPIC_API_KEY in the ' +
  'server environment — without one, nothing else here is affected.';

/** Said under the button, because it is the thing a reader would assume otherwise. */
export const NO_CACHE =
  'Nothing is stored: every Go is a fresh call, and two runs can differ. The token ' +
  'count below is what it cost.';

/**
 * Display names for the model ids the server allows.
 *
 * A cosmetic table, and only that: the **set** of models comes from `/info`, so
 * this cannot offer one the server would reject. An id with no entry here is
 * drawn as itself, which is the honest thing to do with a model this build has
 * not heard of — coercing it onto a familiar name would state something nobody
 * claimed.
 */
const MODEL_LABELS: Record<string, string> = {
  'claude-opus-5': 'Claude Opus 5',
  'claude-sonnet-5': 'Claude Sonnet 5',
  'claude-haiku-4-5': 'Claude Haiku 4.5',
};

function modelLabel(id: string): string {
  return Object.hasOwn(MODEL_LABELS, id) ? (MODEL_LABELS[id] as string) : id;
}

type Run =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'done'; result: SummariseResponse }
  | { kind: 'failed'; error: LedgerApiError };

export interface SummarisePanelProps {
  /** The topic to summarise. Changing it clears any summary already on screen. */
  topicId: string;
}

/**
 * The Summarise drawer, and the tab that pulls it out.
 *
 * A ledger entry written by an agent runs to thousands of words, and a reader
 * who wants the gist of one has, until now, had to read all of it. This asks a
 * model to compress it — the only LLM call this project makes.
 *
 * Three things about it that are decisions rather than details:
 *
 * * **The prompt is editable, and is the server's.** The box is prefilled from
 *   `/info`, which serves the same constant the server falls back to, so what a
 *   reader sees is what would run. Editing it before pressing Go is the point:
 *   "summarise this" and "list only what changed" are different questions of the
 *   same entry, and both are one run away.
 * * **Nothing is cached, at either end.** Two presses make two calls and can
 *   produce two summaries. A stored summary would go stale the moment somebody
 *   appended to the topic, and the staleness would be silent — worse than the
 *   penny each run costs.
 * * **The summary is untrusted output.** The model has just read prose written
 *   by any unauthenticated client on the network, so what comes back goes
 *   through `Markdown`, and therefore DOMPurify, like every other ledger string.
 *
 * When the server has no key the tab stays **visible and says why**, rather than
 * disappearing — the same principle as the write controls with no identity set.
 * A control that vanishes teaches a reader the application cannot do the thing.
 */
export function SummarisePanel({ topicId }: SummarisePanelProps) {
  const format = useFormat();
  const [open, setOpen] = useState(false);

  const [config, setConfig] = useState<InfoResponse | null>(null);
  const [configError, setConfigError] = useState<LedgerApiError | null>(null);
  const [configAttempt, setConfigAttempt] = useState(0);

  // `null` means untouched: the control shows the server's value and sends
  // nothing, so the server's default stays the default even if it changes.
  const [modelDraft, setModelDraft] = useState<string | null>(null);

  /**
   * The saved prompt library, and which of it is selected.
   *
   * Three pieces of state rather than one, because they answer three different
   * questions: `library` is what the server holds, `selected` is which of it
   * the reader picked ({@link BUILT_IN} for the constant that is not a file),
   * and `draft` is what is actually in the box — `null` meaning "whatever the
   * selection says", so a prompt edited on the server elsewhere shows its new
   * body rather than a stale copy this component captured.
   */
  const [library, setLibrary] = useState<PromptsResponse | null>(null);
  const [libraryError, setLibraryError] = useState<LedgerApiError | null>(null);
  const [selected, setSelected] = useState<string>(BUILT_IN);
  const [draft, setDraft] = useState<string | null>(null);

  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const inFlight = useRef<AbortController | null>(null);

  /**
   * Read `/info` — but only once the drawer is opened.
   *
   * A page that fetched configuration for a panel nobody has opened would spend
   * a request on every topic view for a feature most visits do not use.
   */
  useEffect(() => {
    if (!open || config !== null) {
      return undefined;
    }
    const controller = new AbortController();
    setConfigError(null);
    getInfo(controller.signal)
      .then(setConfig)
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setConfigError(asApiError(error));
      });
    return () => controller.abort();
  }, [open, config, configAttempt]);

  /**
   * Read the saved prompt library, on the same trigger as `/info` and in
   * parallel with it.
   *
   * A separate request and separate failure, deliberately: a library that
   * cannot be read must not stop the drawer working, because the built-in
   * instruction needs no library at all.
   */
  useEffect(() => {
    if (!open || library !== null) {
      return undefined;
    }
    const controller = new AbortController();
    setLibraryError(null);
    listPrompts(controller.signal)
      .then(setLibrary)
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setLibraryError(asApiError(error));
      });
    return () => controller.abort();
  }, [open, library, configAttempt]);

  /**
   * A new topic clears the summary — and only the summary.
   *
   * The panel outlives the topic it was opened over (it hangs off the viewport,
   * not off the record), so without this a reader who moves to another entry is
   * shown the previous entry's summary under the new entry's id. That is the one
   * failure mode here that produces a confident, plausible lie.
   *
   * The model choice and the edited prompt deliberately **survive**: those are
   * the reader's settings, not the topic's, and a reader who has tuned a prompt
   * is usually about to run it against the next entry too. Which is also why
   * this is not a `key` at the call site — a key would throw away all three.
   */
  useEffect(() => {
    inFlight.current?.abort();
    inFlight.current = null;
    setRun({ kind: 'idle' });
  }, [topicId]);

  // Nothing left running when the panel goes away.
  useEffect(() => () => inFlight.current?.abort(), []);

  const ready = config !== null && config.summarise_ready;
  const model = modelDraft ?? config?.summarise_default_model ?? '';

  // What the selection says the instruction is. The built-in comes from
  // `/info` — one source of truth with the server's own constant — and every
  // other name comes from the library listing.
  const savedBody =
    selected === BUILT_IN
      ? (config?.summarise_system_prompt ?? '')
      : (library?.prompts.find((saved) => saved.name === selected)?.body ?? '');
  const prompt = draft ?? savedBody;
  const promptEdited = draft !== null && draft !== savedBody;

  /** Take a saved prompt into the list and select it, replacing any namesake. */
  const absorb = (saved: SavedPrompt) => {
    setLibrary((held) => ({
      configured: true,
      prompts: [...(held?.prompts ?? []).filter((p) => p.name !== saved.name), saved].sort((a, b) =>
        a.name.toLowerCase().localeCompare(b.name.toLowerCase()),
      ),
    }));
    setSelected(saved.name);
    setDraft(null);
  };

  const options: readonly SelectOption[] = (config?.summarise_models ?? []).map((id) => ({
    value: id,
    label: modelLabel(id),
  }));

  const go = useCallback(() => {
    if (config === null || !config.summarise_ready) {
      return;
    }
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    setRun({ kind: 'running' });
    summariseTopic(
      topicId,
      {
        model: modelDraft ?? config.summarise_default_model,
        // What is in the box, whatever put it there — the built-in, a saved
        // prompt, or an edit of either. The box is the thing that runs.
        system_prompt: prompt,
      },
      controller.signal,
    )
      .then((result) => setRun({ kind: 'done', result }))
      .catch((error: unknown) => {
        if (isAbort(error)) {
          return;
        }
        setRun({ kind: 'failed', error: asApiError(error) });
      });
  }, [config, modelDraft, prompt, topicId]);

  return (
    <>
      {/* The handle: fixed to the right edge of the viewport, present on every
          topic. It is the affordance the drawer is named for — a tab you pull
          out — rather than another button in an already busy header. */}
      <button
        type="button"
        className={styles.tab}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon name="sparkles" size={14} />
        <span>Summarise</span>
      </button>

      <Drawer open={open} onClose={() => setOpen(false)} title="Summarise" width={560}>
        <div className={styles.body}>
          {configError !== null && (
            <ErrorState
              message="Could not read the server's configuration."
              detail={configError.message}
              onRetry={() => setConfigAttempt((n) => n + 1)}
            />
          )}

          {config === null && configError === null && (
            <p className={styles.waiting}>
              <Spinner size={16} />
              <span>Checking what this server can do…</span>
            </p>
          )}

          {config !== null && !config.summarise_ready && (
            <p className={styles.notice}>
              <Icon name="info" size={14} />
              <span>{NOT_CONFIGURED}</span>
            </p>
          )}

          {config !== null && (
            <>
              <Field label="Model">
                <Select
                  value={model}
                  onChange={setModelDraft}
                  options={options}
                  disabled={!ready}
                />
              </Field>

              {/* The library, when it could be read. A failure here is drawn
                  in its place and stops nothing: the built-in instruction
                  below needs no library at all. */}
              {library !== null && (
                <PromptChooser
                  prompts={library.prompts}
                  configured={library.configured}
                  selected={selected}
                  onSelect={(name) => {
                    setSelected(name);
                    setDraft(null);
                  }}
                  text={prompt}
                  edited={promptEdited}
                  disabled={!ready}
                  onSaved={absorb}
                  onDeleted={(name) => {
                    setLibrary((held) => ({
                      configured: held?.configured ?? true,
                      prompts: (held?.prompts ?? []).filter((p) => p.name !== name),
                    }));
                    setSelected(BUILT_IN);
                    setDraft(null);
                  }}
                />
              )}

              {libraryError !== null && (
                <p className={styles.failed} role="alert">
                  <Icon name="triangle-alert" size={14} />
                  <span>The saved prompts could not be read. {libraryError.message}</span>
                </p>
              )}

              <Field
                label="Instruction"
                help="Sent as the system prompt. The entry itself is sent separately, as data."
              >
                <Textarea
                  value={prompt}
                  onChange={setDraft}
                  rows={8}
                  disabled={!ready}
                  spellCheck={false}
                />
              </Field>

              {/* Said before Go rather than after it, because the box is what
                  runs and an unsaved edit runs perfectly well — the point is
                  only that it is not what the library holds. */}
              {promptEdited && (
                <p className={styles.edited}>
                  <Icon name="pencil" size={13} />
                  <span>
                    Edited
                    {selected === BUILT_IN
                      ? ' — this run will use what is in the box, and nothing is saved.'
                      : ` — not saved to ${selected}.`}
                  </span>
                  <button type="button" className={styles.reset} onClick={() => setDraft(null)}>
                    Reset the instruction to the saved version
                  </button>
                </p>
              )}

              <div className={styles.commit}>
                <div className={styles.commitSay}>
                  <p className={styles.note}>{NO_CACHE}</p>
                </div>
                <Button
                  variant="primary"
                  onClick={go}
                  loading={run.kind === 'running'}
                  disabled={!ready}
                >
                  Go
                </Button>
              </div>
            </>
          )}

          {run.kind === 'running' && (
            <p className={styles.waiting} role="status">
              <Spinner size={16} />
              <span>Reading {topicId}…</span>
            </p>
          )}

          {run.kind === 'failed' &&
            (run.error.unavailable ? (
              <p className={styles.notice}>
                <Icon name="info" size={14} />
                <span>{NOT_CONFIGURED}</span>
              </p>
            ) : (
              <ErrorState message="The summary did not come back." detail={run.error.message} />
            ))}

          {run.kind === 'done' && (
            <section className={styles.result}>
              {run.result.truncated && (
                <p className={styles.notice}>
                  <Icon name="triangle-alert" size={14} />
                  <span>
                    This ran into the output limit and stops mid-thought — it is not the whole
                    summary.
                  </span>
                </p>
              )}
              {/* Through the one sanitising render path, like every other piece
                  of ledger prose. This one has been round a model that read
                  untrusted input, which makes it more suspect, not less. */}
              <Markdown source={run.result.summary} />
              <p className={styles.usage}>
                <Icon name="bot" size={13} />
                <span>
                  {modelLabel(run.result.model)} · {format.number(run.result.usage.input_tokens)}{' '}
                  tokens in · {format.number(run.result.usage.output_tokens)} out
                </span>
              </p>
            </section>
          )}
        </div>
      </Drawer>
    </>
  );
}
