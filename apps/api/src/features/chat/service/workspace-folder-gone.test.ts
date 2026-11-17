import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { tempDirPerTest } from '@localixai/testing'

import { createDatabase, destroyDatabase } from '../../../db/connection'
import { migrateToLatest } from '../../../db/migrator'
import { createProviderConnectionsService } from '../../provider-connections/service'
import { createProjectsRepository } from '../../projects/repository'
import { createProjectsService } from '../../projects/service'
import { createChatRepository } from '../repository'
import {
  createTestCatalogService,
  createTestChatService,
  testChatFeaturePorts,
} from '../test-harness'
import { testWork } from '../../../testing/work-fixture'

/**
 * A project whose folder was renamed, moved or deleted on disk is gone: the project and every
 * chat in it disappear the first time anything asks for them, and nothing runs there. Opening
 * the same folder again brings the project and its chats back (the delete is soft).
 */
const temp = tempDirPerTest('folder-gone-')
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function projectChat() {
  const root = temp()
  const folder = join(root, 'claude-plugin-kit')
  await mkdir(folder)
  await writeFile(join(folder, 'a.txt'), 'hello')
  const db = createDatabase({ filename: join(root, `${randomUUID()}.sqlite`) })
  await migrateToLatest(db)
  cleanups.push(() => destroyDatabase(db))
  const userId = 'u-folder-gone'
  const now = new Date().toISOString()
  await createProjectsRepository(db).insertProject({
    id: 'PRJ-13',
    userId,
    name: 'claude-plugin-kit',
    workingDir: folder,
    settings: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  })
  const chat = createTestChatService({
    db,
    work: testWork(db),
    ports: testChatFeaturePorts(db),
    catalogService: createTestCatalogService(),
    providerConnectionsService: createProviderConnectionsService({ db }),
  })
  const session = await chat.createSession(userId, { title: 'Files', projectId: 'PRJ-13' })
  const projects = createProjectsService({ db })
  return { db, chat, projects, userId, sessionId: session.id, folder, root }
}

const gone = { status: 404, code: 'session_not_found' }

describe('a project folder that is gone', () => {
  test('the chat is gone: reading it answers 404 and the roster leaves it out', async () => {
    const { chat, userId, sessionId, folder, root } = await projectChat()
    expect((await chat.getSession(userId, sessionId)).id).toBe(sessionId)
    await rename(folder, join(root, 'moved'))

    expect(chat.getSession(userId, sessionId)).rejects.toMatchObject(gone)
    const { sessions } = await chat.listSessions(userId)
    expect(sessions.map((s) => s.id)).not.toContain(sessionId)
  })

  test('the project is removed, so the project list leaves it out', async () => {
    const { db, chat, projects, userId, sessionId, folder, root } = await projectChat()
    await rename(folder, join(root, 'moved'))
    await chat.getSession(userId, sessionId).catch(() => {})

    expect(
      (await createProjectsRepository(db).getProject(userId, 'PRJ-13'))?.deletedAt,
    ).toBeString()
    expect((await projects.listProjects(userId)).projects.map((p) => p.id)).not.toContain('PRJ-13')
  })

  test('the project list alone notices: no chat has to be opened first', async () => {
    const { chat, projects, userId, sessionId, folder, root } = await projectChat()
    await rename(folder, join(root, 'moved'))

    expect((await projects.listProjects(userId)).projects.map((p) => p.id)).not.toContain('PRJ-13')
    expect((await chat.listSessions(userId)).sessions.map((s) => s.id)).not.toContain(sessionId)
  })

  test('a message sent there is refused before it is saved, and no turn starts', async () => {
    const { db, chat, userId, sessionId, folder, root } = await projectChat()
    await rename(folder, join(root, 'moved'))

    expect(chat.sendMessage(userId, sessionId, 'hi!')).rejects.toMatchObject(gone)
    expect(await createChatRepository(db).listMessages(userId, sessionId)).toEqual([])
  })

  test('every file operation answers that the chat is gone', async () => {
    const { chat, userId, sessionId, folder, root } = await projectChat()
    await rename(folder, join(root, 'moved'))
    const refusals = await Promise.all(
      [
        chat.listDirectory(userId, sessionId),
        chat.readFile(userId, sessionId, 'a.txt'),
        chat.findFiles(userId, sessionId, 'a'),
        chat.resolveSessionWorkspaceDir(userId, sessionId),
        chat.resolveSessionCwd(userId, sessionId),
      ].map((call) =>
        call.then(
          () => null,
          (e: unknown) => e,
        ),
      ),
    )
    for (const refusal of refusals) expect(refusal).toMatchObject(gone)
  })

  test('opening the same folder again brings the project and its chats back', async () => {
    const { chat, projects, userId, sessionId, folder, root } = await projectChat()
    const moved = join(root, 'moved')
    await rename(folder, moved)
    await projects.listProjects(userId)

    await rename(moved, folder)
    const { project } = await projects.resolveProjectByPath(userId, folder)
    expect(project.id).toBe('PRJ-13')
    expect((await chat.getSession(userId, sessionId)).id).toBe(sessionId)
  })

  test('a file where the folder was is the same: the project is gone', async () => {
    const { chat, userId, sessionId, folder, root } = await projectChat()
    await rename(folder, join(root, 'moved'))
    await writeFile(folder, 'now a file')
    expect(chat.getSession(userId, sessionId)).rejects.toMatchObject(gone)
  })
})
