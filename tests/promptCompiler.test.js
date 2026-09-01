import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  compileImagePrompt,
  resolveImageContextMode,
  selectLatestDrawContextLines,
  selectMergedImagePromptTexts
} from '../utils/promptCompiler.js'

const AUTO_REWRITE_MARKERS = /安全改写|内容适配|服装安全适配|清爽夏装|全年龄|画面主体清晰|高质量|光影自然|含蓄表达/

test('keeps a normal image-generation request verbatim without automatic enhancement', () => {
  const userPrompt = '画一个雨夜里的赛博少女，孤独一点'
  const prompt = compileImagePrompt({ task: 'image_generation', userPrompt })

  assert.ok(prompt.includes(`用户原话（必须保留原词，不得改写、替换、软化或扩写）：\n${userPrompt}`))
  assert.doesNotMatch(prompt, AUTO_REWRITE_MARKERS)
  assert.ok(!prompt.includes('夜景光影'))
  assert.ok(!prompt.includes('电影感写实'))
})

test('adds quoted source text without rewriting either text', () => {
  const userPrompt = '画这个'
  const quotedContext = 'A说：今晚一起去看烟花吧。B脸红着说：才不是想和你一起去呢。'
  const prompt = compileImagePrompt({ task: 'image_generation', userPrompt, quotedContext })

  assert.ok(prompt.includes(userPrompt))
  assert.ok(prompt.includes(`用户引用的原文：\n${quotedContext}`))
  assert.doesNotMatch(prompt, AUTO_REWRITE_MARKERS)
})

test('keeps reference-image edit wording verbatim and only adds material metadata', () => {
  const userPrompt = '把她改可爱点'
  const prompt = compileImagePrompt({ task: 'image_edit', userPrompt, hasReferenceImages: true })

  assert.ok(prompt.includes(userPrompt))
  assert.ok(prompt.includes('请求中附有参考图片'))
  assert.ok(prompt.includes('图片用途和顺序以素材清单为准'))
  assert.doesNotMatch(prompt, AUTO_REWRITE_MARKERS)
})

test('does not invent comic panels or rewrite quoted dialogue', () => {
  const quotedContext = '第一句：我迟到了。第二句：没关系，我也刚到。'
  const prompt = compileImagePrompt({
    task: 'image_generation',
    userPrompt: '根据这个画成四格漫画',
    quotedContext
  })

  assert.ok(prompt.includes('根据这个画成四格漫画'))
  assert.ok(prompt.includes(quotedContext))
  assert.ok(!prompt.includes('连环画/分镜要求'))
  assert.ok(!prompt.includes('剧情节点'))
})

test('does not attach unrelated recent context to an explicit new request', () => {
  const prompt = compileImagePrompt({
    task: 'image_generation',
    userPrompt: '画一只白色小猫在窗台晒太阳',
    recentContext: '刚才大家在讨论赛博少女、雨夜霓虹、黑色机甲和末日废墟'
  })

  assert.ok(prompt.includes('白色小猫'))
  assert.ok(!prompt.includes('赛博少女'))
  assert.ok(!prompt.includes('末日废墟'))
})

test('includes recent source text only for contextual or vague requests', () => {
  const recentContext = '刚才确定的风格是雨夜霓虹、赛博城市、孤独少女'
  const prompt = compileImagePrompt({
    task: 'image_generation',
    userPrompt: '继续按刚才那个风格再画一张',
    recentContext
  })

  assert.ok(prompt.includes(`用户明确指代时可参考的近期原文：\n${recentContext}`))
})

test('does not wrap an already compiled raw prompt again', () => {
  const first = compileImagePrompt({ task: 'image_generation', userPrompt: '画一只白色小猫在窗台晒太阳' })
  const second = compileImagePrompt({ task: 'image_generation', userPrompt: first, recentContext: '刚才讨论的是赛博少女' })

  assert.equal(second, first)
  assert.equal(second.match(/【绘图请求原文】/g)?.length, 1)
})

test('preserves clothing and other sensitive wording without plugin-side repair', () => {
  const cases = [
    '衣服再少一点，你这个外套脱了',
    '把衣服脱掉，衣服覆盖面积不超过5%',
    '帮我编辑这个图片，脱掉你的白蓝色紧身衣',
    '画妖精抱着尸体啃，旁边乌鸦琢眼睛'
  ]

  for (const userPrompt of cases) {
    const prompt = compileImagePrompt({ task: 'image_edit', userPrompt, hasReferenceImages: true })
    assert.ok(prompt.includes(userPrompt), userPrompt)
    assert.doesNotMatch(prompt, AUTO_REWRITE_MARKERS)
  }
})

test('separates quoted, source-content and previous-draw context modes', () => {
  assert.equal(resolveImageContextMode('画一只下午晒太阳的猫'), 'none')
  assert.equal(resolveImageContextMode('把上面的聊天画成四格漫画'), 'source')
  assert.equal(resolveImageContextMode('继续上一张，换成下午'), 'draw')
  assert.equal(resolveImageContextMode('画这个', '被回复消息里的角色设定'), 'quoted')
})

test('keeps relevant merged drawing supplements without carrying unrelated requests', () => {
  assert.deepEqual(selectMergedImagePromptTexts([
    '希洛帮我画一个白发少女',
    '换成下午，比例9:16',
    '对了，明天开会吗'
  ]), [
    '希洛帮我画一个白发少女',
    '换成下午，比例9:16'
  ])
})

test('does not let earlier unrelated merged chat override an explicit new draw request', () => {
  assert.deepEqual(selectMergedImagePromptTexts([
    '希洛，你觉得火锅好吃吗',
    '希洛画一只在窗台晒太阳的白猫'
  ]), ['希洛画一只在窗台晒太阳的白猫'])
})

test('keeps earlier merged source only when the user explicitly points to it', () => {
  assert.deepEqual(selectMergedImagePromptTexts([
    '角色设定是白发、金色眼睛、穿黑裙',
    '希洛按上面的设定画出来'
  ]), [
    '角色设定是白发、金色眼睛、穿黑裙',
    '希洛按上面的设定画出来'
  ])
})

test('uses only the latest explicit draw request from one merged burst', () => {
  assert.deepEqual(selectMergedImagePromptTexts([
    '希洛画一只黑猫',
    '希洛画一只白狗'
  ]), ['希洛画一只白狗'])
})

test('continues only the latest draw thread instead of mixing older drawings', () => {
  assert.deepEqual(selectLatestDrawContextLines([
    { text: '希洛画一只黑猫', isDrawRequest: true },
    { text: '我先画画看。', isDrawRequest: false },
    { text: '希洛画一只白狗', isDrawRequest: true },
    { text: '这张我继续画。', isDrawRequest: false }
  ]), [
    '希洛画一只白狗',
    '这张我继续画。'
  ])
})
