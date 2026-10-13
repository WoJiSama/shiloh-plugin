import {createSemanticMemoryWebApp} from '../dist/backend/modules/memory/infrastructure/semanticMemoryWebApp.js'
import {getSemanticMemoryRuntime} from '../domains/semanticMemory/runtime.js'
const web = createSemanticMemoryWebApp(getSemanticMemoryRuntime)
export function registerSemanticMemoryWebApp(app, root, tokens={}, logger=globalThis.logger){return web.registerSemanticMemoryWebApp(app,root,tokens,logger)}
