import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createCharacterSubscriptions, createCharacterSubscriptionTools, fetchPublicFeed,
  isPublicFeedAddress, normalizePublicFeedUrl, parseFeed,
} from '../dist/backend/modules/simulation/infrastructure/characterSubscriptions.js'

const BASE = 1794200000000
const HOUR = 3600_000
const SCOPE = { botId: 'bot', personaId: 'persona', groupId: '10086' }
const rss = '<rss version="2.0"><channel><title>News</title><item><guid>release-1</guid><title>新版本</title><link>https://example.com/release/1</link><description><![CDATA[<b>公开</b>更新<script>bad()</script>]]></description><pubDate>Mon, 09 Nov 2026 04:00:00 GMT</pubDate></item></channel></rss>'
const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>atom-1</id><title>Atom更新</title><link href="https://example.com/atom/1" rel="alternate"/><summary>说明 &amp; 更多</summary><updated>2026-11-09T04:00:00Z</updated></entry></feed>'
function harness({ fetchFeed, scope = SCOPE, kv = new Map() } = {}) {
  const clock = { value: BASE }
  const redis = { async get(key) { return kv.get(key) ?? null }, async set(key, value) { kv.set(key, value); return 'OK' } }
  const service = createCharacterSubscriptions({ redis, scope, now: () => clock.value, fetchFeed: fetchFeed || (async () => parseFeed(rss, 'rss', 'https://example.com/feed', clock.value)) })
  return { service, kv, clock, redis, add: () => service.add({ title: '版本发布', kind: 'rss', url: 'https://example.com/feed' }) }
}

test('public feed URL and address validation rejects credentials and internal destinations', () => {
  assert.equal(normalizePublicFeedUrl('https://github.com/owner/repo', 'github'), 'https://api.github.com/repos/owner/repo/releases?per_page=16')
  assert.equal(normalizePublicFeedUrl('https://api.github.com/repos/owner/repo/releases?per_page=16', 'github'), 'https://api.github.com/repos/owner/repo/releases?per_page=16')
  for (const value of ['http://example.com/rss', 'https://u:p@example.com/rss', 'https://127.1/rss', 'https://0x7f000001/rss', 'https://[::1]/rss', 'https://localhost/rss', 'https://example.local/rss', 'https://example.com:8443/rss', 'https://example.com/rss?token=private']) assert.throws(() => normalizePublicFeedUrl(value), undefined, value)
  for (const value of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.1', '203.0.113.1', '::ffff:8.8.8.8', '2002:0808:0808::', '2001:db8::1', 'fc00::1', 'fe80::1', '::']) assert.equal(isPublicFeedAddress(value), false, value)
  assert.equal(isPublicFeedAddress('8.8.8.8'), true)
  assert.equal(isPublicFeedAddress('2606:4700:4700::1111'), true)
  assert.throws(() => normalizePublicFeedUrl('https://github.com/owner/repo/issues', 'github'))
})

test('RSS, Atom and GitHub parsing keep bounded plain public information and reject DTD', () => {
  const items = parseFeed(rss, 'rss', 'https://example.com/feed', BASE)
  assert.equal(items.length, 1)
  assert.equal(items[0].summary, '公开更新')
  assert.equal(items[0].receivedAt, BASE)
  assert.ok(items[0].publishedAt)
  const atomItems = parseFeed(atom, 'rss', 'https://example.com/feed', BASE)
  assert.equal(atomItems[0].url, 'https://example.com/atom/1')
  assert.equal(atomItems[0].summary, '说明 & 更多')
  const github = parseFeed(JSON.stringify([{ id: 1, name: 'v1', html_url: 'https://github.com/owner/repo/releases/tag/v1', body: '变更', published_at: '2026-11-09T04:00:00Z' }, { id: 2, name: 'private', html_url: 'https://github.com/owner/repo/releases/tag/v2', draft: true }]), 'github', 'https://api.github.com/repos/owner/repo/releases', BASE)
  assert.equal(github.length, 1)
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY p "expanded">]><rss/>', 'rss', 'https://example.com/feed', BASE), /DTD/)
  assert.throws(() => parseFeed('<html><body>Not a feed</body></html>', 'rss', 'https://example.com/feed', BASE), /RSS/)
  assert.throws(() => parseFeed('<rss><channel></rss>', 'rss', 'https://example.com/feed', BASE))
})

