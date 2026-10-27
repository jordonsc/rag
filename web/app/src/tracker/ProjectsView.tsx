import { useEffect, useState } from 'react';
import { Button, Card, EmptyState, ErrorState, Form, Icon, Input, Spinner } from '@rag/ui';
import { Link, useNavigate } from 'react-router';

import { asApiError, isAbort, type LedgerApiError } from '../api';
import { isProjectName, listProjects, PROJECT_NAME_ERROR } from './api';
import { projectPath } from './paths';
import { summary } from './ProjectPicker';
import styles from './tracker.module.css';
import type { ProjectSummary } from './types';

type Loaded =
  | { kind: 'loading' }
  | { kind: 'ready'; projects: ProjectSummary[] }
  | { kind: 'error'; error: LedgerApiError };

/**
 * `/projects`: every project the tracker knows, with what is waiting in each,
 * and a box to open one by name — including one with nothing in it yet, whose
 * first item will create it (D2).
 */
export function ProjectsView() {
  const navigate = useNavigate();
  const [loaded, setLoaded] = useState<Loaded>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [name, setName] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoaded({ kind: 'loading' });
    listProjects(controller.signal)
      .then((response) => setLoaded({ kind: 'ready', projects: response.projects }))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          setLoaded({ kind: 'error', error: asApiError(error) });
        }
      });
    return () => controller.abort();
  }, [attempt]);

  const trimmed = name.trim();
  const valid = isProjectName(trimmed);
  const open = () => {
    setTouched(true);
    if (valid) {
      navigate(projectPath(trimmed));
    }
  };

  return (
    <div className={styles.view}>
      <header className={styles.head}>
        <div className={styles.headTitle}>
          <Icon name="list-todo" size={18} />
          <h1 className={styles.title}>Projects</h1>
        </div>
        <Form onSubmit={open}>
          <div className={styles.openProject}>
            <Input
              value={name}
              onChange={setName}
              placeholder="Project name"
              aria-label="Open a project by name"
              invalid={touched && !valid}
            />
            <Button type="submit">Open</Button>
          </div>
        </Form>
      </header>
      {touched && !valid && trimmed !== '' && (
        <p className={styles.fieldError} role="alert">
          {PROJECT_NAME_ERROR}
        </p>
      )}

      {loaded.kind === 'loading' && (
        <div className={styles.loading}>
          <Spinner size={18} />
          <span>Loading projects…</span>
        </div>
      )}
      {loaded.kind === 'error' && (
        <Card>
          <ErrorState
            message="Could not list the projects."
            detail={loaded.error.message}
            onRetry={() => setAttempt((n) => n + 1)}
          />
        </Card>
      )}
      {loaded.kind === 'ready' &&
        (loaded.projects.length === 0 ? (
          <Card>
            <EmptyState
              icon="list-todo"
              title="No projects yet"
              message="A project is created by its first write. Open one by name above and add an item."
            />
          </Card>
        ) : (
          <ul className={styles.projects}>
            {loaded.projects.map((project) => (
              <li key={project.name}>
                <Link to={projectPath(project.name)} className={styles.projectCard}>
                  <span className={styles.projectName}>{project.name}</span>
                  <span className={styles.projectCounts}>{summary(project)}</span>
                </Link>
              </li>
            ))}
          </ul>
        ))}
    </div>
  );
}
