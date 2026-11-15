// Wrap Vue's self-contained ESM browser build without leaking a global Vue.
// Unlike the global build, its compiler passes runtimeDom into generated code.
export function wrapVueESM(source) {
  if (/^import\s/m.test(source)) throw new Error('Vue browser bundle must be self-contained');
  const match = /export\s*\{([^}]+)\};?\s*$/.exec(source);
  if (!match) throw new Error('Expected a single terminal Vue ESM export list');
  const properties = match[1].split(',').map(item => {
    const names = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item);
    if (!names) throw new Error('Unexpected Vue export: ' + item);
    return JSON.stringify(names[2] ?? names[1]) + ':' + names[1];
  });
  return 'const Vue = (() => {\n' + source.slice(0, match.index) + '\nreturn {' + properties.join(',') + '};\n})();';
}
