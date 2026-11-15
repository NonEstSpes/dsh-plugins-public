import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const electron = process.env.DSH_TEAM_TEST_ELECTRON ?? path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe');
const runtime = process.env.DSH_TEAM_TEST_RUNTIME ?? path.join(path.dirname(electron), 'resources', 'app.asar', 'dsh');
const child = spawnSync(electron, ['--import', './scripts/runtime-loader.mjs', '--test', 'tests/selection.test.mjs'], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_TEAM_TEST_RUNTIME: runtime },
  stdio: 'inherit',
});
if (child.error) throw child.error;
process.exitCode = child.status ?? 1;
