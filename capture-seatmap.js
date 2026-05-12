import { chromium } from "playwright";

async function main() {
  const browser = await chromium.launch({
    headless: true
  });

  const page = await browser.newPage({
    viewport: {
      width: 1800,
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

  console.log("Suche Event-Ticketbutton...");

  const ticketButtons = page.locator("a, button").filter({
    hasText: /Tickets|Karten|Restkarten/i
  });

  const count = await ticketButtons.count();

  console.log("Buttons gefunden:", count);

  if (count < 2) {
    throw new Error("Keine echten Eventbuttons gefunden");
  }

  // Erstes echtes Event-Ticket
  const target = ticketButtons.nth(1);

  await target.scrollIntoViewIfNeeded();

  await target.click({
    force: true
  });

  console.log("Eventbutton geklickt");

  await page.waitForTimeout(10000);

  await page.screenshot({
    path: "02-after-event-click.png",
    fullPage: true
  });

  console.log("Warte auf Seatmap oder Weiter-Button...");

  try {
    await page.locator(".leaflet-container").waitFor({
      timeout: 15000
    });

    console.log("Seatmap erkannt");
  } catch {
    console.log("Keine Seatmap erkannt");
  }

  await page.screenshot({
    path: "03-final.png",
    fullPage: true
  });

  console.log("Finale URL:", page.url());

  await browser.close();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
