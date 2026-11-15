import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { studioDefinitions } from '../src/palettes.js';
import { studioIcons } from '../src/icons.js';
import { dictionaries } from '../src/copy.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const text = (file) => readFileSync(resolve(root, file), 'utf8');

test('the bundle is enabled independently of its default-off presentation preference', () => {
  const manifest = JSON.parse(text('package.json'));
  assert.equal(manifest.name, '@local/studio-theme');
  assert.equal(manifest.dsh.client.platform, 'web');
  assert.match(text('cordis.patch.yml'), /design: default/);
  assert.doesNotMatch(text('cordis.patch.yml'), /disabled: true|preference: studio/);
  assert.doesNotMatch(text('index.js'), /setTheme|writeFile|cordis\.patch/);
  for (const path of Object.values(manifest.exports)) {
    if (path.includes('*')) continue;
    assert.ok(existsSync(resolve(root, path)), `missing export ${path}`);
  }
  assert.equal(manifest.scripts?.postinstall, undefined);
});

test('locale keys are balanced and plugin metadata does not fall back to generic copy', () => {
  const keys = Object.keys(dictionaries.en).sort();
  for (const dict of Object.values(dictionaries)) assert.deepEqual(Object.keys(dict).sort(), keys);
  for (const language of ['en', 'ru']) {
    const { meta } = JSON.parse(text(`locale/${language}.json`));
    assert.ok(meta.title.includes('Studio'));
    assert.ok(meta.description.length > 30);
  }
});

test('palettes and icons are complete pairs without scripts or document-wide styling', () => {
  const icons = studioIcons();
  assert.equal(Object.keys(icons).length, 80);
  const [light, dark] = studioDefinitions(icons);
  assert.deepEqual(Object.keys(light.tokens).sort(), Object.keys(dark.tokens).sort());
  assert.equal(light.id, 'studio-light'); assert.equal(dark.id, 'studio-dark');
  assert.ok(Object.keys(light.tokens).length > 70);
  for (const [id, svg] of Object.entries(icons)) {
    assert.match(id, /^dsw-icon-[a-z-]+-(regular|medium)$/);
    assert.match(svg, /viewBox="0 0 24 24"/);
    assert.doesNotMatch(svg, /<script|<style|\son\w+=|href=/i);
  }
  mkdirSync(resolve(root, 'verification'), { recursive: true });
  writeFileSync(resolve(root, 'verification/icon-documents.json'), JSON.stringify(icons));
});

test('replacement slots outrank native entries using the lowest shadowing rank', () => {
  const priorities = [...text('src/client.js').matchAll(/priority:\s*(-?\d+)/g)].map((match) => Number(match[1]));
  assert.equal(priorities.length, 4);
  assert.ok(priorities.every((priority) => priority < 0));
});

test('activation uses the existing leading seat and never redeclares native header children', () => {
  const source = text('src/client.js');
  assert.match(source, /name: 'conversation\.header\.leading'/);
  assert.doesNotMatch(source, /name: 'conversation\.header'/);
  assert.doesNotMatch(source, /children:\s*header\.children/);
  assert.doesNotMatch(text('src/header.js'), /renderSlot|conversation\.session\.header|children:/);
});

test('the browser code does not import private UI packages or mutate another plugin DOM', () => {
  const source = text('src/client.js');
  assert.doesNotMatch(source, /require\(['"]@deepseek|document\.body|appendChild|innerHTML|querySelector/);
  assert.match(source, /readDesign: \(\) => own\.getSnapshot\(\)\.value\?\.design/);
  assert.match(source, /id: 'appearance'/);
});
