import { chromium } from "playwright";
import fs from "fs";

const START_URL = "https://tickets.staatstheater.bayern/rth.webshop/";
const MAX_EVENTS = 1;

function csvEscape(value) {
  const s = String(value ?? "");
  return `"${s.replaceAll('"', '""')}"`;
}

async function getTicketButtonCount(page) {
  return await page.evaluate(() => {
    const elements = [...document.querySelectorAll("button, a, [role='button']")];

    return elements
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").trim();
        const style = window.getComputedStyle(el);

        return {
          text,
          x: r.x,
          y: r.y + window.scrollY,
          w: r.width,
          h: r.height,
          visible:
            r.width > 120 &&
            r.height > 30 &&
            r.x > 800 &&
            style.display !== "none" &&
            style.visibility !== "hidden",
        };
      })
      .filter((b) => b.visible && (
  b.text === "Karten" ||
  b.text === "Restkarten" ||
  b.text === "Tickets" ||
  b.text === "Remaining tickets"
))
      .length;
  });
}

async function clickMoreIfPossible(page) {
  const clicked = await page.evaluate(() => {
    const elements = [...document.querySelectorAll("button, a, [role='button']")];

    const candidates = elements
      .map((el) => {
        const text = (el.innerText || el.textContent || "").trim().toLowerCase();
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return { el, text, r, style };
      })
      .filter(({ text, r, style }) => {
        return (
          r.width > 40 &&
          r.height > 20 &&
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          (
            text.includes("mehr") ||
            text.includes("weitere") ||
            text.includes("anzeigen") ||
            text.includes("laden")
          )
        );
      });

    if (!candidates.length) {
      return false;
    }

    const target = candidates[candidates.length - 1].el;
    target.scrollIntoView({ block: "center", inline: "center" });
    target.click();
    return true;
  });

  if (clicked) {
    await page.waitForTimeout(500);
  }

  return clicked;
}

async function loadUntilButtonIndexExists(page, index) {
  let previousCount = -1;
  let maxSeen = 0;
  let noProgressRounds = 0;

  for (let round = 0; round < 40; round++) {
    const count = await getTicketButtonCount(page);
    maxSeen = Math.max(maxSeen, count);

    console.log(`Laderunde ${round + 1}: ${count} Karten-Buttons`);

    if (count > index) {
      return { ok: true, count, maxSeen };
    }

    if (previousCount > 0 && count < previousCount) {
      console.log(`Liste ist zurückgesprungen (${previousCount} → ${count}). Ende erkannt.`);
      return { ok: false, count, maxSeen };
    }

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);

    const clickedMore = await clickMoreIfPossible(page);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(900);

    const afterCount = await getTicketButtonCount(page);

    if (afterCount > maxSeen) {
      maxSeen = afterCount;
      noProgressRounds = 0;
    } else {
      noProgressRounds += 1;
    }

    if (afterCount < count) {
      console.log(`Liste ist zurückgesprungen (${count} → ${afterCount}). Ende erkannt.`);
      return { ok: false, count: afterCount, maxSeen };
    }

    if (!clickedMore && noProgressRounds >= 3) {
      return { ok: afterCount > index, count: afterCount, maxSeen };
    }

    previousCount = afterCount;
  }

  const finalCount = await getTicketButtonCount(page);
  return { ok: finalCount > index, count: finalCount, maxSeen };
}

async function clickEventButtonByIndex(page, index) {
  return await page.evaluate((index) => {
    const elements = [...document.querySelectorAll("button, a, [role='button']")];

    const buttons = elements
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").trim();
        const style = window.getComputedStyle(el);

        return {
          el,
          text,
          x: r.x,
          y: r.y + window.scrollY,
          w: r.width,
          h: r.height,
          visible:
            r.width > 120 &&
            r.height > 30 &&
            r.x > 800 &&
            style.display !== "none" &&
            style.visibility !== "hidden",
        };
      })
      .filter((b) => b.visible && (
  b.text === "Karten" ||
  b.text === "Restkarten" ||
  b.text === "Tickets" ||
  b.text === "Remaining tickets"
))
      .sort((a, b) => a.y - b.y);

    if (!buttons[index]) {
      return { ok: false, count: buttons.length };
    }

    buttons[index].el.scrollIntoView({
      block: "center",
      inline: "center",
    });

    buttons[index].el.click();

    return {
      ok: true,
      count: buttons.length,
      text: buttons[index].text,
      y: buttons[index].y,
    };
  }, index);
}


