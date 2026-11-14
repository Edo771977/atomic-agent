/** Explicit native Windows reliability gate; the Linux full suite remains separate. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCi, testArgs } from './run-tests.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const criticalFiles = [
  'src/tools/fusion/candidate-integration.test.ts',
  'src/tools/fusion/candidate-evidence.test.ts',
  'src/tools/fusion/fusion-candidate.test.ts',
  'src/tools/fusion/delegate-descriptor.test.ts',
  'src/tools/fusion/dependency-readiness.test.ts',
  'src/tools/fusion/artifact-manifest.integration.test.ts',
  'src/tools/fusion/artifact-manifest-tasks.test.ts',
  'src/tools/fusion/artifact-evidence-output.test.ts',
  'src/tools/fusion/outcome-evidence.test.ts',
  'src/tools/fusion/candidate-outcomes.test.ts',
  'src/tools/fusion/candidate-receipt.test.ts',
  'src/tools/fusion/candidate-durability.test.ts',
  'src/tools/fusion/branch-workspace-portability.test.ts',
  'src/tools/verify/verify-fail-closed.test.ts',
  'src/tools/fusion/fusion-delegate-concurrency.test.ts',
  'src/tools/fusion/outcome-report.test.ts',
  'src/tools/fusion/outcome-log.test.ts',
  'src/tools/fusion/measured-routing.test.ts',
];
const state = mkdtempSync(join(tmpdir(), 'atomic-windows-core-state-'));
try {
  for (const path of [...criticalFiles, 'eval-agents/vitest.hermetic.config.ts']) {
    if (!existsSync(join(root, path))) throw new Error(`Missing Windows core gate input: ${path}`);
  }
  const registry = checkCi(root);
  if (registry.some(record => record.status === 'quarantined' && criticalFiles.includes(record.path))) {
    throw new Error('Windows core regressions must not be quarantined');
  }
  const suites = [
    [...testArgs(registry), ...criticalFiles],
    ['run', '--config', 'eval-agents/vitest.hermetic.config.ts'],
  ];
  for (const args of suites) {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), ...args, '--maxWorkers=1', '--minWorkers=1'], {
      cwd: root, stdio: 'inherit', env: { ...process.env, ATOMIC_AGENT_STATE_DIR: state },
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Windows core suite terminated by ${result.signal}`);
    if (result.status !== 0) { process.exitCode = result.status ?? 1; break; }
  }
} catch (error) {
  console.error(error.message); process.exitCode = 1;
} finally {
  rmSync(state, { recursive: true, force: true });
}
