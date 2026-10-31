/**
 * **New concept** (m04, TC-01), `/projects/<project>/docs/new`: a title, a
 * slug (filled from the title until the reader types one) and the first text,
 * in the same editor as every other document, pasted images included.
 *
 * A page rather than a dialog, because a concept is where the owner writes at
 * length: it needs the editor's room, its preview and its unsaved text. The
 * title and slug are kept beside the body's unsaved text, so a reload half-way
 * through a new concept loses nothing either.
 *
 * **Save as draft** (2026-10-30) creates it as a draft: the feed leaves its
 * changes out until it is published from its page. Ctrl+S is Create concept.
 */

import { useEffect, useRef, useState } from 'react';
import { Button, Card, ConfirmDialog, ErrorState, Field, Icon, Input } from '@rag/ui';
import { Link, useNavigate, useParams } from 'react-router';

import { createConcept, isProjectName, PROJECT_NAME_ERROR } from './api';
import { DocEditor } from './DocEditor';
import styles from './docs.module.css';
import { clearDraft, draftKey, readDraft, writeDraft } from './drafts';
import { docPath, docsPath, isSlug, slugify } from './paths';
import frame from './tracker.module.css';
import type { Concept } from './types';

export function NewConceptView() {
  const { project = '' } = useParams();
  if (!isProjectName(project)) {
    return (
      <Card>
        <ErrorState message={`“${project}” is not a project name.`} detail={PROJECT_NAME_ERROR} />
      </Card>
    );
  }
  return <NewConcept key={project} project={project} />;
}

interface Meta {
  title: string;
  slug: string;
  /** Whether the reader typed the slug (it then stops following the title). */
  typed: boolean;
}

function readMeta(key: string): Meta {
  const extra = readDraft(key)?.extra;
  return {
    title: typeof extra?.title === 'string' ? extra.title : '',
    slug: typeof extra?.slug === 'string' ? extra.slug : '',
    typed: extra?.typed === 'yes',
  };
}

function NewConcept({ project }: { project: string }) {
  const navigate = useNavigate();
  const bodyKey = draftKey(project, 'new-concept');
  const metaKey = draftKey(project, 'new-concept:meta');
  const [meta, setMeta] = useState<Meta>(() => readMeta(metaKey));
  const [generation, setGeneration] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const created = useRef<Concept | null>(null);

  const slug = meta.typed ? meta.slug : slugify(meta.title);

  useEffect(() => {
    if (created.current !== null) {
      return;
    }
    if (meta.title.trim() === '' && (!meta.typed || meta.slug === '')) {
      clearDraft(metaKey);
      return;
    }
    writeDraft(metaKey, {
      body: '',
      base_revision: 0,
      message: '',
      saved_at: new Date().toISOString(),
      extra: { title: meta.title, slug: meta.slug, typed: meta.typed ? 'yes' : 'no' },
    });
  }, [meta, metaKey]);

  const blocked =
    meta.title.trim() === ''
      ? 'A concept needs a title.'
      : !isSlug(slug)
        ? 'The slug is lowercase letters, digits and dashes, starting with a letter or digit.'
        : undefined;

  const startOver = () => {
    clearDraft(metaKey);
    clearDraft(bodyKey);
    setMeta({ title: '', slug: '', typed: false });
    setGeneration((n) => n + 1);
    setConfirm(false);
  };

  return (
    <div className={frame.view}>
      <p className={styles.toolbarNote}>
        <Link to={docsPath(project)} className={styles.docMeta}>
          <Icon name="arrow-left" size={13} />
          {project} documents
        </Link>
      </p>
      <header className={frame.head}>
        <div className={frame.headTitle}>
          <Icon name="sparkles" size={18} />
          <h1 className={frame.title}>New concept</h1>
        </div>
        {(meta.title !== '' || meta.slug !== '') && (
          <Button size="sm" variant="ghost" onClick={() => setConfirm(true)}>
            Start over
          </Button>
        )}
      </header>

      <div className={styles.fields}>
        <Field label="Title">
          <Input
            value={meta.title}
            onChange={(title) => setMeta((current) => ({ ...current, title }))}
          />
        </Field>
        <Field
          label="Slug"
          help={`Its path: concepts/${slug === '' ? '…' : slug}.md`}
          error={slug !== '' && !isSlug(slug) ? 'Lowercase letters, digits and dashes.' : undefined}
        >
          <Input
            value={slug}
            onChange={(value) => setMeta((current) => ({ ...current, slug: value, typed: true }))}
            invalid={slug !== '' && !isSlug(slug)}
          />
        </Field>
      </div>

      <DocEditor
        key={generation}
        project={project}
        path={`concepts/${slug === '' ? 'new' : slug}.md`}
        storageKey={bodyKey}
        initial=""
        revision={0}
        requireChange={false}
        saveLabel="Create concept"
        offerDraft
        messageLabel="Note"
        {...(blocked === undefined ? {} : { blocked })}
        onSave={(body, _base, message, fields, asDraft) =>
          createConcept(
            project,
            {
              slug,
              title: meta.title.trim(),
              body,
              ...(message === '' ? {} : { note: message }),
              ...(asDraft ? { draft: true } : {}),
            },
            fields,
          ).then((concept) => {
            created.current = concept;
          })
        }
        onSaved={(stayed) => {
          clearDraft(metaKey);
          const concept = created.current;
          if (concept === null) {
            navigate(docsPath(project));
            return;
          }
          // Ctrl+S goes on editing, now in the document's own editor.
          navigate(`${docPath(project, concept.path)}${stayed ? '?tab=edit' : ''}`);
        }}
        onDiscard={() => clearDraft(metaKey)}
        onClose={() => navigate(docsPath(project))}
      />

      <ConfirmDialog
        open={confirm}
        title="Start over?"
        message="The title, the slug and the text are deleted. This cannot be undone."
        confirmLabel="Start over"
        danger
        onConfirm={startOver}
        onCancel={() => setConfirm(false)}
      />
    </div>
  );
}
