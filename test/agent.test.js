import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGitHub } from '../src/github.js';
import { createJev } from '../src/jev.js';
import { mergeConfig } from '../src/config.js';
import { runAgent } from '../src/agent.js';
import { upsertComment } from '../src/publish.js';
import { basePr, baseRepo, createFakeFetch, defaultJev } from './fake.js';

const target = { owner: 'acme', repo: 'shop', number: 7 };

async function judge(repo, { jev, jevStatus, config } = {}) {
  const fake = createFakeFetch(repo, { jev, jevStatus });
  const gh = createGitHub({ token: 't', fetchImpl: fake.fetchImpl });
  const client = createJev({ apiKey: 'k', fetchImpl: fake.fetchImpl, backoffMs: 1, retries: 3 });
  const result = await runAgent({ gh, jev: client, target, config: mergeConfig(config), gatherOpts: { retryDelayMs: 0 } });
  return { ...result, calls: fake.calls, fake };
}

const withAnswers = (patch) => (body) => ({ ...defaultJev(body), ...patch(body) });
const levels = (r, level) => r.decision.reasons.filter((x) => x.level === level).map((x) => x.message).join(' | ');

test('clean, approved, tested PR → safe with a single Jev call', async () => {
  const r = await judge(baseRepo());
  assert.equal(r.decision.verdict, 'safe', levels(r, 'review'));
  assert.equal(r.calls.jev.length, 1);
  const sent = r.calls.jev[0];
  assert.equal(sent.model, 'jev-latest');
  assert.ok(sent.state.diff.some((d) => d.file === 'src/invoice.js'));
  assert.match(r.report, /🟢 Safe to merge/);
  assert.match(r.report, /<!-- safe-to-merge -->/);
});

test('draft PR blocks', async () => {
  const r = await judge(baseRepo({ pr: basePr({ draft: true }) }));
  assert.equal(r.decision.verdict, 'block');
});

test('merge conflict blocks', async () => {
  const r = await judge(baseRepo({ pr: basePr({ mergeable: false, mergeable_state: 'dirty' }) }));
  assert.equal(r.decision.verdict, 'block');
  assert.match(levels(r, 'block'), /Merge conflicts/);
});

test('changes requested blocks even when Jev says safe', async () => {
  const r = await judge(
    baseRepo({
      reviews: [
        { user: { login: 'sam' }, state: 'APPROVED' },
        { user: { login: 'lee' }, state: 'CHANGES_REQUESTED' },
        { user: { login: 'lee' }, state: 'COMMENTED' }, // comment must not clear it
      ],
    }),
  );
  assert.equal(r.decision.verdict, 'block');
  assert.match(levels(r, 'block'), /@lee requested changes/);
});

test('no approvals → review; ruleset can raise the bar to 2', async () => {
  let r = await judge(baseRepo({ reviews: [] }));
  assert.equal(r.decision.verdict, 'needs_review');
  assert.match(levels(r, 'review'), /0\/1 required approvals/);

  r = await judge(baseRepo({ rules: [{ type: 'pull_request', parameters: { required_approving_review_count: 2 } }] }));
  assert.equal(r.decision.verdict, 'needs_review');
  assert.match(levels(r, 'review'), /1\/2 required approvals/);
});

test('author self-approval does not count', async () => {
  const r = await judge(baseRepo({ reviews: [{ user: { login: 'chris' }, state: 'APPROVED' }] }));
  assert.equal(r.decision.verdict, 'needs_review');
});

