// Combines hard rules (facts) with Jev's judgments into one verdict.
// Asymmetric by design: Jev can raise concerns, but it can never turn a hard rule's BLOCK into SAFE.

export const VERDICT = { SAFE: 'safe', REVIEW: 'needs_review', BLOCK: 'block' };

const pct = (x) => `${Math.round(x * 100)}%`;
const firstLine = (s = '') => s.split('\n').find((l) => l.trim())?.trim().slice(0, 140) ?? '';

export function decide(facts, jev, config) {
  const t = config.thresholds;
  const reasons = [];
  const add = (level, source, message) => reasons.push({ level, source, message });

  // ---------- hard rules ----------
  if (facts.draft) add('block', 'rule', 'PR is still a draft.');
  if (facts.mergeable === false || facts.mergeableState === 'dirty') add('block', 'rule', 'Merge conflicts with the base branch.');
  if (facts.mergeableState === 'behind') add('review', 'rule', 'Branch is behind the base branch; update and re-run CI.');
  if (facts.mergeable == null) add('review', 'rule', 'GitHub has not finished computing mergeability.');

  for (const login of facts.reviews.changesRequested) add('block', 'rule', `@${login} requested changes.`);
  if (facts.reviews.approvals.length < facts.requiredApprovals) {
    add('review', 'rule', `${facts.reviews.approvals.length}/${facts.requiredApprovals} required approvals.`);
  }

  if (facts.secretsIn.strong.length) add('block', 'rule', `Possible credentials added in: ${facts.secretsIn.strong.join(', ')}.`);
  if (facts.secretsIn.weak.length) add('review', 'rule', `Hard-coded secret-like values in: ${facts.secretsIn.weak.join(', ')}.`);

  for (const c of facts.checks.pending) add('review', 'rule', `Check still running: ${c.name}.`);
  for (const name of facts.checks.missingRequired) add('review', 'rule', `Required check hasn't reported: ${name}.`);

  // Failing checks block unless Jev is confident they're not this PR's fault.
  const checkCause = new Map((jev.checks ?? []).map((c) => [c.name, c.answers?.cause]));
  for (const c of facts.checks.failing) {
    const cause = checkCause.get(c.name);
    const softenable = cause && cause.choice !== 'caused_by_pr' && (cause.confidence ?? 0) >= t.softenCheck;
    if (softenable) {
      add('review', 'jev', `\`${c.name}\` failed — looks ${cause.choice.replace('_', ' ')} (${pct(cause.confidence)}). Re-run it.`);
    } else {
      const why = cause ? ` Jev: ${cause.choice.replace(/_/g, ' ')} (${pct(cause.confidence ?? 0)}).` : '';
      add('block', 'rule', `\`${c.name}\` is failing.${why}`);
    }
  }

  // ---------- discussion (Jev) ----------
  for (const th of jev.threads ?? []) {
    const p = th.answers?.blocking?.p;
    if (p == null) continue;
    const where = `\`${th.thread.path}\``;
    const quote = firstLine(th.thread.comments[0]?.body);
    // Outdated threads can at most ask for review.
    if (p >= t.blockingComment && !th.thread.outdated) add('block', 'jev', `Unresolved blocking thread on ${where} (${pct(p)}): "${quote}"`);
    else if (p >= t.reviewComment) add('review', 'jev', `Unresolved thread on ${where} may need addressing (${pct(p)}): "${quote}"`);
  }
  for (const cm of jev.conversation ?? []) {
    const p = cm.answers?.blocking?.p;
    if (p == null) continue;
    const quote = firstLine(cm.comment.body);
    if (p >= t.blockingComment) add('block', 'jev', `@${cm.comment.author} raised a blocking point (${pct(p)}): "${quote}"`);
    else if (p >= t.reviewComment) add('review', 'jev', `@${cm.comment.author} may have an open concern (${pct(p)}): "${quote}"`);
  }

  // ---------- whole-PR judgment (Jev) ----------
  const a = jev.pr?.answers;
  if (a) {
    const v = a.verdict;
    if (v) {
      const conf = v.confidence ?? 0;
      if (v.choice === 'block') add(conf >= t.verdictConfidence ? 'block' : 'review', 'jev', `Jev judges this PR should not merge yet (${pct(conf)} confident).`);
      else if (v.choice === 'needs_review') add('review', 'jev', `Jev recommends a human look (${pct(conf)} confident).`);
      else if (conf < t.verdictConfidence) add('review', 'jev', `Jev leans safe but is unsure (${pct(conf)} confident).`);
    }
    if (a.risk && a.risk.norm >= t.risk) add('review', 'jev', `High risk change: ${a.risk.level?.split(':')[0] ?? 'High'}.`);
    if (facts.sourceChanged && a.tests_adequate && a.tests_adequate.p < t.testsAdequate) {
      add('review', 'jev', `Code changes look under-tested (${pct(a.tests_adequate.p)} adequate).`);
    }
    if (a.breaking_change?.p >= t.breaking) add('review', 'jev', `Likely breaking change (${pct(a.breaking_change.p)}).`);
    if (a.sensitive_area?.p >= t.sensitive) add('review', 'jev', `Touches security-sensitive code (${pct(a.sensitive_area.p)}).`);
    if (a.description_matches && a.description_matches.p < t.descriptionMismatch) {
      add('info', 'jev', `Description may not match the change (${pct(a.description_matches.p)}).`);
    }
    if (a.mixed_concerns?.p >= t.mixedConcerns) add('info', 'jev', `Mixes unrelated changes (${pct(a.mixed_concerns.p)}); consider splitting.`);
  } else {
    add('review', 'rule', 'Jev judgment unavailable — rules-only verdict.');
  }

  for (const err of jev.errors ?? []) add('info', 'rule', `Jev call failed: ${err}`);
  for (const w of facts.warnings ?? []) add('info', 'rule', w);

  // ---------- combine ----------
  let verdict = reasons.some((r) => r.level === 'block')
    ? VERDICT.BLOCK
    : reasons.some((r) => r.level === 'review')
      ? VERDICT.REVIEW
      : VERDICT.SAFE;

  let overridden = false;
  if (facts.override && verdict !== VERDICT.SAFE) {
    overridden = true;
    verdict = VERDICT.SAFE;
    reasons.unshift({ level: 'info', source: 'rule', message: `Overridden by the \`${config.overrideLabel}\` label.` });
  }

  const order = { block: 0, review: 1, info: 2 };
  reasons.sort((x, y) => order[x.level] - order[y.level]);
  return { verdict, overridden, reasons };
}
