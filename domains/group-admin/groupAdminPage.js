// 群管面板：群内命令查看/修改本群群管配置（渲染为图片发送）
import { readUserSettings, applyFlatUpdates } from '../../utils/configWriter.js'
import { getSharedBrowser, scheduleSharedBrowserClose } from '../../utils/sharedBrowser.js'
import { groupModerationManager } from './GroupModerationManager.js'
import { createGroupAdminPageMessage } from '../../dist/backend/modules/groupAdmin/infrastructure/groupAdminPage.js'

export const GroupAdminPageMessage = createGroupAdminPageMessage(plugin, {
  readSettings: readUserSettings,
  applyUpdates: applyFlatUpdates,
  logger: globalThis.logger,
  cwd: process.cwd(),
  getSharedBrowser,
  scheduleSharedBrowserClose,
  image: imagePath => globalThis.segment.image(imagePath)
}, groupModerationManager)
