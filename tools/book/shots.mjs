// Screenshots of the PgCloud Launcher 1.2.0 features for chapter 7 of the book (read-only: no action is taken).
// Needs the playground running (./RUN.dev.sh --extra) with backup nodes, and Google Chrome.
// usage: EXBACKUP=<ex-backup node> BACKUP=<backup node> node shots.mjs
import puppeteer from 'puppeteer-core';

const BASE = 'http://localhost:8080';
const OUT = new URL('./shots/', import.meta.url).pathname;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--hide-scrollbars'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 2 });
await page.evaluateOnNewDocument(() => localStorage.setItem('pgl-theme', 'dark'));

const shot = async (name, el) => {
  await sleep(500);
  if (el) await el.screenshot({ path: `${OUT}${name}.png` });
  else await page.screenshot({ path: `${OUT}${name}.png` });
  console.log('shot', name);
};
const clickText = async (text, sel = 'button') => {
  for (const h of await page.$$(sel)) {
    const t = await h.evaluate((e) => e.textContent.trim());
    if (t === text) return h.click();
  }
  throw new Error(`no ${sel} "${text}"`);
};

await page.goto(BASE, { waitUntil: 'networkidle2' });
await page.waitForSelector('input[type=password]');
await page.type('input[type=password]', 'launcher-test');
await page.keyboard.press('Enter');
await page.waitForSelector('.react-flow__node', { timeout: 20000 });
await sleep(2500);
await page.click('button[aria-label="Fit view"]').catch(() => undefined);
await sleep(800);
await shot('71-topology-backups');

// header: REC button
await shot('72-header-rec', await page.$('header'));

// inspector of each backup / ex-backup node
const openNode = async (name) => {
  for (const n of await page.$$('.react-flow__node')) {
    const t = await n.evaluate((e) => e.querySelector('.pg-node-name')?.textContent?.trim());
    if (t === name) {
      await n.click();
      await sleep(900);
      return;
    }
  }
  throw new Error(`node ${name} not found`);
};
await openNode(process.env.EXBACKUP ?? 'pg3');
await shot('73-inspector-promoted', await page.$('.inspector'));
await openNode(process.env.BACKUP ?? 'pg4');
await page.evaluate(() => {
  const b = document.querySelector('.inspector-body');
  b.scrollTop = b.scrollHeight;
});
await sleep(400);
await shot('74-inspector-backup', await page.$('.inspector'));
await page.keyboard.press('Escape');

// Audit tab
await clickText('Audit');
await sleep(1500);
for (const h of await page.$$('.history-item')) {
  const t = await h.evaluate((e) => e.textContent);
  if (t.includes('backup + fast-swap')) {
    await h.click();
    break;
  }
}
await sleep(2000);
await shot('75-audit');

// Settings tab
await clickText('Settings');
await sleep(1200);
await shot('76-settings');

// Deploy tab: danger zone
await clickText('Deploy');
await sleep(1200);
const dz = await page.$('.danger-zone');
if (dz) {
  await dz.scrollIntoView();
  await shot('77-danger-zone', dz);
}
await browser.close();
