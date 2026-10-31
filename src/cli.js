#!/usr/bin/env bun
// safe-to-merge — "Safe to merge?" verdicts for GitHub PRs, judged by TypeSafe Jev.
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createGitHub } from './github.js';
import { createJev } from './jev.js';
import { fetchRepoConfig } from './gather.js';
import { mergeConfig } from './config.js';
import { runAgent, waitForChecks } from './agent.js';
import { setStatus, upsertComment } from './publish.js';
import { oneLine } from './report.js';

const HELP = `Usage: safe-to-merge <owner/repo#123 | PR URL> [options]

Options
  --post <list>       comma list: comment,status (default: none → print only)
  --fail-on <level>   exit 1 on: block | needs_review | never (default: never)
  --wait <seconds>    wait for running checks before judging (default: 0)
  --config <file>     local JSON config (layered over repo .github/safe-to-merge.json)
  --json              print full JSON result instead of markdown
  -h, --help

Env
  GITHUB_TOKEN / GH_TOKEN   GitHub token (pull-requests:write, statuses:write to post)
  TYPESAFE_API_KEY          TypeSafe API key
  GITHUB_API_URL            for GitHub Enterprise (default https://api.github.com)
  TYPESAFE_BASE_URL         default https://api.typesafe.ai
`;

export function parseTarget(arg, env = process.env) {
  if (arg) {
    const url = arg.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    if (url) return { owner: url[1], repo: url[2], number: Number(url[3]) };
    const short = arg.match(/^([^/\s]+)\/([^#\s]+)#(\d+)$/);
    if (short) return { owner: short[1], repo: short[2], number: Number(short[3]) };
    throw new Error(`Can't parse PR "${arg}". Use owner/repo#123 or a PR URL.`);
  }
  // GitHub Actions context
  if (env.GITHUB_REPOSITORY && (env.PR_NUMBER || env.GITHUB_EVENT_PATH)) {
    const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
    let number = Number(env.PR_NUMBER);
    if (!number) {
      const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
      number = event.pull_request?.number ?? event.issue?.number ?? event.check_suite?.pull_requests?.[0]?.number;
    }
    if (number) return { owner, repo, number };
  }
  throw new Error('No PR given. Pass owner/repo#123 or run inside a pull_request workflow.');
}

export const EXIT = { never: () => 0, block: (v) => (v === 'block' ? 1 : 0), needs_review: (v) => (v === 'safe' ? 0 : 1) };

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      post: { type: 'string', default: process.env.INPUT_POST ?? '' },
      'fail-on': { type: 'string', default: process.env.INPUT_FAIL_ON || 'never' },
      wait: { type: 'string', default: process.env.INPUT_WAIT || '0' },
      config: { type: 'string' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!EXIT[values['fail-on']]) throw new Error(`--fail-on must be block, needs_review or never.`);

  const env = process.env;
  const log = (m) => process.stderr.write(`[safe-to-merge] ${m}\n`);
  const target = parseTarget(positionals[0], env);
  const gh = createGitHub({ token: env.GITHUB_TOKEN || env.GH_TOKEN, baseUrl: env.GITHUB_API_URL });

  // Policy comes from the BASE branch so a PR can't relax its own gate.
  const pr = await gh.get(`/repos/${target.owner}/${target.repo}/pulls/${target.number}`);
  const repoConfig = await fetchRepoConfig(gh, target, pr.base.ref).catch((e) => {
    log(`Ignoring repo config: ${e.message}`);
    return null;
  });
  const localConfig = values.config ? JSON.parse(readFileSync(values.config, 'utf8')) : null;
  const selfCheck = env.SAFE_TO_MERGE_SELF_CHECK ? { ignoreChecks: [env.SAFE_TO_MERGE_SELF_CHECK] } : null;
  const config = mergeConfig(repoConfig, localConfig, selfCheck);

  const jev = createJev({ apiKey: env.TYPESAFE_API_KEY, baseUrl: env.TYPESAFE_BASE_URL, model: config.model });
  const runUrl = env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;

  await waitForChecks(gh, target, config, { timeoutSec: Number(values.wait), log });
  const result = await runAgent({ gh, jev, target, config, runUrl, log });

  const post = new Set(values.post.split(',').map((s) => s.trim()).filter(Boolean));
  if (post.has('comment')) {
    await upsertComment(gh, target, result.report, config.marker).catch((e) => log(`Comment failed: ${e.message}`));
  }
  if (post.has('status')) {
    await setStatus(gh, target, result.sha, result.decision, { targetUrl: runUrl }).catch((e) => log(`Status failed: ${e.message}`));
  }

  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `verdict=${result.decision.verdict}\nsummary=${oneLine(result.decision).replace(/\n/g, ' ')}\n`);
  }
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${result.report}\n`);

  process.stdout.write(
    values.json
      ? `${JSON.stringify({ verdict: result.decision.verdict, reasons: result.decision.reasons, jev: result.jev, facts: { ...result.facts, checks: undefined } }, null, 2)}\n`
      : `${result.report}\n`,
  );
  return EXIT[values['fail-on']](result.decision.verdict);
}

const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[safe-to-merge] ${err.message}\n`);
      process.exit(2);
    },
  );
}
