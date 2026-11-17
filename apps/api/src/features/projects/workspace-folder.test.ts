import { describe, expect, test } from 'bun:test'
import { chmod, mkdir, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tempDirPerTest } from '@localixai/testing'

import { assertWorkspaceFolder, workspaceFolderState } from './workspace-folder'

const temp = tempDirPerTest('workspace-folder-')

describe('workspace folder state', () => {
  test('a folder that is there, and one with spaces and unicode in its name, are present', async () => {
    const plain = join(temp(), 'app')
    const spaced = join(temp(), 'my proj ü 日本')
    await mkdir(plain)
    await mkdir(spaced)
    expect(await workspaceFolderState(plain)).toBe('present')
    expect(await workspaceFolderState(spaced)).toBe('present')
  })

  test('a renamed or deleted folder, and a symlink to a missing target, are missing', async () => {
    const dir = join(temp(), 'old')
    await mkdir(dir)
    await rename(dir, join(temp(), 'new'))
    const link = join(temp(), 'link')
    await symlink(join(temp(), 'nowhere'), link)
    expect(await workspaceFolderState(dir)).toBe('missing')
    expect(await workspaceFolderState(link)).toBe('missing')
  })

  test('a file where the folder was is not a directory', async () => {
    const file = join(temp(), 'file')
    await writeFile(file, 'x')
    expect(await workspaceFolderState(file)).toBe('not_a_directory')
  })

  test.skipIf(process.getuid?.() === 0)('a folder Localix may not open is unreadable', async () => {
    const locked = join(temp(), 'locked')
    await mkdir(locked)
    await chmod(locked, 0o000)
    try {
      expect(await workspaceFolderState(locked)).toBe('unreadable')
    } finally {
      await chmod(locked, 0o755)
    }
  })

  test('the refusal is a 409 conflict naming the state and the path, not a 404', async () => {
    const gone = join(temp(), 'gone')
    const refused = await assertWorkspaceFolder(gone).catch((e: unknown) => e)
    expect(refused).toMatchObject({
      status: 409,
      code: 'workspace_folder_missing',
      detail: gone,
    })
    const file = join(temp(), 'f')
    await writeFile(file, '')
    expect(await assertWorkspaceFolder(file).catch((e: unknown) => e)).toMatchObject({
      status: 409,
      code: 'workspace_folder_not_a_directory',
    })
  })

  test('a folder that comes back is present again, nothing remembered as gone', async () => {
    const dir = join(temp(), 'flaky')
    expect(await workspaceFolderState(dir)).toBe('missing')
    await mkdir(dir)
    expect(await workspaceFolderState(dir)).toBe('present')
    await assertWorkspaceFolder(dir)
  })
})
