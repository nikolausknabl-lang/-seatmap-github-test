import { chromium } from 'playwright';
import fs from 'node:fs/promises';

const START_URL = 'https://tickets.staatstheater.bayern/rth.webshop/';

async function saveDebug(page, name) {
  await page.screenshot({ path: `${name}.png`, fullPage: true });
  await fs.writeFile(`${name}.html`, await page.content(), 'utf8');
  await fs.writeFile(`${name}.url.txt`, page.url(), 'utf8');
  console.log(`Saved ${name}.png/.html/.url.txt`);
}

async function dumpButtons(page) {
  const buttons = await page.locator('button, a, input[type="button"], input[type="submit"], [role="button"]').evaluateAll((els) => {
    return els.map((el, index) => {
      const rect = el.getBoundingClientRect();
      return {
        index,
        tag: el.tagName,
        role: el.getAttribute('role'),
        text: (el.innerText || el.textContent || el.getAttribute('value') || '').trim(),
        href: el.getAttribute('href'),
        visible: rect.width > 0 && rect.height > 0,
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    });
  });
  await fs.writeFile('buttons-debug.json.txt', JSON.stringify(buttons, null, 2), 'utf8');
  console.log('Button dump:');
  console.log(JSON.stringify(buttons.slice(0, 30), null, 2));
}

async function clickFirstKarten(page) {
  await dumpButtons(page);

  const locators = [
    page.getByRole('button', { name: /^Karten$/ }).first(),
    page.getByRole('button', { name: /^(Restkarten|Karten)$/ }).first(),
    page.locator('button:has-text("Karten"), a:has-text("Karten"), [role="button"]:has-text("Karten")').first(),
    page.locator('button:has-text("Restkarten"), a:has-text("Restkarten"), [role="button"]:has-text("Restkarten")').first(),
  ];

  for (const locator of locators) {
    try {
      await locator.waitFor({ state: 'visible', timeout: 5000 });
      await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
      const before = page.url();
      console.log(`Trying normal click. URL before: ${before}`);
      await locator.click({ timeout: 10000, force: true });
      await page.waitForTimeout(3000);
      if (page.url() !== before) {
        console.log(`URL changed to ${page.url()}`);
        return true;
      }
      // Still count it as clicked; some apps update without URL change.
      const text = await page.locator('body').innerText().catch(() => '');
      if (/Saalplan|Sitzplan|Platz|Warenkorb|Tickets?|Weiter|Preiskategorie/i.test(text)) {
        console.log('Page content changed after normal click.');
        return true;
      }
    } catch (err) {
      console.log(`Normal click candidate failed: ${err.message}`);
    }
  }

  console.log('Trying DOM click by visible element text...');
  const domResult = await page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('button, a, input[type="button"], input[type="submit"], [role="button"]'));
    const candidate = elements.find((el) => {
      const text = (el.innerText || el.textContent || el.getAttribute('value') || '').trim();
      const rect = el.getBoundingClientRect();
      return /^(Karten|Restkarten)$/.test(text) && rect.width > 0 && rect.height > 0;
    });
    if (!candidate) return { ok: false, reason: 'no candidate' };
    candidate.scrollIntoView({ block: 'center', inline: 'center' });
    candidate.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, cancelable: true, view: window }));
    candidate.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
    candidate.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
    candidate.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return { ok: true, text: (candidate.innerText || candidate.textContent || '').trim() };
  });

  console.log(`DOM click result: ${JSON.stringify(domResult)}`);
  await page.waitForTimeout(5000);
  return domResult.ok;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1800 },
    locale: 'de-DE',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  });

  page.setDefaultTimeout(30000);

  console.log(`Opening ${START_URL}`);
  await page.goto(START_URL, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(2000);
  await saveDebug(page, '01-home');

  console.log('Looking for events / Karten buttons...');
  const clicked = await clickFirstKarten(page);

  await page.waitForTimeout(6000);
  await saveDebug(page, clicked ? '02-after-karten-click' : '99-no-karten-click');

  const bodyText = await page.locator('body').innerText({ timeout: 10000 }).catch(() => '');
  await fs.writeFile('body-after-click.txt', bodyText, 'utf8');
  console.log('Body text sample after click:');
  console.log(bodyText.slice(0, 3000));

  await browser.close();

  if (!clicked) process.exit(2);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
