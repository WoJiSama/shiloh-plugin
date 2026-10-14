import {createSearchInformationTool} from '../../dist/backend/modules/toolSupport/infrastructure/SearchInformationTool.js'
import {TotalTokens} from '../tools/CalculateToken.js'
import {generateContextualProgressReply} from '../../utils/contextualProgressReply.js'
export const SearchInformationTool=createSearchInformationTool({totalTokens:TotalTokens,progressReplyFactory:generateContextualProgressReply,debug:message=>globalThis.logger?.debug?.(message)})
