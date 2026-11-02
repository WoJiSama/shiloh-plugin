import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTokenLedger } from '../dist/backend/modules/models/infrastructure/tokenLedger.js'

function buildLedger() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'token-ledger-test-'))
  const ledger = createTokenLedger({ dataDir, now: () => 1770000000000 })
  // normalizeUsage 吃 OpenAI 风格字段
  const usage = { prompt_tokens: 19000, completion_tokens: 10, total_tokens: 19010, prompt_tokens_details: { cached_tokens: 18000 } }
  // 双轨记账实况：每笔调用一条 api/global 镜像 + 调用点一条归组行（stage='sim'/scope=群号）
  ledger.record({ scope: 'global', stage: 'api', model: 'm1', usage })
  ledger.record({ scope: '725902146', stage: 'sim', model: 'm1', usage })
  ledger.record({ scope: 'global', stage: 'api', model: 'm1', usage })
  ledger.record({ scope: '691626947', stage: 'sim', model: 'm1', usage })
  // 第三笔：只有镜像行（未归组调用，如主链路）
  ledger.record({ scope: 'global', stage: 'api', model: 'm2', usage })
  return { dataDir, ledger }
}

test('双轨记账下总额只数 api 镜像行，不把归组行重复累加', () => {
  const { dataDir, ledger } = buildLedger()
  try {
    const summary = ledger.summary()
    // 3 笔调用（不是 5 行）；tokens 按镜像行计
    assert.equal(summary.today.calls, 3)
    assert.equal(summary.today.tokens, 19010 * 3)
    // 按模型同样只数镜像行
    assert.equal(summary.today.byModel.m1.calls, 2)
    assert.equal(summary.today.byModel.m2.calls, 1)
    // 同形状调用等额：两个群各 1 笔、global 残差 1 笔，总额 = 3 × 单笔
    const scopes = Object.fromEntries(summary.today.byScopeTop.map(row => [row.scope, row.cost]))
    const eps = 0.0002
    assert.ok(Math.abs(scopes['725902146'] - scopes['691626947']) < eps, '两个群各一笔等额')
    assert.ok(Math.abs((scopes.global || 0) - scopes['725902146']) < eps, `未归组残差=单笔, global=${scopes.global}`)
    assert.ok(Math.abs(summary.today.cost - scopes['725902146'] * 3) < eps, '总额恰为三笔之和（无重复）')
    // 按链路只含归组行（sim = 两笔归组调用），镜像行不进链路表
    assert.equal(summary.today.byStage.sim.calls, 2)
    assert.equal(summary.today.byStage.api, undefined)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('series 只按镜像行聚合，柱高不翻倍', () => {
  const { dataDir, ledger } = buildLedger()
  try {
    const buckets = ledger.series(1, 6)
    const totals = buckets.reduce((acc, b) => ({ tokens: acc.tokens + b.tokens, calls: acc.calls + b.calls }), { tokens: 0, calls: 0 })
    assert.equal(totals.calls, 3, '镜像行每调用恰一条')
    assert.equal(totals.tokens, 19010 * 3)
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
