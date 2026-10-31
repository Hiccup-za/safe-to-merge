import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeScore } from '../src/jev.js';
import { classifyPath, globToRegExp, redact, relatedTests } from '../src/facts.js';
import { mergeConfig } from '../src/config.js';
import { parseTarget } from '../src/cli.js';

const LV = ['Trivial', 'Low', 'Medium', 'High'];

test('normalizeScore: numeric legend', () => {
  const s = normalizeScore({ score: 2.5, legend: { 0: 'Trivial', 1: 'Low', 2: 'Medium', 3: 'High' }, probabilities: { 2: 0.5, 3: 0.45 }, confidence: 0.4 }, LV);
  assert.equal(s.norm, 2.5 / 3);
  assert.equal(s.level, 'Medium');
});

test('normalizeScore: 1-based legend', () => {
  const s = normalizeScore({ score: 4, legend: { 1: 'Trivial', 2: 'Low', 3: 'Medium', 4: 'High' }, probabilities: { 4: 0.9 } }, LV);
  assert.equal(s.norm, 1);
  assert.equal(s.level, 'High');
});

test('normalizeScore: no legend, probabilities keyed by label', () => {
  const s = normalizeScore({ score: 0, probabilities: { Trivial: 0.9, Low: 0.1 } }, LV);
  assert.equal(s.norm, 0);
  assert.equal(s.level, 'Trivial');
});

test('classifyPath', () => {
  assert.equal(classifyPath('src/a.ts'), 'source');
  assert.equal(classifyPath('src/a.test.ts'), 'test');
  assert.equal(classifyPath('tests/test_api.py'), 'test');
  assert.equal(classifyPath('pkg/api_test.go'), 'test');
  assert.equal(classifyPath('README.md'), 'docs');
  assert.equal(classifyPath('package-lock.json'), 'lockfile');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'ci');
  assert.equal(classifyPath('db/migrations/001.sql'), 'migration');
  assert.equal(classifyPath('tsconfig.json'), 'config');
});

test('relatedTests matches by stem across conventions', () => {
  const r = relatedTests(
    [
      { filename: 'src/billing/invoice.ts', status: 'modified' },
      { filename: 'app/api.py', status: 'modified' },
      { filename: 'src/x.ts', status: 'modified' },
    ],
    ['src/billing/__tests__/invoice.test.ts', 'e2e/invoice.spec.ts', 'tests/test_api.py', 'src/x.test.ts'],
  );
  assert.deepEqual(r[0].relatedTests, ['src/billing/__tests__/invoice.test.ts', 'e2e/invoice.spec.ts']);
  assert.deepEqual(r[1].relatedTests, ['tests/test_api.py']);
  assert.deepEqual(r[2].relatedTests, [], 'stems under 3 chars are too noisy to match');
});

test('redact: strong vs weak', () => {
  const r = redact('key=AKIAABCDEFGHIJKLMNOP and password: "hunter2hunter2"');
  assert.equal(r.strong, 1);
  assert.equal(r.weak, 1);
  assert.doesNotMatch(r.text, /AKIA|hunter2/);
  assert.match(r.text, /password: "\[REDACTED\]"/);
});

test('globToRegExp', () => {
  assert.ok(globToRegExp('codecov/*').test('codecov/patch'));
  assert.ok(!globToRegExp('codecov/*').test('test'));
  assert.ok(globToRegExp('Vercel – Preview').test('vercel – preview'));
});

test('mergeConfig layers thresholds and unions ignoreChecks', () => {
  const c = mergeConfig({ thresholds: { risk: 0.9 }, ignoreChecks: ['a'] }, { ignoreChecks: ['b'] });
  assert.equal(c.thresholds.risk, 0.9);
  assert.equal(c.thresholds.blockingComment, 0.7);
  assert.ok(['safe-to-merge', 'a', 'b'].every((n) => c.ignoreChecks.includes(n)));
});

test('parseTarget', () => {
  assert.deepEqual(parseTarget('acme/shop#12'), { owner: 'acme', repo: 'shop', number: 12 });
  assert.deepEqual(parseTarget('https://github.com/acme/shop/pull/12/files'), { owner: 'acme', repo: 'shop', number: 12 });
  assert.deepEqual(parseTarget(undefined, { GITHUB_REPOSITORY: 'acme/shop', PR_NUMBER: '5' }), { owner: 'acme', repo: 'shop', number: 5 });
  assert.throws(() => parseTarget('nope'));
});
