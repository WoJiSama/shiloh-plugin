const EDIT_ACTION_PATTERN = /(?:修图|改图|编辑图片|图片编辑|局部重绘|去水印|换背景|换衣服|换颜色|换发型|换脸|换头|取消掉|去掉|去除|删掉|删除|移除|擦掉|抹掉|修掉|改掉|修改|调整|修一下|改一下|再修|修得|改得|融合|贴合|换成|替换成|替换掉|改成|变成|变为|加上|添加|放上|画上|保留|增强|修复|补全|扩展|扩成|修自然|修得自然|换掉)/i
const IMAGE_SUBJECT_PATTERN = /(?:图|图片|照片|截图|头像|画面|人物|角色|脸|头|手|手臂|背景|衣服|颜色|发型|水印|物体|路人|耳朵|五官|光影|构图)/i
const IMAGE_CONTEXT_PATTERN = /(?:这张|这个图|图片|照片|截图|画面|图里|图中|上一张|上一版|刚才那张|刚生成|刚画|成图|继续)/i
const DIAGNOSTIC_VISUAL_PATTERN = /(?:截图|代码|IDEA|IntelliJ|Maven|Gradle|Tomcat|Servlet|依赖|报错|错误|红了|红线)/i
const AVATAR_INSPECTION_PATTERN = /(?:看|看看|看下|看一下|帮.*看|分析|识别|描述|评价|点评|说说|讲讲).{0,24}头像|头像.{0,24}(?:看|看看|分析|识别|描述|评价|点评|怎么样|好看|是什么|是啥|有啥|像什么|说说|讲讲)/i
const EXPLICIT_IMAGE_GENERATION_PATTERN = /(?:画图|画画|生图|出图|生成图片|生成照片|生成一?张(?:图|图片|照片|照)|画一?张|绘制一?张|做一?张(?:图|图片|照片|照)|从零(?:画|生成|绘制|做)|(?:帮我|给我|请|麻烦).{0,12}(?:画|绘制|生成|做).{0,80}(?:图|画|插画|图片|照片|角色)|(?:画|绘制|生成|做|捏)(?:一|1)?(?:个|张|幅|只|位)?.{1,180}(?:的)?(?:画|画面|图|图片|照片|插画|立绘)(?:$|[，,。.!！?？])|(?<![笔字漫画动刻描油])(?:画|绘制|捏)(?:一|1)?(?:个|张|幅|只|位)[^，,。！!？?？\n]{1,80}|提示词(?:为|是|：|:))/i
const EXISTING_IMAGE_ANCHOR_PATTERN = /(?:这张|那张|这一张|那一张|这个图|那个图|这幅图|那幅图|该图|上图|原图|底图|上一张|上张|刚才那张|刚刚那张|前面那张|我发的|我上传的|发给你的|给你的|回复的|引用的).{0,12}(?:图|图片|照片|截图|头像|画面)?|(?:回复|引用|按照|照着|基于|参考).{0,8}(?:这张|那张|上图|原图|我发的|刚才|刚刚|上一张).{0,8}(?:图|图片|照片|截图|头像|画面)/i

export function hasExplicitImageGenerationRequest(text = "") {
  return EXPLICIT_IMAGE_GENERATION_PATTERN.test(String(text || "").replace(/\s+/g, " ").trim())
}

export function hasExistingImageAnchor(text = "") {
  return EXISTING_IMAGE_ANCHOR_PATTERN.test(String(text || "").replace(/\s+/g, " ").trim())
}

export function isStandaloneImageGenerationRequest(text = "", { hasImages = false, hasRecentBotImage = false } = {}) {
  const content = String(text || "").replace(/\s+/g, " ").trim()
  if (!content || hasImages || hasRecentBotImage) return false
  if (!hasExplicitImageGenerationRequest(content)) return false
  return !hasExistingImageAnchor(content)
}