async function clickEventButtonBySearch(page, search) {
  return await page.evaluate((search) => {
    const elements = [...document.querySelectorAll("button, a, [role='button']")];

    const buttons = elements
      .map((el) => {
        const r = el.getBoundingClientRect();
        const text = (el.innerText || el.textContent || "").trim();
        const style = window.getComputedStyle(el);

        let container = el;
        for (let i = 0; i < 8; i++) {
          if (!container.parentElement) break;
          container = container.parentElement;
          const blockText = (container.innerText || container.textContent || "").trim();

          if (
            blockText.length > 80 &&
            blockText.length < 2500 &&
            /Tickets|Remaining tickets|Karten|Restkarten/i.test(blockText)
          ) {
            break;
          }
        }

        const blockText = (container.innerText || container.textContent || "").trim();

        return {
          el,
          text,
          blockText,
          x: r.x,
          y: r.y + window.scrollY,
          w: r.width,
          h: r.height,
          visible:
            r.width > 120 &&
            r.height > 30 &&
            r.x > 800 &&
            style.display !== "none" &&
            style.visibility !== "hidden",
        };
      })
      .filter((b) => {
        return (
          b.visible &&
          (
            b.text === "Karten" ||
            b.text === "Restkarten" ||
            b.text === "Tickets" ||
            b.text === "Remaining tickets"
          )
        );
      })
      .sort((a, b) => a.y - b.y);

    const titleNeedle = search.title.toLowerCase();
    const venueNeedle = search.venue.toLowerCase();
    const dateNeedles = search.dateNeedles.map((x) => x.toLowerCase());

    const debug = buttons.map((b, index) => ({
      index,
      text: b.text,
      y: b.y,
      blockText: b.blockText.slice(0, 500),
    }));

    const foundIndex = buttons.findIndex((b) => {
      const hay = b.blockText.toLowerCase();
      return (
        (!titleNeedle || hay.includes(titleNeedle)) &&
        (!venueNeedle || hay.includes(venueNeedle)) &&
        (!dateNeedles.length || dateNeedles.some((d) => hay.includes(d)))
      );
    });

    if (foundIndex < 0) {
      return {
        ok: false,
        count: buttons.length,
        debug,
      };
    }

    const target = buttons[foundIndex];

    target.el.scrollIntoView({
      block: "center",
      inline: "center",
    });

    target.el.click();

    return {
      ok: true,
      count: buttons.length,
      index: foundIndex,
      text: target.text,
      y: target.y,
      blockText: target.blockText.slice(0, 500),
    };
  }, search);
}

function detectVenue(pageText) {
  if (pageText.includes("Marstall")) return "marstall";
  if (pageText.includes("Cuvilli")) return "cuv";
  if (pageText.includes("Residenztheater")) return "resi";
  return "other";
}

function extractTitle(pageText) {
  const lines = pageText
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const ignored = new Set([
    "Karten",
    "Restkarten",
    "Warenkorb",
    "Saalplanbuchung",
    "Platzvorschlag",
    "alle Termine",
    "Deutsch",
    "English",
  ]);

  for (const line of lines) {
    if (ignored.has(line)) continue;
    if (line.includes("€")) continue;
    if (line.length < 3) continue;
    if (line.length > 90) continue;
    if (line.match(/^\d{1,2}\.\d{1,2}\./)) continue;
    return line;
  }

  return "";
}

