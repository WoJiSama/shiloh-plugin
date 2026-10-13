import ts from 'typescript';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkTree } from './check-boundaries.mjs';

export const baselineCommit = 'a93265cd94e2307504dad11d26351cf954cfc071';
export const baselinePath = 'docs/architecture/migrations/source-baseline.json';
export const migrations = [
  { legacy: 'domains/memory/commandsApp.js', implementation: 'src/modules/memory/infrastructure/memoryCommands.ts', kind: 'composition', reviewedSha256: '35d396f3430f839d52f6fa067f4120b53d78556f2e705a0198ab7b513037a365' },
  { legacy: 'domains/memory/EmotionManager.js', implementation: 'src/modules/memory/application/emotionManager.ts', kind: 'composition', reviewedSha256: 'dd1a8c0c9c86293d3010d11281ed032e0e8406c931d6fca93d90c4aaa8eb5521' },
  { legacy: 'domains/memory/ExpressionLearner.js', implementation: 'src/modules/memory/application/expressionLearner.ts', kind: 'composition', reviewedSha256: '9296fc96a477df36502d9d3745c01da682350f0166f851dc8bf6e69a4cf58a6b' },
  { legacy: 'domains/memory/PersonProfileInjector.js', implementation: 'src/modules/memory/application/personProfileInjector.ts', kind: 'composition', reviewedSha256: '48ca156a1e4f02939d36f2f2d50b6f108c9099b9b9fea600cb0c35291648a3bd' },
  { legacy: 'domains/memory/PersonaFeedbackManager.js', implementation: 'src/modules/memory/infrastructure/personaFeedbackManager.ts', kind: 'composition', reviewedSha256: '4e9ec5e3fe4f99e390648fef46728ff8ef69b7a2fe63a4c81d1ee684b105aa01' },
  { legacy: 'domains/memory/MemoryManager.js', implementation: 'src/modules/memory/infrastructure/memoryManager.ts', kind: 'composition', reviewedSha256: '4580de7a258dff96ad98fc28803d02f9cf493a8d23c33b2c482bd853fe0f6c50' },
  { legacy: 'utils/expressionSequence.js', implementation: 'src/modules/memory/domain/expressionSequence.ts' },
  { legacy: 'domains/memory/engine/constants.js', implementation: 'src/modules/memory/infrastructure/engine/constants.ts' },
  { legacy: 'domains/memory/engine/boundary.js', implementation: 'src/modules/memory/infrastructure/engine/boundary.ts' },
  { legacy: 'domains/memory/engine/conflictResolver.js', implementation: 'src/modules/memory/infrastructure/engine/conflictResolver.ts' },
  { legacy: 'domains/memory/engine/entityModel.js', implementation: 'src/modules/memory/infrastructure/engine/entityModel.ts' },
  { legacy: 'domains/memory/engine/aliasRegistry.js', implementation: 'src/modules/memory/infrastructure/engine/aliasRegistry.ts' },
  { legacy: 'domains/memory/engine/stats.js', implementation: 'src/modules/memory/infrastructure/engine/stats.ts' },
  { legacy: 'domains/memory/engine/mentionResolver.js', implementation: 'src/modules/memory/infrastructure/engine/mentionResolver.ts' },
  { legacy: 'domains/memory/engine/retriever.js', implementation: 'src/modules/memory/infrastructure/engine/retriever.ts' },
  { legacy: 'domains/memory/engine/groupKnowledge.js', implementation: 'src/modules/memory/infrastructure/engine/groupKnowledge.ts' },
  { legacy: 'domains/memory/engine/groupWorkflow.js', implementation: 'src/modules/memory/infrastructure/engine/groupWorkflow.ts' },
  { legacy: 'domains/memory/engine/embeddings.js', implementation: 'src/modules/memory/infrastructure/engine/embeddings.ts', kind: 'composition', reviewedSha256: '144503cd7b4ca4f661b96e4e1d099e1abc9b46ea1eb396cb988792987aba92da' },
  { legacy: 'domains/memory/engine/extractor.js', implementation: 'src/modules/memory/infrastructure/engine/extractor.ts', kind: 'composition', reviewedSha256: 'd5cc1a82669cb7162ee4064c000916447e999bb05771d9546b65d2165362ed8a' },
  { legacy: 'domains/memory/engine/reflector.js', implementation: 'src/modules/memory/infrastructure/engine/reflector.ts', kind: 'composition', reviewedSha256: 'fb8cc6a740012ad9ac09279492402b9abc98b81e9ce1fe4456a52b0f125ea596' },
  { legacy: 'domains/memory/engine/redisStore.js', implementation: 'src/modules/memory/infrastructure/engine/redisStore.ts', kind: 'composition', reviewedSha256: 'd63615c30b727d978c9e43edef605f7fa7559211383822f71115dc1cf05968ce' },
  { legacy: 'utils/semanticMemoryWebApp.js', implementation: 'src/modules/memory/infrastructure/semanticMemoryWebApp.ts', kind: 'composition', reviewedSha256: '2f8ff0d7d5339288da526cf9ed059a1a7544197919f1018bc55094d329e97597' },
  { legacy: 'apps/SemanticMemory.js', implementation: 'src/modules/memory/infrastructure/semanticMemoryCommands.ts', kind: 'composition', reviewedSha256: 'c4552872fb9def917a0a10aea5b64fa3bffb444e9f8d26542a0be182b5f73dec' },
  { legacy: 'domains/semanticMemory/EmbeddingGateway.js', implementation: 'src/modules/memory/infrastructure/EmbeddingGateway.ts', kind: 'composition', reviewedSha256: '676374c1351095779d4d0722135a4bfeaab9bee0cf3da0560f5c4db8216dac2f' },
  { legacy: 'domains/semanticMemory/RerankGateway.js', implementation: 'src/modules/memory/infrastructure/RerankGateway.ts', kind: 'composition', reviewedSha256: '2fe0e1e3bad1f97193d9ed4b53d2c24ad04bf6e32b7d8fe3a7d022e343a1017f' },
  { legacy: 'domains/semanticMemory/SemanticMemoryStore.js', implementation: 'src/modules/memory/infrastructure/SemanticMemoryStore.ts', kind: 'composition', reviewedSha256: 'da03a3b98c55802dbd9f31d10ec27b05117cb954f5136a230a32025f4b7e5784' },
  { legacy: 'domains/semanticMemory/SemanticMemoryIndexer.js', implementation: 'src/modules/memory/infrastructure/SemanticMemoryIndexer.ts', kind: 'composition', reviewedSha256: 'c004aa3c3ac0a59c5e1e3bc889a2d04580607a738920dca08dab9874d60fa5f8' },
  { legacy: 'domains/semanticMemory/SemanticMemoryRetriever.js', implementation: 'src/modules/memory/infrastructure/SemanticMemoryRetriever.ts', kind: 'composition', reviewedSha256: '1f671439f0c939f7fdf7a797f70f6da4236cfefc14b8156f6e44efd147e36705' },
  { legacy: 'domains/semanticMemory/runtime.js', implementation: 'src/modules/memory/infrastructure/semanticRuntime.ts', kind: 'composition', reviewedSha256: 'ffd3d6802b0b8d7c6a300a2dc2b3d099b80bd699786aa389664bf39751fbd724' },
  { legacy: 'domains/semanticMemory/retrievalEval.js', implementation: 'src/modules/memory/infrastructure/retrievalEval.ts' },
  { legacy: 'domains/midtermMemory/MidtermSummaryManager.js', implementation: 'src/modules/memory/infrastructure/MidtermSummaryManager.ts', kind: 'composition', reviewedSha256: 'fa24838fcdd419ac46694934898129ad01f5533bdbad41d0a9553bac6cd75afc' },
  { legacy: 'utils/episodicMemory.js', implementation: 'src/modules/memory/infrastructure/episodicMemory.ts' },
  { legacy: 'utils/memorySelfCorrection.js', implementation: 'src/modules/memory/infrastructure/memorySelfCorrection.ts', kind: 'composition', reviewedSha256: 'c7a1f836613de19529551b6bc9e7ff0bffd8fd9eb281ac6d19d261b4381bd18e' },
  { legacy: 'domains/memory/GlobalStyleLearnerManager.js', implementation: 'src/modules/memory/infrastructure/globalStyleLearner.ts', kind: 'composition', reviewedSha256: '22f8c9f9e186c7110e0c88401ed361a83bc94b03e8a9f607d257895c5c9dd878' },
  { legacy: 'utils/pluginExportLoader.js', implementation: 'src/modules/platform/domain/pluginExportLoader.ts' },
  { legacy: 'utils/forwardBatches.js', implementation: 'src/modules/messaging/domain/forwardBatches.ts' },
  { legacy: 'utils/turnSession.js', implementation: 'src/modules/runtime/domain/turnSession.ts' },
  // Reviewed composition only: capability injection belongs to adapters, business to application TS.
  // A changed shim must be reviewed and registered again; a matching filename is not sufficient.
  { legacy: 'core/runtime/groupRuntime.js', implementation: 'src/modules/runtime/application/groupRuntime.ts', adapter: 'src/adapters/legacyRuntime.ts', kind: 'composition', reviewedSha256: 'ea846310dec22fdbb3a91813579002446a005fb6a822b83c917bedd90add2f92' },
  { legacy: 'core/runtime/sharedRuntime.js', implementation: 'src/modules/runtime/application/sharedRuntime.ts', adapter: 'src/adapters/sharedRuntime.ts', kind: 'composition', reviewedSha256: 'ffa53a34e2251ada3e5a589063054e27436bff3b4e06cf143bc7de396c174a0d' },
  { legacy: 'utils/imageSourcePolicy.js', implementation: 'src/modules/image/domain/imageSourcePolicy.ts' },
  { legacy: 'utils/imageResult.js', implementation: 'src/modules/image/domain/imageResult.ts' },
  { legacy: 'utils/multipartFormData.js', implementation: 'src/modules/image/infrastructure/multipartFormData.ts' },
  { legacy: 'utils/imageTaskPolicy.js', implementation: 'src/modules/image/domain/imageTaskPolicy.ts' },
  { legacy: 'utils/imageFailurePolicy.js', implementation: 'src/modules/image/domain/imageFailurePolicy.ts' },
  { legacy: 'utils/imageDimensions.js', implementation: 'src/modules/image/domain/imageDimensions.ts' },
  { legacy: 'utils/visibleFailure.js', implementation: 'src/modules/models/domain/visibleFailure.ts' },
  { legacy: 'utils/imageGenerationFallback.js', implementation: 'src/modules/image/domain/providerConfig.ts', additionalImplementations: ['src/modules/image/application/legacyImageGeneration.ts'] },
  { legacy: 'utils/chatCompletionUrl.js', implementation: 'src/modules/models/domain/chatCompletionUrl.ts' },
  { legacy: 'utils/sideLLM.js', implementation: 'src/adapters/sideLLM.ts' },
  { legacy: 'utils/imageAspectRatio.js', implementation: 'src/modules/image/domain/imageAspectRatio.ts' },
  { legacy: 'utils/unicodeText.js', implementation: 'src/modules/models/domain/unicodeText.ts' },
  { legacy: 'utils/modelGateway.js', implementation: 'src/modules/models/domain/modelGateway.ts', additionalImplementations: ['src/adapters/modelFetch.ts'] },
  { legacy: 'utils/chatRequestRecovery.js', implementation: 'src/modules/models/application/chatRequestRecovery.ts' },
  { legacy: 'utils/imageRequestGuard.js', implementation: 'src/modules/image/domain/imageRequestGuard.ts' },
  { legacy: 'utils/providers/ThinkingProcessor.js', implementation: 'src/modules/models/domain/thinkingProcessor.ts' },
  { legacy: 'utils/apiClient.js', implementation: 'src/modules/models/application/modelExecution.ts', kind: 'composition', reviewedSha256: 'bd6c67a0c7b6653c064278f65de06e564ea8589b34e06bb4b0bacb75edf77faf' },
  { legacy: 'utils/aiProviderProbe.js', implementation: 'src/modules/models/application/aiProviderProbe.ts', kind: 'composition', reviewedSha256: 'dd99187a0e58d1c758786d10edbbf90a931f97155fcb135d86f54f1feea5e397' },
  { legacy: 'utils/chatFailureDiagnosis.js', implementation: 'src/modules/models/application/chatFailureDiagnosis.ts', kind: 'composition', reviewedSha256: '8b0256e61189492d748e74c1d6d6d9bb9611dc13548b81b1a1fadcf8e3d5123b' },
  { legacy: 'utils/guobaAiProviderConfig.js', implementation: 'src/modules/config/domain/aiProviderConfig.ts' },
  { legacy: 'models/configSchemas/conversation.js', implementation: 'src/modules/config/domain/schemas/shared/conversation.ts' },
  { legacy: 'models/configSchemas/permission.js', implementation: 'src/modules/config/domain/schemas/shared/permission.ts' },
  { legacy: 'models/configSchemas/triggers.js', implementation: 'src/modules/config/domain/schemas/shared/triggers.ts' },
  { legacy: 'models/configSchemas/aiCore.js', implementation: 'src/modules/config/domain/schemas/shared/aiCore.ts' },
  { legacy: 'models/configSchemas/basic.js', implementation: 'src/modules/config/domain/schemas/shared/basic.ts' },
  { legacy: 'models/configSchemas/reasoning.js', implementation: 'src/modules/config/domain/schemas/shared/reasoning.ts' },
  { legacy: 'models/Guoba/schemas/riskControl.js', implementation: 'src/modules/config/domain/schemas/guoba/riskControl.ts' },
  { legacy: 'models/Guoba/schemas/tools.js', implementation: 'src/modules/config/domain/schemas/guoba/tools.ts' },
  { legacy: 'models/Guoba/schemas/magnetSearch.js', implementation: 'src/modules/config/domain/schemas/guoba/magnetSearch.ts' },
  { legacy: 'models/Guoba/schemas/emoji.js', implementation: 'src/modules/config/domain/schemas/guoba/emoji.ts' },
  { legacy: 'models/Guoba/schemas/messageArchive.js', implementation: 'src/modules/config/domain/schemas/guoba/messageArchive.ts' },
  { legacy: 'models/Guoba/schemas/persona.js', implementation: 'src/modules/config/domain/schemas/guoba/persona.ts' },
  { legacy: 'models/Guoba/schemas/groupGuard.js', implementation: 'src/modules/config/domain/schemas/guoba/groupGuard.ts' },
  { legacy: 'models/Guoba/schemas/dice.js', implementation: 'src/modules/config/domain/schemas/guoba/dice.ts' },
  { legacy: 'models/Guoba/schemas/deltaForce.js', implementation: 'src/modules/config/domain/schemas/guoba/deltaForce.ts' },
  { legacy: 'models/Guoba/schemas/permission.js', implementation: 'src/modules/config/domain/schemas/guoba/permission.ts' },
  { legacy: 'models/Guoba/schemas/memory.js', implementation: 'src/modules/config/domain/schemas/guoba/memory.ts' },
  { legacy: 'models/Guoba/schemas/umaRace.js', implementation: 'src/modules/config/domain/schemas/guoba/umaRace.ts' },
  { legacy: 'models/Guoba/schemas/aiCore.js', implementation: 'src/modules/config/domain/schemas/guoba/aiCore.ts' },
  { legacy: 'models/Guoba/schemas/tracking.js', implementation: 'src/modules/config/domain/schemas/guoba/tracking.ts' },
  { legacy: 'models/Guoba/schemas/emotion.js', implementation: 'src/modules/config/domain/schemas/guoba/emotion.ts' },
  { legacy: 'models/Guoba/schemas/expression.js', implementation: 'src/modules/config/domain/schemas/guoba/expression.ts' },
  { legacy: 'models/Guoba/schemas/aiModels.js', implementation: 'src/modules/config/domain/schemas/guoba/aiModels.ts' },
  { legacy: 'models/Guoba/schemas/knowledge.js', implementation: 'src/modules/config/domain/schemas/guoba/knowledge.ts' },
  { legacy: 'models/Guoba/schemas/basic.js', implementation: 'src/modules/config/domain/schemas/guoba/basic.ts' },
  { legacy: 'models/Guoba/schemas/messagePipeline.js', implementation: 'src/modules/config/domain/schemas/guoba/messagePipeline.ts' },
  { legacy: 'models/Guoba/schemas/voice.js', implementation: 'src/modules/config/domain/schemas/guoba/voice.ts' },
  { legacy: 'models/Guoba/schemas/reasoning.js', implementation: 'src/modules/config/domain/schemas/guoba/reasoning.ts' },
  { legacy: 'models/Guoba/schemas/groupNotice.js', implementation: 'src/modules/config/domain/schemas/guoba/groupNotice.ts' },
  { legacy: 'console/lib/schemaConfig.js', implementation: 'src/adapters/config/schemaConfig.ts' },
  { legacy: 'console/lib/providerCredentials.js', implementation: 'src/adapters/config/providerCredentials.ts' },
  { legacy: 'utils/configWriter.js', implementation: 'src/modules/config/infrastructure/configRepository.ts', kind: 'composition', reviewedSha256: '104062c5197f73ac8cdf75db39a9894307fd3b7783dd57dfe67d8e29b6ffa970' },
  { legacy: 'core/config/configStore.js', implementation: 'src/modules/config/infrastructure/configStore.ts', kind: 'composition', reviewedSha256: 'e3e67595b296087799850131e887b99ffdaba71e6202e667e42e82a72a240cb7' },
  { legacy: 'model/config.js', implementation: 'src/modules/config/infrastructure/namedConfig.ts', kind: 'composition', reviewedSha256: '6ae8da4cd1cc092020e711d4137010d6e88a775661fd2375b2cdcb34fe2bf582' },
  { legacy: 'utils/thinkingForwardSettings.js', implementation: 'src/modules/config/infrastructure/thinkingForwardSettings.ts', kind: 'composition', reviewedSha256: '95b7f4d0dcba636dd3aedb545d075d451f4be5d9ec0b62537255a81365955751' },
  { legacy: 'models/Guoba/schemas/index.js', implementation: 'src/modules/config/application/configPanel.ts', kind: 'composition', reviewedSha256: 'a43fc0749d319eb95662567c49d55286253201637949332aa1fadf91004f4284' },
  { legacy: 'models/Guoba/configInfo.js', implementation: 'src/modules/config/application/configPanel.ts', kind: 'composition', reviewedSha256: '3dbdc0665f8ca75b2b94a7bf61e9bc78a56cf58f290b0a5dfd95b63bdbe0ef2a' },
  { legacy: 'utils/messageCacheTtl.js', implementation: 'src/modules/messaging/domain/messageCacheTtl.ts' },
  { legacy: 'utils/deliveryObservability.js', implementation: 'src/modules/messaging/domain/deliveryObservability.ts' },
  { legacy: 'utils/messagePipeline/leaseHeartbeat.js', implementation: 'src/modules/messaging/infrastructure/leaseHeartbeat.ts' },
  { legacy: 'utils/messagePipeline/keyedSerialQueue.js', implementation: 'src/modules/messaging/infrastructure/keyedSerialQueue.ts' },
  { legacy: 'utils/messagePipeline/outboundArbiter.js', implementation: 'src/modules/messaging/application/outboundArbiter.ts' },
  { legacy: 'utils/messagePipeline/videoThumbnail.js', implementation: 'src/modules/messaging/infrastructure/videoThumbnail.ts' },
  { legacy: 'utils/MessageManager.js', implementation: 'src/modules/messaging/application/recentMessages.ts', kind: 'composition', reviewedSha256: '595dbc7d8ae8b4978f205bd868278afadb5d2e1763a49331cbce20203e3106cd' },
  { legacy: 'utils/MessageArchiveManager.js', implementation: 'src/modules/messaging/infrastructure/messageArchive.ts', kind: 'composition', reviewedSha256: '9845549d27c773910460451818044f8963fae04e348ac1b0d724e8a3bf2d66e6' },
  { legacy: 'utils/messageStats.js', implementation: 'src/modules/messaging/application/messageStats.ts', kind: 'composition', reviewedSha256: 'f8c26f4c2984ed59d22c2f69302ea514fdcb4a8b6c49b792a1de192ee1f54bfd' },
  { legacy: 'utils/messagePipeline/mediaArtifactStore.js', implementation: 'src/modules/messaging/infrastructure/mediaArtifactStore.ts', kind: 'composition', reviewedSha256: 'bd551b351319fba8f9db0c415efae081b5964effed79f323604ccaecc497f428' },
  { legacy: 'utils/messagePipeline/mediaOutbox.js', implementation: 'src/modules/messaging/infrastructure/mediaOutbox.ts', kind: 'composition', reviewedSha256: 'd7f2c33371c8304e22475be5b4e9ff40ddc73133ee06baa044f145a1218e402f' },
  { legacy: 'utils/messagePipeline/runtime.js', implementation: 'src/adapters/pipelineForwardContext.ts', kind: 'composition', reviewedSha256: '1e7b0a744b15d4d35b591231fbb64c365af5976a8e805d4224348853f24eaa38' },
  { legacy: 'utils/messagePipeline/riskSignalMonitor.js', implementation: 'src/adapters/riskSignalMonitor.ts', kind: 'composition', reviewedSha256: '5dc9fda0dcabc2e111fb21fc183b1c7c9384611a62578894bf241463c16d090f' },
  { legacy: 'utils/messagePipeline/mediaRelayAdminReport.js', implementation: 'src/modules/messaging/infrastructure/mediaRelayAdminReport.ts', kind: 'composition', reviewedSha256: '205b325a338991e394481b03633d40a0f12a99c0d50598ed3f0c314cf0d92adc' },
  { legacy: 'utils/messagePipeline/outboundThrottle.js', implementation: 'src/modules/messaging/application/outboundThrottle.ts', kind: 'composition', reviewedSha256: '77afba8eebf49e2cf86a30ceb2753322b649df16480d3c104acc5374b9c3048e' },
  { legacy: 'utils/messagePipeline/redisJobStore.js', implementation: 'src/modules/messaging/infrastructure/redisJobStore.ts', kind: 'composition', reviewedSha256: '2f0644efb97fbac02357db64979da32e42045438986d41865bd237490e7d7c7d' },
  { legacy: 'utils/messagePipeline/eventEnvelope.js', implementation: 'src/modules/messaging/infrastructure/eventEnvelope.ts', kind: 'composition', reviewedSha256: '23056d33bc40a8639cb451dbbc5a6765a2c1c3dc3c57ed13578f6da60b833870' },
  { legacy: 'utils/messagePipeline/messagePipeline.js', implementation: 'src/modules/messaging/infrastructure/messagePipeline.ts', kind: 'composition', reviewedSha256: '6cb005e73456bfe3dee24d5d1d14e32a724c1f903b035f27af7b068da7a1d164' },
  { legacy: 'utils/messagePipeline/deliveryGateway.js', implementation: 'src/modules/messaging/infrastructure/deliveryGateway.ts', kind: 'composition', reviewedSha256: 'fb5d98a1631d1a1dee3728e8b26966ed19ac0cac0d3a71842770e72b7ce42c9b' },
  { legacy: 'console/lib/pipelineJobs.js', implementation: 'src/modules/messaging/application/pipelineJobs.ts' },
];
export function classify(path) {
  if (/(?:^|\/)(?:node_modules|vendor|dist|coverage|data)(?:\/|$)/.test(path)) return 'vendor-generated-data';
  if (/\.d\.(?:ts|mts|cts)$/.test(path)) return 'type-declaration';
  if (/(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\./.test(path)) return 'tests';
  if (/(?:^|\/)(?:examples?|samples?)(?:\/|$)/.test(path)) return 'examples';
  if (path.startsWith('console/frontend/')) return 'frontend';
  if (/^(?:scripts\/|.*\.config\.)/.test(path)) return 'tooling';
  if (/^(?:index\.js|guoba\.support\.js|standalone\/)/.test(path)) return 'entry';
  return 'business';
}
// Count lines touched by non-comment tokens, including code inside multiline literals.
export function codeLines(text) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, true, ts.LanguageVariant.Standard, text);
  const starts = ts.computeLineStarts(text);
  const lineAt = (position) => { let lo = 0, hi = starts.length; while (lo + 1 < hi) { const mid = (lo + hi) >>> 1; if (starts[mid] <= position) lo = mid; else hi = mid; } return lo; };
  const lines = new Set();
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    for (let line = lineAt(scanner.getTokenPos()); line <= lineAt(Math.max(scanner.getTokenPos(), scanner.getTextPos() - 1)); line++) lines.add(line);
  }
  return lines.size;
}
function entry(path, text) {
  const source = path.endsWith('.vue') ? [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]).join('\n') : text;
  return { path, category: classify(path), language: /\.(?:ts|mts|cts)$/.test(path) ? 'ts' : path.endsWith('.vue') ? 'vue-script' : 'js', codeLines: codeLines(source), bytes: Buffer.byteLength(text) };
}
function paths(args) { return execFileSync('git', args, { encoding: 'utf8' }).split('\0').filter(path => /\.(?:[cm]?[jt]s|vue)$/.test(path)); }
function structure(files) {
  const hostMembers = new Set(); let hostReferences = 0, globalAccesses = 0, bridgeReferences = 0;
  for (const item of files.filter(item => item.category === 'business')) {
    const text = readFileSync(item.path, 'utf8');
    const file = ts.createSourceFile(item.path, text, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isPropertyAccessExpression(node)) {
        if (ts.isIdentifier(node.expression) && node.expression.text === 'host') { hostReferences++; hostMembers.add(node.name.text); }
        if (ts.isIdentifier(node.expression) && ['global', 'globalThis', 'Bot', 'redis'].includes(node.expression.text)) globalAccesses++;
        if (ts.isIdentifier(node.expression) && node.expression.text === 'pluginBridge') bridgeReferences++;
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { hostMemberCount: hostMembers.size, hostReferences, globalPropertyAccesses: globalAccesses, pluginBridgePropertyReferences: bridgeReferences, method: 'AST direct named receiver references; alias and computed accesses are not inferred' };
}
export function verifyCompatibility(item, source) {
  if (item.kind === 'composition') return createHash('sha256').update(source).digest('hex') === item.reviewedSha256;
  const file = ts.createSourceFile(item.legacy, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const emitted = [item.implementation, ...(item.additionalImplementations || [])].map(path => resolve(path.replace(/^src\//, 'dist/backend/').replace(/\.ts$/, '.js')));
  return file.parseDiagnostics.length === 0 && file.statements.length > 0 && file.statements.every(statement =>
    ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) &&
    emitted.includes(resolve(item.legacy, '..', statement.moduleSpecifier.text)));
}
export function discoveredDebt(baselineFiles, currentFiles) {
  const known = new Set(baselineFiles.map(file => file.path));
  const discovered = currentFiles.filter(file => file.category === 'business' && file.language === 'js' && !known.has(file.path));
  return { modules: discovered.length, codeLines: discovered.reduce((sum, file) => sum + file.codeLines, 0), paths: discovered.map(file => file.path) };
}
export function report() {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  const files = [...new Set(paths(['ls-files', '-z', '--cached', '--others', '--exclude-standard']))].filter(path => existsSync(path)).sort().map(path => entry(path, readFileSync(path, 'utf8')));
  const registered = migrations.map(item => ({ ...item, present: [item.implementation, ...(item.additionalImplementations || []), ...(item.adapter ? [item.adapter] : [])].every(path => files.some(file => file.path === path)), thinWrapper: existsSync(item.legacy) && verifyCompatibility(item, readFileSync(item.legacy, 'utf8')) }));
  const completed = new Set(registered.filter(item => item.present && item.thinWrapper).map(item => item.legacy));
  const classifiedFiles = files.map(file => completed.has(file.path) ? { ...file, category: 'compatibility' } : file);
  const summarize = list => list.reduce((result, item) => { const key = `${item.category}:${item.language}`; const value = result[key] ??= { files: 0, codeLines: 0, bytes: 0 }; value.files++; value.codeLines += item.codeLines; value.bytes += item.bytes; return result; }, {});
  const business = files.filter(file => file.category === 'business' && !completed.has(file.path));
  const js = business.filter(file => file.language === 'js').reduce((sum, file) => sum + file.codeLines, 0);
  const tsLines = business.filter(file => file.language === 'ts').reduce((sum, file) => sum + file.codeLines, 0);
  const remaining = baseline.files.filter(file => file.category === 'business' && file.language === 'js' && !completed.has(file.path));
  return { baselineCommit: baseline.commit, metricVersion: baseline.metricVersion, current: summarize(classifiedFiles), compatibilityEntries: classifiedFiles.filter(file => file.category === 'compatibility'), discoveredBusinessJsDebt: discoveredDebt(baseline.files, classifiedFiles), businessJsCodeLinePercent: 100 * js / (js + tsLines), baselineRemaining: { modules: remaining.length, codeLines: remaining.reduce((sum, file) => sum + file.codeLines, 0), paths: remaining.map(file => file.path) }, registeredMigrations: registered, structure: { ...structure(files), sourceBoundaryViolations: checkTree().length }, limitations: 'Registered re-export wrappers are AST-validated; composition shims require exact reviewed SHA256 and both adapter/application TS sources. Newly discovered JS debt is separate from the immutable baseline; typecheck, behavior tests and runtime wiring are separate required gates. Vue measures script blocks only. Git language percentage is not this metric.' };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write-baseline')) {
    const files = paths(['ls-tree', '-r', '--name-only', '-z', baselineCommit]).sort().map(path => entry(path, execFileSync('git', ['show', `${baselineCommit}:${path}`], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })));
    writeFileSync(baselinePath, JSON.stringify({ metricVersion: 1, commit: baselineCommit, method: 'TypeScript scanner non-comment token lines; Vue script blocks only; fixed Git source inventory including JS/MJS/CJS/TS/Vue', files }, null, 2) + '\n');
  } else console.log(JSON.stringify(report(), null, 2));
}
