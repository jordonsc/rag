/**
 * The one place this application asks a model for anything.
 *
 * Everything else the viewer does is a read or a write of the ledger's own
 * records. This asks Anthropic to compress an entry, which makes it the only
 * surface here with three properties nothing else has: it costs money per
 * press, it is off unless the server was given a key, and what it renders is
 * text a model produced after reading unauthenticated input.
 */

export {
  NOT_CONFIGURED,
  NO_CACHE,
  SummarisePanel,
  type SummarisePanelProps,
} from './SummarisePanel';

export {
  BUILT_IN,
  BUILT_IN_LABEL,
  NO_LIBRARY,
  PromptChooser,
  type PromptChooserProps,
} from './PromptChooser';