test('failing check caused by the PR blocks', async () => {
  const repo = baseRepo({
    checkRuns: [{ id: 5, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-10-30T10:00:00Z', output: { title: '2 failed', summary: 'invoice.test.js' } }],
    annotations: { 5: [{ path: 'test/invoice.test.js', start_line: 12, annotation_level: 'failure', message: 'expected 10.01 got 10' }] },
  });
  const r = await judge(repo);
  assert.equal(r.decision.verdict, 'block');
  const checkCall = r.calls.jev.find((c) => c.questions.cause);
  assert.ok(checkCall.state.annotations[0].includes('expected 10.01'), 'annotations reach Jev');
});

test('failing check Jev confidently calls flaky → review, never safe', async () => {
  const repo = baseRepo({
    checkRuns: [{ id: 5, name: 'e2e', status: 'completed', conclusion: 'failure', started_at: '2026-10-30T10:00:00Z', output: { summary: 'Timeout 30000ms exceeded' } }],
  });
  const r = await judge(repo, { jev: withAnswers((b) => (b.questions.cause ? { cause: { type: 'choice', choice: 'flaky', confidence: 0.92 } } : {})) });
  assert.equal(r.decision.verdict, 'needs_review');
  assert.match(levels(r, 'review'), /looks flaky.*Re-run/);
});

test('low-confidence flaky call does not soften the block', async () => {
  const repo = baseRepo({
    checkRuns: [{ id: 5, name: 'e2e', status: 'completed', conclusion: 'failure', started_at: '2026-10-30T10:00:00Z', output: {} }],
  });
  const r = await judge(repo, { jev: withAnswers((b) => (b.questions.cause ? { cause: { type: 'choice', choice: 'flaky', confidence: 0.55 } } : {})) });
  assert.equal(r.decision.verdict, 'block');
});

test('a re-run that passed supersedes the earlier failure', async () => {
  const r = await judge(
    baseRepo({
      checkRuns: [
        { id: 1, name: 'test', status: 'completed', conclusion: 'failure', started_at: '2026-10-30T09:00:00Z', output: {} },
        { id: 2, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-30T10:00:00Z', output: {} },
      ],
    }),
  );
  assert.equal(r.decision.verdict, 'safe');
});

test('pending, ignored, and missing required checks', async () => {
  const r = await judge(
    baseRepo({
      checkRuns: [
        { id: 1, name: 'test', status: 'completed', conclusion: 'success', started_at: 'x', output: {} },
        { id: 2, name: 'build', status: 'in_progress', conclusion: null, started_at: 'x', output: {} },
        { id: 3, name: 'safe-to-merge', status: 'in_progress', conclusion: null, started_at: 'x', output: {} },
      ],
      rules: [{ type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'lint' }] } }],
    }),
  );
  assert.equal(r.decision.verdict, 'needs_review');
  const review = levels(r, 'review');
  assert.match(review, /Check still running: build/);
  assert.doesNotMatch(review, /safe-to-merge/, 'ignores itself');
  assert.match(review, /Required check hasn't reported: lint/);
});

test('unresolved thread Jev judges blocking → block; outdated one → only review', async () => {
  const thread = (outdated) => ({
    isResolved: false,
    isOutdated: outdated,
    path: 'src/invoice.js',
    line: 3,
    comments: { nodes: [{ author: { login: 'sam' }, body: 'This drops the last cent on negative totals — bug.' }] },
  });
  const jev = withAnswers((b) => (b.questions.blocking ? { blocking: { type: 'noul', noul: 0.9 } } : {}));

  let r = await judge(baseRepo({ threads: [thread(false), { ...thread(false), isResolved: true }] }), { jev });
  assert.equal(r.decision.verdict, 'block');
  assert.equal(r.calls.jev.filter((c) => c.questions.blocking).length, 1, 'resolved threads are skipped');

  r = await judge(baseRepo({ threads: [thread(true)] }), { jev });
  assert.equal(r.decision.verdict, 'needs_review');
});

test('human "do not merge" comment blocks; bot comments are not sent to Jev', async () => {
  const repo = baseRepo({
    issueComments: [
      { user: { login: 'vercel[bot]' }, body: 'Preview ready' },
      { user: { login: 'pm-jo' }, body: 'Please hold — do not merge until the pricing launch on Monday.' },
    ],
  });
  const r = await judge(repo, {
    jev: withAnswers((b) => (b.questions.blocking ? { blocking: { type: 'noul', noul: b.state.comments[0].includes('hold') ? 0.95 : 0.0 } } : {})),
  });
  assert.equal(r.decision.verdict, 'block');
  const discussionCalls = r.calls.jev.filter((c) => c.questions.blocking);
  assert.equal(discussionCalls.length, 1);
  assert.ok(!JSON.stringify(discussionCalls).includes('Preview ready'));
});

test('source change without test changes: related tests found, Jev says under-tested → review', async () => {
  const repo = baseRepo({
    files: [{ filename: 'src/invoice.js', status: 'modified', additions: 30, deletions: 2, changes: 32, patch: '+x' }],
  });
  const r = await judge(repo, { jev: withAnswers((b) => (b.questions.tests_adequate ? { tests_adequate: { type: 'noul', noul: 0.2 } } : {})) });
  assert.equal(r.decision.verdict, 'needs_review');
  const state = r.calls.jev[0].state;
  assert.match(state.tests.source_files_without_test_changes[0], /src\/invoice\.js \(existing tests: test\/invoice\.test\.js\)/);
  assert.match(r.report, /related: `test\/invoice\.test\.js`/);
});

test('docs-only change ignores tests_adequate', async () => {
  const r = await judge(
    baseRepo({ files: [{ filename: 'README.md', status: 'modified', additions: 3, deletions: 1, changes: 4, patch: '+docs' }] }),
    { jev: withAnswers((b) => (b.questions.tests_adequate ? { tests_adequate: { type: 'noul', noul: 0.1 } } : {})) },
  );
  assert.equal(r.decision.verdict, 'safe');
});

test('Jev high risk / breaking / sensitive raise review', async () => {
  const r = await judge(baseRepo(), {
    jev: withAnswers((b) =>
      b.questions.risk
        ? {
            risk: { type: 'score', score: 3, legend: { 0: 'T', 1: 'L', 2: 'M', 3: 'H' }, probabilities: { 3: 0.8 }, confidence: 0.8 },
            sensitive_area: { type: 'noul', noul: 0.85 },
          }
        : {},
    ),
  });
  assert.equal(r.decision.verdict, 'needs_review');
  assert.match(levels(r, 'review'), /High risk/);
  assert.match(levels(r, 'review'), /security-sensitive/);
});

test('Jev verdict block: confident → block, unsure → review', async () => {
  const v = (conf) => withAnswers((b) => (b.questions.verdict ? { verdict: { type: 'choice', choice: 'block', confidence: conf } } : {}));
  assert.equal((await judge(baseRepo(), { jev: v(0.8) })).decision.verdict, 'block');
  assert.equal((await judge(baseRepo(), { jev: v(0.3) })).decision.verdict, 'needs_review');
});

test('added secret blocks and is redacted before reaching Jev', async () => {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const repo = baseRepo({
    files: [
      { filename: 'src/config.js', status: 'modified', additions: 1, deletions: 0, changes: 1, patch: `@@\n+const t = "${token}";` },
      { filename: 'test/config.test.js', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '+ok' },
    ],
  });
  const r = await judge(repo);
  assert.equal(r.decision.verdict, 'block');
  assert.match(levels(r, 'block'), /credentials added in: src\/config\.js/);
  assert.ok(!JSON.stringify(r.calls.jev).includes(token), 'token must not be sent to Jev');
  assert.ok(JSON.stringify(r.calls.jev).includes('[REDACTED]'));
});

test('removing a secret is fine', async () => {
  const token = `ghp_${'A1b2C3d4E5'.repeat(4)}`;
  const repo = baseRepo({
    files: [
      { filename: 'src/config.js', status: 'modified', additions: 0, deletions: 1, changes: 1, patch: `@@\n-const t = "${token}";` },
      { filename: 'test/config.test.js', status: 'added', additions: 1, deletions: 0, changes: 1, patch: '+ok' },
    ],
  });
  assert.equal((await judge(repo)).decision.verdict, 'safe');
});

test('Jev overloaded: retries, then falls back to rules-only needs_review', async () => {
  const r = await judge(baseRepo(), { jevStatus: { status: 529, times: 100 } });
  assert.equal(r.calls.jev.length, 4, '1 try + 3 retries');
  assert.equal(r.decision.verdict, 'needs_review');
  assert.match(levels(r, 'review'), /rules-only/);
});

test('Jev transient 429 then success', async () => {
  const r = await judge(baseRepo(), { jevStatus: { status: 429, times: 1 } });
  assert.equal(r.decision.verdict, 'safe');
  assert.equal(r.calls.jev.length, 2);
});

test('override label turns a non-safe verdict safe and says so', async () => {
  const r = await judge(baseRepo({ reviews: [], pr: basePr({ labels: [{ name: 'safe-to-merge:override' }] }) }));
  assert.equal(r.decision.verdict, 'safe');
  assert.ok(r.decision.overridden);
  assert.match(r.report, /Overridden/);
});

test('huge diffs stay within the state budget, riskiest files first', async () => {
  const files = Array.from({ length: 60 }, (_, i) => ({
    filename: i === 59 ? 'db/migrations/0042_drop_col.sql' : `docs/page${i}.md`,
    status: 'modified',
    additions: 200,
    deletions: 0,
    changes: 200,
    patch: '+'.padEnd(5000, 'x'),
  }));
  const r = await judge(baseRepo({ files }), { config: { maxStateChars: 12000 } });
  const state = r.calls.jev[0].state;
  assert.ok(JSON.stringify(state).length <= 12000 + 500, `state ${JSON.stringify(state).length} chars`);
  assert.equal(state.diff[0].file, 'db/migrations/0042_drop_col.sql');
  assert.match(state.diff_note, /omitted/);
});

test('sticky comment: creates once, then updates', async () => {
  const repo = baseRepo();
  const fake = createFakeFetch(repo);
  const gh = createGitHub({ token: 't', fetchImpl: fake.fetchImpl });
  await upsertComment(gh, target, '<!-- safe-to-merge -->\nfirst', '<!-- safe-to-merge -->');
  assert.equal(fake.calls.posted.length, 1);
  repo.issueComments = [{ id: 99, user: { login: 'github-actions[bot]' }, body: '<!-- safe-to-merge -->\nfirst' }];
  await upsertComment(gh, target, '<!-- safe-to-merge -->\nsecond', '<!-- safe-to-merge -->');
  assert.equal(fake.calls.patched.length, 1);
  assert.match(fake.calls.patched[0].body.body, /second/);
});
