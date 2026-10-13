import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { classify, codeLines, verifyCompatibility, discoveredDebt } from '../scripts/migration-report.mjs';
import { checkSource } from '../scripts/check-boundaries.mjs';

const path = 'src/modules/example/domain/policy.ts';
test('migration metrics exclude comments and blanks without stripping string content', () => {
  assert.equal(codeLines('// ignored\n\nconst url = "https://example.com";\n/* ignored\n ignored */\nconst n = 1;'), 2);
  assert.equal(codeLines('const s = `first\nsecond`;'), 2);
});
test('inventory separates tests, declarations, frontend, tooling and legacy business', () => {
  assert.equal(classify('console/frontend/src/App.vue'), 'frontend');
  assert.equal(classify('console/frontend/src/api.test.ts'), 'tests');
  assert.equal(classify('src/contracts/external.d.ts'), 'type-declaration');
  assert.equal(classify('utils/forwardBatches.js'), 'business');
  assert.equal(classify('scripts/build.mjs'), 'tooling');
  assert.equal(classify('standalone/chat/index.js'), 'entry');
});
test('boundaries reject external, legacy and infrastructure imports in pure layers', () => {
  for (const source of ['import fs from "node:fs";', 'export * from "../../../../utils/legacy.js";', 'import x from "../infrastructure/client.js";', 'type T = import("node:fs").PathLike;', 'import(somePath);']) {
    assert.ok(checkSource(path, source).length, source);
  }
  assert.deepEqual(checkSource(path, 'import type { Id } from "../../../contracts/id.js";'), []);
});
test('boundaries reject platform globals and extensionless imports but ignore comments and text', () => {
  assert.ok(checkSource(path, 'const bot = globalThis.Bot;').length);
  assert.ok(checkSource(path, 'import x from "./policy";').length);
  assert.deepEqual(checkSource(path, '// globalThis.Bot\nconst text = "pluginBridge.instance";'), []);
  assert.deepEqual(checkSource('src/adapters/qq.ts', 'import fs from "node:fs"; const b = globalThis.Bot;'), []);
});

test('migration wrappers must contain only real re-exports to their registered implementation', () => {
  const item = { legacy: 'utils/example.js', implementation: 'src/modules/example.ts' };
  assert.equal(verifyCompatibility(item, "// shim\nexport { foo } from '../dist/backend/modules/example.js';"), true);
  assert.equal(verifyCompatibility(item, "export { foo } from '../dist/backend/modules/example.js';\nconsole.log('business');"), false);
  assert.equal(verifyCompatibility(item, "export { foo } from '../dist/backend/modules/other.js';"), false);
  assert.equal(verifyCompatibility(item, "// export { foo } from '../dist/backend/modules/example.js';"), false);
  assert.equal(verifyCompatibility(item, "export const logic = 1; export { foo } from '../dist/backend/modules/example.js';"), false);
});
test('reviewed composition registration rejects every unreviewed source change', () => {
  const source = "import { create } from '../dist/backend/adapters/example.js';\nexport const runtime = create();";
  const item = { kind: 'composition', reviewedSha256: createHash('sha256').update(source).digest('hex') };
  assert.equal(verifyCompatibility(item, source), true);
  assert.equal(verifyCompatibility(item, source + '\nexport const hiddenBusiness = 1;'), false);
  assert.equal(verifyCompatibility({ ...item, reviewedSha256: undefined }, source), false);
});
test('newly discovered JS debt is reported without altering fixed baseline or counting compatibility as debt', () => {
  const baseline = [{ path: 'utils/old.js', category: 'business', language: 'js', codeLines: 10 }];
  const before = JSON.stringify(baseline);
  const current = [...baseline,
    { path: 'core/config/configStore.js', category: 'business', language: 'js', codeLines: 20 },
    { path: 'core/runtime/shim.js', category: 'compatibility', language: 'js', codeLines: 3 },
    { path: 'src/new.ts', category: 'business', language: 'ts', codeLines: 30 },
  ];
  assert.deepEqual(discoveredDebt(baseline, current), { modules: 1, codeLines: 20, paths: ['core/config/configStore.js'] });
  assert.equal(JSON.stringify(baseline), before);
});

test('multi-target wrappers only export audited emitted implementations', () => {
  const item = { legacy: 'utils/example.js', implementation: 'src/modules/example.ts', additionalImplementations: ['src/modules/second.ts'] };
  assert.equal(verifyCompatibility(item, "export { a } from '../dist/backend/modules/example.js'; export { b } from '../dist/backend/modules/second.js';"), true);
  assert.equal(verifyCompatibility(item, "export { b } from '../dist/backend/modules/unaudited.js';"), false);
});
test('explicitly renamed injected capability keys are not ambient globals', () => {
  assert.deepEqual(checkSource(path, 'const { redis: client } = ports; client.get("key");'), []);
  assert.ok(checkSource(path, 'const { redis } = ports; redis.get("key");').length);
});
