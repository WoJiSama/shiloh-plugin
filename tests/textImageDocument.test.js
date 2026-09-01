import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'

test('code and markdown default to document card rendering', async (t) => {
  let shouldUseDocumentTemplateForTextImage
  try {
    shouldUseDocumentTemplateForTextImage = (await import('../functions/functions_tools/TextImageTool.js')).shouldUseDocumentTemplateForTextImage
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('render dependencies are not installed in this checkout')
      return
    }
    throw error
  }

  assert.equal(shouldUseDocumentTemplateForTextImage('```js\nconst a = 1\nconsole.log(a)\n```'), true)
  assert.equal(shouldUseDocumentTemplateForTextImage('## 标题\n\n- 第一项\n- 第二项\n- 第三项'), true)
  assert.equal(shouldUseDocumentTemplateForTextImage('好呀，我在。'), false)
})

test('an unfenced Java section in mixed prose renders as a code block', async (t) => {
  let shouldUseDocumentTemplateForTextImage
  let markdownToDocumentHtml
  let markdownToKnowledgeHtml
  try {
    ({ shouldUseDocumentTemplateForTextImage, markdownToDocumentHtml, markdownToKnowledgeHtml } = await import('../functions/functions_tools/TextImageTool.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('render dependencies are not installed in this checkout')
      return
    }
    throw error
  }

  const text = [
    '一般建议：一个业务 code 对应一个稳定语义，默认对应一个固定 msg。',
    '- code：只放前端需要特殊处理的业务异常',
    '- msg：默认提示，例如“用户不存在”',
    '- 动态信息：通过参数补充，例如“订单 xxx 不存在”',
    '',
    'java',
    '@Getter',
    '@AllArgsConstructor',
    'public enum BizCode {',
    '  SUCCESS(0, "成功"),',
    '  USER_NOT_FOUND(40001, "用户不存在"),',
    '  DEFAULT_ERROR(50000, "系统异常");',
    '  private final int code;',
    '  private final String msg;',
    '}'
  ].join('\n')

  assert.equal(shouldUseDocumentTemplateForTextImage(text), true)
  for (const html of [markdownToDocumentHtml(text), markdownToKnowledgeHtml(text)]) {
    assert.match(html, /code-block/)
    assert.match(html, /code-label">java<\/div>/)
    assert.match(html, /BizCode/)
    assert.doesNotMatch(html, /<p>java<\/p>/)
    const codeBlock = html.match(/<pre class="code-block">([\s\S]*?)<\/pre>/)?.[1] || ''
    assert.match(codeBlock, /DEFAULT_ERROR/)
    assert.match(codeBlock, /private/)
  }
})

test('document markdown keeps blank lines as distinct prose paragraphs', async (t) => {
  let markdownToDocumentHtml
  try {
    ({ markdownToDocumentHtml } = await import('../functions/functions_tools/TextImageTool.js'))
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('render dependencies are not installed in this checkout')
      return
    }
    throw error
  }

  const html = markdownToDocumentHtml('第一段。\n\n第二段。\n\n第三段。')
  assert.match(html, /<p>第一段。<\/p>/)
  assert.match(html, /<p>第二段。<\/p>/)
  assert.match(html, /<p>第三段。<\/p>/)
})

test('document template renders a readable html screenshot', async (t) => {
  let sharp
  let TextImageTool
  try {
    sharp = (await import('sharp')).default
    TextImageTool = (await import('../functions/functions_tools/TextImageTool.js')).TextImageTool
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('render dependencies are not installed in this checkout')
      return
    }
    throw error
  }

  const tool = new TextImageTool()
  let imagePath
  try {
    imagePath = await tool.renderDocumentImage({
      text: [
        '# 处理建议',
        '',
        '这个报错主要是 Java 版本和 Maven 插件版本不匹配。',
        '',
        '- 先确认本机 JDK 版本',
        '- 再刷新 Maven 依赖',
        '',
        '```js',
        'const version = process.version',
        'console.log(version)',
        '```'
      ].join('\n')
    })
  } catch (error) {
    if (/Could not find Chrome|Chromium|executable/i.test(error?.message || '')) {
      t.skip('Chromium is not available in this checkout')
      return
    }
    throw error
  }

  try {
    const metadata = await sharp(imagePath).metadata()
    assert.ok(metadata.width >= 900, `document width too small: ${metadata.width}`)
    assert.ok(metadata.height >= 500, `document height too small: ${metadata.height}`)
    assert.equal(metadata.format, 'png')
  } finally {
    await fs.unlink(imagePath).catch(() => {})
  }
})

test('knowledge template turns structured markdown into distinct knowledge sections', async (t) => {
  let markdownToKnowledgeHtml
  let sharp
  let TextImageTool
  try {
    ({ markdownToKnowledgeHtml, TextImageTool } = await import('../functions/functions_tools/TextImageTool.js'))
    sharp = (await import('sharp')).default
  } catch (error) {
    if (error?.code === 'ERR_MODULE_NOT_FOUND') {
      t.skip('render dependencies are not installed in this checkout')
      return
    }
    throw error
  }

  const text = [
    '# MC 模组开发入门',
    '',
    '先定游戏版本和加载器，再建立最小可运行工程。',
    '',
    '## 必须先确定',
    'Minecraft 版本: 1.20.1',
    '加载器: Fabric',
    'JDK: 17',
    '',
    '## 最小起步路线',
    '1. 安装 JDK、IDE 和 Gradle 环境',
    '2. 从 Fabric 模板创建工程并运行客户端',
    '3. 注册一个物品和对应资源文件',
    '',
    '> 先确认开发环境能启动，再逐步增加内容。',
    '',
    '```java',
    'public static final String MOD_ID = "demo";',
    '```'
  ].join('\n')
  const html = markdownToKnowledgeHtml(text)
  assert.match(html, /knowledge-header/)
  assert.match(html, /knowledge-facts/)
  assert.match(html, /knowledge-steps/)
  assert.match(html, /knowledge-note/)
  assert.match(html, /code-block/)

  const tool = new TextImageTool()
  let imagePath
  try {
    imagePath = await tool.renderDocumentImage({ text, template: 'knowledge' })
  } catch (error) {
    if (/Could not find Chrome|Chromium|executable/i.test(error?.message || '')) {
      t.skip('Chromium is not available in this checkout')
      return
    }
    throw error
  }

  try {
    const metadata = await sharp(imagePath).metadata()
    assert.ok(metadata.width >= 900, `knowledge width too small: ${metadata.width}`)
    assert.ok(metadata.height >= 600, `knowledge height too small: ${metadata.height}`)
    assert.equal(metadata.format, 'png')
  } finally {
    await fs.unlink(imagePath).catch(() => {})
  }
})

test('knowledge is an explicit template rather than a document fallback', async () => {
  const source = await fs.readFile(new URL('../functions/functions_tools/TextImageTool.js', import.meta.url), 'utf8')
  assert.match(source, /rawTemplate === "knowledge"\s*\?\s*"knowledge"/)
  assert.match(source, /\[textImageTool\] timing template=\$\{template\} render=/)
})
