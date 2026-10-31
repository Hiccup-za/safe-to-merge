// Fake GitHub + fake Jev behind a single fetch implementation.

const json = (data, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => null },
  json: async () => data,
  text: async () => JSON.stringify(data),
});

export function basePr(overrides = {}) {
  return {
    number: 7,
    title: 'Fix rounding in invoice totals',
    body: 'Rounds line items before summing. Adds tests.',
    draft: false,
    user: { login: 'chris' },
    labels: [],
    mergeable: true,
    mergeable_state: 'clean',
    additions: 20,
    deletions: 4,
    head: { sha: 'abc1234def' },
    base: { ref: 'main' },
    ...overrides,
  };
}

export function baseRepo(overrides = {}) {
  return {
    pr: basePr(),
    files: [
      { filename: 'src/invoice.js', status: 'modified', additions: 10, deletions: 2, changes: 12, patch: '@@ -1 +1 @@\n-a\n+b' },
      { filename: 'test/invoice.test.js', status: 'modified', additions: 10, deletions: 2, changes: 12, patch: '@@ +x @@\n+it()' },
    ],
    reviews: [{ user: { login: 'sam' }, state: 'APPROVED' }],
    issueComments: [],
    threads: [],
    checkRuns: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-10-30T10:00:00Z', output: {} }],
    statuses: [],
    tree: ['src/invoice.js', 'test/invoice.test.js', 'README.md'],
    rules: [],
    annotations: {},
    config: null,
    ...overrides,
  };
}

/**
 * jevAnswer(body) → answers object. Default: everything looks safe.
 */
export function defaultJev(body) {
  const q = body.questions;
  const answers = {};
  if (q.verdict) answers.verdict = { type: 'choice', choice: 'safe', confidence: 0.9, probabilities: { safe: 0.93, needs_review: 0.05, block: 0.02 } };
  if (q.risk) answers.risk = { type: 'score', score: 1, legend: { 0: 'T', 1: 'L', 2: 'M', 3: 'H' }, probabilities: { 0: 0.1, 1: 0.8, 2: 0.08, 3: 0.02 }, confidence: 0.7 };
  if (q.tests_adequate) answers.tests_adequate = { type: 'noul', noul: 0.9 };
  if (q.breaking_change) answers.breaking_change = { type: 'noul', noul: 0.05 };
  if (q.sensitive_area) answers.sensitive_area = { type: 'noul', noul: 0.05 };
  if (q.description_matches) answers.description_matches = { type: 'noul', noul: 0.95 };
  if (q.mixed_concerns) answers.mixed_concerns = { type: 'noul', noul: 0.05 };
  if (q.blocking) answers.blocking = { type: 'noul', noul: 0.1 };
  if (q.kind) answers.kind = { type: 'choice', choice: 'nit', confidence: 0.8, probabilities: {} };
  if (q.cause) answers.cause = { type: 'choice', choice: 'caused_by_pr', confidence: 0.9, probabilities: {} };
  return answers;
}

export function createFakeFetch(repo, { jev = defaultJev, jevStatus } = {}) {
  const calls = { jev: [], posted: [], patched: [] };
  let jevFailuresLeft = jevStatus?.times ?? 0;

  async function fetchImpl(url, init = {}) {
    const u = new URL(url);
    const p = u.pathname;
    const method = init.method ?? 'GET';
    const page = Number(u.searchParams.get('page') ?? 1);
    const paged = (arr) => (page === 1 ? arr : []);

    if (p === '/v1/systemone') {
      const body = JSON.parse(init.body);
      calls.jev.push(body);
      if (jevFailuresLeft > 0) {
        jevFailuresLeft--;
        return json({ error: 'busy' }, jevStatus.status);
      }
      return json({ model: 'jev-1.13.0', answers: jev(body), usage: { input_tokens: 100, output_tokens: 0 } });
    }

    if (p === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: repo.threads } } } } });
    }

    const m = p.match(/^\/repos\/[^/]+\/[^/]+(\/.*)$/);
    const rest = m?.[1] ?? '';
    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(rest)) {
      calls.posted.push({ rest, body: JSON.parse(init.body) });
      return json({ id: 99 }, 201);
    }
    if (method === 'PATCH' && /\/issues\/comments\/\d+$/.test(rest)) {
      calls.patched.push({ rest, body: JSON.parse(init.body) });
      return json({ id: 99 });
    }
    if (method === 'POST' && /\/statuses\//.test(rest)) {
      calls.posted.push({ rest, body: JSON.parse(init.body) });
      return json({}, 201);
    }
    if (/^\/pulls\/\d+$/.test(rest)) return json(repo.pr);
    if (/^\/pulls\/\d+\/files$/.test(rest)) return json(paged(repo.files));
    if (/^\/pulls\/\d+\/reviews$/.test(rest)) return json(paged(repo.reviews));
    if (/^\/issues\/\d+\/comments$/.test(rest)) return json(paged(repo.issueComments));
    if (/^\/commits\/[^/]+\/check-runs$/.test(rest)) return json({ total_count: repo.checkRuns.length, check_runs: paged(repo.checkRuns) });
    if (/^\/commits\/[^/]+\/status$/.test(rest)) return json({ state: 'success', statuses: repo.statuses });
    if (/^\/git\/trees\//.test(rest)) return json({ truncated: false, tree: repo.tree.map((path) => ({ path, type: 'blob' })) });
    if (/^\/rules\/branches\//.test(rest)) return json(repo.rules);
    if (/\/protection\/required_status_checks$/.test(rest)) return json({ message: 'Not Found' }, 404);
    const ann = rest.match(/^\/check-runs\/(\d+)\/annotations$/);
    if (ann) return json(repo.annotations[ann[1]] ?? []);
    if (/^\/contents\//.test(rest)) {
      return repo.config
        ? json({ content: Buffer.from(JSON.stringify(repo.config)).toString('base64') })
        : json({ message: 'Not Found' }, 404);
    }
    return json({ message: `fake: unhandled ${method} ${p}` }, 404);
  }

  return { fetchImpl, calls };
}
