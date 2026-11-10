import { randomUUID } from 'node:crypto'
import type { CharacterScope } from '../../../contracts/character.js'
import type { CharacterWork, CharacterWorkState, CharacterWorkVersion } from '../../../contracts/characterActivities.js'
import { characterKey, validateCharacterScope } from '../domain/characterState.js'
import type { CharacterRedis } from './characterStore.js'
import { createScopedStateStore } from './scopedStateStore.js'
import { AbstractTool } from '../../toolSupport/infrastructure/AbstractTool.js'

const MAX_WORKS = 24, MAX_VERSIONS = 12, MAX_CONTENT = 12_000
const MAX_LIST_CHARS = 3500, MAX_READ_CHARS = 2000
const WORK_KINDS = ['note', 'research', 'story'] as const
type WorkKind = typeof WORK_KINDS[number]

function fail(field: string): never { throw new Error(`作品空间无效：${field}`) }
function object(value: unknown, fields: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(field)
  const raw = value as Record<string, unknown>
  if (Object.keys(raw).some(key => !fields.includes(key))) fail(`${field} 有未知字段`)
  return raw
}
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(field)
  return value
}
function id(value: unknown, field = 'id'): string {
  const checked = text(value, field, 128)
  if (checked !== checked.trim() || /[\u0000-\u001f\u007f]/u.test(checked)) fail(field)
  return checked
}
function integer(value: unknown, field: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) fail(field)
  return value
}
function kind(value: unknown): WorkKind {
  if (typeof value !== 'string' || !WORK_KINDS.includes(value as WorkKind)) fail('kind')
  return value as WorkKind
}
function references(value: unknown, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && !value.length) || value.length > (allowEmpty ? 8192 : 16)) fail('evidenceRefs')
  const refs = value.map(ref => text(ref, 'evidenceRef', 180))
  if (new Set(refs).size !== refs.length || refs.some(ref => !/^(?:message:[1-9]\d*|receipt:[^\s:][^\s]*|memory:[^\s:][^\s]*)$/u.test(ref))) fail('evidenceRefs')
  return refs
}
function sharedReferences(value: unknown, max = 32): string[] {
  if (!Array.isArray(value) || value.length > max) fail('sharedSources')
  const checked = value.map(value => id(value, 'sharedSource'))
  if (new Set(checked).size !== checked.length) fail('sharedSources 重复')
  return checked
}
function sameScope(value: unknown, scope: CharacterScope): CharacterScope {
  const checked = validateCharacterScope(value)
  if (checked.botId !== scope.botId || checked.personaId !== scope.personaId || checked.groupId !== scope.groupId) fail('scope 不符')
  return checked
}
function version(value: unknown): CharacterWorkVersion {
  const raw = object(value, ['revision', 'content', 'evidenceRefs', 'createdAt', 'sharedSources'], 'version')
  return { revision: integer(raw.revision, 'version.revision', 1), content: text(raw.content, 'content', MAX_CONTENT), evidenceRefs: references(raw.evidenceRefs), createdAt: integer(raw.createdAt, 'version.createdAt'), ...(raw.sharedSources === undefined ? {} : { sharedSources: sharedReferences(raw.sharedSources) }) }
}
function work(value: unknown): CharacterWork {
  const raw = object(value, ['id', 'title', 'kind', 'status', 'revision', 'versions', 'createdAt', 'updatedAt'], 'work')
  if (!Array.isArray(raw.versions) || !raw.versions.length || raw.versions.length > MAX_VERSIONS) fail('versions')
  const versions = raw.versions.map(version)
  for (let index = 1; index < versions.length; index++) {
    if (versions[index]!.revision <= versions[index - 1]!.revision || versions[index]!.createdAt < versions[index - 1]!.createdAt) fail('versions 顺序')
  }
  if (raw.status !== 'draft' && raw.status !== 'archived') fail('status')
  const result: CharacterWork = {
    id: id(raw.id), title: text(raw.title, 'title', 120), kind: kind(raw.kind), status: raw.status,
    revision: integer(raw.revision, 'revision', 1), versions,
    createdAt: integer(raw.createdAt, 'createdAt'), updatedAt: integer(raw.updatedAt, 'updatedAt'),
  }
  if (result.updatedAt < result.createdAt || versions.some(v => v.createdAt < result.createdAt || v.createdAt > result.updatedAt || v.revision > result.revision)) fail('work 时间或版本水位')
  return result
}

