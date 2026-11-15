import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStudioController, resolveStudio } from '../src/controller.js';

function fixture(preference = 'dark') {
  const state = { preference, design: 'default', base: preference, dark: true, mounts: 0, releases: 0, writes: [], reports: [], fail: false };
  const theme = {
    getTheme: () => ({ preference: state.preference }),
    setTheme(id) { state.writes.push(id); state.preference = id; },
  };
  const controller = createStudioController({ theme,
    readDesign: () => state.design, readPreference: () => state.base, systemDark: () => state.dark,
    mount() { if (state.fail) throw new Error('registration refused'); state.mounts++; return () => { state.releases++; }; },
    report: (error) => state.reports.push(error),
  });
  return { state, theme, controller };
}

test('installation and enablement do not select a theme or mount replacement UI', () => {
  for (const preference of ['light', 'dark', 'system', 'another-theme']) {
    const { state, controller } = fixture(preference);
    controller.sync(); controller.sync(); controller.dispose();
    assert.equal(state.preference, preference);
    assert.deepEqual(state.writes, []);
    assert.equal(state.mounts, 0);
  }
});

test('missing accepted settings fail closed without changing the current appearance', () => {
  const { state, controller } = fixture();
  state.design = undefined; state.base = undefined;
  controller.sync();
  assert.equal(state.preference, 'dark');
  assert.deepEqual(state.writes, []);
});

test('explicit selection uses the saved built-in scheme and mounts layout once', () => {
  const { state, controller } = fixture();
  state.design = 'studio';
  controller.sync(); controller.sync();
  assert.equal(state.preference, 'studio-dark');
  assert.deepEqual(state.writes, ['studio-dark']);
  assert.equal(state.base, 'dark');
  assert.equal(state.mounts, 1);
  assert.deepEqual(controller.getSnapshot(), { active: true, error: false });
});

test('switching color scheme retains the mounted layout and respects system changes', () => {
  const { state, controller } = fixture('light');
  state.design = 'studio'; controller.sync();
  state.base = 'dark'; controller.sync();
  assert.equal(state.preference, 'studio-dark');
  state.base = 'system'; state.dark = false; controller.sync();
  assert.equal(state.preference, 'studio-light');
  state.dark = true; controller.sync();
  assert.equal(state.preference, 'studio-dark');
  assert.equal(state.mounts, 1);
  assert.equal(state.releases, 0);
});

test('returning to Standard restores the saved built-in preference and removes UI', () => {
  const { state, controller } = fixture('system');
  state.design = 'studio'; controller.sync();
  state.design = 'default'; controller.sync();
  assert.equal(state.preference, 'system');
  assert.equal(state.releases, 1);
  assert.deepEqual(controller.getSnapshot(), { active: false, error: false });
});

test('unload is idempotent and restores the previous preference only when Studio is active', () => {
  const { state, controller } = fixture('light');
  state.design = 'studio'; controller.sync();
  controller.dispose(); controller.dispose(); controller.sync();
  assert.equal(state.preference, 'light');
  assert.deepEqual(state.writes, ['studio-light', 'light']);
  assert.equal(state.releases, 1);
});

test('another explicitly selected third-party theme is not overwritten', () => {
  const { state, controller } = fixture();
  state.design = 'studio'; controller.sync();
  state.preference = 'another-theme'; controller.sync();
  assert.equal(state.preference, 'another-theme');
  assert.equal(state.releases, 1);
  controller.dispose();
  assert.equal(state.preference, 'another-theme');
});

test('an explicit Studio click can replace another theme without background synchronization fighting it', () => {
  const { state, controller } = fixture('another-theme');
  state.base = 'light'; state.design = 'studio';
  controller.sync();
  assert.deepEqual(state.writes, []);
  controller.requestActivation();
  assert.equal(state.preference, 'studio-light');
  assert.equal(state.mounts, 1);
  state.preference = 'another-theme'; controller.sync();
  assert.equal(state.preference, 'another-theme');
});

test('a failed UI registration restores original presentation and reports failure without retry loops', () => {
  const { state, controller } = fixture();
  state.design = 'studio'; state.fail = true; controller.sync(); controller.sync();
  assert.equal(state.preference, 'dark');
  assert.deepEqual(state.writes, ['studio-dark', 'dark']);
  assert.equal(state.reports.length, 1);
  assert.deepEqual(controller.getSnapshot(), { active: false, error: true, details: 'registration refused' });
  state.design = 'default'; controller.sync();
  state.fail = false; state.design = 'studio'; controller.sync();
  assert.equal(state.preference, 'studio-dark');
  assert.equal(state.mounts, 1);
});

test('theme events cannot re-enter a selection transaction', () => {
  const { state, theme, controller } = fixture();
  theme.setTheme = (id) => { state.writes.push(id); state.preference = id; controller.sync(); };
  state.design = 'studio'; controller.sync();
  assert.deepEqual(state.writes, ['studio-dark']);
  assert.equal(state.mounts, 1);
});

test('Studio resolution covers all three built-in preferences', () => {
  assert.equal(resolveStudio('default', 'dark', true), null);
  assert.equal(resolveStudio('studio', 'dark', false), 'studio-dark');
  assert.equal(resolveStudio('studio', 'light', true), 'studio-light');
  assert.equal(resolveStudio('studio', 'system', true), 'studio-dark');
  assert.equal(resolveStudio('studio', 'system', false), 'studio-light');
});
