// Deterministic facts. Code computes; Jev only judges.

// ---------- file classification + related tests ----------

const TEST_RE = [
  /(^|\/)(__tests__|tests?|spec|specs|e2e|cypress|playwright)\//i,
  /\.(test|spec|e2e|cy)\.[cm]?[jt]sx?$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /_spec\.rb$/i,
  /Tests?\.(cs|java|kt|swift|scala)$/,
];
const DOC_RE = [/\.(md|mdx|rst|txt|adoc)$/i, /(^|\/)docs?\//i, /(^|\/)(LICENSE|CHANGELOG|AUTHORS)/i];
const LOCK_RE = [/(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb|Cargo\.lock|poetry\.lock|Gemfile\.lock|go\.sum|composer\.lock|uv\.lock)$/];
const CI_RE = [/^\.github\/(workflows|actions)\//, /(^|\/)(\.gitlab-ci\.yml|Jenkinsfile|\.circleci\/)/, /(^|\/)Dockerfile/i, /(^|\/)(terraform|infra|helm|k8s|deploy)\//i];
const MIGRATION_RE = [/(^|\/)(migrations?|migrate|db\/schema)/i, /\.sql$/i];
const CONFIG_RE = [/\.(json|ya?ml|toml|ini|cfg|conf|env\.example)$/i, /(^|\/)\.[^/]+rc(\.[a-z]+)?$/i];
const SOURCE_RE = /\.([cm]?[jt]sx?|py|go|rb|rs|java|kt|swift|cs|php|scala|ex|exs|c|cc|cpp|h|hpp|vue|svelte|dart|lua|sh)$/i;

const any = (res, p) => res.some((r) => r.test(p));

export function classifyPath(path) {
  if (any(TEST_RE, path)) return 'test';
  if (any(LOCK_RE, path)) return 'lockfile';
  if (any(CI_RE, path)) return 'ci';
  if (any(MIGRATION_RE, path)) return 'migration';
  if (any(DOC_RE, path)) return 'docs';
  if (SOURCE_RE.test(path)) return 'source';
  if (any(CONFIG_RE, path)) return 'config';
  return 'other';
}

function stem(path) {
  const base = path.split('/').pop();
  return base.replace(/\.[^.]+$/, '').replace(/\.(test|spec|e2e|cy)$/i, '').replace(/^test_|_test$|_spec$|Tests?$/g, '');
}

/**
 * For each changed source file, find existing test files in the repo that look related
 * (same stem), and whether the PR touched any of them.
 */
export function relatedTests(files, treePaths) {
  const changed = new Set(files.map((f) => f.filename));
  const testPaths = treePaths.filter((p) => any(TEST_RE, p));
  const byStem = new Map();
  for (const p of testPaths) {
    const s = stem(p).toLowerCase();
    if (!byStem.has(s)) byStem.set(s, []);
    byStem.get(s).push(p);
  }
  const out = [];
  for (const f of files) {
    if (classifyPath(f.filename) !== 'source' || f.status === 'removed') continue;
    const s = stem(f.filename).toLowerCase();
    const related = s.length >= 3 ? byStem.get(s) ?? [] : [];
    out.push({
      file: f.filename,
      relatedTests: related.slice(0, 5),
      testTouchedInPr: related.some((p) => changed.has(p)),
    });
  }
  return out;
}

// ---------- secrets ----------

// Strong: recognisable credential formats → hard block.
const TOKEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{24,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
];
// Weak: `password = "longliteral"` — often test fixtures → human review.
const KEY_VALUE = /((?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["'])([^"'\s]{12,})(["'])/gi;

/** Redacts likely secrets. Returns { text, strong, weak }. */
export function redact(text = '') {
  let strong = 0;
  let weak = 0;
  let out = text;
  for (const re of TOKEN_PATTERNS) {
    out = out.replace(re, () => {
      strong++;
      return '[REDACTED]';
    });
  }
  out = out.replace(KEY_VALUE, (_m, pre, _v, post) => {
    weak++;
    return `${pre}[REDACTED]${post}`;
  });
  return { text: out, strong, weak };
}

/** Secrets in ADDED lines of the diff (removing a leaked key is fine). */
export function findSecretsInDiff(files) {
  const strong = [];
  const weak = [];
  for (const f of files) {
    if (!f.patch) continue;
    const added = f.patch
      .split('\n')
      .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
      .join('\n');
    const r = redact(added);
    if (r.strong) strong.push(f.filename);
    else if (r.weak) weak.push(f.filename);
  }
  return { strong, weak };
}

// ---------- checks ----------

export function globToRegExp(glob) {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 'i');
}

const FAIL = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const OK = new Set(['success', 'neutral', 'skipped']);

/** Normalises check runs + commit statuses into passing / failing / pending buckets. */
export function bucketChecks(checkRuns, statuses, { ignore = [], requiredChecks = [] } = {}) {
  const ignoreRes = ignore.map(globToRegExp);
  const ignored = (name) => ignoreRes.some((r) => r.test(name));

  // Latest run per name wins (re-runs).
  const latest = new Map();
  for (const r of checkRuns) {
    const prev = latest.get(r.name);
    if (!prev || new Date(r.started_at ?? 0) >= new Date(prev.started_at ?? 0)) latest.set(r.name, r);
  }

  const all = [];
  for (const r of latest.values()) {
    let state = 'pending';
    if (r.status === 'completed') state = FAIL.has(r.conclusion) ? 'failing' : OK.has(r.conclusion) ? 'passing' : 'failing';
    if (r.conclusion === 'cancelled') state = 'failing';
    all.push({
      name: r.name,
      kind: 'check_run',
      id: r.id,
      state,
      conclusion: r.conclusion,
      url: r.html_url,
      summary: [r.output?.title, r.output?.summary].filter(Boolean).join(' — ').slice(0, 1500),
      app: r.app?.slug,
    });
  }
  for (const s of statuses) {
    all.push({
      name: s.context,
      kind: 'status',
      state: s.state === 'success' ? 'passing' : s.state === 'pending' ? 'pending' : 'failing',
      conclusion: s.state,
      url: s.target_url,
      summary: (s.description ?? '').slice(0, 500),
    });
  }

  const considered = all.filter((c) => !ignored(c.name));
  const seen = new Set(all.map((c) => c.name));
  return {
    passing: considered.filter((c) => c.state === 'passing'),
    failing: considered.filter((c) => c.state === 'failing'),
    pending: considered.filter((c) => c.state === 'pending'),
    ignored: all.filter((c) => ignored(c.name)).map((c) => c.name),
    missingRequired: requiredChecks.filter((n) => !seen.has(n) && !ignored(n)),
    required: new Set(requiredChecks),
  };
}

// ---------- reviews + discussion ----------

export function latestReviewStates(reviews, prAuthor) {
  const byUser = new Map();
  for (const r of reviews) {
    const login = r.user?.login;
    if (!login || login === prAuthor) continue;
    // COMMENTED doesn't override an earlier APPROVED / CHANGES_REQUESTED
    if (r.state === 'COMMENTED' || r.state === 'PENDING') continue;
    byUser.set(login, r.state);
  }
  const approvals = [];
  const changesRequested = [];
  for (const [login, state] of byUser) {
    if (state === 'APPROVED') approvals.push(login);
    if (state === 'CHANGES_REQUESTED') changesRequested.push(login);
  }
  return { approvals, changesRequested };
}

export const isBot = (login = '') => /\[bot\]$/i.test(login) || /-bot$/i.test(login);

export function openThreads(threads, { max = 20 } = {}) {
  return threads
    .filter((t) => !t.isResolved)
    .slice(0, max)
    .map((t) => ({
      path: t.path,
      line: t.line,
      outdated: t.isOutdated,
      comments: (t.comments?.nodes ?? []).map((c) => ({ author: c.author?.login ?? 'ghost', body: c.body })),
    }));
}

export function humanConversation(issueComments, marker, { max = 10 } = {}) {
  return issueComments
    .filter((c) => !isBot(c.user?.login) && !(c.body ?? '').includes(marker))
    .slice(-max)
    .map((c) => ({ author: c.user?.login ?? 'ghost', body: c.body ?? '', url: c.html_url }));
}

// ---------- everything ----------

export function computeFacts(ctx, config) {
  const { pr, files } = ctx;
  const kinds = {};
  for (const f of files) kinds[classifyPath(f.filename)] = (kinds[classifyPath(f.filename)] ?? 0) + 1;

  const checks = bucketChecks(ctx.checkRuns, ctx.statuses, {
    ignore: config.ignoreChecks,
    requiredChecks: ctx.requiredChecks,
  });
  const reviews = latestReviewStates(ctx.reviews, pr.user?.login);
  const labels = (pr.labels ?? []).map((l) => l.name);

  return {
    title: pr.title,
    author: pr.user?.login,
    draft: !!pr.draft,
    labels,
    override: labels.includes(config.overrideLabel),
    mergeable: pr.mergeable,
    mergeableState: pr.mergeable_state,
    baseRef: pr.base.ref,
    headSha: ctx.sha,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: files.length,
    kinds,
    sourceChanged: (kinds.source ?? 0) + (kinds.migration ?? 0) > 0,
    related: relatedTests(files, ctx.treePaths),
    secretsIn: findSecretsInDiff(files),
    checks,
    reviews,
    requiredApprovals: Math.max(config.minApprovals, ctx.requiredApprovals ?? 0),
    threads: openThreads(ctx.threads),
    conversation: humanConversation(ctx.issueComments, config.marker),
    warnings: [...ctx.warnings],
  };
}
