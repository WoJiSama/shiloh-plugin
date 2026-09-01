const ORIENTATIONS = new Set(["square", "portrait", "landscape"])

const DEFAULT_GPT_IMAGE_SIZES = Object.freeze({
  square: "1024x1024",
  portrait: "1024x1536",
  landscape: "1536x1024"
})

function compact(value = "") {
  return String(value || "").trim()
}

function positiveNumber(value) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : 0
}

function orientationFromDimensions(width, height) {
  const w = positiveNumber(width)
  const h = positiveNumber(height)
  if (!w || !h) return ""
  const ratio = w / h
  if (ratio >= 0.95 && ratio <= 1.05) return "square"
  return ratio < 1 ? "portrait" : "landscape"
}

function buildIntent(orientation, source, width = 0, height = 0, raw = "") {
  if (!ORIENTATIONS.has(orientation)) return null
  const w = positiveNumber(width)
  const h = positiveNumber(height)
  return {
    orientation,
    source,
    raw: compact(raw),
    width: w || null,
    height: h || null,
    ratio: w && h ? w / h : (orientation === "square" ? 1 : null)
  }
}

function parseStructuredRatio(value = "", source = "explicit") {
  const text = compact(value).toLowerCase()
  if (!text) return null
  if (ORIENTATIONS.has(text)) return buildIntent(text, source, 0, 0, text)

  const commonRatios = new Set(["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"])
  for (const dimensions of text.matchAll(/([1-9]\d{0,4})\s*([:x×*])\s*([1-9]\d{0,4})/gi)) {
    const width = Number(dimensions[1])
    const separator = dimensions[2]
    const height = Number(dimensions[3])
    const before = text[dimensions.index - 1] || ""
    const after = text[dimensions.index + dimensions[0].length] || ""
    if (/\d/.test(before) || /\d/.test(after)) continue

    if (source === "user_text" && separator === ":") {
      const ratioKey = `${width}:${height}`
      const beforeNearby = text.slice(Math.max(0, dimensions.index - 12), dimensions.index)
      const afterNearby = text.slice(dimensions.index + dimensions[0].length, dimensions.index + dimensions[0].length + 12)
      const hasRatioContext = /(?:比例|尺寸|画布|分辨率|aspect|ratio)[^，。,.]{0,6}$/i.test(beforeNearby) ||
        /^[\s的]*(?:比例|尺寸|画布|分辨率|aspect|ratio)/i.test(afterNearby)
      if (!commonRatios.has(ratioKey) && !hasRatioContext) continue
    }

    return buildIntent(orientationFromDimensions(width, height), source, width, height, dimensions[0])
  }
  return null
}

/**
 * Extracts only the requested canvas orientation. Pixel expressions such as
 * 1024x1536 are deliberately treated as ratios, not exact output dimensions.
 */
export function resolveImageAspectRatioIntent(text = "", explicitAspectRatio = "") {
  const explicit = parseStructuredRatio(explicitAspectRatio, "tool_parameter")
  if (explicit) return explicit

  const source = String(text || "").replace(/\[CQ:[^\]]+\]/g, " ")
  const numeric = parseStructuredRatio(source, "user_text")
  if (numeric) return numeric

  if (/(?:竖版|竖屏|纵向|直向|portrait|手机壁纸|手机海报|长竖图)/i.test(source)) {
    return buildIntent("portrait", "user_text", 0, 0, "portrait")
  }
  if (/(?:横版|横屏|横向|宽屏|landscape|电脑壁纸|桌面壁纸)/i.test(source)) {
    return buildIntent("landscape", "user_text", 0, 0, "landscape")
  }
  if (/(?:正方形|方形构图|square)/i.test(source)) {
    return buildIntent("square", "user_text", 0, 0, "square")
  }
  return null
}

function firstConfigured(config = {}, keys = []) {
  for (const key of keys) {
    const value = compact(config?.[key])
    if (value) return value
  }
  return ""
}

function isRatioBearingSize(value = "") {
  return /^\s*[1-9]\d{0,4}\s*[x×*]\s*[1-9]\d{0,4}\s*$/i.test(compact(value))
}

function isNeutralResolutionSize(value = "") {
  return /^(?:auto|[1-9]\d*(?:\.\d+)?k)$/i.test(compact(value))
}

function knownProviderSizes(config = {}) {
  const model = compact(config.model)
  if (/(?:^|\/)(?:gpt-image(?:[-_.][a-z0-9]+)*|image-?2(?:[-_.][a-z0-9]+)*)$/i.test(model)) {
    return DEFAULT_GPT_IMAGE_SIZES
  }
  return null
}

/**
 * Resolves a provider-supported request size without changing the prompt.
 * Each provider is resolved independently so fallback channels may use
 * different size catalogs.
 */
export function resolveImageProviderSize(config = {}, intent = null, options = {}) {
  const operation = options.operation === "edit" ? "edit" : "generate"
  const defaultSize = compact(config.size)

  if (!intent?.orientation) {
    if (operation === "edit") {
      return firstConfigured(config, ["autoSize", "imageEditAutoSize", "defaultEditSize"])
    }
    return defaultSize
  }

  const orientation = intent.orientation
  const configured = firstConfigured(config, orientation === "square"
    ? ["squareSize", "imageSquareSize"]
    : orientation === "portrait"
      ? ["portraitSize", "imagePortraitSize"]
      : ["landscapeSize", "imageLandscapeSize"])
  if (configured) return configured

  const knownSizes = knownProviderSizes(config)
  if (knownSizes?.[orientation]) return knownSizes[orientation]

  // Values such as 2K describe quality/resolution without forcing an aspect
  // ratio, so keep them. A fixed WxH with the wrong orientation is omitted.
  if (isNeutralResolutionSize(defaultSize)) return defaultSize
  if (isRatioBearingSize(defaultSize)) {
    const parsed = parseStructuredRatio(defaultSize, "provider_default")
    return parsed?.orientation === orientation ? defaultSize : ""
  }
  return defaultSize
}

export function applyImageAspectRatioToConfigs(configs = [], intent = null, options = {}) {
  const candidates = (Array.isArray(configs) ? configs : [configs]).filter(Boolean)
  return candidates.map(config => ({
    ...config,
    size: resolveImageProviderSize(config, intent, options)
  }))
}

export function describeImageAspectRatioIntent(intent = null) {
  if (!intent?.orientation) return "unspecified"
  return intent.raw ? `${intent.orientation}(${intent.raw})` : intent.orientation
}
