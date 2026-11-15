import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { wrapVueESM } from './build-vue.mjs';
const root = new URL('./', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
const output = new URL(`dist/${manifest.version}/`, root);
await mkdir(output, { recursive: true });
const vue = wrapVueESM(await readFile(new URL('node_modules/vue/dist/vue.esm-browser.prod.js', root), 'utf8'));
const modules = { 'validation.js': 'Validation', 'submission.js': 'Submission', 'drafts.js': 'Drafts', 'components.js': 'Components', 'runtime.js': 'Runtime' };
function wrapModule(source, namespace) {
  const names = [...source.matchAll(/^export (?:async )?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]);
  const body = source.replace(/^import\s+\{([^}]+)\}\s+from\s+['"]\.\/([^'"]+)['"];?\s*$/gm, (_, names, file) => {
    if (!modules[file]) throw new Error(`Unsupported local Client dependency ${file}`);
    return `const {${names}} = ${modules[file]};`;
  }).replace(/^export /gm, '');
  if (/^\s*(import|export)\s/m.test(body)) throw new Error(`Unsupported module syntax in ${namespace}`);
  return `const ${namespace} = (() => {\n${body}\nreturn {${names.join(',')}};\n})();\n`;
}
const bodies = [];
for (const [file, namespace] of Object.entries(modules)) bodies.push(wrapModule(await readFile(new URL(file, root), 'utf8'), namespace));
const core = await readFile(new URL('client-core.js', root), 'utf8');
const dictionaries = Object.fromEntries(await Promise.all(['en', 'ru'].map(async locale => [locale, JSON.parse(await readFile(new URL(`locale/${locale}.json`, root), 'utf8'))])));
const bundle = `// Interactive Replies ${manifest.version}; Vue 3.5.22 (MIT), locally bundled; trusted JavaScript, not sandboxed.\nwindow.__ModuleLoader__.load({\n  id: '@local/interactive-replies',\n  factory(require) {\n    const React = require('react');\n    const PLUGIN_VERSION = ${JSON.stringify(manifest.version)};\n    const dictionaries = ${JSON.stringify(dictionaries)};\n${vue}\n${bodies.join('\n')}\n${core}\n  }\n});\n`;
await writeFile(new URL('client.js', output), bundle);
// ClientModules may retain the pilot's legacy export path until Host restart.
// Both entry paths must always serve the same current runtime, never stale code.
await writeFile(new URL('client.js', root), bundle);
for (const file of ['index.js', 'state.js', 'validation.js', 'catalog-info.js', 'admission.js']) await writeFile(new URL(file === 'index.js' ? 'host.js' : file, output), await readFile(new URL(file, root), 'utf8'));
const license = await readFile(new URL('node_modules/vue/LICENSE', root), 'utf8');
await writeFile(new URL('THIRD_PARTY_NOTICES.md', root), `# Third-party notices\n\nThis plugin bundles Vue 3.5.22. No Projector source code is copied.\n\n${license}`);
console.log(`Built ${manifest.version} versioned Host/Client artifacts, local Vue compiler/catalog and third-party notice.`);