async function prepareSeatmap(page, venue) {
  if (venue === "marstall") {
    console.log("Marstall erkannt → kein Zoom");
    return;
  }

  console.log("Klicke Zoom + ...");

  const zoomPlus = page.locator(
    ".leaflet-control-zoom-in, a[title='Zoom in'], a:has-text('+')"
  );

  await zoomPlus.first().waitFor({
    state: "visible",
    timeout: 15000,
  });

  // Cuv rendert empfindlicher: weniger Zoom, längere Stabilisierung
  const zoomSteps = venue === "cuv" ? 2 : 4;

  for (let z = 0; z < zoomSteps; z++) {
    await zoomPlus.first().click({
      force: true,
    });

    await page.waitForTimeout(700);
  }

  if (venue === "cuv") {
    console.log("Cuv: Repaint durch kleinen Drag triggern");

    await page.mouse.move(700, 700);
    await page.mouse.down();
    await page.mouse.move(735, 700, { steps: 10 });
    await page.mouse.up();

    await page.waitForTimeout(500);
  } else {
    await page.waitForTimeout(3000);
  }

  let dragDistance = 130;
  if (venue === "resi") dragDistance = 260;
  if (venue === "cuv") dragDistance = 180;

  console.log(`Verschiebe Saalplan nach rechts (${dragDistance}px)`);

  await page.mouse.move(390, 820);
  await page.mouse.down();
  await page.mouse.move(390 + dragDistance, 820, { steps: 25 });
  await page.mouse.up();

  await page.waitForTimeout(400);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    
  });

  const context = await browser.newContext({
    viewport: {
      width: 1600,
      height: 1200,
    },
    deviceScaleFactor: 4,
  });

  const page = await context.newPage();

  const rows = [
    ["index", "source_index", "file", "venue", "button", "title", "url"].map(csvEscape).join(",")
  ];

  let saved = 0;

  for (let i = 0; i < MAX_EVENTS; i++) {
    console.log(`\n=== Vorstellung ${i + 1} ===`);

    await page.goto(START_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(1600);

    
    await page.screenshot({
      path: "debug-before-load-buttons.png",
      fullPage: true,
    });

    console.log("DEBUG SCREENSHOT GESPEICHERT: debug-before-load-buttons.png");

    const loaded = await loadUntilButtonIndexExists(page, i);

    if (!loaded.ok) {
      console.log(`Keine weitere Karten-Kachel. Max gesehen: ${loaded.maxSeen}`);
      break;
    }

    const clickResult = await clickEventButtonBySearch(page, {
      title: "Bernarda Albas Haus",
      venue: "Cuvilli",
      dateNeedles: ["15.05.", "May 15"]
    });

    console.log("Such-Klick-Ergebnis:", JSON.stringify(clickResult, null, 2));

    if (!clickResult.ok) {
      await page.screenshot({
        path: "98-search-not-found.png",
        fullPage: true,
      });

      throw new Error(`Gesuchte Vorstellung nicht gefunden. Buttons: ${clickResult.count}`);
    }

    
await page.waitForTimeout(4000);

await page.screenshot({
  path: "debug-eventlist.png",
  fullPage: true
});

console.log("DEBUG SCREENSHOT GESPEICHERT");


    const pageText = await page.locator("body").innerText();
    const venue = detectVenue(pageText);

    console.log("Venue:", venue);

    if (!["resi", "cuv", "marstall"].includes(venue)) {
      console.log("Andere Spielstätte → überspringe");
      continue;
    }

    await prepareSeatmap(page, venue);

    saved += 1;

    const filename = `seatmap-${String(saved).padStart(3, "0")}-${venue}.png`;
    const title = extractTitle(pageText);
    const url = page.url();

    console.log("Versuche Seatmap-Container zu vergrößern...");

    await page.evaluate(() => {
      const map = document.querySelector(".leaflet-container");
      if (!map) return;

      document.querySelectorAll("header, nav, footer").forEach((el) => {
        el.style.display = "none";
      });

      let el = map;
      for (let i = 0; i < 10 && el; i++) {
        el.style.maxWidth = "none";
        el.style.maxHeight = "none";
        el.style.width = "4000px";
        el.style.height = "3000px";
        el.style.overflow = "visible";
        el = el.parentElement;
      }

      map.style.width = "4000px";
      map.style.height = "3000px";

      window.dispatchEvent(new Event("resize"));

      setTimeout(() => {
        window.dispatchEvent(new Event("resize"));
      }, 500);

      if (window.L) {
        document.querySelectorAll(".leaflet-container").forEach((container) => {
          const id = container._leaflet_id;
          if (!id) return;
        });
      }
    });

    console.log("Warte nach Layout-Vergrößerung auf Leaflet-Tiles ...");
    await page.waitForTimeout(10000);

    await page.screenshot({
      path: "debug-expanded-layout.png",
      fullPage: true,
    });

    const debugAssets = await page.evaluate(() => {
      const svgs = [...document.querySelectorAll(".leaflet-container svg, svg")].map((svg, index) => ({
        index,
        outerHTML: svg.outerHTML,
        width: svg.getBoundingClientRect().width,
        height: svg.getBoundingClientRect().height,
      }));

      const canvases = [...document.querySelectorAll(".leaflet-container canvas, canvas")].map((canvas, index) => {
        try {
          return {
            index,
            ok: true,
            width: canvas.width,
            height: canvas.height,
            dataUrl: canvas.toDataURL("image/png"),
          };
        } catch (e) {
          return {
            index,
            ok: false,
            width: canvas.width,
            height: canvas.height,
            error: String(e),
            dataUrl: null,
          };
        }
      });

      return { svgs, canvases };
    });

    
    const layerDebug = await page.evaluate(() => {
      const root = document.querySelector(".leaflet-container");
      if (!root) return [];

      return [...root.querySelectorAll("*")].map((el, index) => {
        const r = el.getBoundingClientRect();
        const cs = window.getComputedStyle(el);

        return {
          index,
          tag: el.tagName,
          className: String(el.className || ""),
          id: el.id || "",
          width: Math.round(r.width),
          height: Math.round(r.height),
          x: Math.round(r.x),
          y: Math.round(r.y),
          opacity: cs.opacity,
          display: cs.display,
          visibility: cs.visibility,
          position: cs.position,
          zIndex: cs.zIndex,
          background: cs.backgroundColor,
          pointerEvents: cs.pointerEvents,
          text: (el.innerText || el.textContent || "").trim().slice(0, 120),
          htmlStart: el.outerHTML.slice(0, 300),
        };
      }).filter(x => x.width > 0 || x.height > 0 || x.text);
    });

    fs.writeFileSync("debug-leaflet-layers.json", JSON.stringify(layerDebug, null, 2), "utf8");
    console.log("Leaflet-Layer gedumpt:", layerDebug.length);

console.log("SVGs gefunden:", debugAssets.svgs.length);
    console.log("Canvases gefunden:", debugAssets.canvases.length);

    fs.writeFileSync("debug-seatmap-assets.json", JSON.stringify({
      svgs: debugAssets.svgs.map(s => ({ index: s.index, width: s.width, height: s.height, length: s.outerHTML.length })),
      canvases: debugAssets.canvases.map(c => ({ index: c.index, ok: c.ok, width: c.width, height: c.height, error: c.error || null }))
    }, null, 2), "utf8");

    for (const svg of debugAssets.svgs) {
      fs.writeFileSync(`debug-seatmap-${svg.index}.svg`, svg.outerHTML, "utf8");
    }

    for (const canvas of debugAssets.canvases) {
      if (!canvas.ok || !canvas.dataUrl) continue;
      const base64 = canvas.dataUrl.split(",")[1];
      fs.writeFileSync(`debug-canvas-${canvas.index}.png`, Buffer.from(base64, "base64"));
    }

    const mapLocator = page.locator(".leaflet-container").first();

    const mainCanvas = debugAssets.canvases.find((c) => c.ok && c.dataUrl);

    if (mainCanvas?.dataUrl) {
      const base64 = mainCanvas.dataUrl.split(",")[1];
      fs.writeFileSync(filename, Buffer.from(base64, "base64"));
      console.log(`Direkter Canvas-Export gespeichert: ${filename}`);
    } else {
      await mapLocator.screenshot({
        path: filename,
      });

      console.log(`Fallback Seatmap-Element-Screenshot gespeichert: ${filename}`);
    }

    rows.push([
      saved,
      i + 1,
      filename,
      venue,
      clickResult.text,
      title,
      url,
    ].map(csvEscape).join(","));
  }

  fs.writeFileSync("seatmap-meta.csv", rows.join("\n"), "utf8");
  console.log("\nMeta gespeichert: seatmap-meta.csv");
  console.log(`Screenshots gespeichert: ${saved}`);

  await browser.close();
})();
