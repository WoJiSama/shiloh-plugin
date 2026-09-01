import { safeTruncateUnicode } from "./unicodeText.js"

const VAGUE_REFERENCE_RE = /(?:这个|这张|它|上面|里面|前面|刚才|刚刚|之前|上一张|上一个|照着|参考|按这个|根据这个|画这个|改这个|修这个|继续|接着|沿用|同风格|同样的?|还是那个)/
const EDIT_RE = /(?:修图|改图|编辑|美化|去水印|换背景|换衣服|加上|添加|去掉|删除|移除|改成|变成|可爱点|好看点|清晰|修复|重绘)/
const COMPILED_PROMPT_MARKER = "【绘图请求原文】"
const IMAGE_REQUEST_RE = /(?:画图|生图|生成(?:一?[张个幅])?(?:图片|照片|图|插画|壁纸|头像|封面|海报|立绘)|画(?:一?[张个幅位只])?|绘制|出图|做(?:一?张)?(?:图|图片|照片)|捏(?:一?个)?(?:角色|人物|图))/i
const SOURCE_CONTEXT_RE = /(?:根据|按照|按|照着|参考|用|拿|以|把|将).{0,20}(?:上面|前面|这个|这段|这句|引用|回复|对话|聊天|内容|描述|设定|故事|台词)|(?:上面|前面|这个|这段|这句|引用|回复|对话|聊天|内容|描述|设定|故事|台词).{0,28}(?:画|绘制|生成|出图|做成|画成)/i
const DRAW_CONTINUATION_RE = /(?:继续|接着|沿用|同风格|同样的?|还是那个|上一张|上张|刚才那张|之前那张|再来一张|再画一张|在那张基础上|按刚才那张)/i
const IMAGE_DETAIL_RE = /(?:上午|中午|下午|黄昏|傍晚|晚上|夜晚|深夜|黎明|清晨|日出|日落|晴天|雨天|下雨|下雪|阴天|时间|季节|春天|夏天|秋天|冬天|比例|尺寸|分辨率|横版|竖版|横屏|竖屏|正方形|\d+\s*[:x×*]\s*\d+|构图|镜头|视角|俯拍|仰拍|特写|全身|半身|近景|远景|广角|背景|前景|场景|风格|写实|二次元|漫画|插画|水墨|赛璐璐|厚涂|像素|色彩|颜色|红色|橙色|黄色|绿色|蓝色|紫色|黑色|白色|灰色|粉色|金色|银色|光线|光影|明亮|昏暗|人物|角色|少女|少年|女孩|男孩|男人|女人|猫|狗|动物|头发|发色|眼睛|五官|脸|表情|微笑|衣服|服装|裙|裤|鞋|丝袜|姿势|动作|站|坐|蹲|躺|手|脚|道具|拿着|抱着|可爱|帅气|冷淡|开心|悲伤|干净|细节|文字|字体|题字|不要.{0,12}(?:复杂|杂乱|模糊|太亮|太暗|鲜艳|单调)|改成|换成|变成|加上|添加|去掉|去除|删除|保留)/i
const INDEPENDENT_REQUEST_RE = /(?:查一下|查查|搜索|搜一下|告诉我|解释|总结|翻译|计算|算一下|提醒|艾特|禁言|撤回|点歌|天气|新闻|排名|表格|excel|为什么|怎么回事|是什么|是谁|多少|几点|能不能|可以吗|好吗|吗[？?]?\s*$|[？?]\s*$)/i

function compact(text = "", maxLength = 1200) {
  return safeTruncateUnicode(String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/\r/g, "")
    .trim(), maxLength)
}

export function resolveImageContextMode(prompt = "", quotedContext = "") {
  const text = compact(prompt, 2600)
  if (compact(quotedContext, 1800)) return "quoted"
  if (SOURCE_CONTEXT_RE.test(text)) return "source"
  if (DRAW_CONTINUATION_RE.test(text)) return "draw"
  return "none"
}

export function isImagePromptSupplement(text = "") {
  const content = compact(text, 600)
  if (!content || INDEPENDENT_REQUEST_RE.test(content)) return false
  return IMAGE_DETAIL_RE.test(content)
}

