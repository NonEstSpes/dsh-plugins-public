/** Build only the allowlisted host-only bridge artifact; no install, profile, private, client or runtime changes. */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
const root = fileURLToPath(new URL('../', import.meta.url))
const options = Object.fromEntries(process.argv.slice(2).map((value, index, args) => value.startsWith('--') ? [value.slice(2), args[index + 1]] : null).filter(Boolean))
if (Object.keys(options).some(key => !['out', 'version'].includes(key)) || process.argv.slice(2).length !== Object.keys(options).length * 2) throw new Error('Use paired --out and --version values only')
const target = options.out ? path.resolve(options.out) : fileURLToPath(new URL('./bundle/', import.meta.url))
const version = options.version ?? '0.1.0'
if (!/^0\.1\.\d+$/.test(version)) throw new Error('Unexpected bridge release version')
const files = ['lib/endpoint.mjs', 'lib/store.mjs', 'lib/engine.mjs', 'lib/projection.mjs', 'lib/federation/identity.mjs', 'lib/federation/peers.mjs', 'lib/federation/history.mjs', 'lib/federation/wire-codec.mjs', 'lib/federation/grants.mjs', 'lib/federation/protocol.mjs', 'lib/federation/settings.mjs', 'lib/federation/catalog.mjs', 'lib/federation/runtime.mjs', 'lib/federation/journal.mjs', 'lib/federation/host-provider.mjs', 'lib/federation/diagnostics.mjs', 'lib/federation/native-adapter.mjs', 'icon.svg', 'FEDERATION-V2.md']
const digest = value => createHash('sha256').update(value).digest('hex')
const audit = []
async function output(relative, bytes) {
  const filename = path.resolve(target, relative)
  if (!filename.startsWith(`${path.resolve(target)}${path.sep}`)) throw new Error('Unexpected artifact path')
  await mkdir(path.dirname(filename), { recursive: true })
  await writeFile(filename, bytes, { flag: 'wx' })
  audit.push({ file: relative, sha256: digest(bytes) })
}
function once(text, old, replacement) {
  if (text.split(old).length !== 2) throw new Error('Bridge source changed; explicit rebase required')
  return text.replace(old, replacement)
}
for (const relative of files) {
  const source = path.join(root, relative)
  if (!(await lstat(source)).isFile()) throw new Error('Allowlisted input must be a regular file')
  await output(relative, await readFile(source))
}
const originalBytes = await readFile(path.join(root, 'index.js'), 'utf8')
const original = originalBytes.replace(/\r\n/g, '\n')
let index = original
index = once(index, "import { fileURLToPath } from 'node:url';\n", '')
index = once(index, "export const Config = Schema.object({ settingsFile: Schema.string().default('').description('Absolute path to the manually paired Controller or Worker JSON configuration; never paste credentials here.') }).default({ settingsFile: '' });", "export const Config = Schema.object({ settingsFile: Schema.string().min(1).required().description('Required absolute path to the explicitly selected role-local configuration; never paste credentials here.'), modelCatalogProviderTimeoutMs: Schema.number().step(1).min(1).max(60000).description('Optional native Worker-only provider deadline in milliseconds. No default; requires the verified bounded-catalog helper. Choose a value below the Controller request deadline.') });")
index = once(index, "const DEFAULT_SETTINGS = fileURLToPath(new URL('./.private/controller.json', import.meta.url));\n", '')
index = once(index, "    this.problem = null; this.closing = false;", "    this.problem = null; this.closing = false; this.federationSourceClosing = Promise.resolve();")
index = once(index, "Generate pairing configs; select settingsFile in plugin configuration, or place the controller config in .private/controller.json; then use Reload configuration.", "Select an explicit absolute role-local settingsFile in this bridge configuration; no private/default file is guessed.")
index = once(index, "    const filename = path.resolve(this.config.settingsFile || DEFAULT_SETTINGS);", "    if (typeof this.config.settingsFile !== 'string' || !this.config.settingsFile || !path.isAbsolute(this.config.settingsFile)) throw new Error('An explicit absolute role-local settingsFile is required');\n    const filename = path.resolve(this.config.settingsFile);")
index = once(index, "    catch (error) { if (error.code === 'ENOENT') return; throw error; }", "    catch (error) { throw new Error('The explicit role-local settings file could not be read'); }")
index = once(index, '    const document = JSON.parse(raw);', "    const document = JSON.parse(raw);\n    if (this.config.modelCatalogProviderTimeoutMs !== undefined && document?.version !== 2) throw new Error('A provider deadline requires native Worker configuration');")
const oldFederation = original.slice(original.indexOf('  async reloadFederation('), original.indexOf('  async ensureSession('))
const federation = `  async reloadFederation(document, filename) {
    const { parseSettingsV2 } = await import('./lib/federation/settings.mjs');
    const settings = await parseSettingsV2(document, filename, { resolveWorkspace: id => this.ctx.get('workspaceRegistry')?.get(id) });
    const { openFederationRuntime } = await import('./lib/federation/runtime.mjs');
    if (settings.role !== 'worker' && this.config.modelCatalogProviderTimeoutMs !== undefined) throw new Error('A provider deadline is only valid for the native Worker role');
    this.settings = settings;
    if (settings.role === 'controller') {
      this.problem = 'Waiting for the owner session-source interface';
      this.federationScope = this.ctx.inject(['sessionSourceController'], sourceCtx => {
        const lifetime = new AbortController();
        const predecessor = this.federationSourceClosing;
        const registrations = [];
        let runtime, startup;
        const closeResources = async () => {
          try { for (const dispose of registrations.splice(0).reverse()) dispose(); }
          finally { if (this.federation === runtime) this.federation = null; await runtime?.close(); }
        };
        sourceCtx.effect(() => () => {
          lifetime.abort();
          const closing = (startup ?? Promise.resolve()).then(closeResources, closeResources);
          this.federationSourceClosing = closing.catch(() => {});
          return closing;
        });
        startup = (async () => {
          await predecessor;
          lifetime.signal.throwIfAborted();
          runtime = await openFederationRuntime(settings, { onError: () => { this.problem = 'A federated source is unavailable; inspect local pairing and grant state'; } });
          lifetime.signal.throwIfAborted();
          const { createHostProvider } = await import('./lib/federation/host-provider.mjs');
          for (const pair of settings.pairs) {
            const provider = await createHostProvider({ runtime, pair });
            lifetime.signal.throwIfAborted();
            registrations.push(sourceCtx.sessionSourceController.registerSource(provider));
          }
          lifetime.signal.throwIfAborted();
          this.federation = runtime; this.problem = null; runtime.start();
        })().catch(async () => {
          await closeResources();
          if (!lifetime.signal.aborted && !this.closing) this.problem = 'Federated sources could not be registered; inspect local configuration and journal locks';
        });
        return startup;
      });
      return;
    }
    const backend = await (await import('./lib/federation/native-adapter.mjs')).createNativeAdapter({ ctx: this.ctx, settings, modelCatalogProviderTimeoutMs: this.config.modelCatalogProviderTimeoutMs });
    this.federation = await openFederationRuntime(settings, { backend, onError: () => { this.problem = 'A federated source is unavailable; inspect local pairing and grant state'; } });
    this.federationSourceDisposers = [];
    for (const agent of this.ctx.agents.list()) await this.federation.restoreAgent(agent);
    this.federation.start();
  }
`
index = once(index, oldFederation, federation)
index = once(index, "    if (this.federation) {\n      const runtime = this.federation; this.federation = null;", "    if (this.federationScope) { const scope = this.federationScope; this.federationScope = null; await scope.dispose(); }\n    await this.federationSourceClosing;\n    if (this.federation) {\n      const runtime = this.federation; this.federation = null;")
await output('index.js', index)
const sourceManifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'))
await output('package.json', JSON.stringify({ name: '@dsh-remote/control-bridge', version, private: true, type: 'module', description: 'Host-only paired native-session bridge; explicit role-local configuration, no legacy client dock', engines: sourceManifest.engines, exports: { '.': './index.js', './icon': './icon.svg', './locale/*.json': './locale/*.json' }, files: ['index.js', 'lib', 'icon.svg', 'locale', 'cordis.patch.yml', 'README.md', 'FEDERATION-V2.md', 'build-report.json'], dsh: { bundle: { patch: './cordis.patch.yml' } }, dependencies: sourceManifest.dependencies, peerDependencies: { ...sourceManifest.peerDependencies, '@dsh-remote/worker-session-controller': '0.1.2' }, peerDependenciesMeta: sourceManifest.peerDependenciesMeta }, null, 2) + '\n')
for (const [language, meta] of Object.entries({
  en: { title: 'Native remote session bridge', description: 'Encrypted Controller–Worker pairing with bounded model catalogs and safe operation diagnostics.' },
  ru: { title: 'Мост удалённых сеансов', description: 'Шифрованная связь Controller и Worker с постраничными каталогами моделей и безопасной диагностикой операций.' },
})) await output(`locale/${language}.json`, JSON.stringify({ meta }, null, 2) + '\n')
await output('cordis.patch.yml', JSON.stringify([{ id: 'remote-control', name: '@local/dsh-remote-control', disabled: true }, { insert: [{ id: 'remote-native-control-bridge', name: '@dsh-remote/control-bridge', config: { settingsFile: '' } }] }], null, 2) + '\n')
await output('README.md', '# Host-only native-session control bridge\n\nThis package contains only the allowlisted Host bridge and its owned libraries; no client export, dsh.client, tests, private files, node_modules, kernel or installed runtime copies. Disabling the old Loader row removes its legacy client dock without changing other profiles.\n\nThe bundle template deliberately has an empty INVALID settingsFile. A role-local generated config bundle must override remote-native-control-bridge.config.settingsFile with an explicit absolute path before activation. No private/default path, credential, workspace or Session is inferred or copied. Keep pairing values only in that user-owned configuration file.\n\nFor v2 Controller, the owner sessionSourceController is consumed through an owned ctx.inject contribution, so late availability is not an error and removal closes providers/runtime. Worker never requires the source BFF. Exact NEW Worker API identity and fresh authenticated response remain required for native mutations; no configuration force flag exists. V1 behavior is preserved for an explicitly selected v1 file.\n\nOptional federation v2 features are advertised by authenticated hello, never inferred from transport liveness. Model catalogs use scoped, hash-checked pages only when the Worker advertises model-catalog-pages-v1; legacy peers keep the original bounded read. Complete response wrappers remain at 32 KiB. Static operation diagnostics never echo raw backend failures. A lost or malformed mutation receipt remains unknown, including failures after dispatch; only the identical request can reconcile it. See [the v2 protocol notes](FEDERATION-V2.md).\n\nTo isolate a slow provider, set the optional modelCatalogProviderTimeoutMs integer (1..60000) ONLY in the native Worker Bridge plugin Config. It has no hidden default and is never read from remote requests or pairing JSON. Choose a value below the Controller request deadline. Explicit bounded mode requires the exact private Worker API 0.1.2 read helper; an old, shadowed or replaced owner is action-unsupported, never an unbounded fallback. The service owns shared observations and preserves quarantine across local policy changes; cancellation of one caller cannot cancel another. The public modelCatalog Remote remains unchanged.\n\nInstall/activate only using the public manager and a reviewed role-local patch in an agreed maintenance window after affected remote work is quiescent; follow its restart/refresh next step. Do not replace signed application files or enable both old/new bridge rows. SDK peers must resolve to the same serving runtime instances.\n')
await output('build-report.json', JSON.stringify({ version: 1, package: '@dsh-remote/control-bridge', packageVersion: version, sourceIndexSha256: digest(original), sourceIndexOriginalSha256: digest(originalBytes), sourceLineEndings: 'LF for exact rebase', hostOnly: true, allowlist: [...files], modifications: ['explicit absolute settings pointer only', 'owned Controller source-BFF injection and teardown', 'versioned optional hello features and bounded model catalog pages', 'safe operation diagnostics and conservative post-dispatch uncertainty', 'EN/RU display metadata and original project icon'], files: audit }, null, 2) + '\n')
console.log('Built host-only bridge artifact; no install, private read, profile activation or remote task.')
