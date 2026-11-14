import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkCi, readQuarantine, testArgs } from './run-tests.mjs';
import { criticalFiles, deferredFiles, supplementalFiles } from './run-windows-core-tests.mjs';
const root = mkdtempSync(join(tmpdir(), 'atomic-quarantine-'));
const put = (p, text) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), text); };
const item = { path: 'src/example.test.ts', owner: 'src/', status: 'quarantined', reason: 'test', issue: '#203', reproduce: 'vitest', observed: 'failure', returnCondition: 'pass' };
const registry = (tests) => put('docs/testing/quarantine.json', JSON.stringify({ schemaVersion: 1, tests }));
let count = 0;
function test(name, body) { body(); count++; console.log(`ok: ${name}`); }
try {
  put(item.path, ''); registry([item]);
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: node scripts/run-tests.mjs\n');
  test('active registry creates exact exclusions', () => assert.deepEqual(testArgs(checkCi(root)), ['run', '--exclude', item.path]));
  test('released test returns to normal suite', () => assert.deepEqual(testArgs([{ ...item, status: 'released' }]), ['run']));
  test('scope and reproduction retain registry paths', () => { assert.deepEqual(testArgs([item], 'src/mcp/'), ['run', 'src/mcp/', '--exclude', item.path]); assert.deepEqual(testArgs([item], undefined, true), ['run', item.path]); });
  registry([{ ...item, owner: '' }]);
  test('unowned exclusion rejected', () => assert.throws(() => readQuarantine(root), /owner/));
  registry([item, item]); test('duplicates rejected', () => assert.throws(() => readQuarantine(root), /duplicate/));
  registry([{ ...item, path: 'src/not-there.test.ts' }]); test('missing targets rejected', () => assert.throws(() => readQuarantine(root), /missing/));
  registry([item]);
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: node scripts/run-tests.mjs --exclude hidden.test.ts\n');
  test('manual exclusion rejected', () => assert.throws(() => checkCi(root), /bypasses/));
  put('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: npx vitest run\n');
  test('direct workflow bypass rejected', () => assert.throws(() => checkCi(root), /does not use/));
  for (const scenario of ['missing', 'quarantined']) test(`Windows gate refuses ${scenario} candidate evidence before Vitest`, () => {
    const fixture = mkdtempSync(join(tmpdir(), 'atomic-windows-preflight-'));
    const write = (path, body) => { mkdirSync(dirname(join(fixture, path)), { recursive: true }); writeFileSync(join(fixture, path), body); };
    const target = 'src/tools/fusion/candidate-evidence.test.ts';
    try {
      const source = readFileSync(new URL('./run-windows-core-tests.mjs', import.meta.url), 'utf8');
      // Retain the real preflight implementation while resolving its parser dependency from this installation.
      write('scripts/run-windows-core-tests.mjs', source.replace("'./run-tests.mjs'", JSON.stringify(new URL('./run-tests.mjs', import.meta.url).href)));
      for (const path of [...criticalFiles, ...deferredFiles, ...supplementalFiles, 'eval-agents/vitest.hermetic.config.ts']) {
        if (path !== target || scenario !== 'missing') write(path, '');
      }
      write('.github/workflows/test.yml', 'jobs:\n  test:\n    steps:\n      - run: node scripts/run-tests.mjs\n');
      write('docs/testing/quarantine.json', JSON.stringify({ schemaVersion: 1, tests: scenario === 'quarantined' ? [{ ...item, path: target }] : [] }));
      write('node_modules/vitest/vitest.mjs', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(fixture, 'vitest-started'))}, 'started');`);
      const result = spawnSync(process.execPath, [join(fixture, 'scripts/run-windows-core-tests.mjs')], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, scenario === 'missing' ? /Missing Windows core gate input/ : /must not be quarantined/);
      assert.equal(existsSync(join(fixture, 'vitest-started')), false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  });
  console.log(`quarantine self-test: ${count} checks passed`);
} finally { rmSync(root, { recursive: true, force: true }); }
