/**
 * SESSION RESIDUE — a reactor on the core change feed.
 *
 * Deleting a chat is a command (its runs are stopped first, then the subtree's rows go in one
 * transaction, each id announced `deleted`). What outlives the rows is cleaned here, per deleted
 * id, so a sub-session's residue goes too — the deletion used to reap only the root's:
 *
 *   - its monitors (live watch processes) and loops (the engine's in-memory read model; the
 *     trigger rows went with the foreign key);
 *   - its Event Center rows, which no foreign key reaches;
 *   - its scratch directory, `~/.localix/workspace/<id>`, unless a project lives there.
 *
 * A deleted PROJECT takes its chats away too (a person removed it, or its folder is gone,
 * `projects/folder-gone.ts`): connected clients are told its chats are deleted, so an open one
 * closes, and their monitors and loops stop. Nothing else of theirs is removed: the delete is soft,
 * and opening the project's folder again brings the project and its chats back.
 *
 * Every step is idempotent, so a duplicate notice does nothing. The reconcile removes inbox rows
 * of chats that no longer exist (a notice lost while down).
 */
import { rm } from 'node:fs/promises'
import path from 'node:path'
import type { ConsumerHandlers } from '@localixai/change-feed'

import { localixHome } from '../../lib/env'
import type { CoreCascades, CoreRefs } from '../changes/core-entities'

export interface SessionResiduePorts {
  stopMonitors(sessionId: string): void
  cancelLoops(sessionId: string): Promise<void> | void
  forgetNotifications(userId: string, sessionId: string): void
  /** Working dirs of the user's projects: a scratch dir that is one is never removed. */
  projectDirs(userId: string): Promise<readonly string[]>
  /** Sessions the inbox still has rows for, and which of them still exist. */
  inboxSessions(): Promise<ReadonlyArray<{ userId: string; sessionId: string }>>
  sessionExists(userId: string, sessionId: string): Promise<boolean>
  /** Every chat filed under a project, sub-sessions included, whether or not it is deleted. */
  projectSessions(userId: string, projectId: string): Promise<readonly string[]>
  /** Tell connected clients these chats are gone (`session.deleted` on the stream). */
  sessionsGone(userId: string, sessionIds: readonly string[]): void
  /** Where scratch directories live (tests). */
  workspaceDir?: string
}

export function createSessionResidue(ports: SessionResiduePorts) {
  const workspace = ports.workspaceDir ?? path.join(localixHome(), 'workspace')

  async function discardSandbox(userId: string, sessionId: string): Promise<void> {
    const dir = path.join(workspace, sessionId)
    if (path.dirname(dir) !== workspace) return
    const projects = (await ports.projectDirs(userId)).map((p) => path.resolve(p))
    if (projects.includes(path.resolve(dir))) return
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }

  async function deleted(userId: string, sessionId: string): Promise<void> {
    ports.stopMonitors(sessionId)
    await ports.cancelLoops(sessionId)
    ports.forgetNotifications(userId, sessionId)
    await discardSandbox(userId, sessionId)
  }

  async function projectDeleted(userId: string, projectId: string): Promise<void> {
    const sessionIds = await ports.projectSessions(userId, projectId)
    for (const sessionId of sessionIds) {
      ports.stopMonitors(sessionId)
      await ports.cancelLoops(sessionId)
    }
    if (sessionIds.length > 0) ports.sessionsGone(userId, sessionIds)
  }

  async function reconcile(): Promise<void> {
    for (const { userId, sessionId } of await ports.inboxSessions())
      if (!(await ports.sessionExists(userId, sessionId)))
        ports.forgetNotifications(userId, sessionId)
  }

  const handlers: ConsumerHandlers<CoreRefs, CoreCascades> = {
    'chat.session': (change) =>
      change.op === 'deleted' ? deleted(change.ref.userId, change.ref.id) : undefined,
    'chat.message': 'ignore',
    skill: 'ignore',
    plugin: 'ignore',
    'mini-app': 'ignore',
    'mini-app.marketplace': 'ignore',
    'mini-app.updates': 'ignore',
    mcp: 'ignore',
    agent: 'ignore',
    'capability.rule': 'ignore',
    project: (change) =>
      change.op === 'deleted' ? projectDeleted(change.ref.userId, change.ref.id) : undefined,
    'local.model': 'ignore',
    'project.settings': 'ignore',
    'user.profile': 'ignore',
    'user.agent-settings': 'ignore',
    'user.view-state': 'ignore',
    secret: 'ignore',
    'system.toggle': 'ignore',
    'provider.connection': 'ignore',
  }
  return { handlers, reconcile, deleted }
}