test('HTTP transport validates every DNS answer and redirect before requesting a pinned public IP', async () => {
  let requests = 0
  await assert.rejects(fetchPublicFeed('https://example.com/feed', 'rss', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
    request: async () => { requests++; return { status: 200, body: rss } },
  }), /非公共/)
  assert.equal(requests, 0)
  await assert.rejects(fetchPublicFeed('https://example.com/feed', 'rss', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => { requests++; return { status: 302, body: '', location: 'https://127.0.0.1/private' } },
  }), /公共/)
  assert.equal(requests, 1)
  const seen = []
  const result = await fetchPublicFeed('https://example.com/feed', 'rss', {
    lookup: async host => { seen.push(host); return [{ address: '8.8.8.8', family: 4 }] },
    request: async (url, address) => {
      assert.deepEqual(address, { address: '8.8.8.8', family: 4 })
      return url.hostname === 'example.com' ? { status: 302, body: '', location: 'https://news.example.org/rss' } : { status: 200, body: rss }
    },
  })
  assert.deepEqual(seen, ['example.com', 'news.example.org'])
  assert.equal(result.length, 1)
  await assert.rejects(fetchPublicFeed('https://example.com/feed', 'rss', {
    lookup: async () => [{ address: '8.8.8.8', family: 4 }],
    request: async () => ({ status: 302, body: '', location: '/again' }),
  }), /重定向/)
})

test('subscriptions poll no earlier than one hour, deduplicate after restart, and do not send messages', async () => {
  let fetches = 0
  const h = harness({ fetchFeed: async () => { fetches++; return parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value) } })
  const item = await h.add()
  assert.equal(item.nextPollAt, BASE + HOUR)
  assert.equal((await h.service.poll()).updates.length, 0)
  assert.equal(fetches, 0)
  h.clock.value += HOUR
  const first = await h.service.poll()
  assert.equal(first.updates.length, 1)
  assert.equal(first.failures, 0)
  const restarted = createCharacterSubscriptions({ redis: h.redis, scope: SCOPE, now: () => h.clock.value, fetchFeed: async () => { fetches++; return parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value) } })
  h.clock.value += HOUR
  assert.equal((await restarted.poll()).updates.length, 0)
  assert.equal(fetches, 2)
  const saved = (await restarted.list())[0]
  assert.equal(saved.seenIds.length, 1)
  assert.equal(saved.items.length, 1)
  assert.match(await restarted.unreadSummary(), /未经核实/)
  await assert.rejects(h.service.add({ title: '过于频繁', kind: 'rss', url: 'https://example.com/other', intervalMs: 1000 }), /检查间隔/)
  await assert.rejects(h.add(), /已存在/)
})

test('failed polls back off, preserve prior entries, and pause or remove invalidates late results', async () => {
  let resolve, entered = false
  const h = harness({ fetchFeed: async () => { entered = true; return await new Promise(done => { resolve = done }) } })
  const added = await h.add()
  h.clock.value += HOUR
  const poll = h.service.poll()
  while (!entered) await new Promise(done => setTimeout(done, 1))
  await h.service.pause(added.id, true)
  resolve(parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value))
  assert.equal((await poll).updates.length, 0)
  assert.equal((await h.service.list())[0].items.length, 0)
  assert.equal((await h.service.list())[0].status, 'paused')
  await h.service.pause(added.id, false)
  h.clock.value += HOUR
  entered = false
  const late = h.service.poll()
  while (!entered) await new Promise(done => setTimeout(done, 1))
  await h.service.remove(added.id)
  resolve(parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value))
  assert.equal((await late).updates.length, 0)
  assert.deepEqual(await h.service.list(), [])

  const failed = harness({ fetchFeed: async () => { throw new Error('offline') } })
  await failed.add(); failed.clock.value += HOUR
  assert.equal((await failed.service.poll()).failures, 1)
  const saved = (await failed.service.list())[0]
  assert.equal(saved.failures, 1)
  assert.equal(saved.nextPollAt, failed.clock.value + 2 * HOUR)
  failed.clock.value += HOUR
  assert.deepEqual(await failed.service.poll(), { updates: [], failures: 0 })
})

