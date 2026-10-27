/**
 * The tracker in the shell (specs/tracker m03, TD-02): its routes under
 * `/projects`, the Tracker destination in the bar going to the last project
 * used, the project list, and the picker.
 */

import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { App } from '../App';
import { mount } from './harness';
import { TrackerServer, queueRoute, queueView } from './trackerFixtures';

const PROJECTS = {
  projects: [
    {
      name: 'demo',
      created_at: '2026-01-01T00:00:00Z',
      queued: 6,
      blocked: 1,
      done_unacknowledged: 2,
    },
    {
      name: 'other',
      created_at: '2026-01-01T00:00:00Z',
      queued: 0,
      blocked: 0,
      done_unacknowledged: 0,
    },
  ],
};

let server: TrackerServer;

beforeEach(() => {
  server = new TrackerServer();
  server.on('/tracker/projects', { body: PROJECTS });
  server.on(
    /^\/tracker\/(demo|other)$/,
    queueRoute(() => queueView()),
  );
  server.install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the tracker in the shell', () => {
  it('goes to the project list from the bar when no project was used yet', async () => {
    const user = userEvent.setup();
    mount(<App />);
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Tracker' }),
    );
    expect(screen.getByTestId('address')).toHaveTextContent('/projects');
    expect(
      await screen.findByRole('link', { name: /demo.*6 queued · 1 blocked · 2 done/ }),
    ).toHaveAttribute('href', '/projects/demo');
  });

  it('goes to the last project used, remembered in this browser', async () => {
    const user = userEvent.setup();
    mount(<App />);
    window.localStorage.setItem('rag.tracker.project', 'demo');
    await user.click(
      within(screen.getByRole('navigation')).getByRole('button', { name: 'Tracker' }),
    );
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/demo');
    expect(await screen.findByRole('heading', { name: 'demo' })).toBeInTheDocument();
  });

  it('names the section in the bar and leaves the ledger’s New topic to the ledger', async () => {
    mount(<App />, { route: '/projects/demo' });
    await screen.findByRole('heading', { name: 'demo' });
    // The brand says Tracker here (and Ledger on the ledger's pages).
    expect(screen.queryByText('Ledger', { selector: 'span' })).toBeNull();
    expect(screen.getAllByText('Tracker', { selector: 'span' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'New topic' })).toBeNull();
    expect(screen.queryByLabelText('Open a topic by id')).toBeNull();
  });

  it('switches project from the picker', async () => {
    const user = userEvent.setup();
    mount(<App />, { route: '/projects/demo' });
    await screen.findByRole('heading', { name: 'demo' });
    const picker = screen.getByRole('combobox', { name: 'Project' });
    await waitFor(() => expect(within(picker).getAllByRole('option')).toHaveLength(3));

    await user.selectOptions(picker, 'other');
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/other');
  });

  it('opens a project by name from the list, refusing one the server would refuse', async () => {
    const user = userEvent.setup();
    mount(<App />, { route: '/projects' });
    const box = await screen.findByLabelText('Open a project by name');

    await user.type(box, 'items{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent(/A project is a repository name/);
    expect(screen.getByTestId('address')).toHaveTextContent('/projects');

    await user.clear(box);
    await user.type(box, 'fresh-project{Enter}');
    expect(screen.getByTestId('address')).toHaveTextContent('/projects/fresh-project');
  });
});
