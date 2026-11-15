/** Render only the actual history-banner JSX expression for the approved presentation truth table. */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const here = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(here, '../../dsh-remote-core/packages/client/ui-workspace');
const require = createRequire(path.join(packageDir, 'package.json'));
const rootRequire = createRequire(path.resolve(here, '../../dsh-remote-core/package.json'));
const ts = rootRequire('typescript'), React = require('react');
const renderedText = element => React.Children.toArray(element.props.children).map(child => React.isValidElement(child) ? child.props.children : child).join('');
const text = await readFile(path.join(packageDir, 'src/client/rows/Rows.tsx'), 'utf8');
const ast = ts.createSourceFile('Rows.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const matches = [];
const visit = node => {
  if (ts.isJsxExpression(node) && node.expression && ts.isBinaryExpression(node.expression) && ts.isJsxElement(node.expression.right)
      && node.expression.right.openingElement.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'className'
        && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression?.getText(ast) === 'css.creationHistory')) matches.push(node);
  ts.forEachChild(node, visit);
};
visit(ast);
assert.equal(matches.length, 1);
const compiled = ts.transpileModule(`function banner(creation, css, t) { return <>${matches[0].getText(ast)}</> }`, {
  compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 }, fileName: 'banner.tsx',
}).outputText;
const banner = new Function('React', compiled + '; return banner;')(React);
const marker = { requestId: 'old-request-fixture', disposition: 'owner-abandoned' };
for (const [state, expected] of [['created', false], ['unknown', true], ['pending', true], ['idle', true]]) {
  const rendered = renderedText(banner({ state, previousUnknownCreate: marker }, { creationHistory: 'history' }, key => key));
  assert.equal(rendered.includes('source.previousUnknownCreate'), expected, state);
}
assert.equal(renderedText(banner({ state: 'unknown' }, { creationHistory: 'history' }, key => key)), '');
console.log('PASS actual banner JSX: created+history hidden; unknown/pending/idle+history retained; absent history hidden');
