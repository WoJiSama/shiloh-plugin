import common from '../../../../lib/common/common.js'
import {createKnowledgePlugin} from '../../dist/backend/modules/knowledge/infrastructure/knowledgePlugin.js'
export const KnowledgePlugin=createKnowledgePlugin({PluginBase:globalThis.plugin,cwd:process.cwd(),makeForwardMsg:(...args)=>common.makeForwardMsg(...args)})
