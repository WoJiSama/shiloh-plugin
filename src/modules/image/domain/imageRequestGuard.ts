const VISUAL_INSPECTION_VERB_RE = /(?:看看|看下|看一下|看一眼|帮我看|帮我看看|瞅瞅|瞧瞧|评价一下|评一下|分析一下|识别一下)/
const CONCRETE_VISUAL_TARGET_RE = /(?:腿|手|手臂|胳膊|脸|眼睛|头发|发型|衣服|裙子|鞋|穿搭|姿势|表情|身材|比例|细节)/
const EXPLICIT_IMAGE_REFERENCE_RE = /(?:这张\s*(?:图|图片|照片|截图)|这图|图里|图中|图片|照片|截图|画面|头像|这个\s*(?:画面|细节))/
const IMAGE_LOCATION_RE = /(?:里面|上面|图里|图中|画面里)/
const CONVERSATION_REFERENCE_RE = /(?:上文|前文|前面(?:说|聊|提|发)|上面(?:说|聊|提|发)|他上面|她上面|他说|她说|群友|聊天|对话|发言|回复|说的话|提到的|事情|这件事|那件事|行为|做法|观点|一直.{0,16}(?:找|说|聊|问|发|做)|找项目|工作|项目)/
const NON_VISUAL_ADVICE_RE = /(?:疼|痛|酸|麻|肿|伤|受伤|抽筋|治疗|医生|医院|怎么练|怎么锻炼|如何练|训练|锻炼|拉伸|运动|怎么办|咋办)/
const IMAGE_REFERENCE_RE = /(?:这个|这张|这图|图|图片|照片|截图|画面|里面|上面|内容|消息|新闻|说法)/
const VERIFICATION_RE = /(?:真假|真的假的|真假的|是不是真的|是不是假的|是不是真|是不是AI|是不是ai|AI生成|ai生成|P图|p图|伪造|造假|辟谣|核实|查证|验证|可信|靠谱吗|真实性|真不真|假不假)/
const IMAGE_LOOKUP_RE = /(?:查一下|查查|帮我查|搜一下|搜索|网上查|联网查|看看|看下|看一下|帮我看|最新|现在最新)/
const IMAGE_AUTHENTICITY_RE = /(?:是不是AI|是不是ai|AI生成|ai生成|P图|p图|P的|p的|修过|改过|合成|伪造痕迹|篡改|图片本身|图本身|这张图本身|这张图片本身)/

function normalizeVisualRequestText(text = "") {
  return String(text || "")
    .replace(/\[CQ:[^\]]+\]/g, " ")
    .replace(/@QQ:\d+|@BOT/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

export function looksLikeVisualInspectionRequest(text = "") {
  const content = normalizeVisualRequestText(text)
  if (!content) return false
  if (!VISUAL_INSPECTION_VERB_RE.test(content)) return false
  if (NON_VISUAL_ADVICE_RE.test(content)) return false
  const explicitImageReference = EXPLICIT_IMAGE_REFERENCE_RE.test(content)
  if (!explicitImageReference && CONVERSATION_REFERENCE_RE.test(content)) return false
  return explicitImageReference || CONCRETE_VISUAL_TARGET_RE.test(content)
}

export function shouldAskForMissingImageForVisualRequest(text = "") {
  const content = normalizeVisualRequestText(text)
  if (!looksLikeVisualInspectionRequest(content)) return false
  const explicitImageReference = EXPLICIT_IMAGE_REFERENCE_RE.test(content)
  if (!explicitImageReference && CONVERSATION_REFERENCE_RE.test(content)) return false
  if (looksLikeImageVerificationRequest(content)) return explicitImageReference
  return explicitImageReference || (CONCRETE_VISUAL_TARGET_RE.test(content) && IMAGE_LOCATION_RE.test(content))
}

export function looksLikeImageVerificationRequest(text = "") {
  const content = normalizeVisualRequestText(text)
  if (!content) return false
  if (NON_VISUAL_ADVICE_RE.test(content)) return false
  if (!EXPLICIT_IMAGE_REFERENCE_RE.test(content) && CONVERSATION_REFERENCE_RE.test(content)) return false
  if (VERIFICATION_RE.test(content) && (IMAGE_REFERENCE_RE.test(content) || IMAGE_LOOKUP_RE.test(content))) return true
  return IMAGE_REFERENCE_RE.test(content) && IMAGE_LOOKUP_RE.test(content) && /(?:真|假|最新|现在|信息|来源|出处)/.test(content)
}

export function looksLikeImageAuthenticityRequest(text = "") {
  const content = normalizeVisualRequestText(text)
  if (!content) return false
  return IMAGE_AUTHENTICITY_RE.test(content)
}

export function buildMissingImageAnalysisReply() {
  return "这条消息里没有可看的图片。把图片发来，或者回复原图，我再按图说。"
}
