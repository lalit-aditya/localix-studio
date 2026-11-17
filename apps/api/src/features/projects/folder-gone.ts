import { NotFoundError } from '../../lib/domain-errors'
import { isDefaultProject } from './default-project'
import type { createProjectsRepository, ProjectRecord } from './repository'
import { workspaceFolderState } from './workspace-folder'

/**
 * A project whose folder is not there any more is deleted, with its chats.
 *
 * No guessing where the folder went and no re-pointing: a folder that was moved, renamed, deleted,
 * unplugged or made unreadable ends the project, the same soft delete as "Remove project". Its
 * rows stay, so opening the same folder again (`resolveProjectByPath`) brings the project and its
 * chats back. The default project is never deleted: its folder is the parent of chat sandboxes,
 * which are made on demand.
 *
 * Asked wherever the server meets a project anyway (the project list, and `requireSession`, the
 * gate of every chat request), so it costs one `stat` and needs no timer.
 *
 * @returns true when the project is gone (deleted now, or before).
 */
export async function forgetProjectIfFolderGone(
  repo: Pick<ReturnType<typeof createProjectsRepository>, 'deleteProject'>,
  project: ProjectRecord,
  at: string,
): Promise<boolean> {
  if (project.deletedAt) return true
  if (isDefaultProject(project)) return false
  if ((await workspaceFolderState(project.workingDir)) === 'present') return false
  await repo.deleteProject(project.userId, project.id, at)
  return true
}

/**
 * What a chat request hears once its project's folder is gone: the chat does not exist (404
 * `session_not_found`, as it will on every later request), and why. A turn that meets it says
 * these words too (`classify-run-error.ts`).
 */
export class ProjectFolderGoneError extends NotFoundError {
  constructor(dir: string) {
    super(
      'session_not_found',
      `The project folder is gone, so the project and its chats were removed: ${dir}`,
      dir,
    )
  }
}

/** {@link forgetProjectIfFolderGone}, refusing with {@link ProjectFolderGoneError} when gone. */
export async function assertProjectFolder(
  repo: Pick<ReturnType<typeof createProjectsRepository>, 'deleteProject'>,
  project: ProjectRecord | null | undefined,
  at: string,
): Promise<void> {
  if (project && (await forgetProjectIfFolderGone(repo, project, at)))
    throw new ProjectFolderGoneError(project.workingDir)
}
