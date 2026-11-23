import type { AppDeps } from '../app'
import { createOwnedAgentRoutes } from '../features/external-agents/backend/owned-session-routes'
import { recordTerminalWork } from '../features/terminal/terminal-work'
import { createAttachAgentRoutes } from '../features/external-agents/backend/attach-session-routes'
import { createLinkAgentRoutes } from '../features/external-agents/backend/link-session-routes'
import { createOwnedScreenRoutes } from '../features/external-agents/backend/owned-screen-routes'
import { createAgentAccountRoutes } from '../features/external-agents/backend/agent-account-routes'
import { agentMcpServers } from './agent-mcp-servers'
import { runAgentProgram } from './agent-program'

export function ownedAgentRoutes(
  deps: Pick<
    AppDeps,
    'chatService' | 'terminalService' | 'work' | 'externalAgents' | 'logger' | 'projectsService'
  >,
) {
  const session = (userId: string, sessionId: string) =>
    deps.chatService.getSession(userId, sessionId)
  const terminals = (userId: string) => deps.terminalService.list(userId)
  const spawn = async (
    userId: string,
    sessionId: string,
    command: string,
    options?: { env?: Record<string, string | undefined> },
  ) => {
    const terminal = await deps.terminalService.spawnCommand(userId, {
      sessionId,
      command,
      env: options?.env,
    })
    recordTerminalWork(deps.work, { owner: { userId, sessionId }, label: command, terminal })
    return terminal
  }
  return createOwnedAgentRoutes(
    {
      session,
      cwd: (...args) => deps.chatService.resolveSessionCwd(...args),
      terminals,
      spawn,
      reportError: (...[error]) =>
        deps.logger.warn({ event: 'external_agents.identity_save_failed', error: String(error) }),
      remember: (userId, id, key) =>
        deps.chatService.updateSession(userId, id, { externalAgentSessionKey: key }),
      mcpServers: (_userId, sessionId, origin) => agentMcpServers(origin, sessionId),
    },
    deps.externalAgents,
  )
    .route(
      '/',
      createOwnedScreenRoutes(
        {
          session,
          terminals,
          screen: async (userId, terminalId) =>
            (await deps.terminalService.get(userId, terminalId)?.screen()) ?? null,
          write: (...args) => deps.terminalService.writeUserInput(...args),
        },
        { agents: deps.externalAgents },
      ),
    )
    .route(
      '/',
      createAgentAccountRoutes(
        {
          session,
          terminals,
          spawn,
          close: (...args) => deps.terminalService.close(...args),
          run: runAgentProgram,
        },
        deps.externalAgents,
      ),
    )
    .route(
      '/',
      createLinkAgentRoutes({
        session: (...args) => deps.chatService.getSession(...args),
        link: (userId, id, provider) =>
          deps.chatService.updateSession(userId, id, { externalAgentProvider: provider }),
      }),
    )
    .route(
      '/',
      createAttachAgentRoutes({
        native: async (...args) => deps.externalAgents?.nativeSummary(...args) ?? null,
        sessions: (...args) => deps.chatService.listSessions(...args),
        project: (...args) => deps.projectsService.getProject(...args),
        resolveProject: async (...args) =>
          (await deps.projectsService.resolveProjectByPath(...args)).project,
        create: (...args) => deps.chatService.createSession(...args),
      }),
    )
}
