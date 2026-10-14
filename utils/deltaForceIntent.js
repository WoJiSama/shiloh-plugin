import {resolveNaturalDeltaForceToolCall as resolve} from '../dist/backend/modules/games/domain/deltaForceIntent.js'
export function resolveNaturalDeltaForceToolCall(text='',options={}){return resolve(text,{botName:globalThis.Bot?.nickname||'',...options})}
