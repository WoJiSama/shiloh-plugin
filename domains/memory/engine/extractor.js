import {MemoryExtractor as Typed} from '../../../dist/backend/modules/memory/infrastructure/engine/extractor.js'
import {sideLLMCall} from '../../../utils/sideLLM.js'
export {parseAndRoute} from '../../../dist/backend/modules/memory/infrastructure/engine/extractor.js'
export class MemoryExtractor extends Typed {constructor(config={}){super(config,{call:sideLLMCall,logger:globalThis.logger})}}
