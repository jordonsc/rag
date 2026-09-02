/**
 * The Summarise drawer.
 *
 * Four of these assertions are the feature and the rest are furniture. The four:
 *
 * * **The model list is the server's**, so the picker cannot offer something the
 *   allow-list would reject.
 * * **The prompt box is prefilled from the server's own constant**, and what is
 *   on screen — edited or not — is what gets sent.
 * * **Opening another topic does not leave the previous topic's summary on
 *   screen.** That is the one failure here that produces a confident lie rather
 *   than an obvious fault.
 * * **A 503 reads as "not configured", not as a crash.** The key is optional by
 *   design; a deployment without one is normal, not broken.
 */

import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { NOT_CONFIGURED, SummarisePanel } from '../summarise';
import { TopicView } from '../views/TopicView';
import { RECORD, SUMMARY, Server, info, prompts } from './fixtures';
import { mount, mountAt } from './harness';

let server: Server;

beforeEach(() => {
  server = new Server();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUMMARISE = /\/summarise$/;

/**
 * Open the drawer over one topic, with `/info` answering as given.
 *
 * `/prompts` is answered too — the drawer reads both on open — with an empty,
 * unconfigured library, so these tests see the built-in prompt alone. The
 * library's own behaviour is `promptLibrary.test.tsx`.
 */
async function openPanel(overrides: Parameters<typeof info>[0] = {}) {
  const user = userEvent.setup();
  server.on('/info', info(overrides));
  server.on('/prompts', prompts({ configured: false, prompts: [] }));
  mount(<SummarisePanel topicId="rag-0009" />);
  await user.click(screen.getByRole('button', { name: /summarise/i }));
  await screen.findByLabelText('Instruction');
  return { user };
}

describe('the tab', () => {
  it('is on the topic page, and asks the server nothing until it is opened', async () => {
    server.on(/\/ledger\/rag-0009$/, RECORD);
    mountAt('/topic/:id', <TopicView />, { route: '/topic/rag-0009' });

    await screen.findByRole('heading', { name: RECORD.title });
    expect(screen.getByRole('button', { name: /summarise/i })).toBeInTheDocument();
    // The topic itself was fetched; the panel's configuration was not.
    expect(server.count('/info')).toBe(0);
  });

  /**
   * A drawer whose configuration is fetched on every topic view would spend a
   * request per visit on a feature most visits never open.
   */
  it('reads /info on the first open, and not again on the second', async () => {
    const { user } = await openPanel();
    expect(server.count('/info')).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Close drawer' }));
    await user.click(screen.getByRole('button', { name: /summarise/i }));
    await screen.findByLabelText('Instruction');
    expect(server.count('/info')).toBe(1);
  });
});

describe('the controls', () => {
  it('offers the models the server allows, defaulting to the one it names', async () => {
    await openPanel();
    const picker = screen.getByLabelText('Model');
    expect(picker).toHaveValue('claude-sonnet-5');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((o) => o.getAttribute('value')),
    ).toEqual(['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  });

  /**
   * The picker is not a copy of the allow-list, it is a read of it. A server
   * offering two models must produce a picker with two options — otherwise the
   * list here is a second source of truth that can drift out of step with the
   * one that does the rejecting.
   */
  it('takes the whole list from the server rather than a copy of its own', async () => {
    await openPanel({
      summarise_models: ['claude-haiku-4-5'],
      summarise_default_model: 'claude-haiku-4-5',
    });
    const picker = screen.getByLabelText('Model');
    expect(within(picker).getAllByRole('option')).toHaveLength(1);
    expect(picker).toHaveValue('claude-haiku-4-5');
  });

  it('prefills the instruction from the server, so what is shown is what would run', async () => {
    await openPanel();
    expect(screen.getByLabelText('Instruction')).toHaveValue(
      'Read and summarise succinctly, using bullet points where apt.',
    );
  });

  it('offers a way back to the saved text only once the instruction has been changed', async () => {
    const { user } = await openPanel();
    const box = screen.getByLabelText('Instruction');
    expect(screen.queryByRole('button', { name: /reset the instruction/i })).toBeNull();

    await user.clear(box);
    await user.type(box, 'List only what changed.');
    await user.click(screen.getByRole('button', { name: /reset the instruction/i }));

    expect(box).toHaveValue('Read and summarise succinctly, using bullet points where apt.');
    expect(screen.queryByRole('button', { name: /reset the instruction/i })).toBeNull();
  });
});

describe('Go', () => {
  it('sends the chosen model and the instruction on screen, to the topic in the address', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);

    await user.selectOptions(screen.getByLabelText('Model'), 'claude-opus-5');
    const box = screen.getByLabelText('Instruction');
    await user.clear(box);
    await user.type(box, 'List only what changed.');
    await user.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    const sent = server.last(SUMMARISE);
    expect(sent.path).toBe('/ledger/rag-0009/summarise');
    expect(sent.method).toBe('POST');
    expect(sent.body).toEqual({
      model: 'claude-opus-5',
      system_prompt: 'List only what changed.',
    });
  });

  /**
   * **The endpoint takes an id, never content.** A body carrying the entry's
   * prose would make it a general-purpose LLM proxy for anything that can reach
   * the port, billed to whoever owns the key.
   */
  it('never sends the entry itself', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    expect(Object.keys(server.last(SUMMARISE).body ?? {}).sort()).toEqual([
      'model',
      'system_prompt',
    ]);
  });

  it('renders the summary as Markdown, because bullet points are what was asked for', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);
    await user.click(screen.getByRole('button', { name: 'Go' }));

    const items = await screen.findAllByRole('listitem');
    expect(items.map((li) => li.textContent)).toEqual([
      'Served same-origin.',
      'Decided once the proxy question was settled.',
    ]);
  });

  it('states what the run cost, since nothing is stored', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);
    await user.click(screen.getByRole('button', { name: 'Go' }));

    // One assertion, on the whole line: the model name alone also appears in
    // the picker above, and matching that would prove nothing about the cost.
    expect(
      await screen.findByText('Claude Sonnet 5 · 1,240 tokens in · 96 out'),
    ).toBeInTheDocument();
  });

  /** No cache is the design, so two presses are two calls and must stay so. */
  it('calls again on a second press rather than reusing the first answer', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(2));
  });

  it('says when the answer was cut off rather than passing a stump off as the whole thing', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, { ...SUMMARY, truncated: true });
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(await screen.findByText(/stops mid-thought/i)).toBeInTheDocument();
  });
});

