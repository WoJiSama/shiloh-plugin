import test from 'node:test'
import assert from 'node:assert/strict'
import { isSilentDeclaration } from '../dist/backend/modules/simulation/domain/silentDeclaration.js'

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
  ]) {
    assert.equal(isSilentDeclaration(text), true, text)
  }
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
  ]) {
    assert.equal(isSilentDeclaration(text), false, text)
  }
})
