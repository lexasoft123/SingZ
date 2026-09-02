import { NativeModules } from 'react-native';
import type { ProjectDoc } from './model';

/** The narrow file surface needed by the shared project.json transaction. */
export interface ProjectDocumentApi {
  readonly readText: (project: string, file: string) => Promise<string>;
  readonly writeText: (
    project: string,
    file: string,
    text: string,
  ) => Promise<boolean>;
}

interface FolderAccessProjectDocumentApi {
  readText(project: string, file: string): Promise<string>;
  writeText(project: string, file: string, text: string): Promise<boolean>;
}

const Folder = NativeModules.FolderAccess as FolderAccessProjectDocumentApi;
const nativeApi: ProjectDocumentApi = {
  readText: (project, file) => Folder.readText(project, file),
  writeText: (project, file, text) => Folder.writeText(project, file, text),
};

/** One completion tail per phone-owned project. Rejections never poison the
 * next mutation; the caller still receives its own failure. */
const tails = new Map<string, Promise<void>>();

/**
 * Atomically, from JS writers' point of view, re-read and replace one phone
 * project document. Every writer supplies only its field merge. Because the
 * read happens after the preceding writer's atomic native rename completes,
 * an analysis landing between a metronome tap's read and write cannot be
 * overwritten by the older snapshot.
 *
 * Returning null is a guarded no-op (used when analysis discovers that the
 * stems changed while it was running). This queue intentionally covers the
 * app-owned Documents library only. Picked folders are not writable through
 * this API on Android SAF and use strict local overrides instead.
 */
export function mutateProjectDocument(
  project: string,
  mutate: (
    current: ProjectDoc,
  ) => ProjectDoc | null | Promise<ProjectDoc | null>,
  api: ProjectDocumentApi = nativeApi,
): Promise<ProjectDoc | null> {
  const previous = tails.get(project) ?? Promise.resolve();
  const operation = previous
    .catch(() => undefined)
    .then(async () => {
      const current = parseProject(await api.readText(project, 'project.json'));
      const next = await mutate(current);
      if (next === null) return null;
      const written = await api.writeText(
        project,
        'project.json',
        JSON.stringify(next, null, 2),
      );
      if (!written) throw new Error('Project document was not written.');
      return next;
    });
  const tail = operation.then(
    () => undefined,
    () => undefined,
  );
  tails.set(project, tail);
  tail.finally(() => {
    if (tails.get(project) === tail) tails.delete(project);
  });
  return operation;
}

function parseProject(text: string): ProjectDoc {
  const raw = JSON.parse(text) as unknown;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
    throw new RangeError('Project document is invalid.');
  const doc = raw as ProjectDoc;
  if (
    doc.settings === null ||
    typeof doc.settings !== 'object' ||
    Array.isArray(doc.settings)
  )
    throw new RangeError('Project settings are invalid.');
  return doc;
}
