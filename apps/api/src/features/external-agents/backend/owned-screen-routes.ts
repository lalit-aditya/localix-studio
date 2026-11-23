import { Hono } from 'hono'
import { z } from 'zod'
import type { HostRouteContext } from '@localixai/mini-app-sdk/backend'
import { encodeKeys } from '../../agent-core/tools/terminal/terminal-keys'
import { zValidator } from '../../../lib/validator'
import { defaultErrorHandler } from '../../../lib/http'
import { ApiError } from '../../../lib/errors'
import { AGENT_KEYS, type AgentScreen } from '../shared/agent-prompt'
import { screenPrompt } from './live/screen-prompt'
import { agentTerminalOf, type OwnedSessionHost } from './owned-session-routes'
import type { AgentSessionsService } from './service'

/**
 * A coding agent's terminal as its chat uses it: the question it waits on, a message typed and
 * submitted, an answer chosen. The chat never holds a terminal id: each call finds the chat's
 * running agent, so a restarted agent is the one written to.
 */
export interface OwnedScreenHost extends Pick<OwnedSessionHost, 'session' | 'terminals'> {
  screen(
    userId: string,
    terminalId: string,
  ): Promise<{ text: string; cols: number; applicationCursorKeys?: boolean } | null>
  write(userId: string, terminalId: string, data: string): boolean
}

/** Rows of the agent's screen a chat can show, for a screen no question was read from. */
const TAIL_LINES = 14
/**
 * Between a message and its Enter. Sent at once, the two read as one paste and the newline is kept
 * as text; a slash command opens a completion list that takes an early Enter for itself.
 */
const MESSAGE_PAUSE_MS = 150
const COMMAND_PAUSE_MS = 1_200

const sessionBody = z.object({ sessionId: z.string().min(1).max(200) })

export function createOwnedScreenRoutes(
  host: OwnedScreenHost,
  options: {
    agents?: AgentSessionsService
    pause?: (ms: number) => Promise<void>
  } = {},
) {
  const pause = options.pause ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)))
  const agentTerminal = async (userId: string, sessionId: string) => {
    const provider = (await host.session(userId, sessionId)).externalAgentProvider
    if (!provider)
      throw new ApiError(400, 'not_external_session', 'This session has no external agent.')
    return agentTerminalOf(host, options.agents, userId, sessionId, provider)
  }
  const running = async (userId: string, sessionId: string) => {
    const terminal = await agentTerminal(userId, sessionId)
    if (!terminal) throw new ApiError(409, 'agent_not_running', 'The agent has stopped.')
    return terminal
  }
  const write = (userId: string, terminalId: string, data: string) => {
    if (!host.write(userId, terminalId, data))
      throw new ApiError(409, 'agent_not_running', 'The agent has stopped.')
  }

  const app = new Hono<HostRouteContext>()
    .post('/owned-screen', zValidator('json', sessionBody), async (c) => {
      const userId = c.get('userId')
      const terminal = await agentTerminal(userId, c.req.valid('json').sessionId)
      const screen = terminal ? await host.screen(userId, terminal.id) : null
      if (!terminal || !screen)
        return c.json<AgentScreen>({ running: false, prompt: null, tail: [] })
      const lines = screen.text.split('\n')
      while (lines.length && !lines.at(-1)?.trim()) lines.pop()
      const result: AgentScreen = {
        running: true,
        prompt: screenPrompt(screen.text, screen.cols),
        tail: lines.slice(-TAIL_LINES),
      }
      return c.json(result)
    })
    .post(
      '/owned-input',
      zValidator('json', sessionBody.extend({ text: z.string().min(1).max(100_000) })),
      async (c) => {
        const userId = c.get('userId')
        const { sessionId, text } = c.req.valid('json')
        const terminal = await running(userId, sessionId)
        write(userId, terminal.id, text)
        await pause(text.startsWith('/') ? COMMAND_PAUSE_MS : MESSAGE_PAUSE_MS)
        write(userId, terminal.id, '\r')
        return c.json({ ok: true })
      },
    )
    .post(
      '/owned-keys',
      zValidator(
        'json',
        sessionBody.extend({
          keys: z.array(z.enum(AGENT_KEYS)).min(1).max(20).optional(),
          choose: z.number().int().min(0).max(50).optional(),
        }),
      ),
      async (c) => {
        const userId = c.get('userId')
        const { sessionId, keys, choose } = c.req.valid('json')
        const terminal = await running(userId, sessionId)
        const screen = await host.screen(userId, terminal.id)
        let names: string[] = keys ?? []
        if (choose !== undefined) {
          // Read now, not when the chat last looked: the highlight is where the agent has it.
          const options = screen ? (screenPrompt(screen.text, screen.cols)?.options ?? []) : []
          const from = options.findIndex((option) => option.selected)
          if (from < 0 || choose >= options.length)
            throw new ApiError(409, 'prompt_changed', 'The agent is no longer asking this.')
          const step = choose > from ? 'down' : 'up'
          names = [...Array<string>(Math.abs(choose - from)).fill(step), 'enter']
        }
        write(userId, terminal.id, encodeKeys([...names], screen?.applicationCursorKeys))
        return c.json({ ok: true })
      },
    )
  app.onError(defaultErrorHandler)
  return app
}
