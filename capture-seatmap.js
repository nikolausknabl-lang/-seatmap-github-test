import { chromium } from "playwright";

const URL = "https://tickets.staatstheater.bayern/rth.webshop/webticket/eventlist";

async function main() {
  const browser = await chromium.launch({
    headless: true,
  });

  const page = await browser.newPage({
    viewport: { width: 1280, height: 1900 },
    deviceScaleFactor: 1,
  });

  page.on("console", msg => console.log("BROWSER:", msg.type(), msg.text()));
  page.on("pageerror", err => console.log("PAGEERROR:", err.message));

  console.log("Öffne Eventliste...");
  await page.goto(URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.screenshot({ path: "01-home.png", fullPage: true });

  console.log("Suche klickbaren Karten/Button...");

  const candidates = await page.locator("button, a, input, [role='button']").evaluateAll((els) => {
    return els.map((el, index) => {
      const rect = el.getBoundingClientRect();
      const text = (el.innerText || el.value || el.getAttribute("aria-label") || "").trim();
      return {
        index,
        tag: el.tagName,
        text,
        href: el.href || null,
        type: el.getAttribute("type"),
        visible: rect.width > 0 && rect.height > 0,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    }).filter(x =>
      x.visible &&
      /Karten|Restkarten/i.test(x.text)
    );
  });

  console.log("Kandidaten:", JSON.stringify(candidates, null, 2));

  if (!candidates.length) {
    await page.screenshot({ path: "99-no-button-found.png", fullPage: true });
    throw new Error("Kein Karten-Button gefunden");
  }

  const first = candidates[0];

  console.log("Klicke Kandidat:", first);

  const locator = page.locator("button, a, input, [role='button']").nth(first.index);

  await locator.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);

  try {
    console.log("Versuch 1: normaler Locator-Klick");
    await locator.click({ timeout: 10000 });
  } catch (e) {
    console.log("Normaler Klick fehlgeschlagen:", e.message);
  }

  await page.waitForTimeout(3000);
  await page.screenshot({ path: "02-after-normal-click.png", fullPage: true });

  if (page.url() === URL || page.url().includes("/eventlist")) {
    console.log("Noch auf Eventliste. Versuch 2: force click.");
    try {
      await locator.click({ force: true, timeout: 10000 });
    } catch (e) {
      console.log("Force-Klick fehlgeschlagen:", e.message);
    }

    await page.waitForTimeout(3000);
    await page.screenshot({ path: "03-after-force-click.png", fullPage: true });
  }

  if (page.url() === URL || page.url().includes("/eventlist")) {
    console.log("Noch auf Eventliste. Versuch 3: Mouse-Klick auf Koordinaten.");

    const cx = first.x + first.width / 2;
    const cy = first.y + first.height / 2;

    await page.mouse.move(cx, cy);
    await page.waitForTimeout(500);
    await page.mouse.down();
    await page.waitForTimeout(200);
    await page.mouse.up();

    await page.waitForTimeout(4000);
    await page.screenshot({ path: "04-after-mouse-click.png", fullPage: true });
  }

  if (page.url() === URL || page.url().includes("/eventlist")) {
    console.log("Noch auf Eventliste. Versuch 4: DOM click + MouseEvent.");

    await locator.evaluate((el) => {
      el.scrollIntoView({ block: "center", inline: "center" });
      el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      if (typeof el.click === "function") el.click();
    });

    await page.waitForTimeout(5000);
    await page.screenshot({ path: "05-after-dom-click.png", fullPage: true });
  }

  
  await page.waitForTimeout(3000);

  const weiterButton = page.getByText("Weiter", { exact: true });

  if (await weiterButton.count()) {
    console.log("Session-Seite erkannt -> klicke Weiter");

    await weiterButton.first().click({ force: true });

    await page.waitForTimeout(5000);

    await page.screenshot({
      path: "06-after-weiter.png",
      fullPage: true
    });
  }

console.log("Finale URL:", page.url());
  await page.screenshot({ path: "99-final.png", fullPage: true });

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
