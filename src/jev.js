// TypeSafe Jev client: POST /v1/systemone with { model, state, questions }.
// Answers: noul → { noul }, choice → { choice, probabilities, confidence },
//          score → { score, legend, probabilities, confidence }.

export class JevError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'JevError';
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504, 529]);

export function createJev({
  apiKey,
  baseUrl = 'https://api.typesafe.ai',
  model = 'jev-latest',
  fetchImpl = globalThis.fetch,
  timeoutMs = 15000,
  retries = 3,
  backoffMs = 500,
}) {
  if (!apiKey) throw new Error('Missing TypeSafe API key (set TYPESAFE_API_KEY).');
  const url = `${baseUrl.replace(/\/$/, '')}/v1/systemone`;

  async function systemOne(state, questions) {
    const body = JSON.stringify({ model, state, questions });
    for (let attempt = 0; ; attempt++) {
      const t0 = Date.now();
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        if (attempt < retries) {
          await sleep(backoffMs * 2 ** attempt);
          continue;
        }
        throw new JevError(`Jev request failed: ${err.message}`, 0);
      }
      if (RETRYABLE.has(res.status) && attempt < retries) {
        const after = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : backoffMs * 2 ** attempt);
        continue;
      }
      if (!res.ok) {
        // Error bodies can echo submitted state; keep it short.
        const text = await res.text().catch(() => '');
        throw new JevError(`Jev ${res.status}: ${text.slice(0, 200)}`, res.status);
      }
      const data = await res.json();
      return {
        model: data.model ?? model,
        ms: Date.now() - t0,
        usage: data.usage,
        answers: normalizeAnswers(data.answers ?? {}, questions),
      };
    }
  }

  return { systemOne, model };
}

// ---------- answer normalising ----------

function argmax(obj = {}) {
  let best = null;
  let bestP = -1;
  for (const [k, p] of Object.entries(obj)) {
    if (p > bestP) {
      best = k;
      bestP = p;
    }
  }
  return best;
}

/**
 * Score answers come as a position along the levels (may sit between two) plus a legend.
 * We normalise to `norm` in [0,1] and pick a `level` label, tolerating 0- or 1-based legends.
 */
export function normalizeScore(a, levels = []) {
  const n = levels.length;
  const legend = a.legend ?? {};
  const keys = Object.keys(legend)
    .map(Number)
    .filter(Number.isFinite);
  let norm;
  if (keys.length >= 2) {
    const min = Math.min(...keys);
    const max = Math.max(...keys);
    norm = (a.score - min) / (max - min);
  } else if (n >= 2) {
    const oneBased = a.score > n - 1;
    norm = ((oneBased ? a.score - 1 : a.score) / (n - 1));
  } else {
    norm = Number(a.score) || 0;
  }
  norm = Math.min(1, Math.max(0, norm));

  let level = null;
  const top = argmax(a.probabilities);
  if (top != null) {
    // Prefer our own level text: map the top key to its position in the sorted legend.
    const sorted = [...keys].sort((x, y) => x - y);
    const idx = sorted.indexOf(Number(top));
    if (idx >= 0 && levels[idx]) level = levels[idx];
    else if (levels.includes(top)) level = top;
    else level = legend[top] ?? levels[Number(top)] ?? top;
  }
  if (level == null && n) level = levels[Math.round(norm * (n - 1))];
  return { type: 'score', score: a.score, norm, level, confidence: a.confidence ?? null, probabilities: a.probabilities };
}

export function normalizeAnswers(answers, questions) {
  const out = {};
  for (const [name, q] of Object.entries(questions)) {
    const a = answers[name];
    if (!a) continue;
    const type = a.type ?? q.type;
    if (type === 'noul') out[name] = { type, p: Number(a.noul) };
    else if (type === 'choice')
      out[name] = { type, choice: a.choice, confidence: a.confidence ?? null, probabilities: a.probabilities };
    else if (type === 'score') out[name] = normalizeScore(a, q.criteria);
  }
  return out;
}

// ---------- question builders ----------

export const noul = (instructions, criteria) => ({ type: 'noul', instructions, ...(criteria ? { criteria } : {}) });
export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const score = (instructions, criteria) => ({ type: 'score', instructions, criteria });
