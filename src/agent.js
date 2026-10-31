// Orchestrates: gather → facts → Jev (parallel) → policy → report.
import { fetchAnnotations, gatherPr } from './gather.js';
import { bucketChecks, computeFacts } from './facts.js';
import { CHECK_QUESTIONS, DISCUSSION_QUESTIONS, PR_QUESTIONS } from './questions.js';
import { buildCheckState, buildDiscussionState, buildPrState } from './state.js';
import { decide } from './policy.js';
import { renderReport } from './report.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Polls until no considered check is pending, or the timeout passes. */
export async function waitForChecks(gh, target, config, { timeoutSec = 0, intervalSec = 15, log = () => {} } = {}) {
  if (!timeoutSec) return;
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const pr = await gh.get(`/repos/${target.owner}/${target.repo}/pulls/${target.number}`);
    const sha = pr.head.sha;
    const [runs, status] = await Promise.all([
      gh.paginate(`/repos/${target.owner}/${target.repo}/commits/${sha}/check-runs`, { key: 'check_runs' }),
      gh.get(`/repos/${target.owner}/${target.repo}/commits/${sha}/status`),
    ]);
    const { pending } = bucketChecks(runs, status.statuses ?? [], { ignore: config.ignoreChecks });
    if (!pending.length) return;
    log(`Waiting on ${pending.length} check(s): ${pending.map((c) => c.name).join(', ')}`);
    await sleep(intervalSec * 1000);
  }
  log('Timed out waiting for checks; judging with what is there.');
}

export async function runAgent({ gh, jev, target, config, runUrl, log = () => {}, gatherOpts }) {
  const ctx = await gatherPr(gh, target, gatherOpts);
  const facts = computeFacts(ctx, config);
  log(`Gathered PR #${target.number}: ${facts.changedFiles} files, ${facts.threads.length} open threads, ${facts.checks.failing.length} failing checks.`);

  const result = { pr: null, threads: [], conversation: [], checks: [], errors: [], calls: 0 };
  const call = async (state, questions) => {
    result.calls++;
    return jev.systemOne(state, questions);
  };
  const capture = (p) =>
    p.catch((err) => {
      result.errors.push(err.message);
      return null;
    });

  const failing = facts.checks.failing.slice(0, config.maxFailingChecks);
  const annotations = await Promise.all(
    failing.map((c) => (c.kind === 'check_run' ? fetchAnnotations(gh, target, c.id) : Promise.resolve([]))),
  );

  // Every Jev call is independent → fire them all at once.
  await Promise.all([
    capture(call(buildPrState(ctx, facts, config), PR_QUESTIONS)).then((r) => (result.pr = r)),
    ...facts.threads.map((thread) =>
      capture(call(buildDiscussionState(thread, thread), DISCUSSION_QUESTIONS)).then(
        (r) => r && result.threads.push({ thread, answers: r.answers }),
      ),
    ),
    ...facts.conversation.map((comment) =>
      capture(call(buildDiscussionState(comment), DISCUSSION_QUESTIONS)).then(
        (r) => r && result.conversation.push({ comment, answers: r.answers }),
      ),
    ),
    ...failing.map((check, i) =>
      capture(call(buildCheckState(check, annotations[i], ctx.files), CHECK_QUESTIONS)).then(
        (r) => r && result.checks.push({ name: check.name, answers: r.answers }),
      ),
    ),
  ]);

  const decision = decide(facts, result, config);
  const report = renderReport({ decision, facts, jev: result, config, url: runUrl });
  return { decision, report, facts, jev: result, sha: ctx.sha };
}
