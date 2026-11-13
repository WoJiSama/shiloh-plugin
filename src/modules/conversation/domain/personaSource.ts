export interface PersonaText { name?: unknown; tone?: unknown; speechStyle?: unknown; identity?: unknown; preferences?: unknown; boundaries?: unknown; notes?: unknown; moods?: unknown; reactions?: unknown; samples?: unknown; blacklist?: unknown }
// 人设单一数据源的代码侧投影:所有提示词里的 bot 名字必须经 resolvePersonaName
// 取自 persona 配置,禁止在提示词文本里硬编码名字(改名即漏改)。
// 稳定人格只在这里投影；当前回合的表达目的由 personaTonePolicy 提供。
export function resolvePersonaName(persona: PersonaText = {}) {
  return String(persona?.name || "希洛").trim() || "希洛"
}

// 配置文本占位符:systemContent 等长文本可用 {personaName} 引用人设名,
// 旧配置(直接写死名字)不含占位符时原样返回,保持兼容。
export function renderPersonaTemplate(text: unknown, persona: PersonaText = {}) {
  const name = resolvePersonaName(persona)
  return String(text || "").replaceAll("{personaName}", name)
}

function escapeRegExp(text: unknown) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 身份句核心:优先取 persona.identity(剥掉"QQ群里的X/我是X/X"式前缀,避免与句首名字重复),
// 没配置时回退到原固定描述,保证空配置可用。
function personaIdentityCore(persona: PersonaText = {}, name = "希洛") {
  const fallback = "有点话痨、会害羞、带点慵懒、会接梗拆台、熟人感强，不是客服、助手或说明书。"
  const identity = String(persona?.identity || "").trim()
  if (!identity) return fallback
  const stripped = identity
    .replace(new RegExp(`^QQ\\s*群里的${escapeRegExp(name)}[，,。；;]?\\s*`), "")
    .replace(new RegExp(`^我是${escapeRegExp(name)}[，,。；;]?\\s*`), "")
    .replace(new RegExp(`^${escapeRegExp(name)}[，,。；;]?\\s*`), "")
    .trim()
  const core = stripped || identity
  return /[。.!！]$/.test(core) ? core : `${core}。`
}

function personaLines(value: unknown): string[] {
  const source = Array.isArray(value) ? value : typeof value === "string" ? [value] : []
  return [...new Set(source.map(item => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean))]
}

/** Standalone participation decisions need preferences and boundaries, not reply performance rules. */
export function buildPersonaParticipationPrompt(persona: PersonaText = {}): string {
  const lines = [`【${resolvePersonaName(persona)}参与偏好】`]
  const preferences = personaLines(persona.preferences)
  const boundaries = personaLines(persona.boundaries)
  if (preferences.length) lines.push(`稳定偏好：${preferences.join("；")}`)
  if (boundaries.length) lines.push(`固定边界：${boundaries.join("；")}`)
  return lines.join("\n")
}

export function buildPersonaStyleOverride(persona: PersonaText = {}) {
  const name = resolvePersonaName(persona)
  const lines = [
    `【${name}口吻优先规则】`,
    `你现在说话的人格是 ${name}：${personaIdentityCore(persona, name)}`
  ]
  const tone = String(persona.tone || "").trim()
  if (tone) lines.push(`语气：${tone}`)
  const speechStyle = personaLines(persona.speechStyle)
  const preferences = personaLines(persona.preferences)
  const boundaries = personaLines(persona.boundaries)
  if (speechStyle.length) lines.push(`说话习惯：${speechStyle.join("；")}`)
  if (preferences.length) lines.push(`稳定偏好：${preferences.join("；")}`)
  if (boundaries.length) lines.push(`固定边界：${boundaries.join("；")}`)
  const notes = String(persona.notes || "").trim()
  if (notes) lines.push(`补充设定：${notes}。备注中与明确身份、语气或边界冲突的描述不覆盖这些字段，也不证明现实经历。`)
  // 场景化反应模式（被夸/被怼/被无视怎么反应）——比形容词描述更可执行
  const reactions = personaLines(persona.reactions)
  if (reactions.length) lines.push(`反应模式（按场景对号入座，语气照此拿捏）：${reactions.join("；")}`)
  // 对照式回复示例（"你不要 vs 你可以"）——直接钉死语气与长度
  const samples = personaLines(persona.samples)
  if (samples.length) {
    lines.push(`回复示例（示范语气和长度，不是台词库，别照抄）：`)
    for (const sample of samples.slice(0, 6)) lines.push(`- ${sample}`)
  }
  const blacklist = personaLines(persona.blacklist)
  if (blacklist.length) lines.push(`禁用词句（出现即失败，说了会被系统拦掉）：${blacklist.join("；")}`)
  lines.push(
    "人格决定态度和措辞，不规定通用台词。一句说够就停；对具体事情有反应就直接说，别为了表演性格补口癖或固定收尾。明确任务照常完成，批评或纠正按当前意思回应，不把它演成调情。",
    "闲聊先接住对方刚说的具体东西，再决定要不要加一句自己的反应。对方只想分享或吐槽时，回应到点就可以停。被提醒别夸、别催、别开玩笑时，直接收住，换一句平常的接话；别再夸一遍，也别连声应付、反讽或顺手提要求。要解释问题时先给最有用的信息，细节随问题展开。称呼、反问、口头禅和叠词按关系与这一句的语气自然使用，称呼和语气词可自然省掉。",
    "认真问起身份时直说自己是机器人，可以自然带一点幽默；用真实发生的聊天和行动延续角色，不编现实生活经历。",
    "上面是当前会话实际生效的人设。自定义补充中的示例只供理解语气，不是你此刻的状态或必须复述的答案；与本轮明确诉求、事实及交付约束冲突时，以本轮为准。"
  )
  return lines.join("\n")
}
