import {Reflector as Typed} from '../../../dist/backend/modules/memory/infrastructure/engine/reflector.js'
import {sideLLMCall} from '../../../utils/sideLLM.js'
export class Reflector extends Typed {constructor(config={}){super(config,{call:sideLLMCall,logger:globalThis.logger})}}
