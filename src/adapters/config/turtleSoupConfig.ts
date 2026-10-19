import { decodeMiniGamesSettings } from '../../modules/games/infrastructure/gameFiles.js'
import { resolveTurtleSoupConfig } from '../../modules/games/infrastructure/turtleSoup/TurtleSoupStore.js'
import { buildSchemaConfigView, prepareSchemaUpdates } from './schemaConfig.js'
import type { SchemaEntry } from './schemaConfig.js'

const record = (value:unknown):Record<string,unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string,unknown> : {}

// Project the same raw snapshot for reads, revisions and diffs. The final runtime
// enabled value combines both gates; the form must keep their own intent separate.
export function turtleSoupSchemaSettings(settings:Record<string,unknown>) {
  const decoded = decodeMiniGamesSettings(settings)
  return {
    ...settings,
    miniGames: {
      ...record(settings.miniGames),
      enabled: decoded.enabled,
      turtleSoup: {...decoded.turtleSoup, ...resolveTurtleSoupConfig(settings), enabled: decoded.turtleSoup.enabled !== false}
    }
  }
}

export function buildTurtleSoupConfigView(entry:SchemaEntry, settings:Record<string,unknown>) {
  return buildSchemaConfigView('turtleSoup', entry, turtleSoupSchemaSettings(settings))
}

export function prepareTurtleSoupConfigUpdates(entry:SchemaEntry, settings:Record<string,unknown>, payload:Record<string,unknown> = {}) {
  if (typeof payload.revision !== 'string' || !payload.revision) throw Object.assign(new Error('请重新加载海龟汤配置，携带当前版本后保存'), {status: 400})
  return prepareSchemaUpdates('turtleSoup', entry, turtleSoupSchemaSettings(settings), payload)
}