export function createCharacterWorkspace({ redis, scope: requestedScope, now = Date.now }: { redis: CharacterRedis; scope: CharacterScope; now?: () => number }) {
  const scope = validateCharacterScope(requestedScope)
  const store = createScopedStateStore<CharacterWorkState>({
    redis, key: `${characterKey(scope)}:workspace`,
    empty: () => ({ schemaVersion: 1, scope: { ...scope }, works: [] }),
    validate(value) {
      const raw = object(value, ['schemaVersion', 'scope', 'works'], 'state')
      if (raw.schemaVersion !== 1 || !Array.isArray(raw.works) || raw.works.length > MAX_WORKS) fail('state')
      const works = raw.works.map(work)
      if (new Set(works.map(w => w.id)).size !== works.length) fail('重复作品 id')
      return { schemaVersion: 1, scope: sameScope(raw.scope, scope), works }
    },
  })
  function target(state: CharacterWorkState, rawId: unknown): CharacterWork {
    const checkedId = id(rawId)
    const found = state.works.find(item => item.id === checkedId)
    if (!found) fail('作品不存在')
    return found
  }
  function checkRevision(item: CharacterWork, expected: unknown): void {
    if (integer(expected, 'expectedRevision', 1) !== item.revision) throw new Error('作品已更新，请重新读取后再修改')
  }
  function at(item?: CharacterWork): number { return Math.max(integer(now(), 'now'), item?.updatedAt ?? 0) }
  function append(item: CharacterWork, content: string, evidenceRefs: string[], sharedSources: string[] = []): void {
    const time = at(item)
    item.revision += 1
    item.versions.push({ revision: item.revision, content, evidenceRefs: [...evidenceRefs], createdAt: time, ...(sharedSources.length ? { sharedSources: [...sharedSources] } : {}) })
    item.versions = item.versions.slice(-MAX_VERSIONS)
    item.updatedAt = time
  }
  return {
    async list(): Promise<CharacterWork[]> { return (await store.load()).works },
    async read(rawId: string, rawRevision?: number): Promise<CharacterWork> {
      const item = target(await store.load(), rawId)
      if (rawRevision === undefined) return item
      const selected = item.versions.find(v => v.revision === integer(rawRevision, 'revision', 1))
      if (!selected) fail('版本不存在或已超出保留窗口')
      return { ...item, versions: [selected] }
    },
    async write(input: { id?: string; title: string; kind: WorkKind; content: string; evidenceRefs: string[]; expectedRevision?: number; sharedSources?: string[] }): Promise<CharacterWork> {
      const raw = object(input, ['id', 'title', 'kind', 'content', 'evidenceRefs', 'expectedRevision', 'sharedSources'], 'write')
      const title = text(raw.title, 'title', 120), content = text(raw.content, 'content', MAX_CONTENT)
      const checkedKind = kind(raw.kind), refs = references(raw.evidenceRefs)
      const sharedSources = raw.sharedSources === undefined ? [] : sharedReferences(raw.sharedSources)
      const checkedId = raw.id === undefined ? `work-${randomUUID()}` : id(raw.id)
      if (raw.id === undefined && raw.expectedRevision !== undefined) fail('新作品不接受 expectedRevision')
      const next = await store.update(state => {
        if (raw.id === undefined) {
          if (state.works.length >= MAX_WORKS) fail('作品容量已满，请先删除旧作')
          const time = at()
          state.works.push({ id: checkedId, title, kind: checkedKind, status: 'draft', revision: 1, versions: [{ revision: 1, content, evidenceRefs: refs, createdAt: time, ...(sharedSources.length ? { sharedSources } : {}) }], createdAt: time, updatedAt: time })
        } else {
          const item = target(state, checkedId)
          checkRevision(item, raw.expectedRevision)
          if (item.status !== 'draft') fail('归档作品须先恢复草稿')
          item.title = title; item.kind = checkedKind
          append(item, content, refs, sharedSources)
        }
        return state
      })
      return target(next, checkedId)
    },
    async restore(rawId: string, rawRevision: number, expectedRevision?: number): Promise<CharacterWork> {
      const checkedId = id(rawId), checkedRevision = integer(rawRevision, 'revision', 1)
      const next = await store.update(state => {
        const item = target(state, checkedId)
        checkRevision(item, expectedRevision)
        const selected = item.versions.find(v => v.revision === checkedRevision)
        if (!selected) fail('版本不存在或已超出保留窗口')
        item.status = 'draft'
        append(item, selected.content, selected.evidenceRefs, selected.sharedSources)
        return state
      })
      return target(next, checkedId)
    },
    async archive(rawId: string, archived: boolean): Promise<CharacterWork> {
      const checkedId = id(rawId)
      if (typeof archived !== 'boolean') fail('archived')
      const next = await store.update(state => {
        const item = target(state, checkedId), status = archived ? 'archived' : 'draft'
        if (item.status !== status) { item.status = status; item.revision += 1; item.updatedAt = at(item) }
        return state
      })
      return target(next, checkedId)
    },
    async remove(rawId: string): Promise<void> {
      const checkedId = id(rawId)
      await store.update(state => { target(state, checkedId); state.works = state.works.filter(item => item.id !== checkedId); return state })
    },
    async pruneEvidence(validRefs: string[]): Promise<void> {
      const valid = new Set(references(validRefs, true))
      await store.update(state => {
        for (const item of state.works) {
          const retained = item.versions.filter(v => v.evidenceRefs.every(ref => !/^(?:memory|receipt):/u.test(ref) || valid.has(ref)))
          if (retained.length !== item.versions.length) {
            item.versions = retained; item.title = '来源已整理的作品'; item.revision += 1; item.updatedAt = at(item)
          }
        }
        state.works = state.works.filter(item => item.versions.length)
        return state
      })
    },
    async pruneShared(activeIds: string[]): Promise<void> {
      const active = new Set(sharedReferences(activeIds, 8192))
      await store.update(state => {
        for (const item of state.works) {
          const retained = item.versions.filter(v => (v.sharedSources || []).every(source => active.has(source)))
          if (retained.length !== item.versions.length) {
            item.versions = retained; item.title = '来源已整理的作品'; item.revision += 1; item.updatedAt = at(item)
          }
        }
        state.works = state.works.filter(item => item.versions.length)
        return state
      })
    },
  }
}

