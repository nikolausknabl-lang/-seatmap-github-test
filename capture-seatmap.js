import { chromium } from "playwright";

const URL = "https://tickets.staatstheater.bayern/rth.webshop/webticket/eventlist";

async function main() {
  const browser = await chromium.launch({ headless: true });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 1900 },
    deviceScaleFactor: 1,
  });

  page.on("console", msg => console.log("BROWSER:", msg.type(), msg.text()));
  page.on("pageerror", err => console.log("PAGEERROR:", err.message));

  console.log("Öffne Eventliste...");
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.screenshot({ path: "01-home.png", fullPage: true });

  console.log("Klicke ersten sichtbaren Event-Kartenbutton per Koordinate...");
  await page.mouse.click(1000, 510);

  await page.waitForTimeout(5000);
  await page.screenshot({ path: "02-after-coordinate-click.png", fullPage: true });

  const weiter = page.getByText("Weiter", { exact: true });
  if (await weiter.count()) {
    console.log("Session-Seite erkannt -> klicke Weiter");
    await weiter.first().click({ force: true });
    await page.waitForTimeout(6000);
    await page.screenshot({ path: "03-after-weiter.png", fullPage: true });
  }

  console.log("Finale URL:", page.url());
  await page.screenshot({ path: "99-final.png", fullPage: true });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
