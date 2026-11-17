import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { registerDom } from '@localixai/kit/testing/dom'
import { backendClient } from '@/shared/api/client'
import type { DirListing } from '@/shared/api/contracts'
import { ApiError } from '@/shared/api/failure'
import { toast } from '@/shared/lib/notify'
import { useFileTree } from './useFileTree'

let teardown: () => Promise<void>
beforeAll(() => {
  teardown = registerDom()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
  await teardown()
})
afterEach(() => mock.restore())

const gone = () =>
  new ApiError(
    'The project folder is gone, so the project and its chats were removed: /w/kit',
    404,
    'session_not_found',
    '/w/kit',
  )
const listing = (names: string[]): DirListing => ({
  path: '/w/kit',
  entries: names.map((name) => ({ name, type: 'file' })),
})

async function mountTree() {
  const React = await import('react')
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(document.createElement('div'))
  let current: ReturnType<typeof useFileTree> | null = null
  function Tree() {
    const value = useFileTree('gone-tree', { refreshDelayMs: 0 })
    React.useEffect(() => {
      current = value
    })
    return null
  }
  await React.act(async () => {
    root.render(<Tree />)
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  return {
    act: React.act,
    get current() {
      if (!current) throw new Error('tree did not mount')
      return current
    },
    unmount: () => React.act(async () => root.unmount()),
  }
}

// A chat whose project's folder went away is gone with its project: the server deletes the project
// and the roster drops the chat on the next poke. Its tree has nothing to say meanwhile, so it says
// nothing: no problem line, no toast.
describe('the tree of a chat that is gone', () => {
  test('a gone chat is not a problem to report', async () => {
    spyOn(backendClient, 'listDirectory').mockRejectedValue(gone())
    const tree = await mountTree()
    try {
      expect(tree.current.problem).toBeNull()
    } finally {
      await tree.unmount()
    }
  })

  test('the chat going away under a loaded tree raises no toast on the next re-list', async () => {
    const list = spyOn(backendClient, 'listDirectory').mockResolvedValue(listing(['a.txt']))
    const errors = spyOn(toast, 'error')
    const tree = await mountTree()
    try {
      list.mockRejectedValue(gone())
      await tree.act(async () => {
        await tree.current.reloadDir('')
      })
      expect(errors).not.toHaveBeenCalled()
    } finally {
      await tree.unmount()
    }
  })

  test('any other failure stays a problem line', async () => {
    spyOn(backendClient, 'listDirectory').mockRejectedValue(new ApiError('boom', 500, 'internal'))
    const tree = await mountTree()
    try {
      expect(tree.current.problem).not.toBeNull()
    } finally {
      await tree.unmount()
    }
  })
})
