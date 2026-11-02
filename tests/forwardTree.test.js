import test from 'node:test'
import assert from 'node:assert/strict'
import { renderForwardTree } from '../dist/backend/modules/simulation/domain/forwardView.js'

const node = (name, message) => ({ sender: { nickname: name }, message })

test('递归展开多层内嵌转发，拉不到的层明确标注', async () => {
  const layers = {
    root: [node('甲', [{ type: 'text', data: { text: '第一层开头' } }]), node('乙', [{ type: 'forward', data: { id: 'mid' } }, { type: 'text', data: { text: '后面还有字' } }])],
    mid: [node('丙', [{ type: 'text', data: { text: '第二层内容' } }]), node('丁', [{ type: 'forward', data: { id: 'deep' } }])],
    deep: [node('戊', [{ type: 'text', data: { text: '第三层内容' } }])],
  }
  const result = await renderForwardTree(async id => {
    if (id === 'bad') throw new Error('fetch failed')
    if (!layers[id]) throw new Error('unknown')
    return layers[id]
  }, 'root')
  const text = result.lines.join('\n')
  assert.ok(text.includes('第一层开头'), '顶层内容')
  assert.ok(text.includes('内嵌转发'), '内嵌标记')
  assert.ok(text.includes('第二层内容'), '自动展开到第二层')
  assert.ok(text.includes('第三层内容'), '自动展开到第三层')
  assert.equal(result.total, 5)
  // 拉不到的层有标注
  const failed = await renderForwardTree(async id => (id === 'root' ? layers.root : Promise.reject(new Error('no'))), 'root')
  assert.ok(failed.lines.some(line => line.includes('内嵌转发展开失败')), failed.lines.join('|'))
  assert.equal(failed.failedNested, 1)
})

test('防环与深度护栏', async () => {
  // 自引用环
  const cyclic = await renderForwardTree(async () => [node('甲', [{ type: 'forward', data: { id: 'root' } }])], 'root')
  assert.ok(cyclic.lines.some(line => line.includes('嵌套转发重复')), cyclic.lines.join('|'))
  // 深度上限：1 层就停，未展开的 id 供手动兜底
  const shallow = await renderForwardTree(async id => (id === 'root' ? [node('甲', [{ type: 'forward', data: { id: 'mid' } }])] : [node('乙', [{ type: 'text', data: { text: '不该出现' } }])]), 'root', { maxDepth: 1 })
  assert.ok(shallow.lines.some(line => line.includes('更深一层未自动展开')), shallow.lines.join('|'))
  assert.deepEqual(shallow.nestedForwardIds, ['mid'])
  assert.ok(!shallow.lines.join('\n').includes('不该出现'))
})

test('顶层拉取失败沿用 error 语义', async () => {
  await assert.rejects(
    renderForwardTree(async () => { throw new Error('top failed') }, 'root'),
    /top failed/,
  )
})
