import {createPersonaLibrary as create} from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
export {PERSONA_ENTRY_FIELDS,normalizePersonaEntry} from '../dist/backend/modules/conversation/infrastructure/personaLibrary.js'
export const createPersonaLibrary = (options={}) => create({logger:globalThis.logger,...options})
