import { pluginBridge } from '../../utils/pluginBridge.js'
import { createPersonProfileClass } from '../../dist/backend/modules/memory/application/personProfileInjector.js'
export const PersonProfileInjector = createPersonProfileClass({ getConfig: () => pluginBridge.instance?.config || {}, getPersonaFor: event => pluginBridge.instance?.getPersonaFor?.(event) || null, getMessages: (type, groupId) => pluginBridge.sharedState?.messageManager?.getMessages?.(type, groupId) || Promise.resolve([]) })
export const personProfileInjector = new PersonProfileInjector()
