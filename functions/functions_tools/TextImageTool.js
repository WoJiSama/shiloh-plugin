import {TextImageTool as TypedTextImageTool} from '../../dist/backend/modules/rendering/infrastructure/TextImageTool.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from '../../utils/sharedBrowser.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
export {hasLatexMath,extractLatexMath,shouldUseDocumentTemplateForTextImage,normalizeMarkdownHeadings,markdownToDocumentHtml,markdownToKnowledgeHtml} from '../../dist/backend/modules/rendering/infrastructure/TextImageTool.js'
export class TextImageTool extends TypedTextImageTool {
 constructor(){super({
  getSharedBrowser,scheduleSharedBrowserClose,logger:globalThis.logger,image:file=>globalThis.segment.image(file),
  guardText:(text,event)=>personaFeedbackManager.guardReply(text,pluginBridge.instance?.config?.personaGuard,{userText:event?.msg||'',botNames:[event?.bot?.nickname,pluginBridge.instance?.getPersonaFor?.(event)?.name??pluginBridge.instance?.config?.persona?.name]})
 })}
}
