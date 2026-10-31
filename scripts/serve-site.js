// Serves the static marketing site: bun run site
const root = new URL('../site/', import.meta.url);
const port = Number(process.env.PORT ?? 3000);

Bun.serve({
  port,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const name = path === '/' ? 'index.html' : path.slice(1);
    if (name.includes('..')) return new Response('Not found', { status: 404 });
    const file = Bun.file(new URL(name, root));
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
  },
});

console.log(`safe-to-merge site → http://localhost:${port}`);
