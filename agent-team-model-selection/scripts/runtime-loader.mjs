// Isolated offline tests use exactly the libraries shipped with this DSH.
// No profile/configuration reads and no package installation.
import { registerHooks, createRequire, isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const runtime = process.env.DSH_TEAM_TEST_RUNTIME;
if (!runtime || !path.isAbsolute(runtime)) throw new Error('Set DSH_TEAM_TEST_RUNTIME to the installed dsh directory');
const anchor = createRequire(path.join(runtime, 'package.json'));
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('runtime:')) {
      const name = specifier.slice('runtime:'.length);
      return next(pathToFileURL(anchor.resolve(name)).href + '?team-test-internals', context);
    }
    try { return next(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':') || isBuiltin(specifier)) throw error;
      return next(pathToFileURL(anchor.resolve(specifier)).href, context);
    }
  },
  load(url, context, next) {
    const loaded = next(url, context);
    if (!url.endsWith('?team-test-internals')) return loaded;
    const pathname = fileURLToPath(url).replaceAll('\\', '/');
    let extra;
    if (pathname.endsWith('/agent-team-model-selection/team.js')) extra = 'TeamRoster, TeamTaskBoard, teamProjectionDefinition';
    else if (pathname.endsWith('/dsh-tool-subagent/lib/index.js')) extra = 'subagentModelSelectionProjectionDefinition';
    else throw new Error('Unknown test-only internal module');
    return { ...loaded, source: String(loaded.source) + `\nexport { ${extra} };\n` };
  },
});
