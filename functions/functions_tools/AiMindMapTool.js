import {Transformer} from 'markmap-lib'
import {createAiMindMapTool} from '../../dist/backend/modules/content/infrastructure/AiMindMapTool.js'
export const {AiMindMapTool}=createAiMindMapTool({cwd:process.cwd(),image:file=>globalThis.segment.image(file),logger:globalThis.logger,transform:markdown=>new Transformer().transform(markdown)})