describe('when the server has no key', () => {
  it('keeps the tab, explains itself, and refuses to spend a request', async () => {
    const { user } = await openPanel({ summarise_ready: false });

    expect(screen.getByRole('button', { name: /summarise/i })).toBeInTheDocument();
    expect(screen.getByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeDisabled();
    expect(screen.getByLabelText('Instruction')).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(server.count(SUMMARISE)).toBe(0);
  });

  /**
   * The other way to meet the same condition: `/info` said ready, and the
   * endpoint disagreed. Same sentence, and no alert — nothing has failed.
   */
  it('reads a 503 as "not configured" rather than as a fault', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, { error: 'summarise unavailable: no Anthropic API key' }, 503);
    await user.click(screen.getByRole('button', { name: 'Go' }));

    expect(await screen.findByText(NOT_CONFIGURED)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows any other failure with the server’s own words', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, { error: 'anthropic API error: 429 rate_limit_error: slow down' }, 502);
    await user.click(screen.getByRole('button', { name: 'Go' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('The summary did not come back.');
    expect(alert).toHaveTextContent('rate_limit_error: slow down');
  });
});

/**
 * A host that changes the topic under a panel that stays mounted — which is
 * what navigating between topics does to this component, since it hangs off the
 * viewport rather than off the record.
 */
function Switcher() {
  const [id, setId] = useState('rag-0009');
  return (
    <>
      <button type="button" onClick={() => setId('rag-0010')}>
        next topic
      </button>
      <SummarisePanel topicId={id} />
    </>
  );
}

describe('moving to another topic', () => {
  /**
   * Without an explicit clear this would show one entry's summary under another
   * entry's id — the one failure here that produces a confident lie rather than
   * a visible fault.
   */
  it('drops the summary but keeps the reader’s prompt', async () => {
    const user = userEvent.setup();
    server.on('/info', info());
    server.on('/prompts', prompts({ configured: false, prompts: [] }));
    server.on(SUMMARISE, SUMMARY);
    mount(<Switcher />);

    await user.click(screen.getByRole('button', { name: /summarise/i }));
    const box = await screen.findByLabelText('Instruction');
    await user.clear(box);
    await user.type(box, 'List only what changed.');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await screen.findByText('Served same-origin.');

    await user.click(screen.getByRole('button', { name: 'next topic' }));

    expect(screen.queryByText('Served same-origin.')).toBeNull();
    expect(screen.getByLabelText('Instruction')).toHaveValue('List only what changed.');
    // And the next run goes to the topic now on screen, not the one before it.
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(2));
    expect(server.last(SUMMARISE).path).toBe('/ledger/rag-0010/summarise');
  });
});
