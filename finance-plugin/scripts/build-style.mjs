import { readFile, writeFile } from 'node:fs/promises';

// Embed local theme-token CSS into the existing Client artifact; no server or preview.
const clientUrl = new URL('../client.js', import.meta.url);
const css = await readFile(new URL('../ui.css', import.meta.url), 'utf8');
const source = await readFile(clientUrl, 'utf8');
const marker = /    const CSS = `[\s\S]*?`;/g;
if ([...source.matchAll(marker)].length !== 1) throw new Error('Expected exactly one Finance CSS declaration.');
const escaped = css.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
const next = source.replace(marker, () => `    const CSS = \`\n${escaped}\`;`);
if (process.argv.includes('--check')) {
  if (source !== next) throw new Error('Embedded Finance styles differ from ui.css. Run node scripts/build-style.mjs.');
  console.log('Embedded Finance styles match ui.css.');
} else if (source !== next) {
  await writeFile(clientUrl, next, 'utf8'); console.log('Updated embedded Finance styles.');
}
