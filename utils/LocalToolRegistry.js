import { JinyanTool } from "../functions/functions_tools/JinyanTool.js"
import { SearchInformationTool } from "../functions/functions_tools/SearchInformationTool.js"
import { SearchVideoTool } from "../functions/functions_tools/SearchVideoTool.js"
import { SearchMusicTool } from "../functions/functions_tools/SearchMusicTool.js"
import { EmojiSearchTool } from "../functions/functions_tools/EmojiSearchTool.js"
import { BingImageSearchTool } from "../functions/functions_tools/BingImageSearchTool.js"
import { GoogleImageAnalysisTool } from "../functions/functions_tools/GoogleAnalysisTool.js"
import { ChatHistoryTool } from "../functions/functions_tools/ChatHistoryTool.js"
import { PokeTool } from "../functions/functions_tools/PokeTool.js"
import { LikeTool } from "../functions/functions_tools/LikeTool.js"
import { AiMindMapTool } from "../functions/functions_tools/AiMindMapTool.js"
import { GoogleImageEditTool } from "../functions/functions_tools/GoogleImageEditTool.js"
import { WebParserTool } from "../functions/functions_tools/webParserTool.js"
import { GitHubRepoTool } from "../functions/functions_tools/GithubTool.js"
import { VideoAnalysisTool } from "../functions/functions_tools/VideoAnalysisTool.js"
import { QQZoneTool } from "../functions/functions_tools/QQZoneTool.js"
import { ChangeCardTool } from "../functions/functions_tools/ChangeCardTool.js"
import { VoiceTool } from "../functions/functions_tools/VoiceTool.js"
import { BananaTool } from "../functions/functions_tools/BananaTool.js"
import { ReactionTool } from "../functions/functions_tools/ReactionTool.js"
import { MemberInfoTool } from "../functions/functions_tools/MemberInfoTool.js"
import { RecallTool } from "../functions/functions_tools/RecallTool.js"
import { GrabRedBagTool } from "../functions/functions_tools/GrabRedBagTool.js"
import { ReminderTool } from "../functions/functions_tools/ReminderTool.js"
import { TextImageTool } from "../functions/functions_tools/TextImageTool.js"
import { SendLocalEmojiTool } from "../functions/functions_tools/SendLocalEmojiTool.js"
import { SendGiftTool } from "../functions/functions_tools/SendGiftTool.js"
import { DeltaForceTool } from "../functions/functions_tools/DeltaForceTool.js"
import { ExcelWorkbookTool } from "../functions/functions_tools/ExcelWorkbookTool.js"
import { ModrinthTool } from "../functions/functions_tools/ModrinthTool.js"
import { MentionAdminsTool } from "../functions/functions_tools/MentionAdminsTool.js"
import { MentionMembersTool } from "../functions/functions_tools/MentionMembersTool.js"
import { ForgetGroupKnowledgeTool } from "../functions/functions_tools/ForgetGroupKnowledgeTool.js"
import { TorrentDownloadTool } from "../functions/functions_tools/TorrentDownloadTool.js"
import { PixivSearchTool } from "../functions/functions_tools/PixivSearchTool.js"
import { PixivDownloadTool } from "../functions/functions_tools/PixivDownloadTool.js"
import "./toolManifestRegistry.js"
import {LocalToolRegistry as TypedLocalToolRegistry} from "../dist/backend/modules/tools/infrastructure/LocalToolRegistry.js"
const BUILT_IN_TOOL_FACTORIES = [
  () => new JinyanTool(),
  () => new SearchInformationTool(),
  () => new SearchVideoTool(),
  () => new SearchMusicTool(),
  () => new EmojiSearchTool(),
  () => new BingImageSearchTool(),
  () => new GoogleImageAnalysisTool(),
  () => new ChatHistoryTool(),
  () => new PokeTool(),
  () => new LikeTool(),
  () => new AiMindMapTool(),
  () => new WebParserTool(),
  () => new GoogleImageEditTool(),
  () => new GitHubRepoTool(),
  () => new VideoAnalysisTool(),
  () => new QQZoneTool(),
  () => new ChangeCardTool(),
  () => new VoiceTool(),
  () => new BananaTool(),
  () => new ReactionTool(),
  () => new MemberInfoTool(),
  () => new RecallTool(),
  () => new GrabRedBagTool(),
  () => new ReminderTool(),
  () => new TextImageTool(),
  () => new SendLocalEmojiTool(),
  () => new SendGiftTool(),
  () => new DeltaForceTool(),
  () => new ExcelWorkbookTool(),
  () => new ModrinthTool(),
  () => new MentionAdminsTool(),
  () => new MentionMembersTool(),
  () => new ForgetGroupKnowledgeTool(),
  () => new TorrentDownloadTool(),
  () => new PixivSearchTool(),
  () => new PixivDownloadTool(),
]

export class LocalToolRegistry extends TypedLocalToolRegistry {constructor(options={}){super(options,{factories:BUILT_IN_TOOL_FACTORIES,logger:{info:message=>globalThis.logger?.info?.(message),warn:message=>globalThis.logger?.warn?.(message),error:(message,error)=>globalThis.logger?.error?.(message,error)}})}}
export const localToolRegistry=new LocalToolRegistry()
