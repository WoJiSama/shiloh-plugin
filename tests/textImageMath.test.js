import { test } from 'node:test'
import assert from 'node:assert/strict'

async function loadTextImageModule() {
  try {
    return await import('../functions/functions_tools/TextImageTool.js')
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') return null
    throw error
  }
}

const DERIVATION_TEXT = [
  '设介质折射率为 \\(n(\\mathbf r)\\)，光线轨迹写成 \\[\\mathbf r=\\mathbf r(\\lambda)\\]',
  '',
  '\\[ S[\\mathbf r]=\\int n(\\mathbf r)\\,ds \\]',
  '',
  '取拉格朗日量 \\(L=n\\sqrt{\\dot{\\mathbf r}^{2}}\\)，代入欧拉-拉格朗日方程 \\(\\frac{d}{ds}\\frac{\\partial L}{\\partial \\dot{\\mathbf r}}=\\frac{\\partial L}{\\partial \\mathbf r}\\) 得到',
  '',
  '\\[ \\frac{d}{ds}\\left(n\\frac{d\\mathbf r}{ds}\\right)=\\nabla n \\]',
  '',
  '其中 $$\\nabla n$$ 是折射率梯度，$E=mc^2$ 也能识别。'
].join('\n')

test('latex math detection covers explicit delimiters and rejects currency', async (t) => {
  const mod = await loadTextImageModule()
  if (!mod) return t.skip('render dependencies are not installed in this checkout')

  assert.equal(mod.hasLatexMath(DERIVATION_TEXT), true)
  assert.equal(mod.hasLatexMath('动能公式是 \\(E_k=\\frac{1}{2}mv^2\\)'), true)
  assert.equal(mod.hasLatexMath('答案 $$x^2+1$$'), true)
  assert.equal(mod.hasLatexMath('质量 $m$ 满足 $F=ma$'), true)
  assert.equal(mod.hasLatexMath('今天花了 $5 和 $6'), false)
  assert.equal(mod.hasLatexMath('普通聊天,没有公式'), false)
  assert.equal(mod.hasLatexMath(''), false)
})

test('math-bearing content is upgraded to a document-family template', async (t) => {
  const mod = await loadTextImageModule()
  if (!mod) return t.skip('render dependencies are not installed in this checkout')

  assert.equal(mod.shouldUseDocumentTemplateForTextImage(DERIVATION_TEXT), true)
  assert.equal(mod.shouldUseDocumentTemplateForTextImage('好呀，我在。'), false)
})

test('knowledge and document cards render katex markup instead of raw latex source', async (t) => {
  const mod = await loadTextImageModule()
  if (!mod) return t.skip('render dependencies are not installed in this checkout')

  for (const build of [mod.markdownToKnowledgeHtml, mod.markdownToDocumentHtml]) {
    const html = build(DERIVATION_TEXT)
    const katexCount = (html.match(/class="katex"/g) || []).length
    assert.ok(katexCount >= 8, `公式应渲染成 katex 标记,实际 ${katexCount} 处`)
    assert.doesNotMatch(html, /\\\(/, '行内定界符不应残留在卡面')
    assert.doesNotMatch(html, /\\\[/, '独立行定界符不应残留在卡面')
    assert.doesNotMatch(html, /\\frac\{/, 'LaTeX 源码命令不应残留在卡面')
    assert.ok(html.includes('math-display'), '独立行公式应有 display 块')
  }
})

test('display math on its own line becomes a centered block', async (t) => {
  const mod = await loadTextImageModule()
  if (!mod) return t.skip('render dependencies are not installed in this checkout')

  const html = mod.markdownToKnowledgeHtml('结论是\n\n\\[ \\frac{d}{ds}\\left(n\\frac{d\\mathbf r}{ds}\\right)=\\nabla n \\]\n\n证毕')
  const blocks = html.match(/<div class="math-display">[\s\S]*?<\/div>/g) || []
  assert.equal(blocks.length, 1)
  assert.match(blocks[0], /katex-display/)
})

test('unrenderable math falls back to escaped source instead of vanishing', async (t) => {
  const mod = await loadTextImageModule()
  if (!mod) return t.skip('render dependencies are not installed in this checkout')

  const html = mod.markdownToKnowledgeHtml('\\( \\unknowncmd{x} \\)')
  assert.ok((html.match(/class="katex"/g) || []).length >= 1, 'throwOnError:false 仍应产出 katex 容器')
})
