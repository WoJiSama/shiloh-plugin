import { getEmojiToolIntentPatterns } from "./emojiToolPolicy.js"
import { buildExcelToolParams } from "./excelRequestPolicy.js"
import { parseModrinthRequestOptions } from "./modrinth.js"
import { extractGroupKnowledgeForgetTarget } from "./groupKnowledgeForgetPolicy.js"
import { extractValidBtihMagnetUri } from "./torrentDownload.js"
import { PIXIV_DOWNLOAD_TOOL_MANIFEST, PIXIV_SEARCH_TOOL_MANIFEST } from "./pixivIntent.js"

import { createBuiltinToolManifests } from "../dist/backend/modules/tools/domain/builtinToolManifests.js"
const manifests = createBuiltinToolManifests({getEmojiToolIntentPatterns,buildExcelToolParams,parseModrinthRequestOptions,extractGroupKnowledgeForgetTarget,extractValidBtihMagnetUri,PIXIV_DOWNLOAD_TOOL_MANIFEST,PIXIV_SEARCH_TOOL_MANIFEST})
export const DELTA_FORCE_TOOL_MANIFEST = manifests.DELTA_FORCE_TOOL_MANIFEST
export const REMINDER_TOOL_MANIFEST = manifests.REMINDER_TOOL_MANIFEST
export const SEARCH_MUSIC_TOOL_MANIFEST = manifests.SEARCH_MUSIC_TOOL_MANIFEST
export const VOICE_TOOL_MANIFEST = manifests.VOICE_TOOL_MANIFEST
export const SEND_LOCAL_EMOJI_TOOL_MANIFEST = manifests.SEND_LOCAL_EMOJI_TOOL_MANIFEST
export const MENTION_MEMBERS_TOOL_MANIFEST = manifests.MENTION_MEMBERS_TOOL_MANIFEST
export const MENTION_ADMINS_TOOL_MANIFEST = manifests.MENTION_ADMINS_TOOL_MANIFEST
export const FORGET_GROUP_KNOWLEDGE_TOOL_MANIFEST = manifests.FORGET_GROUP_KNOWLEDGE_TOOL_MANIFEST
export const EMOJI_SEARCH_TOOL_MANIFEST = manifests.EMOJI_SEARCH_TOOL_MANIFEST
export const SEARCH_INFORMATION_TOOL_MANIFEST = manifests.SEARCH_INFORMATION_TOOL_MANIFEST
export const WEB_PARSER_TOOL_MANIFEST = manifests.WEB_PARSER_TOOL_MANIFEST
export const GITHUB_REPO_TOOL_MANIFEST = manifests.GITHUB_REPO_TOOL_MANIFEST
export const AI_MIND_MAP_TOOL_MANIFEST = manifests.AI_MIND_MAP_TOOL_MANIFEST
export const EXCEL_WORKBOOK_TOOL_MANIFEST = manifests.EXCEL_WORKBOOK_TOOL_MANIFEST
export const MODRINTH_TOOL_MANIFEST = manifests.MODRINTH_TOOL_MANIFEST
export const TORRENT_DOWNLOAD_TOOL_MANIFEST = manifests.TORRENT_DOWNLOAD_TOOL_MANIFEST
export const TEXT_IMAGE_TOOL_MANIFEST = manifests.TEXT_IMAGE_TOOL_MANIFEST
export const POKE_TOOL_MANIFEST = manifests.POKE_TOOL_MANIFEST
export const LIKE_TOOL_MANIFEST = manifests.LIKE_TOOL_MANIFEST
export const CHANGE_CARD_TOOL_MANIFEST = manifests.CHANGE_CARD_TOOL_MANIFEST
export const JINYAN_TOOL_MANIFEST = manifests.JINYAN_TOOL_MANIFEST
export const BANANA_TOOL_MANIFEST = manifests.BANANA_TOOL_MANIFEST
export const GOOGLE_IMAGE_EDIT_TOOL_MANIFEST = manifests.GOOGLE_IMAGE_EDIT_TOOL_MANIFEST
export const WAIT_TOOL_MANIFEST = manifests.WAIT_TOOL_MANIFEST
export const BUILTIN_TOOL_MANIFESTS = manifests.BUILTIN_TOOL_MANIFESTS
