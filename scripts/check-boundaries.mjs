import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function checkSource(path, text, root = process.cwd()) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const errors = [];
  const pure = /(?:^|\/)src\/(?:contracts\/|modules\/[^/]+\/(?:domain|application)\/)/.test(path.replaceAll('\\', '/'));
  const add = (node, message) => errors.push(`${path}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}: ${message}`);
  const checkImport = (node, specifier) => {
    if (specifier.startsWith('.') && !specifier.endsWith('.js')) add(node, 'Relative imports must use an explicit .js extension');
    if (!pure) return;
    const target = relative(resolve(root, 'src'), resolve(dirname(resolve(root, path)), specifier)).replaceAll('\\', '/');
    if (!specifier.startsWith('.') || target.startsWith('../') || /(?:^|\/)(adapters|bootstrap|infrastructure)(?:\/|$)/.test(target)) {
      add(node, 'Domain/application/contracts may only import internal contracts and domain/application modules');
    }
  };
  const visit = (node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) checkImport(node, node.moduleSpecifier.text);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) checkImport(node, node.argument.literal.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      if (node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) checkImport(node, node.arguments[0].text);
      else if (pure) add(node, 'Computed dynamic imports are forbidden in domain/application/contracts');
    }
    if (pure && ts.isIdentifier(node) && ['Bot', 'redis', 'global', 'globalThis', 'process', 'pluginBridge'].includes(node.text)) {
      const parent = node.parent;
      const propertyName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || ((ts.isPropertySignature(parent) || ts.isPropertyAssignment(parent)) && parent.name === node);
      const bindingProperty = ts.isBindingElement(parent) && parent.propertyName === node;
      if (!propertyName && !bindingProperty) add(node, `Platform/global access ${node.text} is forbidden in domain/application/contracts`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return errors;
}
export function checkTree(root = process.cwd()) {
  const errors = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.ts$/.test(path)) errors.push(...checkSource(relative(root, path), readFileSync(path, 'utf8'), root));
    }
  };
  walk(resolve(root, 'src'));
  return errors;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkTree();
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
  else console.log('Backend source boundaries passed');
}
