/** Explicit native Windows reliability gate; the Linux full suite remains separate. */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCi, testArgs } from './run-tests.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
/** Directories whose test files must each be classified below. */
export const coreDirectories = ['src/tools/fusion', 'src/tools/verify'];
/** Whole files the native Windows gate runs. */
export const criticalFiles = [
  'src/tools/fusion/candidate-integration.test.ts',
  'src/tools/fusion/candidate-durability.test.ts',
  'src/tools/fusion/branch-workspace-portability.test.ts',
  'src/tools/fusion/branch-workspace-dependency-links.test.ts',
  'src/tools/verify/verify-fail-closed.test.ts',
  'src/tools/fusion/fusion-delegate-concurrency.test.ts',
  'src/tools/fusion/outcome-report.test.ts',
  'src/tools/fusion/outcome-log.test.ts',
  'src/tools/fusion/measured-routing.test.ts',
];
/**
 * Test files in coreDirectories deliberately outside the Windows gate: not yet
 * migrated for Windows portability, or not reliability-critical. A new test
 * file in those directories fails scopeDrift until it is added to one list.
 */
export const deferredFiles = [
  'src/tools/fusion/artifact-manifest.integration.test.ts',
  'src/tools/fusion/artifact-manifest.test.ts',
  'src/tools/fusion/branch-diff.test.ts',
  'src/tools/fusion/branch-ignore-policy.test.ts',
  'src/tools/fusion/branch-isolation-safety.test.ts',
  'src/tools/fusion/branch-merge.test.ts',
  'src/tools/fusion/branch-workspace-autocrlf.test.ts',
  'src/tools/fusion/branch-workspace-cancellation.test.ts',
  'src/tools/fusion/contract-checks.test.ts',
  'src/tools/fusion/contract-shape.test.ts',
  'src/tools/fusion/contract.test.ts',
  'src/tools/fusion/declared-files.test.ts',
  'src/tools/fusion/delegate-args.test.ts',
  'src/tools/fusion/delegate-descriptor.test.ts',
  'src/tools/fusion/dependency-readiness.test.ts',
  'src/tools/fusion/escalation.test.ts',
  'src/tools/fusion/failure-breaker.test.ts',
  'src/tools/fusion/fanout-paths.test.ts',
  'src/tools/fusion/fusion-candidate.test.ts',
  'src/tools/fusion/fusion-delegate.integration.test.ts',
  'src/tools/fusion/fusion-delegate.outcome-log.test.ts',
  'src/tools/fusion/fusion-delegate.test.ts',
  'src/tools/fusion/judge.test.ts',
  'src/tools/fusion/local-grammar-smoke.test.ts',
  'src/tools/fusion/local-leg-health.test.ts',
  'src/tools/fusion/merge-gate.test.ts',
  'src/tools/fusion/orchestrator-hints.test.ts',
  'src/tools/fusion/replan.test.ts',
  'src/tools/fusion/role-models.test.ts',
  'src/tools/fusion/run-checkpoint.test.ts',
  'src/tools/fusion/run-resume.test.ts',
  'src/tools/fusion/syntax-pass.test.ts',
  'src/tools/fusion/task-permits.test.ts',
  'src/tools/fusion/task-profiles.test.ts',
  'src/tools/fusion/task-tree.test.ts',
  'src/tools/fusion/turn-budget.test.ts',
  'src/tools/fusion/turn-receipt.subscription-cli.test.ts',
  'src/tools/fusion/turn-receipt.test.ts',
  'src/tools/fusion/worker-budgets.test.ts',
  'src/tools/fusion/worker-changes.test.ts',
  'src/tools/fusion/worker-needs-input.test.ts',
  'src/tools/fusion/worker-prompt.test.ts',
  'src/tools/fusion/worker-queue-clock.test.ts',
  'src/tools/fusion/worker-reply-cap.test.ts',
  'src/tools/fusion/worker-result.test.ts',
  'src/tools/fusion/worker-runner.test.ts',
  'src/tools/fusion/worker-self-check.test.ts',
  'src/tools/fusion/worker-steer.test.ts',
  'src/tools/fusion/worker-tool-policy.test.ts',
  'src/tools/fusion/worker-transport-renew.test.ts',
  'src/tools/verify/check-css-syntax.test.ts',
  'src/tools/verify/check-html-syntax.test.ts',
  'src/tools/verify/check-language-syntax.test.ts',
  'src/tools/verify/check-script-syntax.test.ts',
  'src/tools/verify/check-typescript-syntax.test.ts',
  'src/tools/verify/run-verify.test.ts',
  'src/tools/verify/terminal-app-hint.test.ts',
  'src/tools/verify/verify-checks.test.ts',
  'src/tools/verify/verify-isolation.test.ts',
  'src/tools/verify/verify-run-guard.test.ts',
  'src/tools/verify/verify-run-summary.test.ts',
  'src/tools/verify/verify-run.test.ts',
  'src/tools/verify/verify-syntax.test.ts',
  'src/tools/verify/verify-workspace-copy.test.ts',
];

/** Test files in coreDirectories missing from both lists, stale entries, and double entries. */
export function scopeDrift(base = root) {
  const present = coreDirectories.flatMap(dir => {
    const abs = join(base, dir);
    return existsSync(abs) ? readdirSync(abs).filter(name => name.endsWith('.test.ts')).map(name => `${dir}/${name}`) : [];
  }).sort();
  const listed = new Set([...criticalFiles, ...deferredFiles]);
  return {
    unclassified: present.filter(path => !listed.has(path)),
    missing: [...listed].filter(path => !present.includes(path)).sort(),
    overlapping: criticalFiles.filter(path => deferredFiles.includes(path)),
  };
}

function main() {
  const state = mkdtempSync(join(tmpdir(), 'atomic-windows-core-state-'));
  try {
    for (const path of [...criticalFiles, 'eval-agents/vitest.hermetic.config.ts']) {
      if (!existsSync(join(root, path))) throw new Error(`Missing Windows core gate input: ${path}`);
    }
    const drift = scopeDrift();
    if (drift.unclassified.length || drift.missing.length || drift.overlapping.length) {
      throw new Error(`Windows core gate scope drift: ${JSON.stringify(drift)}; classify each file in criticalFiles or deferredFiles`);
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
}

// Run only as a script; tests import the scope lists and scopeDrift.
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) main();
