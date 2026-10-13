type RawConfig = Record<string, unknown>;
export interface ImageProviderConfig {
  name: string; aliases: string[]; apiUrl: string; apiKey: string; model: string;
  priority: number | null; size: string; squareSize: string; portraitSize: string;
  landscapeSize: string; autoSize: string; quality?: string; defaultEditSize?: string;
  [key: string]: unknown;
}
function record(value: unknown): RawConfig {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RawConfig : {};
}
export const DEFAULT_IMAGE_GENERATION_URL = 'https://api.openai.com/v1/images/generations';
export const DEFAULT_IMAGE_EDIT_URL = 'https://api.openai.com/v1/images/edits';

const DEFAULT_IMAGE_GENERATION_MODEL = 'gpt-image-2';
const DEFAULT_IMAGE_GENERATION_SIZE = '1024x1024';

function compactString(value: unknown) {
  return String(value || "").trim();
}

function uniqueStrings(values: readonly unknown[] = []) {
  return [...new Set(values.map(compactString).filter(Boolean))];
}

function pickFirst(...values: unknown[]) {
  return compactString(values.find(value => compactString(value)));
}

function isPlaceholderKey(apiKey: unknown) {
  const key = compactString(apiKey);
  return !key || /(?:sk-xxx|sk-xxxxx|sk-xxxxxx|your[-_ ]?key|api[-_ ]?key)/i.test(key);
}

function asArray(value: unknown): RawConfig[] {
  if (!value) return [];
  return (Array.isArray(value) ? value : [value]).filter((item): item is RawConfig => item !== null && typeof item === 'object' && !Array.isArray(item));
}

function normalizePriority(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  const priority = Number(value);
  return Number.isFinite(priority) && priority > 0 ? priority : null;
}

function providerMatchKey(value: unknown = "") {
  return compactString(value)
    .toLowerCase()
    .replace(/[\s_./\\-]+/g, "");
}

export function getImageProviderAliases(candidateInput: unknown = {}) {
  const candidate = record(candidateInput);
  const names = uniqueStrings([
    candidate.name,
    candidate.label,
    candidate.channelName,
    candidate.providerName
  ]);
  const shortNames = names
    .map(name => name.match(/^([A-Za-z][A-Za-z0-9]{2,})[-_ ]/)?.[1] || "")
    .filter(Boolean);
  return uniqueStrings([
    ...names,
    ...shortNames,
    candidate.imageGenerationApiModel,
    candidate.imageEditApiModel,
    candidate.model
  ]);
}

export function matchesImageProvider(candidateInput: unknown = {}, requestedProvider = "") {
  const candidate = record(candidateInput);
  const requestedKey = providerMatchKey(requestedProvider);
  if (!requestedKey) return false;
  const aliases = Array.isArray(candidate.aliases)
    ? uniqueStrings([...candidate.aliases, ...getImageProviderAliases(candidate)])
    : getImageProviderAliases(candidate);
  return aliases.some(alias => providerMatchKey(alias) === requestedKey);
}

function getRawImageProviderCandidates(config: RawConfig = {}) {
  const generationCfg = record(config.imageGenerationAiConfig);
  const editCfg = record(config.imageEditAiConfig);
  return [
    generationCfg,
    ...getProviderList(generationCfg),
    ...getFallbackList(generationCfg),
    editCfg,
    ...getImageEditProviderList(editCfg),
    ...getImageEditFallbackList(editCfg)
  ].filter(candidate => candidate && typeof candidate === "object");
}

function findAliasPosition(text = "", alias = "") {
  const source = String(text || "");
  const target = compactString(alias);
  if (!source || !target) return -1;
  const lowerSource = source.toLowerCase();
  const lowerTarget = target.toLowerCase();
  let index = lowerSource.indexOf(lowerTarget);
  while (index >= 0) {
    const before = index > 0 ? source[index - 1]! : "";
    const after = source[index + target.length] || "";
    const asciiAlias = /^[a-z0-9_.\-/ ]+$/i.test(target);
    const leftOk = !asciiAlias || !/[a-z0-9_]/i.test(before);
    const rightOk = !asciiAlias || !/[a-z0-9_]/i.test(after);
    if (leftOk && rightOk) return index;
    index = lowerSource.indexOf(lowerTarget, index + lowerTarget.length);
  }
  return -1;
}

