/** Explicit measurement entry; ordinary native acceptance never starts the benchmark. */
import { fileURLToPath } from 'node:url'
import native from './native-joint.config.mjs'
export default {
  ...native,
  test: { ...native.test, include: [fileURLToPath(new URL('source-transfer-benchmark.host.spec.ts', import.meta.url)).replaceAll('\\', '/')] },
}
