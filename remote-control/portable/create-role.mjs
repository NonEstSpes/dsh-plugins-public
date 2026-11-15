/** Create an inert configuration-only role bundle; never read settings contents or modify a profile. */
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url)), values = new Map(), fail = () => { throw new Error('Use --settings-file EXISTING_ABSOLUTE_FILE --out NEW_ABSOLUTE_DIRECTORY outside any DSH profile') }
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index], value = process.argv[index + 1]
  if (!['--settings-file', '--out'].includes(key) || values.has(key) || typeof value !== 'string' || !value || value.includes('\0')) fail()
  values.set(key, value)
}
const settingsFile = values.get('--settings-file'), requested = values.get('--out')
if (values.size !== 2 || !path.isAbsolute(settingsFile ?? '') || !path.isAbsolute(requested ?? '')) fail()
const input = await lstat(settingsFile)
if (!input.isFile() || input.isSymbolicLink()) fail()
const parent = await realpath(path.dirname(requested)), output = path.join(parent, path.basename(requested))
if (!path.basename(requested)) fail()
for (const value of [process.env.DSH_PROFILE_DIR, process.env.DSH_HOME].filter(Boolean)) {
  const relative = path.relative(await realpath(value), output)
  if (relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))) fail()
}
try { await lstat(output); fail() } catch (error) { if (error.code !== 'ENOENT') throw error }
const icon = await readFile(path.join(here, 'icon.svg')), json = value => JSON.stringify(value, null, 2) + '\n'
const manifest = { name: '@dsh-remote/worker-role', version: '0.1.7', private: true, type: 'module',
  description: 'Explicit role-local settings pointer for an already paired remote Worker', engines: { node: '>=24.9', dsh: '0.2.2-rc.1' },
  exports: { './icon': './icon.svg', './locale/*.json': './locale/*.json' }, files: ['icon.svg', 'locale', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } }
await mkdir(output, { mode: 0o700 }); await mkdir(path.join(output, 'locale'))
for (const [name, value] of Object.entries({ 'package.json': json(manifest), 'icon.svg': icon,
  'cordis.patch.yml': json([{ id: 'remote-native-control-bridge', name: '@dsh-remote/control-bridge', disabled: false, config: { settingsFile } }]),
  'locale/en.json': json({ meta: { title: 'Remote Worker role', description: 'Explicit settings pointer; activates only after you install this role bundle.' } }),
  'locale/ru.json': json({ meta: { title: 'Роль удалённого Worker', description: 'Явный указатель настроек; включается только после установки этого role-bundle.' } }),
})) await writeFile(path.join(output, name), value, { flag: 'wx', mode: 0o600 })
console.log('ROLE_BUNDLE_READY; not installed or activated; settings contents were not read or copied')
