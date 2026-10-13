// Built-asset browser QA against loopback fixtures only. Never loads production config or calls Docker/Redis.
// Usage: npm run console:build && node tests/consoleFrontendSmoke.mjs
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer'
import YAML from 'yaml'
import { buildSchemaConfigView } from '../console/lib/schemaConfig.js'
import conversationSchema from '../models/configSchemas/conversation.js'
import reasoningSchema from '../models/configSchemas/reasoning.js'
import personaSchema from '../models/Guoba/schemas/persona.js'
import pipelineSchema from '../models/Guoba/schemas/messagePipeline.js'
import riskSchema from '../models/Guoba/schemas/riskControl.js'
import { AI_PROVIDER_DEFINITIONS } from '../utils/guobaAiProviderConfig.js'
import { buildDiceReplyPayload } from '../domains/dice/diceReplyCatalog.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'console/frontend/dist')
assert(fs.existsSync(path.join(dist, 'index.html')), 'Build console/frontend before running browser QA')
const screenshotDir = process.env.CONSOLE_SMOKE_OUTPUT || '/tmp/bl-console-vue-review'
fs.mkdirSync(screenshotDir, { recursive: true })
const defaults = YAML.parse(fs.readFileSync(path.join(root, 'config_default/message.yaml'), 'utf8')).pluginSettings || {}
const schemas = { conversation: conversationSchema, reasoning: reasoningSchema, pipeline: pipelineSchema, persona: personaSchema, riskControl: riskSchema }
const schemaViews = Object.fromEntries(Object.entries(schemas).map(([kind, schema]) => [kind, buildSchemaConfigView(kind, { title: kind, schema }, defaults)]))
// Even default files are treated as untrusted credential sources. Credentials in fixtures are always empty.
for (const view of Object.values(schemaViews)) for (const group of view.groups) for (const field of group.fields) if (field.secret) { field.value = ''; field.configured = true }
const accounts = [
  { account: '100001', container: 'napcat', running: true, status: 'running', loginState: '已登录', qrAvailable: false, memory: '186 MiB', exitIp: '192.0.2.11', sidecar: 'proxy-100001', fingerprint: { stable: true, changes: 0, firstSeen: '2026-10-01T00:00:00Z' } },
  { account: '200002', container: 'napcat-200002', running: false, status: 'exited', loginState: '掉线', qrAvailable: false, memory: '—', exitIp: null }
]
const traffic = { recv: 1234, send: 321, fail: 4 }
const library = { revision: 'fixture-library-r1', personas: [
  { id: 'friendly', name: '随和群友', identity: '熟悉的群友，善于接梗', tone: '随意自然', speechStyle: ['简短', '不客服'], moods: [{ name: '活泼', hint: '多接梗，语速快一点', probability: .12 }] },
  { id: 'careful', name: '安静观察者', identity: '在群聊中耐心倾听', preferences: ['游戏', '日常生活'], notes: '只在合适的时候加入讨论' }
], groupBindings: { '100001': 'friendly' }, accountBindings: { '100001': 'careful' }, privateBinding: '', basePersona: { name: '希洛', identity: '群里的真实群友', tone: '熟人、随意' } }
const ai = {
  definitions: AI_PROVIDER_DEFINITIONS.map(def => ({ configKey: def.configKey, title: def.title, usageHint: def.usageHint, urlPlaceholder: def.urlPlaceholder, modelPlaceholder: def.modelPlaceholder, kind: def.configKey.includes('image') ? 'image' : def.configKey.includes('embedding') ? 'embedding' : 'chat', extraFields: (def.extraFields || []).map(field => ({ field: field.panelField, label: field.label, placeholder: field.placeholder })) })),
  sections: Object.fromEntries(AI_PROVIDER_DEFINITIONS.map((def, index) => [def.configKey, [{ _consoleId: `c-${String(index).padStart(24, '0')}`, name: '主渠道', apiUrl: 'https://models.example.test/v1', model: def.modelPlaceholder || 'fixture-model', apiKey: '', apiKeyConfigured: true, priority: 1, autoResolve: true }]])),
  revisions: Object.fromEntries(AI_PROVIDER_DEFINITIONS.map(def => [def.configKey, 'fixture-ai-r1']))
}
const domains = [{ key: 'dice', name: '骰子与跑团', icon: '', desc: '骰子、人物卡与规则说明', order: 1, commands: [{ usage: '.r 1d100', desc: '掷骰', perm: 'all', src: 'domains/dice' }, { usage: '.骰规则启用 <包名>', desc: '启用规则', perm: 'admin', src: 'domains/dice' }, { usage: '.骰规则导入', desc: '导入规则', perm: 'master', src: 'domains/dice' }] }]
const dice = { ...buildDiceReplyPayload(defaults.diceSystem || {}), decks: [{ name: '故事开场', fileName: 'story.json', author: 'fixture', version: '1.0', visibleCount: 2, entryCount: 20, keys: ['开场', '遭遇'] }], packs: [{ id: 'sample-rule', name: '示例规则', versions: ['1.0'], enabledGroups: 1, commands: ['.sample'] }] }
const timing = { count: 20, avg: 1250, p50: 1100, p95: 2400 }
const observe = { report: { turns: 42, intents: [['chat', 30], ['tool', 12]], triggers: [['mention', 28]], routes: [['model', 42]], fastPathSkipCount: 3, totalMs: timing, modelStages: { reply: timing }, tools: { runs: 12, failures: 2, topFailures: [['mediaRelay', 2]] }, failureStages: [['send', 2]], outbound: { total: 60, avgPerTurn: 1.43 } }, hours: Array.from({ length: 24 }, (_, i) => ({ hour: `2026-10-12 ${String(i).padStart(2, '0')}`, turns: i % 7 + 1, failures: i % 5 === 0 ? 1 : 0 })), recent: [{ at: '14:20:00', group: '100001', trigger: 'mention', tools: 'mediaRelay', outbound: 2, totalMs: 2300, failures: ['send'] }] }
const memory = id => ({ id, text: '大家约好周末一起打游戏，下午三点在群里集合。', preview: '周末游戏约定', timeRange: '2026-10-12 12:00–12:30', messages: 8, speakers: '3 位群友', recallCount: 2, effectiveStrength: .8, vectorScore: .76 })
const semanticRequests = [], missingApis = [], browserErrors = [], externalRequests = [], checks = [], screenshots = []
let authMode = 'authenticated'
const json = (res, data, status = 200) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)) }
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j9zQAAAAASUVORK5CYII=', 'base64')
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1'), pathname = url.pathname
  if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return }
  if (pathname === '/api/auth/state') return json(res, { hasUser: authMode !== 'setup', username: authMode === 'authenticated' ? 'fixture-admin' : null, tokenWorks: false })
  if (pathname === '/api/identities') return json(res, { bots: [{ id: '100001', name: '长昵称示例机器人与桌游助手' }, { id: '200002', name: '离线测试机器人' }], groups: [{ id: '100001', name: '周末游戏交流与桌游活动安排群（长名称示例）' }] })
  if (pathname === '/api/overview/accounts') return json(res, { accounts })
  if (pathname === '/api/overview/stats') return json(res, { stats: { total: traffic, week: [{ ...traffic, day: '10-12' }], todayGroups: { '100001': traffic, '200002': { recv: 8, send: 2, fail: 0 } } } })
  if (pathname === '/api/sentinel') return json(res, { status: '正常', alerts: ['[WARN] napcat(100001) fixture登录状态告警', '[WARN] napcat-200002 fixture离线告警'] })
  if (pathname === '/api/bot/stats') return json(res, { today: traffic, failCodes: { timeout: 2, throttled_dropped: 2 } })
  if (pathname === '/api/groups') return json(res, { groups: [{ id: '100001', name: '周末游戏交流与桌游活动安排群（长名称示例）', whitelisted: true, today: traffic, bots: ['100001'] }, { id: '200002', name: '', whitelisted: false, today: { recv: 8, send: 2 }, bots: ['100001', '200002'] }] })
  if (pathname.startsWith('/api/config/')) return json(res, schemaViews[pathname.split('/').at(-1)] || {})
  if (pathname === '/api/persona/library') return json(res, library)
  if (pathname === '/api/persona/accounts') return json(res, { accounts: accounts.map(item => ({ qq: item.account, container: item.container, running: item.running })) })
  if (pathname === '/api/ai/config') return json(res, ai)
  if (pathname === '/api/observe/summary') return json(res, observe)
  if (pathname === '/api/image/providers') return json(res, { generation: [{ label: '主生图渠道', model: 'fixture-image', host: 'models.example.test' }], edit: [{ label: '编辑渠道', model: 'fixture-edit', host: 'models.example.test' }] })
  if (pathname === '/api/image/history') return json(res, [])
  if (pathname === '/api/pipeline/jobs') return json(res, { returned: 1, scanTruncated: false, retention: { eventMinutes: 360, deliveryHours: 24 }, jobs: [{ id: 'fixture-job', kind: 'delivery', state: 'failed', platform: 'bilibili', botId: '100001', groupId: '100001', lastError: '下载请求超时，将按策略重试', updatedAt: Date.now(), createdAt: Date.now() - 10000, attempts: 2 }] })
  if (pathname === '/api/qzone/bots') return json(res, { bots: [{ qq: '100001', nickname: '示例账号' }] })
  if (pathname.startsWith('/bl-chat/commands/api/')) {
    const endpoint = pathname.split('/api/')[1]
    if (endpoint === 'data') return json(res, { domains, commandCount: 3, loadError: '' })
    if (endpoint === 'dice-data') return json(res, dice)
    if (endpoint === 'emoji-data') return json(res, { items: Array.from({ length: 45 }, (_, i) => ({ hash: i.toString(16).padStart(12, 'a'), tags: ['反应', `素材${i + 1}`], usedCount: i, registeredAt: '2026-10-12T00:00:00Z', isBanned: i % 7 === 0 })), stats: { total: 45, banned: 7 } })
    if (endpoint === 'emoji-admission') return json(res, { allow: ['夸张的拟人反应'], reject: ['聊天记录截图'] })
    if (endpoint.startsWith('emoji-file/')) { res.writeHead(200, { 'content-type': 'image/png' }); res.end(pixel); return }
  }
  if (pathname.startsWith('/bl-chat/semantic-memory/api/')) {
    const endpoint = pathname.split('/api/')[1]
    if (endpoint === 'stats') return json(res, { enabled: true, store: { groups: 2, chunks: 42, diskMb: 1.2 }, config: { rerankEnabled: true, topK: 6 }, embedding: { model: 'fixture-embedding' }, retriever: { searches: 32 }, indexer: { indexed: 42 } })
    if (endpoint === 'eval-history') return json(res, { history: [{ at: '2026-10-12 10:00', samples: 20, recall: .85 }] })
    if (endpoint === 'playground') { semanticRequests.push({ method: 'GET', endpoint, group: url.searchParams.get('group'), query: url.searchParams.get('q') }); return json(res, { items: [memory('fixture-search')], elapsedMs: 80, vectorMs: 42, bm25Ms: 8 }) }
    if (endpoint === 'chunks') { const offset = Number(url.searchParams.get('offset') || 0); semanticRequests.push({ method: 'GET', endpoint, group: url.searchParams.get('group'), offset }); return json(res, { chunks: Array.from({ length: 20 }, (_, i) => memory(`chunk-${offset + i}`)), total: 42 }) }
    if (req.method === 'POST' && ['forget', 'reinforce'].includes(endpoint)) { const chunks = []; for await (const chunk of req) chunks.push(chunk); const body = JSON.parse(Buffer.concat(chunks).toString()); semanticRequests.push({ method: 'POST', endpoint, ...body }); return json(res, { ok: true, message: 'fixture更新成功' }) }
  }
  if (pathname === '/bl-chat/observe/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><html lang="zh"><body style="font:14px sans-serif;color:#8796ac;background:#191f29">本地运行明细 fixture</body></html>'); return }
  if (pathname.startsWith('/api/') || pathname.includes('/api/')) { missingApis.push(`${req.method} ${req.url}`); return json(res, { error: `Unmocked API ${pathname}` }, 404) }
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1), target = path.resolve(dist, relative)
  if (!target.startsWith(dist + path.sep) && target !== path.join(dist, 'index.html')) { res.writeHead(403); res.end(); return }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) { res.writeHead(404); res.end(); return }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[path.extname(target)] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': mime }); fs.createReadStream(target).pipe(res)
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port, origin = `http://127.0.0.1:${port}`
let browser, page
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const routes = [['/', '机器人'], ['/bot/100001', '100001'], ['/groups', '群聊'], ['/persona', '人设'], ['/ai', 'AI 模型'], ['/conversation', '对话设置'], ['/pipeline', '消息与搬运'], ['/risk', '风控管理'], ['/draw', '生图工作台'], ['/observe', '运行观测'], ['/observe/details', '运行观测明细'], ['/commands', '命令与骰子'], ['/semantic', '语义记忆']]
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
  page = await browser.newPage()
  await page.setRequestInterception(true)
  page.on('request', request => {
    const url = request.url()
    if (url.startsWith(origin) || url.startsWith('data:') || url.startsWith('blob:')) request.continue()
    else { externalRequests.push(url); request.abort() }
  })
  page.on('pageerror', error => browserErrors.push({ type: 'pageerror', message: error.message, url: page.url() }))
  page.on('console', item => { if (item.type() === 'error') browserErrors.push({ type: 'console', message: item.text(), url: page.url() }) })
  async function click(text, selector = 'button') {
    const handle = await page.evaluateHandle((label, query) => [...document.querySelectorAll(query)].find(element => element.getClientRects().length && element.textContent.trim() === label), text, selector)
    const element = handle.asElement()
    if (!element) { await page.screenshot({ path: path.join(screenshotDir, 'missing-control.png'), fullPage: true }); console.error(JSON.stringify(await page.evaluate(() => ({ text: document.body.innerText, controls: [...document.querySelectorAll('button,.n-tabs-tab')].map(element => ({ tag: element.tagName, text: element.textContent.trim(), rect: element.getClientRects().length })) })), null, 2)) }
    assert(element, `Missing visible ${selector} ${text} on ${page.url()}`)
    await element.click(); await handle.dispose(); await delay(100)
  }
  async function ready(title) { await page.waitForFunction(value => document.querySelector('h1')?.textContent.includes(value), { timeout: 8000 }, title); await page.waitForNetworkIdle({ idleTime: 100, timeout: 5000 }); await delay(120) }
  async function check(label) {
    await delay(80)
    const result = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, bodyWidth: document.body.scrollWidth, overflow: [...document.querySelectorAll('body *')].filter(element => { const rect = element.getBoundingClientRect(); return rect.width && rect.right > innerWidth + 1 && getComputedStyle(element).position !== 'fixed' }).slice(0, 10).map(element => ({ tag: element.tagName, class: element.className?.baseVal ?? element.className, width: element.getBoundingClientRect().width, right: element.getBoundingClientRect().right })) }))
    checks.push({ label, ...result, ok: result.documentWidth <= result.width + 1 && result.bodyWidth <= result.width + 1 })
  }
  async function screenshot(name) { const target = path.join(screenshotDir, `${name}.png`); await page.screenshot({ path: target, fullPage: true }); screenshots.push(target) }
  const widths = process.env.CONSOLE_SMOKE_WIDTHS?.split(',').map(Number) || [1440, 736, 320]
  const themes = process.env.CONSOLE_SMOKE_THEMES?.split(',') || ['dark', 'light']
  const selectedRoutes = process.env.CONSOLE_SMOKE_ROUTES?.split(',')
  for (const width of widths) for (const theme of themes) {
    console.log(`Checking built console: ${width}px ${theme}`)
    await page.setViewport({ width, height: 900, deviceScaleFactor: 1 })
    await page.goto(origin, { waitUntil: 'networkidle0' })
    await page.evaluate(value => localStorage.setItem('bl-console-theme', value), theme)
    await page.reload({ waitUntil: 'networkidle0' })
    assert.equal(await page.$eval('html', element => element.dataset.theme), theme)
    for (const [route, title] of routes) {
      if (selectedRoutes && !selectedRoutes.includes(route)) continue
      await page.goto(`${origin}/#${route}`, { waitUntil: 'networkidle0' }); await ready(title)
      const label = `${width}-${theme}-${route.replace(/\//g, '_') || 'home'}`
      await check(label)
      const blankTabs = await page.$$eval('.n-tabs-tab', elements => elements.filter(element => element.getClientRects().length && !element.textContent.trim()).map(element => element.getAttribute('data-name')))
      if (blankTabs.length) browserErrors.push({ type: 'blank-tabs', message: `Empty labels: ${blankTabs.join(', ')}`, url: page.url() })
      if (route === '/') assert.match(await page.$eval('.alerts-list', element => element.textContent), /长昵称示例机器人与桌游助手/)
      if (route === '/' || route === '/bot/100001') {
        assert.match(await page.$eval('.account-card', element => element.textContent), /长昵称示例机器人与桌游助手/)
      }
      if (route === '/groups') {
        assert.match(await page.$eval('.group-bot-links', element => element.textContent), /长昵称示例机器人与桌游助手/)

        assert.deepEqual(await page.$$eval('.group-name', elements => elements.map(element => element.textContent)), ['周末游戏交流与桌游活动安排群（长名称示例）', '群名未获取'])
        await page.type('.group-filters input', '活动安排'); await delay(150)
        assert.equal(await page.$$eval('.group-identity', elements => elements.length), 1)
        await click('100001'); await page.waitForSelector('.drawer-group-name')
        assert.match(await page.$eval('.drawer-group-name', element => element.textContent), /周末游戏交流/)
        await page.keyboard.press('Escape'); await page.waitForSelector('.n-drawer', { hidden: true })
        await page.$eval('.group-filters input', element => { element.value = ''; element.dispatchEvent(new Event('input', { bubbles: true })) }); await delay(150)
        await check(`${label}-group-names`); await screenshot(`${label}-group-names`)
      }
      if (route === '/commands') {
        for (const text of ['骰子回复', '牌堆与规则', '表情包', '命令总表']) { await click(text); await check(`${label}-${text}`) }
      }
      if (route === '/persona') {
        for (const text of ['账号与会话绑定', '默认人设与画像', '人设库']) { await click(text, '.n-tabs-tab'); if (text === '账号与会话绑定') { assert.match(await page.$eval('.binding-panel', element => element.textContent), /长昵称示例机器人与桌游助手/); assert.match(await page.$$eval('.binding-panel', elements => elements.map(element => element.textContent).join(' ')), /周末游戏交流/); } await check(`${label}-${text}`); if (text === '默认人设与画像' && width === 320 && theme === 'light') await screenshot('persona-default-long-tags-mobile') }
      }
      if (route === '/conversation') {
        for (const text of ['访问权限', '上下文与路由', '任务模型', '回复方式', '触发与私聊']) {
          await click(text, '.n-tabs-tab'); await check(`${label}-${text}`)
          if (text === '任务模型') assert.equal(await page.$eval('#field-taskAiConfig-casual-maxOutputTokens', e => e.value), '1200')
          if ((width === 1440 && theme === 'dark') || (width === 320 && theme === 'light')) await screenshot(`${label}-${text}`)
        }
      }
      if (route === '/pipeline') {
        if (width === 1440 && theme === 'dark') await screenshot('pipeline-config-desktop')
        for (const text of ['平台授权', '健康报告', '可靠管道']) { await click(text, '.n-tabs-tab'); await check(`${label}-${text}`) }
        if (width === 1440 && theme === 'dark') { await click('平台授权', '.n-tabs-tab'); await screenshot('pipeline-authorization-desktop'); await click('可靠管道', '.n-tabs-tab') }
        await click('任务记录'); await page.waitForNetworkIdle({ idleTime: 100 }); await check(`${label}-任务记录`)
        assert.match(await page.$eval('.job-row', element => element.textContent), /长昵称示例机器人与桌游助手/)
        assert.match(await page.$eval('.job-row', element => element.textContent), /周末游戏交流/)
        await page.click('.job-row'); await page.waitForSelector('.detail-list .identity-label'); await delay(350)
        assert.match(await page.$eval('.detail-list', element => element.textContent), /长昵称示例机器人与桌游助手/)
        assert.match(await page.$eval('.detail-list', element => element.textContent), /周末游戏交流/)
        await check(`${label}-任务详情`); await page.keyboard.press('Escape'); await page.waitForSelector('.n-drawer', { hidden: true })
      }
      if (route === '/observe') assert.match(await page.$eval('.recent-panel', element => element.textContent), /周末游戏交流/)
      if (route === '/semantic') for (const text of ['分块管理', '评估历史', '运行信息', '检索测试']) { await click(text); await check(`${label}-${text}`) }
      if (width === 1440 && theme === 'dark' && ['/pipeline', '/ai', '/persona', '/commands', '/observe'].includes(route)) await screenshot(label)
      if (width === 320 && theme === 'light' && ['/pipeline', '/persona', '/commands', '/semantic'].includes(route)) await screenshot(label)
    }
  }
  // The desktop shortcut really filters, and the mobile drawer navigates with an actual click.
  await page.setViewport({ width: 1440, height: 900 })
  await page.goto(`${origin}/#/`, { waitUntil: 'networkidle0' }); await ready('机器人')
  await click('重启', '.account-actions button'); await page.waitForSelector('.n-dialog'); assert.match(await page.$eval('.n-dialog', element => element.textContent), /100001 · 长昵称示例机器人与桌游助手/); await click('取消', '.n-dialog button'); await page.waitForSelector('.n-dialog', { hidden: true })
  await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta')
  await page.waitForSelector('.search-modal input')
  await page.type('.search-modal input', 'AI')
  await delay(100)
  assert.deepEqual(await page.$$eval('.search-results button', elements => elements.map(element => element.innerText.split('\n')[0])), ['AI 模型'])
  await page.click('.search-results button'); await ready('AI 模型'); await check('desktop-quick-search')
  await page.waitForSelector('.search-modal', { hidden: true }); await delay(150)
  for (const [term, expected] of [['长昵称', '/bot/100001'], ['活动安排', '/groups?group=100001']]) {
    await page.keyboard.down('Meta'); await page.keyboard.press('k'); await page.keyboard.up('Meta'); await page.waitForSelector('.search-modal input')
    await page.type('.search-modal input', term); await delay(100)
    assert.equal(await page.$$eval('.search-results button', elements => elements.length), 1)
    await page.click('.search-results button'); await page.waitForFunction(value => location.hash === '#' + value, {}, expected)
    await page.waitForSelector('.search-modal', { hidden: true }); await delay(150)
  }
  assert.equal(await page.$eval('.group-filters input', element => element.value), '100001')

  await page.setViewport({ width: 320, height: 900 })
  await page.click('button[aria-label="打开导航"]'); await page.waitForSelector('.n-drawer'); await delay(400)
  await page.evaluate(() => document.querySelector('.n-drawer a[href="#/groups"]').scrollIntoView())
  await page.click('.n-drawer a[href="#/groups"]'); await ready('群聊')
  await page.waitForSelector('.n-drawer', { hidden: true }); await check('mobile-drawer-navigation')
  for (const mode of ['login', 'setup']) {
    authMode = mode
    await page.reload({ waitUntil: 'networkidle0' }); await page.waitForSelector('.auth-page')
    assert.equal(await page.$$eval('.auth-page input[type="password"]', elements => elements.length), mode === 'setup' ? 2 : 1)
    await check(`320-${mode}`)
    await screenshot(`auth-${mode}-mobile`)
  }
  authMode = 'authenticated'
  // Result ownership stays fixed when the inputs change; destructive confirmation captures its result owner.
  await page.setViewport({ width: 1440, height: 900 })
  // A query change forces a full boot after changing mock auth; hash navigation keeps the current boot state.
  await page.goto(`${origin}/?auth-restored=1#/semantic`, { waitUntil: 'networkidle0' }); await ready('语义记忆')
  const typeInto = async (selector, value) => { await page.$eval(selector, element => { element.value = ''; element.dispatchEvent(new Event('input', { bubbles: true })) }); await page.type(selector, value) }
  await typeInto('input[placeholder="输入完整群号"]', '100001'); await typeInto('input[placeholder="想找回什么记忆？"]', '周末游戏'); await click('检索'); await page.waitForNetworkIdle({ idleTime: 100 })
  await typeInto('input[placeholder="输入完整群号"]', '200002'); await click('忘记'); await page.waitForSelector('.n-dialog')
  assert.match(await page.$eval('.n-dialog', element => element.textContent), /群 100001/)
  await click('忘记', '.n-dialog button'); await page.waitForNetworkIdle({ idleTime: 100 })
  await page.waitForSelector('.n-dialog', { hidden: true }); await delay(200)
  assert.deepEqual(semanticRequests.filter(request => request.endpoint === 'forget').at(-1), { method: 'POST', endpoint: 'forget', group: '100001', id: 'fixture-search' })
  await click('分块管理'); await typeInto('input[placeholder="输入完整群号"]', '100001'); await click('浏览'); await page.waitForNetworkIdle({ idleTime: 100 })
  await typeInto('input[placeholder="输入完整群号"]', '200002'); await click('2', '.n-pagination-item'); await page.waitForNetworkIdle({ idleTime: 100 })
  assert.deepEqual(semanticRequests.filter(request => request.endpoint === 'chunks').at(-1), { method: 'GET', endpoint: 'chunks', group: '100001', offset: 20 })
  await screenshot('semantic-snapshot-context')
  const report = { builtAt: fs.statSync(path.join(dist, 'index.html')).mtime.toISOString(), checks, failures: checks.filter(check => !check.ok), browserErrors, missingApis, externalRequests, semanticRequests, screenshots }
  fs.writeFileSync(path.join(screenshotDir, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ checks: checks.length, failures: report.failures, browserErrors, missingApis, externalRequests, semanticSnapshots: 'passed', screenshots, report: path.join(screenshotDir, 'report.json') }, null, 2))
  assert.equal(missingApis.length, 0, 'Browser requested unmocked APIs')
  assert.equal(externalRequests.length, 0, 'Browser attempted an external request')
  assert.equal(browserErrors.length, 0, 'Browser emitted errors')
  assert.equal(report.failures.length, 0, 'One or more pages have horizontal document overflow')
} catch (error) {
  const partial = { error: String(error), builtAt: fs.statSync(path.join(dist, 'index.html')).mtime.toISOString(), checks, failures: checks.filter(check => !check.ok), browserErrors, missingApis, externalRequests, semanticRequests, screenshots }
  fs.writeFileSync(path.join(screenshotDir, 'report-partial.json'), JSON.stringify(partial, null, 2))
  if (page) await page.screenshot({ path: path.join(screenshotDir, 'failure.png'), fullPage: true }).catch(() => {})
  throw error
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)) }
