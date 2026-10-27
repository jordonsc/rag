import { useEffect, useState } from 'react';
import { Select } from '@rag/ui';
import { useNavigate } from 'react-router';

import { isAbort } from '../api';
import { listProjects } from './api';
import { PROJECTS_PATH, projectPath } from './paths';
import type { ProjectSummary } from './types';

const ALL = '';

/**
 * The project picker at the top of the dashboard (D14, TD-02): the projects
 * the server knows, by name, with what is waiting in each.
 *
 * The current project is always an option, even before its first write has
 * created it on the server, so the control never displays a project it is not
 * showing. The empty choice goes to the project list.
 */
export function ProjectPicker({ current }: { current: string }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    listProjects(controller.signal)
      .then((response) => setProjects(response.projects))
      .catch((error: unknown) => {
        if (!isAbort(error)) {
          // The picker is a convenience: without the list it offers the
          // project in hand and the way back to all of them.
          setProjects([]);
        }
      });
    return () => controller.abort();
  }, []);

  const known = projects ?? [];
  const options = [
    { value: ALL, label: 'All projects' },
    ...known.map((project) => ({ value: project.name, label: project.name })),
    ...(known.some((project) => project.name === current)
      ? []
      : [{ value: current, label: current }]),
  ];

  return (
    <Select
      value={current}
      onChange={(value) => navigate(value === ALL ? PROJECTS_PATH : projectPath(value))}
      options={options}
      aria-label="Project"
    />
  );
}

export function summary(project: ProjectSummary): string {
  const parts = [`${project.queued} queued`];
  if ((project.review ?? 0) > 0) {
    parts.push(`${project.review} in review`);
  }
  if (project.blocked > 0) {
    parts.push(`${project.blocked} blocked`);
  }
  if ((project.deferred ?? 0) > 0) {
    parts.push(`${project.deferred} deferred`);
  }
  if (project.done_unacknowledged > 0) {
    parts.push(`${project.done_unacknowledged} done`);
  }
  return parts.join(' · ');
}
