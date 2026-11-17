import { afterAll, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createDatabase } from '../../db/connection'
import { migrateToLatest } from '../../db/migrator'
import { createCoreChangeFeed, recordCoreChanges } from '../changes/core-entities'
import { recordSessionChanges } from './session-changes'
import { createSessionResidue } from './session-residue'

const roots: string[] = []
afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true })
})

const exists = (dir: string) =>
  stat(dir).then(
    () => true,
    () => false,
  )

async function setup() {
  const workspace = await mkdtemp(path.join(tmpdir(), 'residue-'))
  roots.push(workspace)
  const log: string[] = []
  const live = new Set(['alive'])
  const residue = createSessionResidue({
    workspaceDir: workspace,
    stopMonitors: (id) => void log.push(`monitors:${id}`),
    cancelLoops: (id) => void log.push(`loops:${id}`),
    forgetNotifications: (_u, id) => void log.push(`inbox:${id}`),
    projectDirs: async () => [path.join(workspace, 'project-here')],
    inboxSessions: async () => [
      { userId: 'u1', sessionId: 'alive' },
      { userId: 'u1', sessionId: 'gone' },
    ],
    sessionExists: async (_u, id) => live.has(id),
    projectSessions: async (_u, projectId) => (projectId === 'PRJ-2' ? ['chat', 'worker'] : []),
    sessionsGone: (_u, ids) => void log.push(`gone:${ids.join(',')}`),
  })
  return { workspace, log, residue }
}

describe('session residue', () => {
  test('every id of a deleted tree loses its monitors, loops, inbox rows and scratch dir', async () => {
    const t = await setup()
    await mkdir(path.join(t.workspace, 'root'))
    await mkdir(path.join(t.workspace, 'project-here'))
    const db = createDatabase()
    await migrateToLatest(db)
    const feed = createCoreChangeFeed(db)
    await feed.subscribe('session-residue', t.residue.handlers, { kind: 'reactor' })
    await recordSessionChanges(db, 'u1', ['root', 'child'], 'deleted')
    // A duplicate delivery repeats harmless, idempotent steps.
    await recordSessionChanges(db, 'u1', ['root'], 'deleted')
    await feed.settle()
    expect(t.log).toEqual([
      'monitors:root',
      'loops:root',
      'inbox:root',
      'monitors:child',
      'loops:child',
      'inbox:child',
      'monitors:root',
      'loops:root',
      'inbox:root',
    ])
    expect(await exists(path.join(t.workspace, 'root'))).toBe(false)
    await t.residue.deleted('u1', 'project-here')
    // A project that lives where a scratch dir would is the person's: it stays.
    expect(await exists(path.join(t.workspace, 'project-here'))).toBe(true)
    await feed.close()
  })

  test('a deleted project takes its chats away: clients drop them, their monitors and loops stop', async () => {
    const t = await setup()
    await mkdir(path.join(t.workspace, 'chat'))
    const db = createDatabase()
    await migrateToLatest(db)
    const feed = createCoreChangeFeed(db)
    await feed.subscribe('session-residue', t.residue.handlers, { kind: 'reactor' })
    await recordCoreChanges(db, {
      entity: 'project',
      op: 'deleted',
      ref: { id: 'PRJ-2', userId: 'u1' },
    })
    await recordCoreChanges(db, {
      entity: 'project',
      op: 'upserted',
      ref: { id: 'PRJ-3', userId: 'u1' },
    })
    await feed.settle()
    expect(t.log).toEqual([
      'monitors:chat',
      'loops:chat',
      'monitors:worker',
      'loops:worker',
      'gone:chat,worker',
    ])
    // The delete is soft: the project's folder coming back brings its chats back, so nothing of
    // theirs on disk or in the inbox is removed.
    expect(await exists(path.join(t.workspace, 'chat'))).toBe(true)
    await feed.close()
  })

  test('the reconcile forgets inbox rows of chats that no longer exist', async () => {
    const t = await setup()
    await t.residue.reconcile()
    expect(t.log).toEqual(['inbox:gone'])
  })
})
