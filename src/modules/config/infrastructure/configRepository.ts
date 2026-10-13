import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import YAML from 'yaml'
import { withConfigFileLock, atomicWriteConfigFile } from './filePersistence.js'

export interface ConfigRepositoryOptions {
  file: string
  defaultFile?: string
  settingsKey?: string
  lockTimeoutMs?: number
}
export interface ConfigUpdateOptions { expectedRevision?: string }
export class ConfigConflictError extends Error { readonly code = 'CONFIG_CONFLICT' }
function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
function revision(source: string) { return createHash('sha256').update(source).digest('hex') }

export function createConfigRepository(options: ConfigRepositoryOptions) {
  const file = path.resolve(options.file)
  const backup = file + '.bak'
  const settingsKey = options.settingsKey || 'pluginSettings'
  function source() {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    if (options.defaultFile && fs.existsSync(options.defaultFile)) return fs.readFileSync(options.defaultFile, 'utf8')
    return settingsKey + ': {}\n'
  }
  function parse(text: string) {
    const document = YAML.parseDocument(text)
    if (document.errors.length) throw new Error(`Invalid configuration YAML: ${document.errors[0]!.message}`)
    return document
  }
  function read() {
    const text = source()
    const document = parse(text)
    const raw: unknown = document.toJS()
    return { revision: revision(text), settings: object(object(raw)[settingsKey]), document }
  }
  function assertRevision(before: string, settings: ConfigUpdateOptions) {
    if (settings.expectedRevision !== undefined && revision(before) !== settings.expectedRevision) {
      throw new ConfigConflictError('Configuration revision changed')
    }
  }
  function update(mutator: (document: YAML.Document) => void, settings: ConfigUpdateOptions = {}) {
    return withConfigFileLock(file, () => {
      const before = source()
      assertRevision(before, settings)
      const document = parse(before)
      mutator(document)
      const after = document.toString()
      parse(after)
      if (after !== before || !fs.existsSync(file)) {
        if (fs.existsSync(file)) atomicWriteConfigFile(backup, before)
        atomicWriteConfigFile(file, after)
      }
      return read()
    }, options.lockTimeoutMs)
  }
  function updateFlat(updates: Record<string, unknown>, settings: ConfigUpdateOptions = {}) {
    return update(document => {
      for (const [key, value] of Object.entries(updates)) {
        if (!key || value === undefined || value === null) continue
        const keys = key.split('.')
        if (keys.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) throw new Error('Invalid configuration path')
        document.setIn([settingsKey, ...keys], value)
      }
    }, settings)
  }
  function recoverBackup(settings: ConfigUpdateOptions = {}) {
    return withConfigFileLock(file, () => {
      assertRevision(source(), settings)
      const saved = fs.readFileSync(backup, 'utf8')
      parse(saved)
      atomicWriteConfigFile(file, saved)
      return read()
    }, options.lockTimeoutMs)
  }
  function remove(settings: ConfigUpdateOptions = {}) {
    return withConfigFileLock(file, () => {
      const current = source()
      assertRevision(current, settings)
      if (fs.existsSync(file)) {
        atomicWriteConfigFile(backup, current)
        fs.unlinkSync(file)
      }
    }, options.lockTimeoutMs)
  }
  return { read, update, updateFlat, recoverBackup, remove, paths: { file, backup, lock: file + '.lock' } }
}
