import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Invoke the native CLI with inherited stdio; no esbuild service/pipe IPC or install scripts.
const require = createRequire(import.meta.url);
function installedExecutable() {
  const fromEsbuild = createRequire(require.resolve('esbuild/package.json'));
  const binary = process.platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
  return fromEsbuild.resolve(`@esbuild/${process.platform}-${process.arch}/${binary}`);
}
const executable = process.argv[2] ?? installedExecutable();
const cwd = fileURLToPath(new URL('.', import.meta.url));
const result = spawnSync(executable, ['src/client.js', '--bundle', '--format=iife', '--target=es2022', '--outfile=client.js', '--legal-comments=inline', '--charset=utf8'], { cwd, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
