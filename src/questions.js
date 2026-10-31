// The judgment calls handed to Jev. Each set is evaluated in parallel, in isolation, against one state.
import { choice, noul, score } from './jev.js';

export const RISK_LEVELS = [
  'Trivial: docs, comments, formatting, or config with no behavioural effect',
  'Low: small, isolated behaviour change that is covered by tests',
  'Medium: meaningful behaviour change, moderate size, or only partly tested',
  'High: touches auth, payments, data migrations, infrastructure, concurrency, or public APIs, or is a large or untested change',
];

/** Asked once about the whole PR. */
export const PR_QUESTIONS = {
  verdict: choice(
    'You are a senior reviewer deciding whether this GitHub pull request is safe to merge right now. Weigh the code changes, tests, CI results, reviews and open discussion.',
    {
      safe: 'Low-risk, coherent change that is tested (or needs no tests), CI is green and nobody has an open concern. Can merge now.',
      needs_review: 'Probably fine, but has risk, gaps or uncertainty a human should look at before merging.',
      block: 'Has a clear problem that must be fixed first: a likely bug, broken behaviour, a relevant CI failure, an unaddressed reviewer concern, or an unsafe change.',
    },
  ),
  risk: score('How risky is merging this pull request?', RISK_LEVELS),
  tests_adequate: noul(
    'Are the behavioural code changes in this pull request adequately covered by tests added or updated in the same pull request?',
    'Yes if the changes are tested, or if there are no behavioural code changes (docs, config, formatting). No if behaviour changed without matching test changes.',
  ),
  breaking_change: noul(
    'Is this pull request likely to break existing behaviour, a public API, a database schema, or a contract that other code depends on?',
  ),
  sensitive_area: noul(
    'Does this pull request change security-sensitive code such as authentication, authorization, payments, secrets handling, cryptography, permissions, or data deletion?',
  ),
  description_matches: noul('Do the pull request title and description accurately describe what the code changes do?'),
  mixed_concerns: noul('Does this pull request mix several unrelated changes that would be safer to review as separate pull requests?'),
};

/** Asked per unresolved review thread and per recent conversation comment. */
export const DISCUSSION_QUESTIONS = {
  blocking: noul(
    'Does this pull request discussion raise a concern that must be resolved before the pull request is merged?',
    'Yes for reported bugs, correctness or security problems, missing tests the reviewer insists on, or explicit requests not to merge. No for nits, optional suggestions, answered questions, approvals, thanks or praise.',
  ),
  kind: choice('What kind of comment is this?', {
    bug: 'Reports a bug, incorrect behaviour or a security problem.',
    design: 'Disagrees with the approach or architecture.',
    test_gap: 'Asks for tests or points out missing coverage.',
    hold: 'Asks to wait, hold or not merge yet.',
    question: 'Asks a question for clarification.',
    nit: 'Minor style, naming or optional suggestion.',
    ack: 'Approval, thanks, acknowledgement or praise.',
  }),
};

/** Asked per failing CI check. */
export const CHECK_QUESTIONS = {
  cause: choice('What most likely caused this CI check to fail, given the files this pull request changed?', {
    caused_by_pr: 'The failure is most likely caused by the code changed in this pull request.',
    flaky: 'An intermittent failure such as a timeout, race condition or random test flake unrelated to the change.',
    infrastructure: 'A CI or environment problem: runner, network, package registry, rate limit, quota or credentials.',
    unrelated: 'A pre-existing failure in code this pull request does not touch.',
  }),
};
