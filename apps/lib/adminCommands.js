import {createAdminCommands} from '../../dist/backend/modules/platform/infrastructure/admin/adminCommands.js'
import {mcpManager} from '../../utils/MCPClient.js'
import {applyFlatUpdates} from '../../utils/configWriter.js'
const commands=createAdminCommands({mcpManager,applyFlatUpdates,logger:globalThis.logger})
export const {mcpStatus,testMCPTool,isChatManager,forbiddenWordList,handleForbiddenList,handleForbiddenAdd,handleForbiddenRemove,resolvePersonaTargetGroup,formatPersonaDetail,handlePersonaList,handlePersonaCurrent,handlePersonaDetail,handlePersonaSwitch,handlePersonaReset,handlePersonaSave,handlePersonaDelete,handlePersonaReload,handlePersonaBindings}=commands
