import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const START_URL = 'https://tickets.staatstheater.bayern/rth.webshop/';

async function saveDebug(page, name) {
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  await fs.writeFile(`${name}.html`, await page.content(), 'utf8');
  console.log(`Saved ${name}.png and ${name}.html`);
}

async function clickFirstKarten(page) {
  const candidates = [
    page.getByRole('button', { name: /^Karten$/ }).first(),
    page.getByRole('button', { name: /Restkarten|Karten/ }).first(),
    page.locator('button:has-text("Karten"), a:has-text("Karten")').first(),
    page.locator('button:has-text("Restkarten"), a:has-text("Restkarten")').first(),
  ];

  for (const locator of candidates) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      console.log('Clicking first Karten/Restkarten button...');
      await Promise.allSettled([
        page.waitForLoadState('networkidle', { timeout: 20000 }),
        locator.click({ timeout: 10000 }),
      ]);
      return true;
    } catch (err) {
      console.log(`Candidate failed: ${err.message}`);
    }
  }

  return false;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1800 },
    locale: 'de-DE',
  });

  page.setDefaultTimeout(30000);

  console.log(`Opening ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await saveDebug(page, '01-home');

  console.log('Looking for events / Karten buttons...');
  const clicked = await clickFirstKarten(page);

  if (!clicked) {
    console.log('No Karten button found. Saving failure screenshot.');
    await saveDebug(page, '99-no-karten-found');
    await browser.close();
    process.exit(2);
  }

  await page.waitForTimeout(5000);
  await saveDebug(page, '02-after-karten-click');

  const url = page.url();
  console.log(`Current URL after click: ${url}`);

  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  console.log('Body text sample after click:');
  console.log(bodyText.slice(0, 2000));

  await browser.close();
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
