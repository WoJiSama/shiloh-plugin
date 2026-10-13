export interface ProviderDefinition {
 configKey: string; title: string; listLabel: string; urlField: string; modelField: string; keyField: string; priorityField: string
 urlPlaceholder: string; modelPlaceholder: string; autoResolveHelp?: string; usageHint?: string
 legacyProviderFields?: string[]; extraFields?: { panelField: string; legacyField: string; label: string; placeholder: string }[]
}
export interface PanelProvider { name: unknown; apiUrl: unknown; model: unknown; apiKey: unknown; priority: number; autoResolve?: boolean | undefined; [field: string]: unknown }
function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {} }
export const AI_PROVIDER_DEFINITIONS: ProviderDefinition[] = [
  {
    configKey: "trackAiConfig",
    title: "对话追踪 trackAiConfig",
    listLabel: "对话追踪模型列表",
    urlField: "trackAiUrl",
    modelField: "trackAiModel",
    keyField: "trackAiApikey",
    priorityField: "trackAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gpt-4o-mini",
    autoResolveHelp: "开启时自动补全 /chat/completions 等路径;关闭则直接使用上方 URL 原文",
    usageHint: "用于会话追踪时判断用户是否在和 bot 继续对话，推荐快速小模型"
  },
  {
    configKey: "intentAiConfig",
    title: "意图分类 intentAiConfig",
    listLabel: "意图分类模型列表",
    urlField: "intentAiUrl",
    modelField: "intentAiModel",
    keyField: "intentAiApikey",
    priorityField: "intentAiPriority",
    urlPlaceholder: "https://api.deepseek.com/chat/completions",
    modelPlaceholder: "deepseek-v4-flash",
    usageHint: "每条消息都要过的前置意图分类与语义工具分类，延迟直接决定响应速度，必须用 flash 级快模型；留空时回退工具决策模型"
  },
  {
    configKey: "toolsAiConfig",
    title: "工具决策 toolsAiConfig",
    listLabel: "工具决策模型列表",
    urlField: "toolsAiUrl",
    modelField: "toolsAiModel",
    keyField: "toolsAiApikey",
    priorityField: "toolsAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gemini-2.5-flash",
    usageHint: "用于工具决策、表情包满额替换决策等，推荐中等模型"
  },
  {
    configKey: "chatAiConfig",
    title: "主对话 chatAiConfig",
    listLabel: "主对话模型列表",
    urlField: "chatApiUrl",
    modelField: "chatApiModel",
    keyField: "chatApiKey",
    priorityField: "chatAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gemini-2.5-pro",
    usageHint: "主对话使用的模型，决定 bot 回复质量，推荐强模型"
  },
  {
    configKey: "imageEditAiConfig",
    title: "图像编辑 imageEditAiConfig",
    listLabel: "图像编辑模型列表",
    urlField: "imageEditApiUrl",
    modelField: "imageEditApiModel",
    keyField: "imageEditApiKey",
    priorityField: "imageEditPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gemini-3-pro-image-preview",
    usageHint: "用于 googleImageEditTool 图生图/图片编辑"
  },
  {
    configKey: "imageGenerationAiConfig",
    title: "文生图 imageGenerationAiConfig",
    listLabel: "文生图模型列表",
    urlField: "imageGenerationApiUrl",
    modelField: "imageGenerationApiModel",
    keyField: "imageGenerationApiKey",
    priorityField: "imageGenerationPriority",
    extraFields: [
      { panelField: "size", legacyField: "imageGenerationSize", label: "默认尺寸", placeholder: "未指定比例时使用，例如 1024x1024 或 2K" },
      { panelField: "squareSize", legacyField: "imageGenerationSquareSize", label: "正方形尺寸", placeholder: "例如 1024x1024" },
      { panelField: "portraitSize", legacyField: "imageGenerationPortraitSize", label: "竖版尺寸", placeholder: "例如 1024x1536" },
      { panelField: "landscapeSize", legacyField: "imageGenerationLandscapeSize", label: "横版尺寸", placeholder: "例如 1536x1024" },
      { panelField: "autoSize", legacyField: "imageGenerationAutoSize", label: "自动尺寸", placeholder: "图生图未指定比例时可填 auto；留空则不发送 size" }
    ],
    legacyProviderFields: ["imageGenerationProviders", "imageGenerationCandidates", "imageGenerationFallbacks"],
    urlPlaceholder: "https://ark.cn-beijing.volces.com/api/v3/images/generations",
    modelPlaceholder: "doubao-seedream-5-0-260128",
    usageHint: "用于 bananaTool 纯文字生成图片；当前已支持失败后自动尝试下一个候选模型"
  },
  {
    configKey: "analysisAiConfig",
    title: "图像识别/VLM analysisAiConfig",
    listLabel: "图像识别模型列表",
    urlField: "analysisApiUrl",
    modelField: "analysisApiModel",
    keyField: "analysisApiKey",
    priorityField: "analysisAiPriority",
    extraFields: [
      { panelField: "timeoutMs", legacyField: "timeoutMs", label: "单次超时（毫秒）", placeholder: "例如 45000" }
    ],
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gemini-3-pro-preview",
    usageHint: "用于 googleImageAnalysisTool 识图、表情包系统 VLM 打标和内容审查"
  },
  {
    configKey: "searchAiConfig",
    title: "联网搜索 searchAiConfig",
    listLabel: "联网搜索模型列表",
    urlField: "searchApiUrl",
    modelField: "searchApiModel",
    keyField: "searchApiKey",
    priorityField: "searchAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "deepseek-r1-search",
    usageHint: "用于 searchInformationTool 联网搜索，建议使用带搜索能力的模型"
  },
  {
    configKey: "memoryAiConfig",
    title: "记忆提取 memoryAiConfig",
    listLabel: "记忆提取模型列表",
    urlField: "memoryAiUrl",
    modelField: "memoryAiModel",
    keyField: "memoryAiApikey",
    priorityField: "memoryAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/chat/completions",
    modelPlaceholder: "gpt-4o-mini",
    usageHint: "用于长期记忆提取、表达学习的 AI 场景化学习，推荐小模型省钱"
  },
  {
    configKey: "embeddingAiConfig",
    title: "Embedding embeddingAiConfig",
    listLabel: "Embedding 模型列表",
    urlField: "embeddingApiUrl",
    modelField: "embeddingApiModel",
    keyField: "embeddingApiKey",
    priorityField: "embeddingAiPriority",
    urlPlaceholder: "https://api.openai.com/v1/embeddings",
    modelPlaceholder: "text-embedding-3-small",
    usageHint: "用于知识库语义检索、表情包系统 embedding 召回；URL 是 /v1/embeddings"
  }
];