export function hasExplicitImageEditAction(text = "", { hasImages = false, hasRecentBotImage = false } = {}) {
  const content = String(text || "").trim()
  if (hasRecentBotImage && /(?:继续|接着|再).{0,8}(?:改|修|调|换|删)|(?:改|修|调|换|删).{0,8}(?:上一张|上张|刚才|刚刚)/.test(content)) return true
  if (!content || !EDIT_ACTION_PATTERN.test(content)) return false
  if (hasRecentBotImage && /(?:刚|上一|继续|再)/.test(content)) return true
  const hasVisualSubject = IMAGE_SUBJECT_PATTERN.test(content)
  const hasImageContext = IMAGE_CONTEXT_PATTERN.test(content) || hasImages || hasRecentBotImage
  const imperativeVisualEdit = /^(?:请|麻烦|帮我|给我|把|将|去掉|删除|移除|擦掉|调整|修改|修一下|改一下)/.test(content) && hasVisualSubject
  const addressedImperativeVisualEdit = /(?:请|麻烦|帮我|给我|把|将).{0,36}(?:图|图片|照片|截图|头像|脸|头|背景|衣服|发型)/.test(content)
  return hasVisualSubject && (hasImageContext || imperativeVisualEdit || addressedImperativeVisualEdit)
}

export function shouldRequireImageEditBase(text = "", options = {}) {
  // Whether a message refers to an existing image is a factual boundary. The
  // generation-vs-edit intent inside a free-form prompt belongs to the model.
  if (options.hasImages || options.hasRecentBotImage || !hasExistingImageAnchor(text)) return false
  return hasExplicitImageEditAction(text, options) || hasExplicitImageGenerationRequest(text)
}

export function shouldPreferImageGeneration(text = "", options = {}) {
  if (isStandaloneImageGenerationRequest(text, options)) return true
  return hasExplicitImageGenerationRequest(text) && !hasExplicitImageEditAction(text, options)
}

export function shouldTreatAsAvatarInspection(text = "", options = {}) {
  const content = String(text || "").trim()
  if (!content || !content.includes("头像")) return false
  if (hasExplicitImageEditAction(content, options)) return false
  return AVATAR_INSPECTION_PATTERN.test(content)
}

export function shouldRenderImageAnalysisAsDocument({ userText = "", output = "", looksDiagnostic = false } = {}) {
  const content = String(userText || "")
  if (!DIAGNOSTIC_VISUAL_PATTERN.test(content)) return false
  return String(output || "").trim().length > 120 || Boolean(looksDiagnostic)
}

export function classifyImageTaskPolicy({ text = "", hasImages = false, hasRecentBotImage = false } = {}) {
  const options = { hasImages, hasRecentBotImage }
  if (!hasImages && !hasRecentBotImage && shouldRequireImageEditBase(text, options)) return "image_edit_missing_base"
  if (shouldPreferImageGeneration(text, options)) return "image_generation"
  if (hasExplicitImageEditAction(text, { hasImages, hasRecentBotImage })) {
    return hasImages || hasRecentBotImage ? "image_edit" : "image_edit_missing_base"
  }
  if (shouldTreatAsAvatarInspection(text, { hasImages, hasRecentBotImage })) return hasImages ? "image_analysis" : "avatar_inspection"
  if (/(?:画一|绘制一|生成一|做一张|出一张|生图|画个|绘制一个|生成可爱)/i.test(text)) return "image_generation"
  if (hasImages && /(?:图|图片|照片|截图|头像|画|人物|角色|手|脸|五官)/i.test(text) && /(?:为什么|怎么|哪里|哪儿|很怪|不自然|分析|看看|评价|像吗|好看吗|有几个|有几个人|发生了什么|解释)/i.test(text)) return "image_analysis"
  if (/(?:看图|看一下这张|看看这张|看看这幅|分析图片|分析一下|识别图片|图里|图中|图片里|这张照片|这张头像|这像吗|好看吗|哪里不自然|哪里错|怎么看|解释一下|有几个人|发生了什么)/i.test(text)) {
    return hasImages ? "image_analysis" : "image_analysis_missing_image"
  }
  return "chat"
}