export function selectMergedImagePromptTexts(texts = []) {
  const items = (Array.isArray(texts) ? texts : [texts])
    .map(item => compact(item, 1200))
    .filter(Boolean)
  if (items.length <= 1) return items

  let anchorIndex = -1
  for (let index = 0; index < items.length; index++) {
    if (IMAGE_REQUEST_RE.test(items[index])) anchorIndex = index
  }

  if (anchorIndex < 0) {
    const supplements = items.filter(item => DRAW_CONTINUATION_RE.test(item) || isImagePromptSupplement(item))
    return supplements.length ? supplements : [items.at(-1)]
  }

  const anchor = items[anchorIndex]
  const selected = resolveImageContextMode(anchor) === "source"
    ? items.slice(0, anchorIndex + 1)
    : [anchor]
  for (const item of items.slice(anchorIndex + 1)) {
    if (isImagePromptSupplement(item)) selected.push(item)
  }
  return selected
}

export function selectLatestDrawContextLines(lines = [], maxLines = 3) {
  const items = (Array.isArray(lines) ? lines : [])
    .map(item => ({
      text: compact(item?.text || item, 600),
      isDrawRequest: Boolean(item?.isDrawRequest)
    }))
    .filter(item => item.text)
  if (!items.length) return []

  let latestRequestIndex = -1
  for (let index = 0; index < items.length; index++) {
    if (items[index].isDrawRequest) latestRequestIndex = index
  }
  const limit = Math.max(1, Math.min(6, Number(maxLines) || 3))
  return (latestRequestIndex >= 0
    ? items.slice(latestRequestIndex, latestRequestIndex + limit)
    : items.slice(-1))
    .map(item => item.text)
}

function inferTask(task = "", prompt = "") {
  if (task === "image_edit" || task === "image_generation") return task
  return EDIT_RE.test(prompt) ? "image_edit" : "image_generation"
}

function hasMeaningfulPrompt(text = "") {
  const content = compact(text)
  if (!content) return false
  const stripped = content
    .replace(/^(希洛|小希洛|bot|机器人)[，,：:\s]*/i, "")
    .replace(/^(帮我|给我|替我|麻烦|可以|能不能|能不能帮我|请你)?(画|生成|生图|出图|做图|修|改|编辑|看看|弄一下|处理一下)?/i, "")
    .replace(VAGUE_REFERENCE_RE, "")
    .replace(/[，。,.!！?？\s]/g, "")
  return stripped.length >= 2
}

function shouldUseRecentContext({ prompt = "", recentContext = "", hasContextualReference = false }) {
  if (!compact(recentContext)) return false
  if (!hasMeaningfulPrompt(prompt)) return true
  return Boolean(hasContextualReference) || VAGUE_REFERENCE_RE.test(prompt)
}

export function compileImagePrompt(options = {}) {
  const task = inferTask(options.task, options.userPrompt || options.prompt || "")
  const prompt = compact(options.userPrompt || options.prompt || "", 2400)
  if (prompt.includes(COMPILED_PROMPT_MARKER)) {
    return compact(prompt, task === "image_edit" ? 4800 : 4400)
  }

  const quotedContext = compact(options.quotedContext || "", 1800)
  const hasReferenceImages = Boolean(options.hasReferenceImages)
  const hasContextualReference = Boolean(options.hasContextualReference) ||
    VAGUE_REFERENCE_RE.test([prompt, quotedContext].filter(Boolean).join("\n"))
  const rawRecentContext = compact(options.recentContext || "", 1200)
  const recentContext = shouldUseRecentContext({ prompt, recentContext: rawRecentContext, hasContextualReference })
    ? rawRecentContext
    : ""

  const lines = [
    COMPILED_PROMPT_MARKER,
    `任务类型：${task === "image_edit" ? "图片编辑/图生图" : "图片生成"}`,
    prompt ? `用户原话（必须保留原词，不得改写、替换、软化或扩写）：\n${prompt}` : "",
    quotedContext ? `用户引用的原文：\n${quotedContext}` : "",
    recentContext ? `用户明确指代时可参考的近期原文：\n${recentContext}` : "",
    hasReferenceImages ? "请求中附有参考图片；图片用途和顺序以素材清单为准。" : "",
    "不要自动补充质量词、风格词、构图词、情绪词或安全化措辞；只按上述用户原话和明确上下文执行。"
  ].filter(Boolean)

  return compact(lines.join("\n"), task === "image_edit" ? 4800 : 4400)
}
