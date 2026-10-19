import type {ChatRequestData, ChatResponse} from '../../../../contracts/modelGateway.js'
import type {ExecutionConfig, ExecutionOptions} from '../../../../contracts/modelExecution.js'
import {readPluginSettings} from '../gameFiles.js'
import type {TurtleSoupModelCall} from './TurtleSoupGenerator.js'

type ExecuteModel = (request:ChatRequestData, config:ExecutionConfig, toolContent?:unknown, toolName?:string, options?:ExecutionOptions) => Promise<ChatResponse>
const record=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{}
const text=(value:unknown):string|undefined=>typeof value==='string'&&value.trim()?value.trim():undefined

// The general gateway selects its model from config, not request.model. Apply
// per-stage selection to that backend and reload settings after console edits.
export function createTurtleSoupModelCall({cwd,executeModel}:{cwd:string;executeModel:ExecuteModel}):TurtleSoupModelCall {
  return async (messages,options={})=>{
    const settings=readPluginSettings(cwd),chat=record(settings.chatAiConfig)
    const keys=chat.chatApiKey
    const config:ExecutionConfig={useTools:false,chatAiConfig:{
      chatApiUrl:text(chat.chatApiUrl),
      chatApiModel:options.model?.trim()||text(chat.chatApiModel),
      chatApiKey:typeof keys==='string'?keys:Array.isArray(keys)?keys.filter((key):key is string=>typeof key==='string'):undefined,
      ...(text(chat.chatReasoningEffort)?{chatReasoningEffort:text(chat.chatReasoningEffort)!}:{})
    }}
    const provider=text(settings.providers)
    if(provider)config.providers=provider
    const response=await executeModel({messages,temperature:options.temperature??0.7,top_p:0.9},config,undefined,undefined,{
      forceChatBackend:true,routeLabel:'海龟汤',...(options.signal?{signal:options.signal}:{})
    })
    if(response.error)throw new Error(`模型调用失败: ${typeof response.error==='object'?JSON.stringify(response.error):String(response.error)}`)
    const content=response.choices?.[0]?.message?.content
    if(typeof content!=='string'||!content.trim())throw new Error('模型返回内容为空')
    return content
  }
}
