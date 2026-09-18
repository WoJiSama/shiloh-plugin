import { isImageGenerationRequest, isImageCompositionEditRequest, isImageAnalysisRequest } from "../core/intent/messageIntent.js"
import { isLongRunningTaskLinkRequest } from "./smartLockPolicy.js"

// 长任务统一反馈契约：立刻本地回一句（不经模型）、过程消息可查、结束只出结果、失败只出事实。
// 本表是各类长耗时任务反馈策略的唯一来源：smart 锁是否提前释放、开场由谁负责。
// 出站消息仲裁（docs/refactor-blueprint.md §四.3）落地后，开场/进度/结果/失败都过同一个队列，并继续消费本表。
export const LONG_TASK_FEEDBACK_POLICIES = {
  image_generate: {
    releaseSmartLock: true,
    // bananaTool：排队时本地固定开场 + contextualProgressReply 生成进度接话
    openingMode: "tool"
  },
  image_edit: {
    releaseSmartLock: true,
    // googleImageEditTool：contextualProgressReply 生成进度接话
    openingMode: "tool"
  },
  image_analysis: {
    // 识图是同步视觉调用，此前不释放 smart 锁，跑的整段时间该群其他触发全部排队
    releaseSmartLock: true,
    // googleAnalysisTool：contextualProgressReply 生成进度接话
    openingMode: "tool"
  },
  media_link: {
    releaseSmartLock: true,
    // 磁链/视频解析：torrentDownloadTool 本地"正在识别磁链"开场 + 完成/失败回执
    openingMode: "tool"
  },
  web: {
    // webParserTool 是 puppeteer 同步抓取（30s+），此前既不释放锁也全程静默
    releaseSmartLock: true,
    openingMode: "local",
    openingText: "我打开这个页面看看"
  }
}

const PLAIN_WEB_URL_PATTERN = /(https?:\/\/|www\.)\S+/i

export function classifyLongTaskFeedback(text = "") {
  const content = String(text || "")
  if (!content) return null
  if (isImageGenerationRequest(content)) return "image_generate"
  if (isImageCompositionEditRequest(content)) return "image_edit"
  if (isImageAnalysisRequest(content)) return "image_analysis"
  // 磁链/B站/抖音链接要在通用网页判定之前，避免被 web 吃掉
  if (isLongRunningTaskLinkRequest(content)) return "media_link"
  if (PLAIN_WEB_URL_PATTERN.test(content)) return "web"
  return null
}

export function resolveLongTaskFeedbackPolicy(text = "") {
  const kind = classifyLongTaskFeedback(text)
  if (!kind) return null
  return { kind, ...LONG_TASK_FEEDBACK_POLICIES[kind] }
}

const openedKindsByEvent = new WeakMap()

// 本地开场直接取策略表文案立即发送，不等待、不经过模型；发送失败不阻断工具执行。
// 同一事件上同一类任务只发一次，避免多轮工具循环对同一轮重复开场。
export async function sendLongTaskOpening(e, kind) {
  const policy = LONG_TASK_FEEDBACK_POLICIES[kind]
  if (!e || policy?.openingMode !== "local" || !policy.openingText) return ""
  let opened = openedKindsByEvent.get(e)
  if (!opened) {
    opened = new Set()
    openedKindsByEvent.set(e, opened)
  }
  if (opened.has(kind)) return ""
  opened.add(kind)
  try {
    await e.reply?.(policy.openingText)
    globalThis.logger?.info?.(`[长任务反馈] kind=${kind} 本地开场已发送`)
  } catch (error) {
    globalThis.logger?.warn?.(`[长任务反馈] kind=${kind} 本地开场发送失败，不中止任务: ${error?.message || error}`)
  }
  return policy.openingText
}
