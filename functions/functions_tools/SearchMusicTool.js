import {createSearchMusicTool} from '../../dist/backend/modules/media/infrastructure/SearchMusicTool.js'
export const SearchMusicTool=createSearchMusicTool({fetch:(...args)=>globalThis.fetch(...args),getBot:()=>globalThis.Bot||null,logger:{error:(...args)=>globalThis.logger?.error?.(...args),info:(...args)=>globalThis.logger?.info?.(...args)}})
