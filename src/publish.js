// Posts the verdict back to GitHub: one sticky PR comment + one commit status.
import { oneLine } from './report.js';

export async function upsertComment(gh, { owner, repo, number }, body, marker) {
  const comments = await gh.paginate(`/repos/${owner}/${repo}/issues/${number}/comments`);
  const mine = comments.find((c) => (c.body ?? '').includes(marker));
  if (mine) return gh.patch(`/repos/${owner}/${repo}/issues/comments/${mine.id}`, { body });
  return gh.post(`/repos/${owner}/${repo}/issues/${number}/comments`, { body });
}

const STATE = { safe: 'success', needs_review: 'failure', block: 'failure' };

export async function setStatus(gh, { owner, repo }, sha, decision, { context = 'safe-to-merge', targetUrl } = {}) {
  return gh.post(`/repos/${owner}/${repo}/statuses/${sha}`, {
    state: STATE[decision.verdict],
    context,
    description: oneLine(decision).slice(0, 140),
    ...(targetUrl ? { target_url: targetUrl } : {}),
  });
}
