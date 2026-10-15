import {TextImageTool as TypedTextImageTool} from '../../dist/backend/modules/rendering/infrastructure/TextImageTool.js'
import {getSharedBrowser,scheduleSharedBrowserClose} from '../../utils/sharedBrowser.js'
import {personaFeedbackManager} from '../../domains/memory/PersonaFeedbackManager.js'
import {pluginBridge} from '../../utils/pluginBridge.js'
import {withPersonaSnapshot} from '../../dist/backend/modules/conversation/domain/personaSnapshotConfig.js'
export {hasLatexMath,extractLatexMath,shouldUseDocumentTemplateForTextImage,normalizeMarkdownHeadings,markdownToDocumentHtml,markdownToKnowledgeHtml} from '../../dist/backend/modules/rendering/infrastructure/TextImageTool.js'
export class TextImageTool extends TypedTextImageTool {
 constructor(){super({
  getSharedBrowser,scheduleSharedBrowserClose,logger:globalThis.logger,image:file=>globalThis.segment.image(file),
  guardText:(text,event)=>{
   const bridge=pluginBridge.instance
   const config=withPersonaSnapshot(bridge?.config||{},event)
   const persona=event?._personaSnapshot?config.persona:bridge?.getPersonaFor?.(event)??config.persona
   return personaFeedbackManager.guardReply(text,config.personaGuard,{userText:event?.msg||'',botNames:[persona?.name,event?.bot?.nickname].filter(name=>typeof name==='string')})
  }
 })}
}
