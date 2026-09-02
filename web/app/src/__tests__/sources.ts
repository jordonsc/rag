/**
 * Reading the application's own source, for the handful of guarantees that are
 * properties of the *codebase* rather than of any one function.
 *
 * They are the invariants a reviewer would otherwise have to remember: exactly
 * one `dangerouslySetInnerHTML`, no write path that names the author fields for
 * itself, one module that builds a topic route, one module that spells the repo
 * charset. None can be caught by exercising the code, because in every case the
 * failure is a *new* line appearing somewhere else — which is exactly how the
 * unencoded-route defect got in, with four call sites copying a fifth that had
 * the rule written above it.
 *
 * A helper rather than three copies of a directory walk.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The application source root — `app/src`. */
export const SRC = resolve(__dirname, '..');

/** Every `.ts`/`.tsx` file under the source root, tests excluded. */
export function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__tests__' ? [] : sourceFiles(path);
    }
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

export function read(path: string): string {
  return readFileSync(path, 'utf8');
}

/** The files whose text matches, named relative to the source root. */
export function matching(pattern: RegExp): string[] {
  return sourceFiles()
    .filter((path) => pattern.test(read(path)))
    .map((path) => path.slice(SRC.length + 1));
}
