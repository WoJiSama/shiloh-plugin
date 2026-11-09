import test from 'node:test'
import assert from 'node:assert/strict'
import { isSilentDeclaration, isWrappedAnnotation, mentionsSilenceVocabulary } from '../dist/backend/modules/simulation/domain/silentDeclaration.js'

test('识别实测出现过的沉默声明形态', () => {
  for (const text of [
    '无需发送，结束回合。',
    '旁听，结束回合。',
    '（回合结束，不再发言）',
    '(旁听结束，本轮不发言)',
    '[SILENT]',
    '[不发了]',
    '已读，沉默。',
    '保持沉默，本回合结束。',
    '【无需发送】',
    // 295708427 群实拍的自创变体
    '（已静默结束。）',
    '（旁听，结束。）',
    '（不是对我说的，结束。）',
    // 953676639 群实拍（2026-11-09 漏进群后补词）：纯元词句整句可拼出
    '（不说话，停。）',
    '（不说了，直接停。）',
  ]) {
    assert.equal(isSilentDeclaration(text), true, text)
  }
})

test('实拍事故样本的三道防线回归：词表拼不全也绝不允许兜底直发', () => {
  const incident = '(已经决定不说话，直接停。)'
  // 第一道（拼词表）拦不住——"已经/决定/直接"不是元词，这正是当时漏网的原因；
  // 但第二道（子串元词）与第三道（括号形状）必须拦住，兜底直发被双保险否决。
  assert.equal(isSilentDeclaration(incident), false, '拼词表对本句本来就不该命中')
  assert.equal(mentionsSilenceVocabulary(incident), true, '含"不说话/直接停"元词')
  assert.equal(isWrappedAnnotation(incident), true, '整条括号包裹')
})

test('含同词的真聊天不会被误判为沉默声明', () => {
  for (const text of [
    '这游戏什么时候结束回合啊',
    '我结束回合了，该你了',
    '他说无需发送我就没发，笑死',
    '今天也要加油鸭！',
    '旁听了一上午的课，困死',
    '（安静，睡。）',
    '已读不回的人最讨厌了',
    '他一向静默寡言，今天终于说话了',
    '这局游戏结束得真快',
  ]) {
    assert.equal(isSilentDeclaration(text), false, text)
  }
})

test('直发前最后防线：沾到元词即按沉默处理（子串级，宁漏发不误发）', () => {
  for (const text of ['（已静默结束。）', '不是对我说的', '这轮先旁听一下', 'markRead 后静默', '(已经决定不说话，直接停。)', '我决定不说话了']) {
    assert.equal(mentionsSilenceVocabulary(text), true, text)
  }
  for (const text of ['今天也要加油鸭！', '火车进站了，我们下车吧', '这个梗太好笑了']) {
    assert.equal(mentionsSilenceVocabulary(text), false, text)
  }
})

test('形状防线：整条括号/引号包裹的状态标注一律不兜底直发（2026-11-09 实拍事故后新增）', () => {
  for (const text of [
    '(已经决定不说话，直接停。)',
    '（已静默结束。）',
    '（安静潜水）',
    '(默默退出对话)',
    '「本轮不参与」',
    '【保持观望】',
  ]) {
    assert.equal(isWrappedAnnotation(text), true, text)
  }
  // 裸文本（真想说的话）不受形状防线影响，仍走兜底直发
  for (const text of [
    '这游戏什么时候结束回合啊',
    '已经在路上了，等我五分钟',
    '哈哈这个梗我能笑一年',
    '（）', // 空壳不算（<3字）
  ]) {
    assert.equal(isWrappedAnnotation(text), false, text)
  }
})
