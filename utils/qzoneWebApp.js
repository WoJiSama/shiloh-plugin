import {createQzoneWebApp} from '../dist/backend/modules/platform/infrastructure/console/qzoneWebApp.js'
const app = createQzoneWebApp({bots:()=>globalThis.Bot?.bots || {},fetchImpl:globalThis.fetch,logger:globalThis.logger})
export const {listQzoneBots,publishShuoshuo,registerQzoneWebApp} = app
