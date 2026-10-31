// Builds the (redacted, size-budgeted) state objects sent to Jev.
import { classifyPath, redact } from './facts.js';

const clip = (s = '', n) => (s.length > n ? `${s.slice(0, n)}… [truncated ${s.length - n} chars]` : s);
const clean = (s, n) => clip(redact(s ?? '').text, n);

// Review the riskiest files first when the diff doesn't fit.
const KIND_PRIORITY = { migration: 0, source: 1, ci: 2, config: 3, test: 4, other: 5, docs: 6, lockfile: 7 };

export function buildPrState(ctx, facts, { maxStateChars = 24000, perFilePatchChars = 2500 } = {}) {
  const { pr, files } = ctx;
  const state = {
    pull_request: {
      title: clean(pr.title, 300),
      description: clean(pr.body || '(no description)', 3000),
      author: facts.author,
      base: facts.baseRef,
      labels: facts.labels,
      size: { files: facts.changedFiles, additions: facts.additions, deletions: facts.deletions },
      file_kinds: facts.kinds,
    },
    files: files.slice(0, 150).map((f) => `${f.status} ${f.filename} (+${f.additions}/-${f.deletions}) [${classifyPath(f.filename)}]`),
    tests: {
      test_files_changed: facts.kinds.test ?? 0,
      source_files_without_test_changes: facts.related
        .filter((r) => !r.testTouchedInPr)
        .slice(0, 30)
        .map((r) => (r.relatedTests.length ? `${r.file} (existing tests: ${r.relatedTests.join(', ')})` : `${r.file} (no related tests found)`)),
    },
    ci: {
      passing: facts.checks.passing.map((c) => c.name),
      failing: facts.checks.failing.map((c) => `${c.name}: ${clip(c.summary, 300)}`),
      pending: facts.checks.pending.map((c) => c.name),
    },
    reviews: {
      approved_by: facts.reviews.approvals,
      changes_requested_by: facts.reviews.changesRequested,
    },
    open_discussion: facts.threads.slice(0, 10).map((t) => `${t.path}: ${clean(t.comments[0]?.body, 400)}`),
    diff: [],
  };

  // Fill the remaining budget with patches, riskiest kinds first.
  const sorted = [...files]
    .filter((f) => f.patch)
    .sort(
      (a, b) =>
        (KIND_PRIORITY[classifyPath(a.filename)] ?? 9) - (KIND_PRIORITY[classifyPath(b.filename)] ?? 9) ||
        b.changes - a.changes,
    );
  let used = JSON.stringify(state).length;
  let omitted = 0;
  for (const f of sorted) {
    const entry = { file: f.filename, patch: clean(f.patch, perFilePatchChars) };
    const size = JSON.stringify(entry).length + 1;
    if (used + size > maxStateChars) {
      omitted++;
      continue;
    }
    state.diff.push(entry);
    used += size;
  }
  if (omitted) state.diff_note = `${omitted} file diff(s) omitted for size.`;
  return state;
}

export function buildDiscussionState(item, { path, outdated } = {}) {
  return {
    ...(path ? { file: path } : {}),
    ...(outdated ? { note: 'The code this thread is attached to has since changed.' } : {}),
    comments: (item.comments ?? [item]).map((c) => `${c.author}: ${clean(c.body, 1500)}`),
  };
}

export function buildCheckState(check, annotations, files) {
  return {
    check: check.name,
    conclusion: check.conclusion,
    summary: clean(check.summary, 1500),
    annotations: annotations.slice(0, 15).map((a) => `${a.level} ${a.path}:${a.line} ${clean(a.message, 300)}`),
    files_changed_in_pr: files.slice(0, 100).map((f) => f.filename),
  };
}
