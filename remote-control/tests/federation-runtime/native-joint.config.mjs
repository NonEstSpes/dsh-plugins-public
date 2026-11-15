// Focused source-plane plugin/native acceptance, never the broad repository suites.
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { standardDecoratorPlugin, vitestExecArgv } from '../../../dsh-remote-core/vitest.shared.ts'
const root = fileURLToPath(new URL('../../../dsh-remote-core/', import.meta.url))
const require = createRequire(new URL('../../../dsh-remote-core/package.json', import.meta.url))
const { default: tsconfigPaths } = await import(pathToFileURL(require.resolve('vite-tsconfig-paths')).href)
export default {
  root,
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../../../dsh-remote-core/tsconfig.base.json', import.meta.url)), fileURLToPath(new URL('./native-joint.tsconfig.json', import.meta.url)), fileURLToPath(new URL('./native-acceptance.client.tsconfig.json', import.meta.url))] }), standardDecoratorPlugin()],
  server: { fs: { allow: [root, fileURLToPath(new URL('../../', import.meta.url))] } },
  test: { include: ['native-joint.host.spec.ts', 'native-worker-owner.host.spec.ts', 'native-catalog-composition.host.spec.ts', 'live-history.native.host.spec.ts', 'native-live-owner.host.spec.ts', 'native-follow-history.host.spec.ts', 'native-live-composition.host.spec.ts', 'native-project-owner.host.spec.ts', 'native-file-transfer.host.spec.ts', 'native-image-transfer.host.spec.ts'].map(file => fileURLToPath(new URL(file, import.meta.url)).replaceAll('\\', '/')), pool: 'forks', maxWorkers: 1, fileParallelism: false, execArgv: vitestExecArgv, testTimeout: 15000 },
}
