// Minimal GitHub REST + GraphQL client. Zero dependencies; uses global fetch.

export class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

export function createGitHub({ token, baseUrl = 'https://api.github.com', fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('Missing GitHub token (set GITHUB_TOKEN or GH_TOKEN).');
  const root = baseUrl.replace(/\/$/, '');
  // GHES: https://host/api/v3 → https://host/api/graphql
  const graphqlUrl = /\/api\/v3$/.test(root) ? root.replace(/\/v3$/, '/graphql') : `${root}/graphql`;

  async function request(method, path, body) {
    const url = path.startsWith('http') ? path : `${root}${path}`;
    const res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'safe-to-merge',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new GitHubError(`GitHub ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`, res.status);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function paginate(path, { max = 1000, key } = {}) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const data = await request('GET', `${path}${sep}per_page=100&page=${page}`);
      const items = key ? data[key] ?? [] : data;
      out.push(...items);
      if (items.length < 100) break;
    }
    return out.slice(0, max);
  }

  async function graphql(query, variables) {
    const data = await request('POST', graphqlUrl, { query, variables });
    if (data.errors?.length) throw new GitHubError(`GraphQL: ${data.errors[0].message}`, 200);
    return data.data;
  }

  return {
    request,
    paginate,
    graphql,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
  };
}

/** Returns null instead of throwing on 403/404 (permission-gated endpoints). */
export async function optional(promise) {
  try {
    return await promise;
  } catch (err) {
    if (err.status === 403 || err.status === 404) return null;
    throw err;
  }
}
