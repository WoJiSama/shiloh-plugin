import {createWaitTool} from '../../dist/backend/modules/toolSupport/infrastructure/WaitTool.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
export const WaitTool=createWaitTool({getInstance:()=>pluginBridge.instance})
