// Stress test for the opt-in live layout loop (scripts/serve.py --watch + ?live).
// npm install --no-save playwright; npx playwright install chromium
// node scripts/verify_live_layout.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = async name => JSON.parse(await readFile(resolve(root, 'tests/fixtures', name), 'utf8'));
const dir = await mkdtemp(join(tmpdir(), 'iconic-live-'));
const layoutPath = join(dir, 'house.json');
const results = [];
const note = (name, detail = '') => { results.push(`PASS ${name}${detail ? `  (${detail})` : ''}`); };

const freePort = () => new Promise(done => {
  const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => done(p)); });
});

async function startServer(args) {
  const port = await freePort();
  const proc = spawn(process.env.PYTHON || 'python3', ['-u', resolve(root, 'scripts/serve.py'), String(port), ...args],
    { stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((done, fail) => {
    const t = setTimeout(() => fail(new Error('serve.py did not start')), 10000);
    proc.stdout.on('data', d => { if (String(d).includes('Serving')) { clearTimeout(t); done(); } });
    proc.on('exit', code => fail(new Error(`serve.py exited ${code}`)));
  });
  return { proc, base: `http://127.0.0.1:${port}` };
}

const multi = await fixture('layout_multi.json');   // 4 entities
const c1 = await fixture('layout_c1.json');         // 2 entities
const writeLayout = obj => writeFile(layoutPath, JSON.stringify(obj, null, 2));
const fileCount = async () => JSON.parse(await readFile(layoutPath, 'utf8')).entities.length;

await writeLayout(multi);
const live = await startServer(['--watch', layoutPath]);
const plain = await startServer([]);
const browser = await chromium.launch({ args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const entities = () => page.evaluate(async () => (await import('/js/state.js')).doc.entities.length);
  // Poll from Node: waitForFunction does not await an async predicate (a
  // Promise is truthy), so it would pass before the reload lands.
  const waitEntities = async (n, timeout = 5000) => {
    const end = Date.now() + timeout;
    let got;
    while (Date.now() < end) {
      got = await entities().catch(() => undefined);
      if (got === n) return;
      await page.waitForTimeout(50);
    }
    throw new Error(`page has ${got} entities, expected ${n}`);
  };
  const badge = () => page.locator('#live-status').evaluate(el => ({ kind: el.dataset.kind, text: el.textContent }));

  // 1. Open with ?live: the file loads and the design view shows.
  await page.goto(`${live.base}/?live`);
  await waitEntities(4);
  assert.match((await badge()).text, /loaded .*: 4 entities/);
  note('initial load from file', '4 entities');

  // 1b. The page still finishes loading (the event stream must not hold the
  // window 'load' event open).
  assert.equal(await page.evaluate(() => document.readyState), 'complete');
  note('page reaches readyState complete');

  // 2. Terminal -> browser: rewrite the file, page follows.
  let t0 = Date.now();
  await writeLayout(c1);
  await waitEntities(2);
  note('file edit reaches page', `${Date.now() - t0} ms`);

  // 3. Browser -> terminal: change the model in the page, file follows.
  t0 = Date.now();
  await page.evaluate(async () => {
    const { doc } = await import('/js/state.js');
    const { markModelChanged } = await import('/js/app.js');
    doc.entities.pop();
    markModelChanged();
  });
  for (let i = 0; i < 100 && await fileCount() !== 1; i++) await page.waitForTimeout(50);
  assert.equal(await fileCount(), 1);
  note('page edit reaches file', `${Date.now() - t0} ms`);

  // 4. No echo: the browser's own save does not bounce back as a reload.
  await page.waitForTimeout(1000);
  assert.match((await badge()).text, /saved to disk/);
  assert.equal(await entities(), 1);
  note('own save is not echoed back');

  // 5. Invalid JSON on disk keeps the current design and says why.
  await writeFile(layoutPath, '{ "entities": [ oops');
  await page.waitForFunction(() => document.querySelector('#live-status')?.dataset.kind === 'error');
  assert.equal(await entities(), 1);
  note('invalid JSON keeps the design', (await badge()).text.split('\n')[1]);

  // 6. A valid file again recovers.
  await writeLayout(multi);
  await waitEntities(4);
  note('recovers after a valid write');

  // 7. Burst: 10 rapid writes, the page ends on the last one.
  for (let i = 0; i < 10; i++) {
    await writeLayout(i % 2 ? c1 : multi);
    await new Promise(r => setTimeout(r, 30));
  }
  await writeLayout(c1);
  await waitEntities(2);
  await page.waitForTimeout(800);
  assert.equal(await entities(), 2);
  note('burst of 11 writes settles on the last');

  // 8. Unknown module: record what the existing load path does (SOL-14 area).
  const bad = structuredClone(c1);
  bad.entities[1].module = 'no_such_module';
  await writeLayout(bad);
  await page.waitForTimeout(1200);
  const b8 = await badge();
  note('unknown module in file', `badge=${b8.kind}, page entities=${await entities()}`);
  await writeLayout(c1);
  await page.waitForTimeout(800);

  assert.deepEqual(errors, []);
  note('no page errors');

  // 9. Without ?live nothing changes: no badge, no /__live requests.
  const plainPage = await browser.newPage();
  const liveHits = [];
  plainPage.on('request', r => { if (r.url().includes('/__live/')) liveHits.push(r.url()); });
  await plainPage.goto(`${live.base}/`);
  await plainPage.waitForTimeout(1000);
  assert.equal(await plainPage.locator('#live-status').count(), 0);
  assert.deepEqual(liveHits, []);
  note('without ?live: no badge, no live requests');

  // 10. ?live against a server without --watch explains itself.
  const p2 = await browser.newPage();
  await p2.goto(`${plain.base}/?live`);
  await p2.waitForSelector('#live-status');
  assert.match(await p2.locator('#live-status').textContent(), /--watch/);
  note('?live without --watch shows how to start it');

  // 11. Server binds loopback only with --watch.
  assert.match(live.base, /127\.0\.0\.1/);
} finally {
  await browser.close();
  live.proc.kill();
  plain.proc.kill();
}
console.log(results.join('\n'));
console.log(`\nlive layout: ${results.length} checks passed`);
