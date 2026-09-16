import { readUserSettings, applyFlatUpdates } from "../../../utils/configWriter.js"
import {
  normalizeAiProviderUpdates,
  withAiProviderPanelDefaults
} from "../../../utils/guobaAiProviderConfig.js"

import basic from "./basic.js"
import permission from "./permission.js"
import groupGuard from "./groupGuard.js"
import groupNotice from "./groupNotice.js"
import messageArchive from "./messageArchive.js"
import messagePipeline from "./messagePipeline.js"
import persona from "./persona.js"
import aiCore from "./aiCore.js"
import tracking from "./tracking.js"
import emotion from "./emotion.js"
import memory from "./memory.js"
import expression from "./expression.js"
import knowledge from "./knowledge.js"
import emoji from "./emoji.js"
import aiModels from "./aiModels.js"
import voice from "./voice.js"
import deltaForce from "./deltaForce.js"
import magnetSearch from "./magnetSearch.js"
import tools from "./tools.js"
import umaRace from "./umaRace.js"
import dice from "./dice.js"

export const schemas = [
  basic,
  aiCore,
  permission,
  persona,
  groupGuard,
  groupNotice,
  messageArchive,
  messagePipeline,
  tracking,
  aiModels,
  emotion,
  memory,
  expression,
  knowledge,
  emoji,
  voice,
  deltaForce,
  magnetSearch,
  umaRace,
  dice,
  tools
].flat()

export function getConfigData() {
  return withAiProviderPanelDefaults(readUserSettings())
}

export function setConfigData(data, { Result }) {
  try {
    applyFlatUpdates(normalizeAiProviderUpdates(data || {}))
    return Result.ok({}, "保存成功 (´。• ᵕ •。`)")
  } catch (err) {
    return Result.error?.(`保存失败: ${err.message}`) || Result.ok({}, `保存失败: ${err.message}`)
  }
}