function isExplicitProviderMention(text = "", alias = "") {
  const index = findAliasPosition(text, alias);
  if (index < 0) return false;
  const before = String(text).slice(Math.max(0, index - 32), index);
  const after = String(text).slice(index + alias.length, index + alias.length + 32);
  const beforeRejects = /(?:不要|别|禁止|不准|无需|不用)\s*(?:再)?\s*(?:用|使用)?\s*(?:名字?(?:叫|是|为)?\s*)?[“"'「『【]?\s*$/i.test(before);
  if (beforeRejects) return false;
  const beforeSelects = /(?:用|使用|指定|选择|选用|走|调用|切到|切换到|换成|通过|让)\s*(?:名字?(?:叫|是|为)?\s*)?[“"'「『【]?\s*$/i.test(before);
  const afterDraws = /^\s*[”"'」』】]?\s*的?\s*(?:(?:渠道|通道|模型)\s*)?(?:来|去|帮我|给我|替我)?\s*(?:画|绘制|生成|生图|出图|做图|改(?:图|一下|下|成|为)|修(?:图|一下|下)|编辑|去掉|去除|删除|移除|擦掉|换掉|替换|调整|处理)/i.test(after);
  const afterNamesChannel = /^\s*[”"'」』】]?\s*的?\s*(?:渠道|通道|模型)(?:\s|来|去|画|绘制|生成|生图|出图|做图|改|修|编辑|$)/i.test(after);
  const directlyDraws = /^\s*(?:画|绘制|生成|生图|出图|做图|改(?:图|一下|下|成|为)|修(?:图|一下|下)|编辑|去掉|去除|删除|移除|擦掉|换掉|替换|调整|处理)/i.test(after);
  const saysStyle = /^\s*风格/i.test(after);
  return (beforeSelects && !saysStyle && (afterDraws || afterNamesChannel || directlyDraws)) ||
    afterNamesChannel || directlyDraws;
}

export function resolveRequestedImageProvider(configInput: unknown = {}, text = "", explicitProvider = "") {
  const config = record(configInput);
  const explicit = compactString(explicitProvider);
  const source = String(text || "").replace(/\[CQ:[^\]]+\]/g, " ");
  if (!source.trim()) return "";

  // provider is often produced by a planner/model. It is only an execution
  // constraint when the user's own text proves that they selected it.
  if (explicit) {
    if (isExplicitProviderMention(source, explicit)) return explicit;
    const matchingCandidates = getRawImageProviderCandidates(config)
      .filter(candidate => matchesImageProvider(candidate, explicit));
    for (const candidate of matchingCandidates) {
      const matchedAlias = getImageProviderAliases(candidate)
        .find(alias => isExplicitProviderMention(source, alias));
      if (matchedAlias) {
        return pickFirst(candidate.name, candidate.label, candidate.imageGenerationApiModel, candidate.imageEditApiModel, candidate.model, explicit);
      }
    }
  }

  const entries = getRawImageProviderCandidates(config)
    .flatMap(candidate => {
      const aliases = getImageProviderAliases(candidate);
      const canonical = pickFirst(candidate.name, candidate.label, candidate.imageGenerationApiModel, candidate.imageEditApiModel, candidate.model);
      return aliases.map(alias => ({ alias, canonical: canonical || alias }));
    })
    .sort((a, b) => b.alias.length - a.alias.length);
  const checkedAliases = new Set();
  for (const entry of entries) {
    const aliasKey = providerMatchKey(entry.alias);
    if (!aliasKey || checkedAliases.has(aliasKey)) continue;
    checkedAliases.add(aliasKey);
    if (!isExplicitProviderMention(source, entry.alias)) continue;
    const canonicals = uniqueStrings(entries
      .filter(candidate => providerMatchKey(candidate.alias) === aliasKey)
      .map(candidate => candidate.canonical));
    return canonicals.length === 1 ? canonicals[0]! : entry.alias;
  }

  const marked = source.match(/(?:用|使用|指定|选择|选用|走|调用|切到|切换到|换成|通过)\s*[“"'「『【]?\s*([A-Za-z0-9][A-Za-z0-9_.\-/ ]{0,38}|[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9_.\-/]{1,20})\s*[”"'」』】]?\s*(?:渠道|通道|模型)/i);
  return compactString(marked?.[1]);
}

export function normalizeImageProviderParameter(params: unknown = {}, config: unknown = {}, userText = "") {
  const normalized = { ...record(params) };
  const provider = resolveRequestedImageProvider(config, userText, compactString(normalized.provider));
  if (provider) normalized.provider = provider;
  else delete normalized.provider;
  return normalized;
}

export function selectImageConfigsByProvider<T extends RawConfig>(configs: T | T[], requestedProvider = "", capability = "图片生成") {
  const candidates = (Array.isArray(configs) ? configs : [configs]).filter(Boolean);
  const requested = compactString(requestedProvider);
  if (!requested) return candidates;
  const exactNameMatches = candidates.filter(candidate => providerMatchKey(candidate.name) === providerMatchKey(requested));
  if (exactNameMatches.length) return exactNameMatches;
  const selected = candidates.filter(candidate => matchesImageProvider(candidate, requested));
  const distinctNames = uniqueStrings(selected.map(candidate => candidate.name));
  if (distinctNames.length === 1) return selected;
  if (distinctNames.length > 1) {
    throw new Error(`指定的图片模型“${requested}”同时匹配多个渠道（${distinctNames.join("、")}），请明确说渠道名称`);
  }
  throw new Error(`未找到可用于${capability}的指定图片渠道“${requested}”，不会自动改用其他渠道`);
}

export function toImageGenerationUrl(apiUrl = DEFAULT_IMAGE_GENERATION_URL) {
  const url = compactString(apiUrl);
  if (!url) return DEFAULT_IMAGE_GENERATION_URL;
  if (/\/images\/generations\/?$/i.test(url)) return url;
  if (/\/images\/edits\/?$/i.test(url)) return url.replace(/\/images\/edits\/?$/i, "/images/generations");
  if (/\/chat\/completions\/?$/i.test(url)) return url.replace(/\/chat\/completions\/?$/i, "/images/generations");
  if (/\/v1\/?$/i.test(url)) return url.replace(/\/?$/i, "/images/generations");
  return url;
}

export function toImageEditUrl(apiUrl = DEFAULT_IMAGE_EDIT_URL) {
  const url = compactString(apiUrl);
  if (!url) return DEFAULT_IMAGE_EDIT_URL;
  if (/\/images\/edits\/?$/i.test(url)) return url;
  if (/\/images\/generations\/?$/i.test(url)) return url.replace(/\/images\/generations\/?$/i, "/images/edits");
  if (/\/chat\/completions\/?$/i.test(url)) return url.replace(/\/chat\/completions\/?$/i, "/images/edits");
  if (/(?:\/v1|\/openai\/v1|\/api\/v1)\/?$/i.test(url)) return url.replace(/\/?$/i, "/images/edits");
  if (/^https?:\/\/[^/]+\/?$/i.test(url)) return url.replace(/\/?$/i, "/images/edits");
  return url;
}

function normalizeImageGenerationConfig(candidate: RawConfig = {}, fallback: RawConfig = {}): ImageProviderConfig | null {
  const apiKey = pickFirst(
    candidate.imageGenerationApiKey,
    candidate.apiKey,
    fallback.imageGenerationApiKey,
    fallback.apiKey
  );
  if (isPlaceholderKey(apiKey)) return null;

  const model = pickFirst(
    candidate.imageGenerationApiModel,
    candidate.model,
    fallback.imageGenerationApiModel,
    fallback.model,
    DEFAULT_IMAGE_GENERATION_MODEL
  );
  if (!model) return null;

  const apiUrl = toImageGenerationUrl(pickFirst(
    candidate.imageGenerationApiUrl,
    candidate.apiUrl,
    fallback.imageGenerationApiUrl,
    fallback.apiUrl,
    DEFAULT_IMAGE_GENERATION_URL
  ));

  return {
    name: pickFirst(candidate.name, candidate.label, fallback.name, model),
    aliases: uniqueStrings([...getImageProviderAliases(candidate), model]),
    apiUrl,
    apiKey,
    model,
    priority: normalizePriority(candidate.imageGenerationPriority ?? candidate.priority),
    quality: pickFirst(
      candidate.imageGenerationQuality,
      candidate.quality,
      fallback.imageGenerationQuality,
      fallback.quality
    ),
    size: pickFirst(
      candidate.imageGenerationSize,
      candidate.size,
      fallback.imageGenerationSize,
      fallback.size,
      DEFAULT_IMAGE_GENERATION_SIZE
    ),
    squareSize: pickFirst(
      candidate.imageGenerationSquareSize,
      candidate.squareSize,
      fallback.imageGenerationSquareSize,
      fallback.squareSize
    ),
    portraitSize: pickFirst(
      candidate.imageGenerationPortraitSize,
      candidate.portraitSize,
      fallback.imageGenerationPortraitSize,
      fallback.portraitSize
    ),
    landscapeSize: pickFirst(
      candidate.imageGenerationLandscapeSize,
      candidate.landscapeSize,
      fallback.imageGenerationLandscapeSize,
      fallback.landscapeSize
    ),
    autoSize: pickFirst(
      candidate.imageGenerationAutoSize,
      candidate.autoSize,
      fallback.imageGenerationAutoSize,
      fallback.autoSize
    )
  };
}

function dedupeConfigs<T extends ImageProviderConfig>(configs: T[]): T[] {
  const seen = new Map<string, T>();
  const result: T[] = [];
  for (const config of configs) {
    const key = [
      config.apiUrl,
      config.model,
      config.size,
      config.squareSize,
      config.portraitSize,
      config.landscapeSize,
      config.autoSize,
      config.defaultEditSize,
      config.quality,
      config.apiKey
    ].join("\u0000");
    const existing = seen.get(key);
    if (existing) {
      existing.aliases = uniqueStrings([...(existing.aliases || []), ...(config.aliases || []), config.name]);
      continue;
    }
    seen.set(key, config);
    result.push(config);
  }
  return result;
}

function orderConfigs(configs: ImageProviderConfig[]): ImageProviderConfig[] {
  const ordered = configs.map((config, index) => ({ ...config, _order: index }));
  ordered.sort((a, b) => {
    const aHasPriority = Number.isFinite(a.priority);
    const bHasPriority = Number.isFinite(b.priority);
    if (aHasPriority && bHasPriority && a.priority !== b.priority) return (a.priority ?? 0) - (b.priority ?? 0);
    if (aHasPriority !== bHasPriority) return aHasPriority ? -1 : 1;
    return a._order - b._order;
  });

  return dedupeConfigs(ordered).map(({ _order, ...config }) => config);
}

function hasGenerationFields(cfg: RawConfig = {}) {
  return Boolean(
    cfg.imageGenerationApiUrl ||
    cfg.imageGenerationApiModel ||
    cfg.imageGenerationApiKey ||
    cfg.apiUrl ||
    cfg.model ||
    cfg.apiKey
  );
}

function getProviderList(generationCfg: RawConfig = {}) {
  return [
    ...asArray(generationCfg.providers),
    ...asArray(generationCfg.imageGenerationProviders),
    ...asArray(generationCfg.imageGenerationCandidates)
  ];
}

function getFallbackList(generationCfg: RawConfig = {}) {
  return asArray(generationCfg.imageGenerationFallbacks);
}

function getImageEditProviderList(editCfg: RawConfig = {}) {
  return [
    ...asArray(editCfg.providers),
    ...asArray(editCfg.imageEditProviders),
    ...asArray(editCfg.imageEditCandidates)
  ];
}

function getImageEditFallbackList(editCfg: RawConfig = {}) {
  return asArray(editCfg.imageEditFallbacks);
}

function hasExplicitImageEditFields(cfg: RawConfig = {}) {
  return Boolean(
    cfg.imageEditApiUrl ||
    cfg.imageEditApiModel ||
    cfg.imageEditApiKey ||
    cfg.imageEditSize
  );
}

function hasExplicitImageEditCapability(cfg: RawConfig = {}) {
  return [cfg.supportsImageEdit, cfg.imageEditSupported, record(cfg.capabilities).imageEdit, record(cfg.capabilities).image_edit]
    .some(value => value === true || String(value).toLowerCase() === "true");
}

export function isKnownImageEditModel(model = "") {
  const normalized = compactString(model);
  return /(?:^|\/)(?:gpt-image(?:[-_.][a-z0-9]+)*|image-?2(?:[-_.][a-z0-9]+)*)$/i.test(normalized);
}

function isExplicitImageEditEndpoint(apiUrl = "") {
  return /\/images\/edits\/?$/i.test(compactString(apiUrl));
}

function normalizeImageEditConfig(candidate: RawConfig = {}, fallback: RawConfig = {}, { explicitEditConfig = false, fromEditConfig = false } = {}): ImageProviderConfig | null {
  const candidateModel = pickFirst(
    candidate.imageEditApiModel,
    candidate.imageGenerationApiModel,
    candidate.model
  );
  const candidateUrl = pickFirst(
    candidate.imageEditApiUrl,
    candidate.imageGenerationApiUrl,
    candidate.apiUrl
  );
  const isChatEndpoint = /\/chat\/completions\/?$/i.test(candidateUrl);
  const supportsEdit =
    (explicitEditConfig && hasExplicitImageEditFields(candidate) && Boolean(candidateUrl) && !isChatEndpoint) ||
    hasExplicitImageEditCapability(candidate) ||
    isExplicitImageEditEndpoint(candidateUrl) ||
    isKnownImageEditModel(candidateModel);
  if (!supportsEdit) return null;

  const apiKey = pickFirst(
    candidate.imageEditApiKey,
    candidate.imageGenerationApiKey,
    candidate.apiKey,
    fallback.imageEditApiKey,
    fallback.imageGenerationApiKey,
    fallback.apiKey
  );
  if (isPlaceholderKey(apiKey)) return null;

  const model = pickFirst(
    candidateModel,
    fallback.imageEditApiModel,
    fallback.imageGenerationApiModel,
    fallback.model,
    DEFAULT_IMAGE_GENERATION_MODEL
  );
  const apiUrl = toImageEditUrl(pickFirst(
    candidateUrl,
    fallback.imageEditApiUrl,
    fallback.imageGenerationApiUrl,
    fallback.apiUrl,
    DEFAULT_IMAGE_EDIT_URL
  ));

  const editConfigOwnsDefaultSize = explicitEditConfig || fromEditConfig;
  return {
    name: pickFirst(candidate.name, candidate.label, fallback.name, model),
    aliases: uniqueStrings([...getImageProviderAliases(candidate), model]),
    apiUrl,
    apiKey,
    model,
    priority: normalizePriority(candidate.imageEditPriority ?? candidate.imageGenerationPriority ?? candidate.priority),
    size: pickFirst(
      candidate.imageEditSize,
      candidate.imageGenerationSize,
      candidate.size,
      fallback.imageEditSize,
      fallback.imageGenerationSize,
      fallback.size,
      DEFAULT_IMAGE_GENERATION_SIZE
    ),
    defaultEditSize: editConfigOwnsDefaultSize
      ? pickFirst(candidate.imageEditSize, candidate.size, fallback.imageEditSize, fallback.size)
      : "",
    squareSize: pickFirst(
      candidate.imageEditSquareSize,
      candidate.imageGenerationSquareSize,
      candidate.squareSize,
      fallback.imageEditSquareSize,
      fallback.imageGenerationSquareSize,
      fallback.squareSize
    ),
    portraitSize: pickFirst(
      candidate.imageEditPortraitSize,
      candidate.imageGenerationPortraitSize,
      candidate.portraitSize,
      fallback.imageEditPortraitSize,
      fallback.imageGenerationPortraitSize,
      fallback.portraitSize
    ),
    landscapeSize: pickFirst(
      candidate.imageEditLandscapeSize,
      candidate.imageGenerationLandscapeSize,
      candidate.landscapeSize,
      fallback.imageEditLandscapeSize,
      fallback.imageGenerationLandscapeSize,
      fallback.landscapeSize
    ),
    autoSize: pickFirst(
      candidate.imageEditAutoSize,
      candidate.imageGenerationAutoSize,
      candidate.autoSize,
      fallback.imageEditAutoSize,
      fallback.imageGenerationAutoSize,
      fallback.autoSize
    )
  };
}

function shouldUseLegacyGenerationConfig(generationCfg: RawConfig = {}, editCfg: RawConfig = {}) {
  const editModel = compactString(editCfg.imageEditApiModel);
  const editUrl = compactString(editCfg.imageEditApiUrl);
  return Boolean(
    hasGenerationFields(generationCfg) ||
    generationCfg.imageGenerationSize ||
    editCfg.imageGenerationApiUrl ||
    editCfg.imageGenerationApiModel ||
    editCfg.imageGenerationApiKey ||
    editCfg.imageGenerationSize ||
    /^gpt-image/i.test(editModel) ||
    /\/images\/(?:edits|generations)\/?$/i.test(editUrl) ||
    /souimagery\.fun/i.test(editUrl)
  );
}

function buildLegacyFallback(generationCfg: RawConfig = {}, editCfg: RawConfig = {}) {
  const editModel = compactString(editCfg.imageEditApiModel);
  return {
    imageGenerationApiUrl: pickFirst(
      generationCfg.imageGenerationApiUrl,
      editCfg.imageGenerationApiUrl,
      editCfg.imageEditApiUrl,
      DEFAULT_IMAGE_GENERATION_URL
    ),
    imageGenerationApiModel: pickFirst(
      generationCfg.imageGenerationApiModel,
      editCfg.imageGenerationApiModel,
      /^gpt-image/i.test(editModel) ? editModel : DEFAULT_IMAGE_GENERATION_MODEL
    ),
    imageGenerationApiKey: pickFirst(
      generationCfg.imageGenerationApiKey,
      editCfg.imageGenerationApiKey,
      editCfg.imageEditApiKey
    ),
    imageGenerationSize: pickFirst(
      generationCfg.imageGenerationSize,
      editCfg.imageGenerationSize,
      DEFAULT_IMAGE_GENERATION_SIZE
    ),
    imageGenerationSquareSize: generationCfg.imageGenerationSquareSize,
    imageGenerationPortraitSize: generationCfg.imageGenerationPortraitSize,
    imageGenerationLandscapeSize: generationCfg.imageGenerationLandscapeSize,
    imageGenerationAutoSize: generationCfg.imageGenerationAutoSize,
    imageGenerationPriority: generationCfg.imageGenerationPriority ?? generationCfg.priority,
    name: pickFirst(generationCfg.name, generationCfg.imageGenerationApiModel, editCfg.imageGenerationApiModel, editModel)
  };
}

export function resolveImageGenerationConfigs(configInput: unknown = {}) {
  const config = record(configInput);
  const generationCfg = record(config.imageGenerationAiConfig);
  const editCfg = record(config.imageEditAiConfig);
  const providerList = getProviderList(generationCfg);

  if (providerList.length) {
    const base = buildLegacyFallback(generationCfg, editCfg);
    const configs: ImageProviderConfig[] = [];
    const primary = normalizeImageGenerationConfig(base);
    if (primary) configs.push(primary);
    configs.push(...providerList
      .map(item => normalizeImageGenerationConfig(item, base))
      .filter((item): item is ImageProviderConfig => item !== null));
    return orderConfigs(configs);
  }

  const configs: ImageProviderConfig[] = [];
  if (shouldUseLegacyGenerationConfig(generationCfg, editCfg)) {
    const primary = normalizeImageGenerationConfig(buildLegacyFallback(generationCfg, editCfg));
    if (primary) configs.push(primary);
  }

  const fallbackBase = {
    imageGenerationApiUrl: generationCfg.imageGenerationApiUrl || DEFAULT_IMAGE_GENERATION_URL,
    imageGenerationApiKey: generationCfg.imageGenerationApiKey,
    imageGenerationSize: generationCfg.imageGenerationSize || DEFAULT_IMAGE_GENERATION_SIZE,
    imageGenerationSquareSize: generationCfg.imageGenerationSquareSize,
    imageGenerationPortraitSize: generationCfg.imageGenerationPortraitSize,
    imageGenerationLandscapeSize: generationCfg.imageGenerationLandscapeSize,
    imageGenerationAutoSize: generationCfg.imageGenerationAutoSize
  };
  for (const fallback of getFallbackList(generationCfg)) {
    const normalized = normalizeImageGenerationConfig(fallback, fallbackBase);
    if (normalized) configs.push(normalized);
  }

  return orderConfigs(configs);
}

export function resolveImageEditConfigs(configInput: unknown = {}) {
  const config = record(configInput);
  const generationCfg = record(config.imageGenerationAiConfig);
  const editCfg = record(config.imageEditAiConfig);
  const configs: ImageProviderConfig[] = [];

  const primary = normalizeImageEditConfig(editCfg, {}, { explicitEditConfig: true });
  if (primary) configs.push(primary);

  const fallbackCandidates = [
    ...getImageEditProviderList(editCfg).map(candidate => ({ candidate, fallback: editCfg, fromEditConfig: true })),
    ...getImageEditFallbackList(editCfg).map(candidate => ({ candidate, fallback: editCfg, fromEditConfig: true })),
    { candidate: generationCfg, fallback: generationCfg, fromEditConfig: false },
    ...getProviderList(generationCfg).map(candidate => ({ candidate, fallback: generationCfg, fromEditConfig: false })),
    ...getFallbackList(generationCfg).map(candidate => ({ candidate, fallback: generationCfg, fromEditConfig: false }))
  ];
  const fallbacks = fallbackCandidates
    .map(({ candidate, fallback, fromEditConfig }) => normalizeImageEditConfig(candidate, fallback, { fromEditConfig }))
    .filter((item): item is ImageProviderConfig => item !== null);

  return dedupeConfigs([
    ...configs,
    ...orderConfigs(fallbacks)
  ]);
}

export function isImageToolContractError(errorMessage = "") {
  const message = String(errorMessage || "");
  return /tool choice\s*['\"]?image_generation['\"]?.*not found.*tools?\s+parameter|image_generation.*(?:missing|not found|not present|未找到|不存在).*(?:tools?|工具)/i.test(message);
}

export function shouldRetryWithoutUrlResponseFormat(errorMessage = "") {
  const message = String(errorMessage || "");
  if (isImageToolContractError(message)) return false;
  return /response[_ -]?format|b64_json/i.test(message) &&
    /unsupported|not support|unknown parameter|invalid parameter|not allowed|不支持|未知参数|无效参数/i.test(message);
}

export function describeImageGenerationConfig(configInput: unknown = {}, index = 0) {
  const config = record(configInput);
  const name = compactString(config.name) || compactString(config.model) || `candidate-${index + 1}`;
  const model = compactString(config.model);
  return model && model !== name ? `${name}(${model})` : name;
}

export function buildImageGenerationFailureMessage(errors: readonly { label: string; message?: string | undefined }[] = []) {
  const details = errors
    .map(item => `${item.label}: ${item.message}`)
    .filter(Boolean)
    .join("；");
  return details ? `所有文生图模型都失败了：${details}` : "所有文生图模型都失败了";
}

export function buildImageEditFailureMessage(errors: readonly { label: string; message?: string | undefined }[] = []) {
  const details = errors
    .map(item => `${item.label}: ${item.message}`)
    .filter(Boolean)
    .join("；");
  return details ? `所有图片编辑通道都失败了：${details}` : "所有图片编辑通道都失败了";
}

