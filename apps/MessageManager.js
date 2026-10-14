import {MessageManager} from '../utils/MessageManager.js'
import {messageArchiveManager} from '../utils/MessageArchiveManager.js'
import {getBase64Image} from '../utils/fileUtils.js'
import {getInstalledMessagePipeline} from '../utils/messagePipeline/runtime.js'
import {sendCompleteLocalFile} from '../utils/messagePipeline/deliveryGateway.js'
import {createMessageRecordPlugin} from '../dist/backend/modules/host/infrastructure/MessageRecordPlugin.js'
export const MessageRecordPlugin=createMessageRecordPlugin(plugin,{MessageManager,archiveManager:messageArchiveManager,getBase64Image,getInstalledMessagePipeline,sendCompleteLocalFile,getBot:()=>globalThis.Bot,logger:globalThis.logger,segment:globalThis.segment})
