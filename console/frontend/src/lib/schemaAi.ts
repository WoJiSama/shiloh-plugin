import { clientId as newClientId } from './clientId'
export interface AiDefinition {
  configKey: string
  title: string
  usageHint?: string
  kind?: string
  urlPlaceholder?: string
  modelPlaceholder?: string
  extraFields?: { field: string; label: string; placeholder?: string }[]
}
export interface AiProvider {
  _consoleId?: string
  _clientId: string
  _keyAction: 'keep' | 'replace' | 'clear'
  apiKeyConfigured?: boolean
  name: string
  apiUrl: string
  model: string
  apiKey: string
  priority: number | null
  autoResolve: boolean
  [key: string]: any
}
export interface AiOverview {
  definitions: AiDefinition[]
  sections: Record<string, Record<string, any>[]>
  revisions?: Record<string, string>
}
export function hydrateProvider(provider: Record<string, any>, clientId?: string): AiProvider {
  return {
    ...provider,
    name: provider.name || '',
    apiUrl: provider.apiUrl || '',
    model: provider.model || '',
    priority: provider.priority ?? 1,
    autoResolve: provider.autoResolve !== false,
    apiKeyConfigured: provider.apiKeyConfigured ?? Boolean(provider.apiKey),
    apiKey: '',
    _keyAction: 'keep',
    _clientId: clientId || provider._consoleId || newClientId()
  }
}
export function providerPayload(provider: AiProvider) {
  const { _clientId, _keyAction, apiKeyConfigured, ...payload } = provider
  return {
    ...payload,
    apiKeyAction: _keyAction,
    apiKey: _keyAction === 'replace' ? provider.apiKey : ''
  }
}
export function rebaseAiProviders(
  fresh: AiProvider[],
  current: AiProvider[],
  previous: AiProvider[]
) {
  const oldById = new Map(previous.map((provider) => [provider._clientId, provider]))
  const freshById = new Map(fresh.map((provider) => [provider._clientId, provider]))
  const edited = current.flatMap((provider) => {
    const old = oldById.get(provider._clientId),
      server = freshById.get(provider._clientId)
    if (!old) return [{ ...provider }]
    if (!server) return JSON.stringify(provider) === JSON.stringify(old) ? [] : [{ ...provider }]
    const merged = { ...server }
    for (const key of Object.keys(provider)) {
      if (['_consoleId', '_clientId', 'apiKeyConfigured'].includes(key)) continue
      if (JSON.stringify(provider[key]) !== JSON.stringify(old[key])) merged[key] = provider[key]
    }
    return [merged]
  })
  const editedById = new Map(edited.map((provider) => [provider._clientId, provider]))
  const locallyReordered =
    JSON.stringify(
      current
        .filter((provider) => oldById.has(provider._clientId))
        .map((provider) => provider._clientId)
    ) !==
    JSON.stringify(
      previous
        .filter((provider) => current.some((item) => item._clientId === provider._clientId))
        .map((provider) => provider._clientId)
    )
  const serverAdded = fresh
    .filter((provider) => !oldById.has(provider._clientId))
    .map((provider) => ({ ...provider }))
  if (locallyReordered) return [...edited, ...serverAdded]
  const localAdded = edited.filter((provider) => !freshById.has(provider._clientId))
  return [
    ...fresh.flatMap((provider) =>
      !oldById.has(provider._clientId)
        ? [{ ...provider }]
        : editedById.has(provider._clientId)
          ? [editedById.get(provider._clientId)!]
          : []
    ),
    ...localAdded
  ]
}
export function previewAiUrl(def: AiDefinition, provider: AiProvider) {
  const url = String(provider.apiUrl || '')
    .trim()
    .replace(/\/+$/, '')
  if (!url) return ''
  if (def.kind === 'image') {
    const tail = def.configKey === 'imageEditAiConfig' ? '/images/edits' : '/images/generations'
    if (/\/images\/(generations|edits)(?:\/?.*)$/i.test(url))
      return url.replace(/\/images\/(generations|edits)(?:\/?.*)$/i, tail)
    if (/\/chat\/completions(?:\/?.*)$/i.test(url))
      return url.replace(/\/chat\/completions(?:\/?.*)$/i, tail)
    return /\/v1$/i.test(url) ? url + tail : url
  }
  if (def.kind === 'embedding') {
    if (/\/embeddings$/i.test(url)) return url
    return /\/v\d+$/i.test(url) ? url + '/embeddings' : url + '/v1/embeddings'
  }
  if (provider.autoResolve === false || /\/chat\/completions$/i.test(url)) return url
  return /\/v[0-9]+$/i.test(url) ? url + '/chat/completions' : url + '/v1/chat/completions'
}
