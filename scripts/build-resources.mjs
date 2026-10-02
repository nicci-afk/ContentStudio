// Renders resources/<workspaceId>/src/*.html to PDFs next to the manifest.
// Usage: node scripts/build-resources.mjs <workspaceId>
// Needs Playwright with Chromium (see CLAUDE.md working conventions).
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ws = process.argv[2];
if (!ws) throw new Error('pass a workspace id');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'resources', ws);
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
for (const f of fs.readdirSync(path.join(dir, 'src')).filter((x) => x.endsWith('.html'))) {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(path.join(dir, 'src', f)).href, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const out = path.join(dir, f.replace(/\.html$/, '.pdf'));
  await page.pdf({ path: out, format: 'Letter', printBackground: true, preferCSSPageSize: true });
  console.log('wrote', path.relative(process.cwd(), out), fs.statSync(out).size, 'bytes');
  await page.close();
}
await browser.close();