function hasText(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0 : value !== undefined && value !== null && value !== "";
}

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function normalizePriority(value: unknown) {
  const priority = Number(value);
  return Number.isFinite(priority) && priority > 0 ? priority : 1;
}

export function sortAiProviders<T extends { priority?: unknown }>(providers: readonly T[] = []): T[] {
  return [...providers].sort((a, b) => {
    const ap = Number(a?.priority);
    const bp = Number(b?.priority);
    const av = Number.isFinite(ap) && ap > 0 ? ap : Number.MAX_SAFE_INTEGER;
    const bv = Number.isFinite(bp) && bp > 0 ? bp : Number.MAX_SAFE_INTEGER;
    return av - bv;
  });
}

export function getProviderDefinition(configKey: string) {
  return AI_PROVIDER_DEFINITIONS.find(item => item.configKey === configKey) || null;
}

function readProviderValue(provider: Record<string, unknown>, _definition: ProviderDefinition, genericField: string, legacyField: string) {
  return provider[genericField] ?? provider[legacyField] ?? "";
}

export function normalizeProviderForPanel(value: unknown = {}, definition: ProviderDefinition): PanelProvider | null {
  const provider = record(value)
  const apiUrl = readProviderValue(provider, definition, "apiUrl", definition.urlField)
  const model = readProviderValue(provider, definition, "model", definition.modelField)
  const apiKey = readProviderValue(provider, definition, "apiKey", definition.keyField)
  if (!hasText(apiUrl) && !hasText(model) && !hasText(apiKey)) return null

  const item: PanelProvider = {
    ...Object.fromEntries(Object.entries(provider).filter(([, value]) => value !== undefined)),
    name: provider.name || provider.label || provider[definition.modelField] || provider.model || "primary",
    apiUrl,
    model,
    apiKey,
    priority: normalizePriority(provider.priority ?? provider[definition.priorityField])
  }

  // 显式设置的 URL 自动补全开关必须原样保留,否则每次保存都会被重置
  if (provider.autoResolve !== undefined) {
    const flag = provider.autoResolve
    item.autoResolve = flag === true || flag === "true" || flag === 1
      ? true
      : (flag === false || flag === "false" || flag === 0 ? false : undefined)
    if (item.autoResolve === undefined) delete item.autoResolve
  }

  for (const extra of definition.extraFields || []) {
    const value = provider[extra.panelField] ?? provider[extra.legacyField] ?? ""
    if (hasText(value) || provider[extra.panelField] === "" || provider[extra.legacyField] === "") item[extra.panelField] = value
  }

  return item
}

