import { runRelayTests } from './relay.test.mjs';
import { runEndpointTests } from './endpoint.test.mjs';
import { runEngineTests } from './engine.test.mjs';
import { runIntegrationTests } from './integration.test.mjs';
import { runHostTests } from './host.test.mjs';
import { runWorkerSetupTests } from './worker-setup.test.mjs';
import { runDiagnosticTests } from './diagnostics.test.mjs';
import { runClientContractTests } from './client-contract.test.mjs';

try {
  await runClientContractTests();
  await runRelayTests();
  const endpoints = await runEndpointTests();
  console.log(`endpoint: ${endpoints.passed} groups passed`);
  await runEngineTests();
  await runHostTests();
  await runIntegrationTests();
  await runWorkerSetupTests();
  console.log('worker-setup: safe repair, backups, no grant changes and no secret output passed');
  await runDiagnosticTests();
  console.log('All Remote Control suites passed. Real DSH/Tuna/Windows acceptance remains separate.');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
