import { childEnv } from '../lib/login-shell-env'
import { whichBinary } from '../features/agent-core/tools/environments/shell'

/** Longer than a sign-out or a status read takes; a hung CLI must not hold its request open. */
const RUN_DEADLINE_MS = 30_000

/**
 * Run a coding agent's own command to its end, without a terminal (`claude auth status`), and
 * return what it printed. The program is found on the repaired PATH, as installed agents are.
 */
export async function runAgentProgram(
  program: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
): Promise<{ code: number; stdout: string }> {
  const merged = childEnv(env)
  const child = Bun.spawn([whichBinary(program, merged) ?? program, ...args], {
    env: merged,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'ignore',
    signal: AbortSignal.timeout(RUN_DEADLINE_MS),
    windowsHide: true,
  })
  const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
  return { code, stdout }
}
