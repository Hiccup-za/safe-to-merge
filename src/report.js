// Templated markdown. Jev doesn't write text, so every word here comes from code.
import { VERDICT } from './policy.js';

const HEAD = {
  [VERDICT.SAFE]: '## 🟢 Safe to merge',
  [VERDICT.REVIEW]: '## 🟡 Needs human review',
  [VERDICT.BLOCK]: '## 🔴 Not safe to merge',
};
const ICON = { block: '🔴', review: '🟡', info: 'ℹ️' };
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

function signalRows(a) {
  if (!a) return [];
  const rows = [];
  if (a.verdict) rows.push(['Verdict', a.verdict.choice.replace('_', ' '), pct(a.verdict.confidence)]);
  if (a.risk) rows.push(['Risk', a.risk.level?.split(':')[0] ?? a.risk.score, pct(a.risk.confidence)]);
  const yes = (k, label) => a[k] && rows.push([label, a[k].p >= 0.5 ? 'yes' : 'no', `P(yes) ${pct(a[k].p)}`]);
  yes('tests_adequate', 'Tests adequate');
  yes('breaking_change', 'Breaking change');
  yes('sensitive_area', 'Security-sensitive');
  yes('description_matches', 'Description matches');
  yes('mixed_concerns', 'Mixed concerns');
  return rows;
}

export function renderReport({ decision, facts, jev, config, url }) {
  const out = [config.marker, HEAD[decision.verdict]];
  if (decision.overridden) out.push('_Overridden by label._');

  const visible = decision.reasons.filter((r) => r.level !== 'info');
  const notes = decision.reasons.filter((r) => r.level === 'info');
  if (visible.length) {
    out.push('', ...visible.map((r) => `- ${ICON[r.level]} ${r.message}${r.source === 'jev' ? ' _(Jev)_' : ''}`));
  } else {
    out.push('', 'All rules pass and Jev sees no concerns.');
  }
  if (notes.length) out.push('', ...notes.map((r) => `- ${ICON.info} ${r.message}`));

  const rows = signalRows(jev.pr?.answers);
  if (rows.length) {
    out.push('', '<details><summary>Jev signals</summary>', '', '| Signal | Answer | Confidence |', '|---|---|---|');
    out.push(...rows.map((r) => `| ${r.join(' | ')} |`), '', '</details>');
  }

  const c = facts.checks;
  const untested = facts.related.filter((r) => !r.testTouchedInPr);
  out.push(
    '',
    '<details><summary>Facts</summary>',
    '',
    `- **Size:** ${facts.changedFiles} files, +${facts.additions}/-${facts.deletions}`,
    `- **Checks:** ${c.passing.length} passing, ${c.failing.length} failing, ${c.pending.length} pending${c.ignored.length ? `, ${c.ignored.length} ignored` : ''}`,
    `- **Approvals:** ${facts.reviews.approvals.length}/${facts.requiredApprovals}${facts.reviews.approvals.length ? ` (${facts.reviews.approvals.map((l) => `@${l}`).join(', ')})` : ''}`,
    `- **Unresolved threads:** ${facts.threads.length}`,
  );
  if (untested.length) {
    out.push(`- **Source changed without test changes:**`);
    for (const r of untested.slice(0, 10)) {
      out.push(`  - \`${r.file}\`${r.relatedTests.length ? ` → related: ${r.relatedTests.map((p) => `\`${p}\``).join(', ')}` : ' → no related tests found'}`);
    }
  }
  out.push('', '</details>');

  const model = jev.pr?.model ?? config.model;
  out.push(
    '',
    `<sub>Head \`${facts.headSha.slice(0, 7)}\` · ${model} · ${jev.calls ?? 0} Jev calls · Add the \`${config.overrideLabel}\` label to override${url ? ` · [run](${url})` : ''}</sub>`,
  );
  return out.join('\n');
}

export function oneLine(decision) {
  const top = decision.reasons.find((r) => r.level !== 'info');
  const label = { safe: 'Safe to merge', needs_review: 'Needs human review', block: 'Not safe to merge' }[decision.verdict];
  return top ? `${label}: ${top.message}` : label;
}
