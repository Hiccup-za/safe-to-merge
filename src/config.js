export const DEFAULT_CONFIG = {
  model: 'jev-latest', // pin a version (e.g. "jev-1.13.0") once thresholds are tuned
  minApprovals: 1, // raised automatically if branch rulesets require more
  overrideLabel: 'safe-to-merge:override',
  ignoreChecks: ['safe-to-merge', 'Safe to merge?*'], // never judge ourselves
  marker: '<!-- safe-to-merge -->',
  maxStateChars: 24000,
  maxFailingChecks: 8,
  thresholds: {
    blockingComment: 0.7, // P(blocking) ≥ → BLOCK
    reviewComment: 0.4, // P(blocking) ≥ → NEEDS REVIEW
    verdictConfidence: 0.6, // Jev verdict below this confidence → NEEDS REVIEW
    risk: 0.67, // normalised risk score ≥ → NEEDS REVIEW (≈ "High")
    testsAdequate: 0.5, // P(tests adequate) < → NEEDS REVIEW
    breaking: 0.6,
    sensitive: 0.6,
    softenCheck: 0.8, // confidence a failing check is flaky/infra/unrelated to soften BLOCK → REVIEW
    descriptionMismatch: 0.3, // P(description matches) < → note
    mixedConcerns: 0.6,
  },
};

export function mergeConfig(...layers) {
  const out = structuredClone(DEFAULT_CONFIG);
  for (const layer of layers) {
    if (!layer) continue;
    for (const [k, v] of Object.entries(layer)) {
      if (k === 'thresholds') Object.assign(out.thresholds, v);
      else if (k === 'ignoreChecks') out.ignoreChecks = [...new Set([...out.ignoreChecks, ...v])];
      else out[k] = v;
    }
  }
  return out;
}
