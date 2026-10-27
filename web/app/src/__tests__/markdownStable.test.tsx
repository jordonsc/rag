/**
 * Rendered prose keeps its DOM across a parent's re-render (m04).
 *
 * React 19 compares `dangerouslySetInnerHTML` by object identity, so a fresh
 * `{ __html }` per render rewrote the whole subtree whenever the parent
 * rendered: a link the reader was pressing was replaced before the click
 * landed, and a selection was lost. Found on the document page, where the
 * record arrives a moment after the body.
 */

import { render } from '@testing-library/react';

import { Markdown } from '../markdown/Markdown';

it('keeps the same nodes when the parent re-renders with the same source', () => {
  const view = render(
    <div data-tick="1">
      <Markdown source="See [a link](https://example.com)." />
    </div>,
  );
  const link = view.getByRole('link', { name: 'a link' });
  view.rerender(
    <div data-tick="2">
      <Markdown source="See [a link](https://example.com)." />
    </div>,
  );
  expect(link.isConnected).toBe(true);
  expect(view.getByRole('link', { name: 'a link' })).toBe(link);
});

it('still replaces the nodes when the source changes', () => {
  const view = render(<Markdown source="First." />);
  view.rerender(<Markdown source="Second." />);
  expect(view.getByText('Second.')).toBeInTheDocument();
  expect(view.queryByText('First.')).not.toBeInTheDocument();
});
