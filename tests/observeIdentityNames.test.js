import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { registerObserveWebApp } from '../utils/observeWebApp.js'

test('observe retains full group IDs and escapes group names in initial HTML and rendered tables', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'observe-names-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const directory = path.join(root, 'data', 'turn_trace')
  fs.mkdirSync(directory, { recursive: true })
  const at = new Date(), pad = value => String(value).padStart(2, '0')
  const file = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.ndjson`
  const name = '</script><img src=x onerror=alert(1)>'
  fs.writeFileSync(path.join(root, 'data', 'group_names.json'), JSON.stringify({ '123456789': name }))
  fs.writeFileSync(path.join(directory, file), JSON.stringify({ turnId: 'fixture', groupId: '123456789', at: at.toISOString(), tools: [], outbound: 0 }) + '\n')
  let handler
  registerObserveWebApp({ use: (_, callback) => { handler = callback } }, root, { token: 'fixture-only', observeToken: 'fixture-only' })
  let payload, html
  const response = { set() { return this }, status() { return this }, type() { return this }, json(value) { payload = value }, send(value) { html = value } }
  await handler({ path: '/api/stats', query: {}, headers: { 'x-commands-token': 'fixture-only' } }, response, () => {})
  assert.equal(payload.recentTurns[0].group, '123456789')
  assert.equal(payload.recentTurns[0].groupName, name)
  await handler({ path: '/', query: {}, headers: {} }, response, () => {})
  assert.equal(html.includes(name), false, 'a group name must not terminate the script element')
  const initial = html.match(/window\.__OBSERVE_SSR__=(.*?)<\/script>/s)[1]
  assert.equal(JSON.parse(initial).groups[0].groupName, name)
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  const elements = new Map()
  const context = vm.createContext({ document: { getElementById: id => { if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', style: {} }); return elements.get(id) } }, window: {}, URLSearchParams, location: { search: '', pathname: '/' }, history: { replaceState() {} }, console, setInterval: () => {}, fetch: () => new Promise(() => {}) })
  vm.runInContext(scripts.at(-1)[1], context)
  context.fixture = payload
  vm.runInContext('render(fixture)', context)
  const rendered = elements.get('app').innerHTML
  assert.match(rendered, /123456789/)
  assert.equal(rendered.includes('<img src=x'), false)
  assert.match(rendered, /&lt;\/script&gt;&lt;img/)
})