export function buildLegacyProvider(value: unknown = {}, definition: ProviderDefinition) {
  const cfg = record(value)
  return normalizeProviderForPanel({
    name: cfg.name || cfg[definition.modelField] || "primary",
    apiUrl: cfg[definition.urlField],
    model: cfg[definition.modelField],
    apiKey: cfg[definition.keyField],
    priority: cfg[definition.priorityField] || cfg.priority || 1,
    ...Object.fromEntries((definition.extraFields || []).map(extra => [
      extra.panelField,
      cfg[extra.legacyField]
    ]))
  }, definition);
}

export function getConfiguredProviders(value: unknown = {}, definition: ProviderDefinition): PanelProvider[] {
  const cfg = record(value)
  const providerFields = ["providers", ...(definition.legacyProviderFields || [])];
  for (const field of providerFields) {
    const providers = toArray(cfg[field])
      .map(item => normalizeProviderForPanel(item, definition))
      .filter((item): item is PanelProvider => item !== null);
    if (providers.length) return providers;
  }
  return [];
}

export function withAiProviderPanelDefaults(value: unknown = {}): Record<string, unknown> {
  const settings = record(value)
  let changed = false;
  const next = { ...settings };

  for (const definition of AI_PROVIDER_DEFINITIONS) {
    const cfg = record(next[definition.configKey]);
    const providers = getConfiguredProviders(cfg, definition);
    if (providers.length) {
      if (!Array.isArray(cfg.providers) || cfg.providers.length !== providers.length) {
        next[definition.configKey] = { ...cfg, providers };
        changed = true;
      }
      continue;
    }

    const legacyProvider = buildLegacyProvider(cfg, definition);
    if (legacyProvider) {
      next[definition.configKey] = { ...cfg, providers: [legacyProvider] };
      changed = true;
    }
  }

  return changed ? next : settings;
}

export function normalizeAiProviderUpdates(value: unknown = {}, currentSettings: unknown = {}): Record<string, unknown> {
  const updates = record(value)
  let next = { ...updates }

  for (const definition of AI_PROVIDER_DEFINITIONS) {
    const flatProvidersKey = `${definition.configKey}.providers`
    const providers = next[flatProvidersKey]
    if (providers === undefined) continue
    // 列表为空(undefined/null/[]/整行无效)时绝不能把空值写回——
    // 那会把已保存的多渠道配置整个抹掉。丢弃该键,保留磁盘原状。
    const current = getConfiguredProviders(record(currentSettings)[definition.configKey], definition)
    const signature = (item: PanelProvider) => JSON.stringify([item.name, item.apiUrl, item.model])
    const normalizedProviders = Array.isArray(providers)
      ? providers.map(item => {
        const normalized = normalizeProviderForPanel(item, definition)
        if (!normalized) return null
        const matches = current.filter(existing => normalized._consoleId
          ? existing._consoleId === normalized._consoleId
          : signature(existing) === signature(normalized))
        return matches.length === 1 ? { ...matches[0], ...normalized } : normalized
      }).filter((item): item is PanelProvider => item !== null)
      : []
    if (!normalizedProviders.length) {
      delete next[flatProvidersKey]
      continue
    }

    const primary = sortAiProviders(normalizedProviders)[0]!
    next = {
      ...next,
      [flatProvidersKey]: normalizedProviders,
      [`${definition.configKey}.name`]: primary.name,
      [`${definition.configKey}.${definition.urlField}`]: primary.apiUrl,
      [`${definition.configKey}.${definition.modelField}`]: primary.model,
      [`${definition.configKey}.${definition.keyField}`]: primary.apiKey,
      [`${definition.configKey}.${definition.priorityField}`]: primary.priority
    }

    for (const extra of definition.extraFields || []) {
      next[`${definition.configKey}.${extra.legacyField}`] = primary[extra.panelField]
    }
  }

  return next
}
