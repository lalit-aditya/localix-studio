import { constants, type Stats } from 'node:fs'
import { access, stat } from 'node:fs/promises'

import { ConflictError } from '../../lib/domain-errors'

/**
 * Whether a project's folder is still where the project says it is.
 *
 * A folder goes away in ordinary life: it is renamed or moved, its disk is unplugged, a worktree is
 * deleted. Every consumer that WORKS in the folder (the file tree, file reads and writes, search,
 * the terminal, a chat turn, the live watcher, the language server) asks here first and refuses with
 * the one error below, so the person meets the same words everywhere instead of `ENOENT
 * posix_spawn '/bin/zsh'` in one place and a 404 in another. A consumer that only needs the path as
 * a key (the ownership check, discovery of settings and plugins) does not ask: a missing folder has
 * no project files, which is the truthful answer there.
 *
 * Nothing is cached about a folder being gone. Each question stats the disk again. A PROJECT whose
 * folder is gone is deleted with its chats (`folder-gone.ts`); this refusal is what the folders
 * that are not a project's own say (a chat sandbox, a workflow worktree).
 */
export type WorkspaceFolderState = 'present' | 'missing' | 'not_a_directory' | 'unreadable'

const REFUSAL: Record<Exclude<WorkspaceFolderState, 'present'>, { code: string; says: string }> = {
  missing: {
    code: 'workspace_folder_missing',
    says: 'The project folder was moved, renamed or deleted',
  },
  not_a_directory: {
    code: 'workspace_folder_not_a_directory',
    says: 'The project path is a file, not a folder',
  },
  unreadable: {
    code: 'workspace_folder_unreadable',
    says: 'Localix may not open the project folder',
  },
}

/**
 * The project's folder is not usable (HTTP 409).
 *
 * A conflict, not a 404: the session exists; what conflicts is the path it records and the disk.
 * `detail` is the recorded path.
 */
export class WorkspaceFolderUnavailableError extends ConflictError {
  readonly state: Exclude<WorkspaceFolderState, 'present'>

  constructor(state: Exclude<WorkspaceFolderState, 'present'>, dir: string) {
    super(REFUSAL[state].code, `${REFUSAL[state].says}: ${dir}`, dir)
    this.state = state
  }
}

const denied = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === 'EACCES' || code === 'EPERM'
}

/** Stat the folder (following a symlink: a link to a missing target is missing). */
export async function workspaceFolderState(dir: string): Promise<WorkspaceFolderState> {
  let info: Stats
  try {
    info = await stat(dir)
  } catch (error) {
    return denied(error) ? 'unreadable' : 'missing'
  }
  if (!info.isDirectory()) return 'not_a_directory'
  try {
    await access(dir, constants.R_OK | constants.X_OK)
  } catch {
    return 'unreadable'
  }
  return 'present'
}

/** Refuse to work in a folder that is not there; see {@link WorkspaceFolderUnavailableError}. */
export async function assertWorkspaceFolder(dir: string): Promise<void> {
  const state = await workspaceFolderState(dir)
  if (state !== 'present') throw new WorkspaceFolderUnavailableError(state, dir)
}
