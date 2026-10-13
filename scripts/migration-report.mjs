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
