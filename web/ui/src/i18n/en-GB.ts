/**
 * The en-GB message catalogue — the only locale shipped today.
 *
 * Every user-visible string the design system draws for itself resolves
 * through here: a component names a key, never a literal. Application strings
 * belong to the application; this file holds what the components themselves
 * say when nobody has told them what to say.
 *
 * Adding a locale is translation work, not engineering: `I18nProvider` takes
 * `messages` overrides and a BCP 47 tag.
 */
export const enGB = {
  'common.loading': 'Loading…',
  'common.empty': 'Nothing to show',
  'common.error': 'Something went wrong',

  // A duration shorter than the smallest unit shown. Not "0s": zero is the one
  // reading that is certainly wrong, because the thing being measured happened.
  'format.duration.moment': 'Less than a second',

  'action.cancel': 'Cancel',
  'action.close': 'Close',
  'action.confirm': 'Confirm',
  'action.retry': 'Retry',
  'action.save': 'Save',

  'severity.info': 'Information',
  'severity.warning': 'Warning',
  'severity.critical': 'Critical',

  'table.empty': 'No entries',
  'table.sortBy': 'Sort by {column}',
  // A grouped table's header: how many rows are folded under it, and what the
  // disclosure does. The count is on the header because a collapsed group has
  // to say how much it is hiding.
  //
  // Two keys because this catalogue has no plural machinery — `useT`
  // interpolates `{param}` and stops there — so the renderer picks the string
  // from the count. The count is interpolated into both rather than written
  // into the singular one: a string that restates a number is a second copy of
  // it with nothing holding the two together.
  'table.group.member': '{count} entry',
  'table.group.members': '{count} entries',
  'table.group.expand': 'Show {group}',
  'table.group.collapse': 'Hide {group}',

  'secret.reveal': 'Reveal value',
  'secret.hide': 'Hide value',

  'chiplist.add': 'Add entry',
  'chiplist.remove': 'Remove {value}',

  'duration.unit': 'Unit',
  'duration.unit.ms': 'milliseconds',
  'duration.unit.s': 'seconds',
  'duration.unit.m': 'minutes',
  'duration.unit.h': 'hours',
  'duration.unit.d': 'days',

  // The lead option a `Select` draws when it holds nothing and the caller named
  // no placeholder. Neutral on purpose: it says the control is unanswered
  // without claiming which option is expected, which is the mistake the
  // browser's own first-option fallback makes.
  'select.choose': 'Choose…',

  'picker.search': 'Type to search…',
  // The name of the button that empties the search box, not an explanation of
  // it: it is an `IconButton` label, so it is both the accessible name and the
  // hover title.
  'picker.clearSearch': 'Clear the search',
  'picker.none': 'There is nothing to choose from yet',
  'picker.noMatch': 'Nothing matches',
  'picker.more': 'Showing {shown} of {total} — keep typing to narrow it',
  'picker.notOffered': 'no longer offered',

  'slider.unset': 'Not set',

  'dialog.close': 'Close dialogue',
  'drawer.close': 'Close drawer',
};

export type MessageKey = keyof typeof enGB;
export type Catalogue = Record<MessageKey, string>;
