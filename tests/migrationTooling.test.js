import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, codeLines } from '../scripts/migration-report.mjs';
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
