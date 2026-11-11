import assert from 'node:assert/strict'
import fs from 'node:fs'
import ts from 'typescript'

/** Execute the actual host assembly's sender without importing unrelated singleton services. */
export function hostSimulationSender({ settings = () => ({}), bot }) {
  const file = new URL('../../utils/simulationRuntime.js', import.meta.url)
  const source = ts.createSourceFile(file.pathname, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  let initializer
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'simulationRuntime' && node.initializer && ts.isCallExpression(node.initializer)) {
      const object = node.initializer.arguments[0]
      assert.ok(object && ts.isObjectLiteralExpression(object))
      initializer = object.properties.find(property => ts.isPropertyAssignment(property) && property.name.getText(source) === 'sendGroupMessage')?.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert.ok(initializer, 'production runtime assembly must expose its real sendGroupMessage adapter')
  return new Function('readPluginSettings', 'scopedBot', `return (${initializer.getText(source)})`)(settings, bot)
}
