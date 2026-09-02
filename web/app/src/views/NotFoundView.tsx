import { Card, EmptyState } from '@rag/ui';

import { OpenTopic } from '../ledger/OpenTopic';
import styles from './notfound.module.css';

/**
 * An address this application does not serve.
 *
 * It offers a topic-id box rather than only a link home, because the way a
 * reader arrives here is almost always a mistyped or truncated id pasted out of
 * a chat log — so the useful thing to hand them is the field that fixes it.
 *
 * The box is `OpenTopic`, the same component the top bar carries, and that is
 * deliberate: this page used to hold its own copy of the "trim it and navigate"
 * logic, which is precisely the shape of the defect that stranded a topic once
 * already — one rule written down at one call site and not applied at the
 * others. It is focused here, because on this page it is the only thing the
 * reader wants.
 */
export function NotFoundView() {
  return (
    <Card>
      <EmptyState
        icon="circle-help"
        title="Nothing here"
        message="That address is not one of this viewer's pages."
      />
      <div className={styles.rescue}>
        <p className={styles.line}>
          Open a topic by id — the handle an agent quotes, like <code>demo-0001</code>.
        </p>
        <OpenTopic autoFocus />
      </div>
    </Card>
  );
}
