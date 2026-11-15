#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import { createRelay } from './server.mjs';

const USAGE = 'Usage: node relay/cli.mjs [--config] <relay-config.json>\n';

/** Start one relay from JSON. Relative storage paths are relative to the config. */
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(USAGE);
    return;
  }
  const filename = argv.length === 1 && !argv[0].startsWith('-') ? argv[0]
    : argv.length === 2 && argv[0] === '--config' ? argv[1] : undefined;
  if (!filename) throw new Error('Invalid arguments');
  const configPath = path.resolve(filename);
  const stat = await fs.stat(configPath);
  if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('Invalid configuration');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const allowed = ['directory', 'devices', 'host', 'port', 'pollMs', 'maxPending'];
  if (!config || typeof config !== 'object' || Array.isArray(config) ||
      Object.keys(config).some((key) => !allowed.includes(key)) ||
      typeof config.directory !== 'string' || !config.directory.trim() ||
      !Array.isArray(config.devices)) throw new Error('Invalid configuration');
  const host = config.host ?? '127.0.0.1';
  const port = config.port ?? 8787;
  // The relay must stay behind a trusted HTTPS tunnel, never on a public bind.
  // Restrict to canonical numeric loopback addresses; no DNS or exposure opt-in.
  if (!['127.0.0.1', '::1'].includes(host) || !Number.isSafeInteger(port) ||
      port < 0 || port > 65535) throw new Error('Invalid listen address');
  const relay = createRelay({
    directory: path.resolve(path.dirname(configPath), config.directory),
    devices: config.devices,
    ...(config.pollMs !== undefined ? { pollMs: config.pollMs } : {}),
    ...(config.maxPending !== undefined ? { maxPending: config.maxPending } : {}),
  });
  try {
    await new Promise((resolve, reject) => {
      relay.server.once('error', reject);
      relay.server.listen(port, host, () => {
        relay.server.off('error', reject);
        resolve();
      });
    });
  } catch {
    await relay.close();
    throw new Error('Relay startup failed');
  }

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    relay.close().catch(() => {
      process.stderr.write('Relay shutdown failed.\n');
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  relay.server.once('close', () => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  });
  relay.server.on('error', () => {
    process.stderr.write('Relay server failed.\n');
    process.exitCode = 1;
    stop();
  });
  const address = relay.server.address();
  const displayHost = isIP(host) === 6 ? `[${host}]` : host;
  process.stdout.write(`Relay listening on http://${displayHost}:${address.port}\n`);
  return relay;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(() => {
    // Never include exception text: JSON parse errors may quote secrets from config.
    process.stderr.write('Relay failed to start: invalid configuration or unavailable storage/listen address.\n');
    process.exitCode = 1;
  });
}
