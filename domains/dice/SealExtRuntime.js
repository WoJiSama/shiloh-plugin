import {fileURLToPath} from 'node:url'
import {SealExtRuntime as TypedSealExtRuntime} from '../../dist/backend/modules/dice/infrastructure/SealExtRuntime.js'
export {looksLikeSealExtensionSource,extractUserScriptMeta} from '../../dist/backend/modules/dice/infrastructure/SealExtRuntime.js'
export class SealExtRuntime extends TypedSealExtRuntime {constructor(options={}){super({statePath:fileURLToPath(new URL('../../data/dice_seal_ext_state.json',import.meta.url)),logger:globalThis.logger,...options})}}
