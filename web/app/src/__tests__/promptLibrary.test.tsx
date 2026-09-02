/**
 * The saved prompt library in the Summarise drawer.
 *
 * A prompt is a Markdown file on the server, and these routes are the only ones
 * in the service that **write a file** — over an endpoint with no
 * authentication. So the assertions worth having are not "the button works":
 *
 * * **The built-in is not a file.** It is always offered, it is never in the
 *   saved list, and it has no Delete. Saving an edit of it asks for a name
 *   rather than overwriting anything.
 * * **A name that could be a path never leaves the browser.** The server is the
 *   barrier, but a client that cheerfully posts `../../etc/x` is a client that
 *   is relying on it.
 * * **An unsaved edit survives a change of selection**, or is discarded only
 *   after being asked about. It is the one thing here that destroys work.
 * * **A server with no prompts directory is a valid server**, not a broken one.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { BUILT_IN_LABEL, NO_LIBRARY, SummarisePanel } from '../summarise';
import { PROMPTS, SUMMARY, Server, info, prompts } from './fixtures';
import { mount } from './harness';

let server: Server;

beforeEach(() => {
  server = new Server();
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const SUMMARISE = /\/summarise$/;
const DEFAULT_PROMPT = 'Read and summarise succinctly, using bullet points where apt.';

/** Open the drawer with the library answering as given. */
async function openPanel(library = prompts()) {
  const user = userEvent.setup();
  server.on('/info', info());
  server.on('/prompts', library);
  mount(<SummarisePanel topicId="rag-0009" />);
  await user.click(screen.getByRole('button', { name: /summarise/i }));
  await screen.findByLabelText('Instruction');
  return { user };
}

const chooser = () => screen.getByLabelText('Saved prompt');
const box = () => screen.getByLabelText('Instruction');

describe('the chooser', () => {
  it('lists the built-in first and every saved prompt after it', async () => {
    await openPanel();
    expect(
      within(chooser())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([BUILT_IN_LABEL, 'Terse', 'What changed']);
    // And starts on the built-in, whose text came from /info.
    expect(chooser()).toHaveValue('');
    expect(box()).toHaveValue(DEFAULT_PROMPT);
  });

  it('loads the chosen prompt into the box, and that is what runs', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);

    await user.selectOptions(chooser(), 'What changed');
    expect(box()).toHaveValue('List only what changed, newest first.');

    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    expect(server.last(SUMMARISE).body).toEqual({
      model: 'claude-sonnet-5',
      system_prompt: 'List only what changed, newest first.',
    });
  });

  /**
   * The box stays editable whatever is selected — a saved prompt is a starting
   * point, not a lock — and an edit of a saved prompt runs without being saved.
   */
  it('still sends an unsaved edit of a saved prompt', async () => {
    const { user } = await openPanel();
    server.on(SUMMARISE, SUMMARY);

    await user.selectOptions(chooser(), 'Terse');
    await user.clear(box());
    await user.type(box(), 'Two sentences.');
    await user.click(screen.getByRole('button', { name: 'Go' }));

    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    expect(server.last(SUMMARISE).body).toMatchObject({ system_prompt: 'Two sentences.' });
    expect(server.count('/prompts/save')).toBe(0);
  });

  it('is not fetched until the drawer is opened', async () => {
    server.on('/info', info());
    server.on('/prompts', prompts());
    mount(<SummarisePanel topicId="rag-0009" />);
    expect(server.count('/prompts')).toBe(0);
  });
});