test('same scope concurrent polls share one operation and guard failures prevent network', async () => {
  let fetches = 0
  const h = harness({ fetchFeed: async () => { fetches++; await new Promise(done => setTimeout(done, 5)); return parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value) } })
  await h.add(); h.clock.value += HOUR
  const other = createCharacterSubscriptions({ redis: h.redis, scope: SCOPE, now: () => h.clock.value, fetchFeed: async () => { throw new Error('second fetch is wrong') } })
  const [one, two] = await Promise.all([h.service.poll(), other.poll()])
  assert.deepEqual(one, two)
  assert.equal(fetches, 1)
  h.clock.value += HOUR
  await assert.rejects(h.service.poll(async () => { throw new Error('paused') }), /paused/)
  assert.equal(fetches, 1)
})

test('poll timeout reports unknown, backs off, and cannot commit a late fetch result', async t => {
  let finish
  const late = new Promise(resolve => { finish = resolve })
  const nativeTimeout = globalThis.setTimeout
  t.mock.method(globalThis, 'setTimeout', (callback, delay, ...args) => nativeTimeout(callback, delay === 10_000 ? 1 : delay, ...args))
  const h = harness({ fetchFeed: async () => late })
  await h.add(); h.clock.value += HOUR

  assert.deepEqual(await h.service.poll(), { updates: [], failures: 1, unknowns: 1 })
  const afterTimeout = (await h.service.list())[0]
  assert.equal(afterTimeout.failures, 1)
  assert.equal(afterTimeout.nextPollAt, h.clock.value + 2 * HOUR)
  finish(parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value))
  await Promise.resolve()
  assert.deepEqual((await h.service.list())[0], afterTimeout)
  assert.deepEqual(await h.service.poll(), { updates: [], failures: 0 }, 'normal results retain their original shape')
})

test('guard cancellation during fetch propagates without committing late items or a failed result', async () => {
  let finish, started
  const entered = new Promise(resolve => { started = resolve })
  const h = harness({ fetchFeed: async () => { started(); return new Promise(resolve => { finish = resolve }) } })
  await h.add(); h.clock.value += HOUR
  let active = true
  const polling = h.service.poll(async () => { if (!active) throw new Error('activity cancelled') })
  const rejected = assert.rejects(polling, /activity cancelled/)
  await entered
  const claimed = await h.service.list()
  active = false
  finish(parseFeed(rss, 'rss', 'https://example.com/feed', h.clock.value))
  await rejected

  assert.deepEqual(await h.service.list(), claimed, 'only the pre-fetch claim persists after cancellation')
  assert.equal(claimed[0].failures, 0)
  assert.deepEqual(claimed[0].items, [])
  assert.deepEqual(await h.service.poll(), { updates: [], failures: 0 }, 'a cancelled operation releases the scope lock')
})

test('corrupt or foreign-scope state fails without overwriting persisted data', async () => {
  const h = harness(); await h.add()
  const key = [...h.kv.keys()][0]
  h.kv.set(key, '{broken')
  await assert.rejects(h.service.list())
  await assert.rejects(h.add())
  assert.equal(h.kv.get(key), '{broken')
  const valid = harness(); await valid.add()
  const validKey = [...valid.kv.keys()][0], raw = JSON.parse(valid.kv.get(validKey)); raw.scope.groupId = 'another-group'
  valid.kv.set(validKey, JSON.stringify(raw))
  await assert.rejects(valid.service.list(), /范围/)
})

test('subscription tools enforce action-specific parameters and bounded metadata/content', async () => {
  const h = harness(); let active = true
  const tool = createCharacterSubscriptionTools({ subscriptions: h.service, ensureActive: async () => { if (!active) throw new Error('inactive') } })[0]
  assert.match(await tool.execute({ action: 'add', title: 'bad', kind: 'rss', url: 'https://127.0.0.1/private' }, {}), /^error:/)
  assert.match(await tool.execute({ action: 'list', url: 'https://example.com/feed' }, {}), /^error:/)
  const added = await tool.execute({ action: 'add', title: '公开更新', kind: 'rss', url: 'https://example.com/feed' }, {})
  assert.equal(added.ok, true)
  h.clock.value += HOUR; await h.service.poll()
  const listed = await tool.execute({ action: 'list' }, {})
  assert.ok(JSON.stringify(listed).length < 3500)
  assert.equal(listed.subscriptions.length, 1)
  const read = await tool.execute({ action: 'read', id: added.subscription.id }, {})
  assert.equal(read.untrusted, true)
  assert.ok(JSON.stringify(read).length < 2000)
  active = false
  assert.match(await tool.execute({ action: 'read', id: added.subscription.id }, {}), /^error:/)
})
