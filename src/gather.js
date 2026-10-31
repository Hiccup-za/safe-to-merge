// Collects everything about a PR that the agent reasons over.
import { optional } from './github.js';

const THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          isOutdated
          path
          line
          comments(first: 20) { nodes { author { login } body createdAt } }
        }
      }
    }
  }
}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function gatherPr(gh, { owner, repo, number }, { mergeableRetries = 3, retryDelayMs = 2000 } = {}) {
  const base = `/repos/${owner}/${repo}`;
  const warnings = [];

  // GitHub computes `mergeable` lazily; it is null on first read.
  let pr = await gh.get(`${base}/pulls/${number}`);
  for (let i = 0; pr.mergeable === null && i < mergeableRetries; i++) {
    await sleep(retryDelayMs);
    pr = await gh.get(`${base}/pulls/${number}`);
  }

  const sha = pr.head.sha;
  const baseRef = pr.base.ref;

  const [files, reviews, issueComments, threads, checkRuns, status, tree, rules, classicRequired] = await Promise.all([
    gh.paginate(`${base}/pulls/${number}/files`, { max: 3000 }),
    gh.paginate(`${base}/pulls/${number}/reviews`),
    gh.paginate(`${base}/issues/${number}/comments`),
    gh
      .graphql(THREADS_QUERY, { owner, repo, number })
      .then((d) => d.repository.pullRequest.reviewThreads.nodes)
      .catch((err) => {
        warnings.push(`Could not read review threads: ${err.message}`);
        return [];
      }),
    gh.paginate(`${base}/commits/${sha}/check-runs`, { key: 'check_runs' }),
    gh.get(`${base}/commits/${sha}/status`),
    optional(gh.get(`${base}/git/trees/${sha}?recursive=1`)),
    optional(gh.get(`${base}/rules/branches/${encodeURIComponent(baseRef)}`)),
    optional(gh.get(`${base}/branches/${encodeURIComponent(baseRef)}/protection/required_status_checks`)),
  ]);

  if (!tree) warnings.push('Could not read repo tree; related-test lookup skipped.');
  if (tree?.truncated) warnings.push('Repo tree truncated by GitHub; related-test lookup is partial.');

  // Required checks / approvals from rulesets (readable with read access) and classic protection (needs admin).
  const required = new Set();
  let requiredApprovals = 0;
  for (const rule of rules ?? []) {
    if (rule.type === 'required_status_checks') {
      for (const c of rule.parameters?.required_status_checks ?? []) required.add(c.context);
    }
    if (rule.type === 'pull_request') {
      requiredApprovals = Math.max(requiredApprovals, rule.parameters?.required_approving_review_count ?? 0);
    }
  }
  for (const c of classicRequired?.contexts ?? []) required.add(c);
  for (const c of classicRequired?.checks ?? []) required.add(c.context);

  return {
    owner,
    repo,
    number,
    pr,
    sha,
    files,
    reviews,
    issueComments,
    threads,
    checkRuns,
    statuses: status?.statuses ?? [],
    treePaths: (tree?.tree ?? []).filter((t) => t.type === 'blob').map((t) => t.path),
    requiredChecks: [...required],
    requiredApprovals,
    warnings,
  };
}

/** Annotations give the "why" for failing checks without downloading logs. */
export async function fetchAnnotations(gh, { owner, repo }, checkRunId) {
  const items = await optional(gh.get(`/repos/${owner}/${repo}/check-runs/${checkRunId}/annotations?per_page=30`));
  return (items ?? []).map((a) => ({
    path: a.path,
    line: a.start_line,
    level: a.annotation_level,
    message: (a.message ?? '').slice(0, 400),
  }));
}

/** Loads policy config from the BASE branch so a PR can't loosen its own gate. */
export async function fetchRepoConfig(gh, { owner, repo }, ref, path = '.github/safe-to-merge.json') {
  const file = await optional(gh.get(`/repos/${owner}/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`));
  if (!file?.content) return null;
  return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
}
