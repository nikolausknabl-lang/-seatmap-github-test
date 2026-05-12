import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: {
      width: 1600,
      height: 2600
    }
  });

  page.on("console", msg => {
    console.log("BROWSER:", msg.type(), msg.text());
  });

  page.on("pageerror", err => {
    console.log("PAGEERROR:", err.message);
  });

  console.log("Öffne Eventliste...");

  await page.goto(
    "https://tickets.staatstheater.bayern/rth.webshop/webticket/eventlist",
    {
      waitUntil: "domcontentloaded",
      timeout: 120000
    }
  );

  await page.waitForTimeout(5000);

  await page.screenshot({
    path: "01-home.png",
    fullPage: true
  });

  console.log("Suche echten Event-Tickets-Button...");

  const ticketButtons = page.locator("a, button").filter({
    hasText: /Tickets|Karten|Restkarten/i
  });

  const count = await ticketButtons.count();

  console.log("Gefundene Buttons:", count);

  if (count === 0) {
    throw new Error("Keine Ticket-Buttons gefunden");
  }

  await ticketButtons.nth(0).scrollIntoViewIfNeeded();

  await ticketButtons.nth(0).click({
    force: true
  });

  console.log("Ticket-Button geklickt");

  await page.waitForTimeout(6000);

  await page.screenshot({
    path: "02-after-ticket-click.png",
    fullPage: true
  });

  console.log("Finale URL:", page.url());

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
