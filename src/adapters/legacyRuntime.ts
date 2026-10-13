import { createGroupRuntime } from '../modules/runtime/application/groupRuntime.js'
import type { RuntimePorts } from '../contracts/runtime.js'

/** The legacy composition root supplies capabilities, never its full plugin instance. */
export function createLegacyGroupRuntime<Topic, Social>(context: Pick<RuntimePorts<ReturnType<typeof setTimeout>, Topic, Social>, 'peekTopic' | 'peekSocial' | 'logger'>) {
  return createGroupRuntime<ReturnType<typeof setTimeout>, Topic, Social>({ ...context, now: () => Date.now(), cancelTimer: timer => clearTimeout(timer) })
}
