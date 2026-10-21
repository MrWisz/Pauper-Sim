import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/** The site-wide headers from public/_headers (what Netlify sends), so `vite preview` behaves like production. */
function netlifyHeaders(): Record<string, string> {
  const out: Record<string, string> = {};
  let inSite = false;
  for (const line of readFileSync('public/_headers', 'utf8').split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      inSite = line.trim() === '/*';
      continue;
    }
    const i = line.indexOf(':');
    if (inSite && i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // previews are plain http on localhost
  delete out['Strict-Transport-Security'];
  if (out['Content-Security-Policy']) out['Content-Security-Policy'] = out['Content-Security-Policy'].replace(/;\s*upgrade-insecure-requests/, '');
  return out;
}

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173, headers: netlifyHeaders() },
});
