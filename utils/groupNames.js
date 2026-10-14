import {collectBotGroupNames as groups,collectBotIdentities as identities} from '../dist/backend/modules/platform/infrastructure/groupNames.js'
export {readCachedGroupNames,mergeGroupNames} from '../dist/backend/modules/platform/infrastructure/groupNames.js'
export const collectBotGroupNames=(registry=globalThis.Bot)=>groups(registry)
export const collectBotIdentities=(registry=globalThis.Bot)=>identities(registry)