describe('an unsaved edit', () => {
  it('is announced, and is one press away from being undone', async () => {
    const { user } = await openPanel();
    expect(screen.queryByText(/^Edited/)).toBeNull();

    await user.selectOptions(chooser(), 'Terse');
    await user.type(box(), ' Really.');
    expect(screen.getByText(/not saved to Terse/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /reset the instruction/i }));
    expect(box()).toHaveValue('One sentence. No bullets.');
    expect(screen.queryByText(/not saved to Terse/)).toBeNull();
  });

  /** The one failure here that destroys work, so it is asked about. */
  it('is not thrown away by a change of selection without being asked', async () => {
    const { user } = await openPanel();
    await user.selectOptions(chooser(), 'Terse');
    await user.type(box(), ' Really.');

    await user.selectOptions(chooser(), 'What changed');
    expect(await screen.findByText(/Discard your unsaved changes\?/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(box()).toHaveValue('One sentence. No bullets. Really.');
    expect(chooser()).toHaveValue('Terse');
  });

  it('goes when the discard is confirmed', async () => {
    const { user } = await openPanel();
    await user.selectOptions(chooser(), 'Terse');
    await user.type(box(), ' Really.');
    await user.selectOptions(chooser(), 'What changed');
    await user.click(screen.getByRole('button', { name: 'Discard and switch' }));

    expect(chooser()).toHaveValue('What changed');
    expect(box()).toHaveValue('List only what changed, newest first.');
  });

  /** An unedited switch asks nothing — the dialog is for lost work, not habit. */
  it('does not interrupt a switch that would lose nothing', async () => {
    const { user } = await openPanel();
    await user.selectOptions(chooser(), 'Terse');
    expect(screen.queryByText(/Discard your unsaved changes\?/)).toBeNull();
    expect(box()).toHaveValue('One sentence. No bullets.');
  });
});

describe('Save', () => {
  it('writes the box over the selected prompt', async () => {
    const { user } = await openPanel();
    server.on('/prompts/save', { name: 'Terse', body: 'One sentence. Really.' });

    await user.selectOptions(chooser(), 'Terse');
    await user.clear(box());
    await user.type(box(), 'One sentence. Really.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(server.count('/prompts/save')).toBe(1));
    expect(server.last('/prompts/save').body).toEqual({
      name: 'Terse',
      body: 'One sentence. Really.',
    });
    // The edit is now the saved version, so the marker goes.
    await waitFor(() => expect(screen.queryByText(/not saved to Terse/)).toBeNull());
  });

  /**
   * **The built-in has nowhere to be written.** It is a constant on the server,
   * not a file, so Save asks for a name instead of failing or — much worse —
   * quietly overwriting a saved prompt that happened to be nearby.
   */
  it('asks for a name when the built-in is selected, rather than overwriting anything', async () => {
    const { user } = await openPanel();
    await user.clear(box());
    await user.type(box(), 'Be blunt.');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(server.count('/prompts/save')).toBe(0);
  });

  it('adds the new prompt to the chooser and selects it', async () => {
    const { user } = await openPanel();
    server.on('/prompts/save', { name: 'Blunt', body: 'Be blunt.' });

    await user.clear(box());
    await user.type(box(), 'Be blunt.');
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(await screen.findByLabelText('Name'), 'Blunt');
    await user.click(screen.getByRole('button', { name: 'Save it' }));

    await waitFor(() => expect(server.count('/prompts/save')).toBe(1));
    expect(server.last('/prompts/save').body).toEqual({ name: 'Blunt', body: 'Be blunt.' });
    await waitFor(() => expect(chooser()).toHaveValue('Blunt'));
    expect(
      within(chooser())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([BUILT_IN_LABEL, 'Blunt', 'Terse', 'What changed']);
  });

  it('says plainly when a name is about to replace an existing prompt', async () => {
    const { user } = await openPanel();
    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(await screen.findByLabelText('Name'), 'Terse');
    expect(screen.getByText(/already exists and will be replaced/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replace it' })).toBeInTheDocument();
  });

  /**
   * **A name that could be a path never leaves the browser.** The server is the
   * real barrier (`crates/serve/src/prompts.rs`), and this is the assertion
   * that the client is not leaning on it.
   */
  it('refuses a name that is not a name, without sending anything', async () => {
    const { user } = await openPanel();
    const field = await (async () => {
      await user.click(screen.getByRole('button', { name: 'New' }));
      return screen.findByLabelText('Name');
    })();

    for (const hostile of ['../escape', 'sub/dir', '..', 'name.md', 'has%2fescape']) {
      await user.clear(field);
      await user.type(field, hostile);
      await user.click(screen.getByRole('button', { name: 'Save it' }));
      expect(server.count('/prompts/save')).toBe(0);
      expect(screen.getByText(/may hold only letters, digits, spaces/)).toBeInTheDocument();
    }
  });

  it('shows the server’s own words when it refuses a name anyway', async () => {
    const { user } = await openPanel();
    server.on('/prompts/save', { error: 'a prompt name may not be a path (got "x")' }, 400);

    await user.click(screen.getByRole('button', { name: 'New' }));
    await user.type(await screen.findByLabelText('Name'), 'Blunt');
    await user.click(screen.getByRole('button', { name: 'Save it' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('a prompt name may not be a path');
  });
});

describe('Delete', () => {
  /** Not disabled — absent. The built-in is not a file, so there is nothing to delete. */
  it('is not offered for the built-in', async () => {
    const { user } = await openPanel();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    await user.selectOptions(chooser(), 'Terse');
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('confirms, then removes the prompt and falls back to the built-in', async () => {
    const { user } = await openPanel();
    server.on('/prompts/delete', { name: 'Terse', deleted: true });

    await user.selectOptions(chooser(), 'Terse');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText(/Delete the prompt/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete it' }));

    await waitFor(() => expect(server.count('/prompts/delete')).toBe(1));
    expect(server.last('/prompts/delete').body).toEqual({ name: 'Terse' });
    await waitFor(() => expect(chooser()).toHaveValue(''));
    expect(box()).toHaveValue(DEFAULT_PROMPT);
    expect(
      within(chooser())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([BUILT_IN_LABEL, 'What changed']);
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const { user } = await openPanel();
    await user.selectOptions(chooser(), 'Terse');
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(server.count('/prompts/delete')).toBe(0);
    expect(chooser()).toHaveValue('Terse');
  });
});

describe('a server with no prompts directory', () => {
  /**
   * A valid deployment, not a fault: the built-in needs no library, so the
   * drawer says what is missing and stays entirely usable.
   */
  it('says so, offers no writes, and still runs the built-in', async () => {
    const { user } = await openPanel(prompts({ configured: false, prompts: [] }));
    server.on(SUMMARISE, SUMMARY);

    expect(screen.getByText(NO_LIBRARY)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(
      within(chooser())
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([BUILT_IN_LABEL]);

    await user.clear(box());
    await user.type(box(), 'Be blunt.');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    await waitFor(() => expect(server.count(SUMMARISE)).toBe(1));
    expect(server.last(SUMMARISE).body).toMatchObject({ system_prompt: 'Be blunt.' });
  });

  it('draws a failed listing as a failure rather than as an empty library', async () => {
    const user = userEvent.setup();
    server.on('/info', info());
    server.on('/prompts', { error: 'could not read the prompts directory' }, 500);
    mount(<SummarisePanel topicId="rag-0009" />);
    await user.click(screen.getByRole('button', { name: /summarise/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The saved prompts could not be read.',
    );
    expect(screen.queryByText(NO_LIBRARY)).toBeNull();
    // The instruction box is still there, still prefilled, still runnable.
    expect(box()).toHaveValue(DEFAULT_PROMPT);
  });
});

/** The library fixture is a description of the server, so it has to be one. */
describe('the fixture', () => {
  it('never lists the built-in as a saved prompt', () => {
    expect(PROMPTS.map((prompt) => prompt.name)).not.toContain(BUILT_IN_LABEL);
    expect(PROMPTS.every((prompt) => prompt.name.trim() !== '')).toBe(true);
  });
});