export type CharacterWorkspace = ReturnType<typeof createCharacterWorkspace>

export function createCharacterWorkspaceTools({ workspace, visibleEvidenceRefs, ensureActive, sharedSourceIds }: {
  workspace: CharacterWorkspace; visibleEvidenceRefs(): string[]; ensureActive(): Promise<void>; sharedSourceIds?(): string[]
}): AbstractTool[] {
  function visible(refs: string[]): void {
    const available = new Set(visibleEvidenceRefs())
    if (references(refs).some(ref => !available.has(ref))) throw new Error('作品引用了本轮不可见的来源')
  }
  class WorkspaceTool extends AbstractTool {
    constructor() {
      super()
      this.name = 'simWorkspace'
      this.description = '管理当前角色在本群的作品草稿：list分页查看目录，read按版本分段阅读，write创建或提交新版本（修改须expectedRevision），restore把旧内容复制为新版本，archive归档或恢复草稿。写入须可见来源，不能访问任意文件或执行代码；保存草稿不等于已经向群里分享。'
      this.parameters = {
        type: 'object', additionalProperties: false, required: ['action'], properties: {
          action: { type: 'string', enum: ['list', 'read', 'write', 'restore', 'archive'] },
          id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: [...WORK_KINDS] },
          content: { type: 'string' }, evidenceRefs: { type: 'array', items: { type: 'string' } },
          expectedRevision: { type: 'number', minimum: 1 }, revision: { type: 'number', minimum: 1 },
          beforeId: { type: 'string' }, offset: { type: 'number', minimum: 0 }, limit: { type: 'number', minimum: 1, maximum: MAX_READ_CHARS },
          archived: { type: 'boolean' },
        },
      }
    }
    override validateParameters(params: Record<string, unknown>) {
      const unknown = Object.keys(params).find(key => !(key in this.parameters.properties))
      return unknown ? `不支持的参数: ${unknown}` : super.validateParameters(params)
    }
    override async func(input: Record<string, unknown>) {
      await ensureActive()
      const action = text(input.action, 'action', 20)
      const fieldSets: Record<string, string[]> = {
        list: ['action', 'beforeId'], read: ['action', 'id', 'revision', 'offset', 'limit'],
        write: ['action', 'id', 'title', 'kind', 'content', 'evidenceRefs', 'expectedRevision'],
        restore: ['action', 'id', 'revision', 'expectedRevision'], archive: ['action', 'id', 'archived'],
      }
      if (!fieldSets[action]) fail('action')
      object(input, fieldSets[action]!, action)
      if (action === 'list') {
        const items = (await workspace.list()).sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id))
        let start = 0
        if (input.beforeId !== undefined) {
          const index = items.findIndex(item => item.id === id(input.beforeId, 'beforeId'))
          if (index < 0) fail('beforeId 不存在')
          start = index + 1
        }
        const works: { id: string; title: string; kind: WorkKind; status: 'draft' | 'archived'; revision: number; versions: number[]; updatedAt: number }[] = []
        const result = (hasMore: boolean) => ({ ok: true, works, hasMore, nextBeforeId: hasMore ? works.at(-1)?.id ?? null : null })
        for (const item of items.slice(start)) {
          works.push({ id: item.id, title: item.title, kind: item.kind, status: item.status, revision: item.revision, versions: item.versions.map(v => v.revision), updatedAt: item.updatedAt })
          if (JSON.stringify(result(true)).length > MAX_LIST_CHARS) { works.pop(); break }
        }
        return result(start + works.length < items.length)
      }
      const checkedId = action === 'write' && input.id === undefined ? undefined : id(input.id)
      if (action === 'read') {
        const item = await workspace.read(checkedId!, input.revision === undefined ? undefined : integer(input.revision, 'revision', 1))
        const selected = item.versions.at(-1)!
        const offset = input.offset === undefined ? 0 : integer(input.offset, 'offset', 0, MAX_CONTENT)
        const limit = input.limit === undefined ? MAX_READ_CHARS : integer(input.limit, 'limit', 1, MAX_READ_CHARS)
        if (offset > selected.content.length) fail('offset 超出正文')
        let content = selected.content.slice(offset, offset + limit)
        const result = () => ({ ok: true, id: item.id, title: item.title, kind: item.kind, status: item.status, revision: item.revision, version: selected.revision, evidenceRefs: selected.evidenceRefs, offset, content, totalChars: selected.content.length, nextOffset: offset + content.length < selected.content.length ? offset + content.length : null })
        // Preserve complete provenance inside the runtime's 4000-char result
        // window; only the body is paginated, never a half-serialized source.
        while (JSON.stringify(result()).length > MAX_LIST_CHARS && content.length) content = content.slice(0, Math.max(0, content.length - 50))
        if (JSON.stringify(result()).length > MAX_LIST_CHARS || (!content && offset < selected.content.length)) fail('来源过长，请在控制台查看整条记录')
        return result()
      }
      if (action === 'write') {
        const refs = references(input.evidenceRefs); visible(refs)
        const item = await workspace.write({
          ...(checkedId ? { id: checkedId } : {}), title: text(input.title, 'title', 120), kind: kind(input.kind), content: text(input.content, 'content', MAX_CONTENT), evidenceRefs: refs,
          ...(input.expectedRevision === undefined ? {} : { expectedRevision: integer(input.expectedRevision, 'expectedRevision', 1) }),
          ...(sharedSourceIds ? { sharedSources: sharedReferences(sharedSourceIds()) } : {}),
        })
        return { ok: true, id: item.id, revision: item.revision, status: item.status, saved: true, shared: false }
      }
      if (action === 'restore') {
        const revision = integer(input.revision, 'revision', 1)
        const original = await workspace.read(checkedId!, revision)
        visible(original.versions[0]!.evidenceRefs)
        const item = await workspace.restore(checkedId!, revision, integer(input.expectedRevision, 'expectedRevision', 1))
        return { ok: true, id: item.id, revision: item.revision, restoredFrom: revision, shared: false }
      }
      const item = await workspace.archive(checkedId!, input.archived === undefined ? true : input.archived as boolean)
      return { ok: true, id: item.id, revision: item.revision, status: item.status }
    }
  }
  return [new WorkspaceTool()]
}
