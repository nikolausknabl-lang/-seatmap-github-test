import { chromium } from 'playwright';

const URL = 'https://tickets.staatstheater.bayern/rth.webshop/';

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-blink-features=AutomationControlled'
    ]
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
    deviceScaleFactor: 1,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin'
  });

  page.setDefaultTimeout(30000);

  console.log(`Opening ${URL}`);
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(5000);

  console.log('Page title:', await page.title());
  console.log('Current URL:', page.url());

  await page.screenshot({ path: 'seatmap-test-home.png', fullPage: true });

  // Minimaler Klick-Test: versucht, eine sichtbare Karten-/Weiter-Schaltfläche zu finden.
  const candidateTexts = ['Karten', 'Restkarten', 'Weiter'];
  for (const text of candidateTexts) {
    const locator = page.getByText(text, { exact: false }).first();
    const count = await locator.count().catch(() => 0);
    if (count > 0) {
      console.log(`Found candidate text: ${text}`);
      await locator.screenshot({ path: `seatmap-test-found-${text}.png` }).catch(() => undefined);
      break;
    }
  }

  await browser.close();
  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
