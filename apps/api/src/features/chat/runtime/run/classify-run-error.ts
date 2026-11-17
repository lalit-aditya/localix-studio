import { classifyAgentError, type AgentErrorInfo } from '@localixai/agent/agents'
import { DomainError } from '../../../../lib/domain-errors'
import { LocalContextBudgetExceededError } from '../context-budget'

/**
 * The host itself refused, in its own words (a chat whose project folder is gone, a record that
 * does not exist, a request it will not serve). Not a provider's answer, so it never goes through
 * the provider's status table, which has no sentence for a 404 or 409 and called it "an unexpected
 * error". A host fault that may clear (`unavailable`, `internal`) still does, so it is retried.
 */
const isHostRefusal = (error: unknown): error is DomainError =>
  error instanceof DomainError && error.kind !== 'unavailable' && error.kind !== 'internal'

/**
 * `classifyAgentError`, plus vault-value redaction of the one field that leaves the process.
 *
 * `info.userMessage` is the response body verbatim for any status the classifier has no mapping for
 * (`error-classification.ts` falls back to `error.message`), and a provider that rejects a request
 * may echo the credential it rejected. That string then reaches four sinks, none of which redacts:
 *
 *   - the assistant row's persisted `content` (forever, in the transcript the user scrolls);
 *   - the `run.failed` frame, on every connected client;
 *   - `console.error` / `console.warn`, which bypass the pino redaction sink entirely.
 *
 * So the redaction belongs at the classification, not at the four sinks. Both places that let a
 * classified message REACH a sink use this: the run-failure finalizer and the transient retry's log
 * line. Any bare `classifyAgentError` call left elsewhere must read `kind`/`retryable` only; once
 * one reads the message, it moves here.
 *
 * The audit that found this also found the reason it went unnoticed: the shield's `redactText` had no
 * caller anywhere outside its own module, and `providerHttpErrorMessage` — the function the previous
 * fix's rationale named as the leak path — has no call sites at all. The leak was real; the named
 * path was not.
 */
export function classifyRunError(
  deps: { sanitizeText?: (userId: string, text: string) => string },
  userId: string,
  error: unknown,
): AgentErrorInfo {
  const info: AgentErrorInfo = isHostRefusal(error)
    ? { kind: 'fatal', userMessage: error.message, retryable: false }
    : error instanceof LocalContextBudgetExceededError
      ? error.reason === 'estimated_context_too_large'
        ? {
            kind: 'context_overflow',
            userMessage: error.message,
            retryable: false,
            shouldCompress: true,
          }
        : {
            kind: 'fatal',
            userMessage: error.message,
            retryable: false,
          }
      : classifyAgentError(error)
  if (!deps.sanitizeText) return info
  const safe = deps.sanitizeText(userId, info.userMessage)
  // Same object when nothing matched, so a caller comparing identity (or a test asserting the
  // classifier's own result) sees no difference on the overwhelmingly common path.
  return safe === info.userMessage ? info : { ...info, userMessage: safe }
}
