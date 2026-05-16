import { chromium } from "playwright";
import fs from "fs";
import path from "path";

const START_URL = "https://tickets.staatstheater.bayern/rth.webshop/";
const MAX_EVENTS = Number(process.env.MAX_EVENTS || 999);
const OUTPUT_ROOT = path.join(process.cwd(), "seatmap-output");
const RUN_TIMESTAMP = new Date()
  .toISOString()
  .replace("T", "_")
  .replace(/\..+$/, "")
  .replace(/:/g, "-");
const OUTPUT_DIR = path.join(OUTPUT_ROOT, RUN_TIMESTAMP);

function isTicketText(text) {
  return /^(Karten|Restkarten|Tickets|Remaining tickets)$/i.test(String(text || "").trim());
}

function isSoldOutText(text) {
  return /ausverkauft|sold out|verkauft/i.test(String(text || ""));
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function outputPath(filename) {
  return path.join(OUTPUT_DIR, filename);
}

function writeMarkerFile(filenameBase, contents) {
  const txtPath = outputPath(`${filenameBase}.txt`);
  fs.writeFileSync(txtPath, `${contents}\n`);
  return txtPath;
}

async function waitForEventCountIncrease(page, previousCount, timeout = 12000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const currentCards = await getEventCards(page);
    if (currentCards.length > previousCount) {
      return currentCards;
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function waitForSeatmapReady(page, timeout = 12000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const state = await page.evaluate(() => {
      const leaflet = !!document.querySelector(".leaflet-container");
      const canvas = !!document.querySelector(".leaflet-container canvas, canvas");
      return { leaflet, canvas };
    });

    if (state.leaflet || state.canvas) {
      return true;
    }

    await page.waitForTimeout(250);
  }

  return false;
}

async function waitForSeatmapOrPreview(page, timeout = 12000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeout) {
    const state = await page.evaluate(() => {
      function normalize(text) {
        return String(text || "").replace(/\s+/g, " ").trim();
      }

      function findPreviewRoot() {
        const candidates = [...document.querySelectorAll("section, article, div, main, form")]
          .filter((el) => {
            const text = normalize(el.innerText || el.textContent || "");
            const rect = el.getBoundingClientRect();
            if (rect.width < 200 || rect.height < 120) return false;
            return /Saalplan-Vorschau|Seating chart preview/i.test(text) && /Platzgruppe/i.test(text);
          })
          .sort((a, b) => {
            const rectA = a.getBoundingClientRect();
            const rectB = b.getBoundingClientRect();
            return rectA.width * rectA.height - rectB.width * rectB.height;
          });

        return candidates[0] || null;
      }

      const bodyText = document.body?.innerText || "";
      const hasLeaflet = !!document.querySelector(".leaflet-container");
      const hasCanvas = !!document.querySelector(".leaflet-container canvas, canvas");
      const hasPreviewHeading = /Saalplan-Vorschau|Seating chart preview/i.test(bodyText);
      const hasPlatzgruppe = /Platzgruppe/i.test(bodyText);
      const previewRoot = findPreviewRoot();

      return {
        hasLeaflet,
        hasCanvas,
        hasPreview: !!previewRoot || (hasPreviewHeading && hasPlatzgruppe),
      };
    });

    if (state.hasLeaflet || state.hasCanvas) {
      return { mode: "seatmap" };
    }

    if (state.hasPreview) {
      return { mode: "preview" };
    }

    await page.waitForTimeout(250);
  }

  return { mode: "none" };
}

async function openStartPage(page) {
  await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function returnToEventList(page) {
  try {
    await page.goBack({ waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(400);
  } catch (error) {
    console.log("goBack fehlgeschlagen, lade Startseite neu");
    await openStartPage(page);
  }
}

async function ensureEventListReady(page, index) {
  let cards = await getEventCards(page);

  if (!cards.length) {
    await openStartPage(page);
    cards = await getEventCards(page);
  }

  if (cards.length <= index) {
    cards = await ensureEventIndexLoaded(page, index);
  }

  return cards;
}







async function clickMoreIfPossible(page) {
  const beforeCards = await getEventCards(page);

  const btn = page.locator("button.evt-lm-btn").last();

  if (await btn.count() === 0) {
    console.log("Kein Mehr-Button gefunden");
    return false;
  }

  await btn.scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);

  console.log(`Vor Mehr-Klick: ${beforeCards.length} Vorstellungen`);

  await btn.click({ force: true });
  const afterCards = await waitForEventCountIncrease(page, beforeCards.length, 15000);

  if (afterCards) {
    console.log(`Nach Mehr-Klick: ${afterCards.length}`);
    return true;
  }

  console.log("Mehr-Klick brachte keine neuen Vorstellungen");
  return false;
}

async function getEventCards(page) {
  return await page.evaluate(() => {
    function normalize(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    function normalizeComparableTitle(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function venueKeyFromText(text) {
      if (/Marstall Salon/i.test(text)) return "marstall-salon";
      if (/Zur schönen Aussicht|Schöne Aussicht|Zur schoenen Aussicht|Schoene Aussicht/i.test(text)) return "aussicht";
      if (/Marstall/i.test(text)) return "marstall";
      if (/Cuvilli/i.test(text)) return "cuv";
      if (/Residenztheater/i.test(text)) return "resi";
      return "other";
    }

    function findCardContainer(el) {
      let container = el;
      for (let i = 0; i < 10 && container; i++) {
        const blockText = normalize(container.innerText || container.textContent || "");
        const hasDate = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/.test(blockText) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./i.test(blockText);
        const hasTime = /\b\d{1,2}:\d{2}\b/.test(blockText);
        const hasVenue = /Residenztheater|Cuvilli|Marstall/i.test(blockText);
        const hasStatus = /Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out|verkauft/i.test(blockText);

        if (blockText.length > 40 && blockText.length < 450 && hasStatus && (hasDate || hasTime) && hasVenue) {
          return container;
        }

        container = container.parentElement;
      }
      return null;
    }

    function extractEventMeta(blockText, venueKey) {
      const text = normalize(blockText || "");

      const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      const timeMatch = text.match(/(\d{1,2}:\d{2})/);

      let beforeDate = dateMatch ? text.slice(0, dateMatch.index).trim() : text;
      beforeDate = beforeDate
        .replace(/\b(Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out)\b/gi, "")
        .trim();

      const subtitleMarkers = [
        " Ein Spiel ",
        " Nach ",
        " Von ",
        " nach ",
        " von ",
        " Based ",
        " A play ",
      ];

      let title = beforeDate;
      for (const marker of subtitleMarkers) {
        const pos = title.indexOf(marker);
        if (pos > 0) {
          title = title.slice(0, pos).trim();
        }
      }

      title = title.replace(/\s+/g, " ").trim() || "Vorstellung";

      const date = dateMatch
        ? `${dateMatch[3]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`
        : "date-unknown";

      const time = timeMatch ? timeMatch[1].replace(":", "-") : "time-unknown";

      return {
        title,
        normalizedTitle: normalizeComparableTitle(title),
        date,
        time,
        venue: venueKey || "venue-unknown",
      };
    }

    const statusElements = [...document.querySelectorAll("button, a, [role='button'], span, div, p")]
      .map((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return { el, text, r, style };
      })
      .filter(({ text, r, style }) => {
        if (!text) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (r.width <= 0 || r.height <= 0) return false;
        return /^(Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out)$|\bAusverkauft\b|\bverkauft\b/i.test(text);
      });

    const byKey = new Map();

    for (const item of statusElements) {
      const container = findCardContainer(item.el);
      if (!container) continue;

      const cr = container.getBoundingClientRect();
      const blockText = normalize(container.innerText || container.textContent || "");
      const statusText = item.text;
      const isSoldOut = /ausverkauft|sold out/i.test(blockText) || /ausverkauft|sold out/i.test(statusText);
      const hasTickets = /\b(Karten|Restkarten|Tickets|Remaining tickets)\b/i.test(blockText) && !isSoldOut;
      const venue = venueKeyFromText(blockText);
      const meta = extractEventMeta(blockText, venue);

      const key = blockText.slice(0, 300);
      if (!byKey.has(key)) {
        byKey.set(key, {
          blockText,
          statusText,
          isSoldOut,
          hasTickets,
          venue,
          meta,
          y: cr.top + window.scrollY,
        });
      } else {
        const prev = byKey.get(key);
        prev.isSoldOut = prev.isSoldOut || isSoldOut;
        prev.hasTickets = prev.hasTickets || hasTickets;
      }
    }

    return [...byKey.values()]
      .sort((a, b) => a.y - b.y)
      .map((card, index) => ({ ...card, index }));
  });
}


async function ensureEventIndexLoaded(page, index) {
  while (true) {
    const cards = await getEventCards(page);

    console.log(`Aktuell geladen: ${cards.length}, benötigt: ${index + 1}`);

    if (cards.length > index) {
      return cards;
    }

    const clicked = await clickMoreIfPossible(page);

    if (!clicked) {
      console.log("Kein weiteres Nachladen möglich");
      return cards;
    }
  }
}

async function loadAllEventCards(page) {
  let lastCount = -1;
  let stableRounds = 0;

  for (let round = 0; round < 60; round++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(700);

    const clicked = await clickMoreIfPossible(page);
    const cards = await getEventCards(page);

    console.log(`Laderunde ${round + 1}: ${cards.length} Vorstellungen gefunden${clicked ? " (+ mehr geklickt)" : ""}`);

    if (cards.length === lastCount && !clicked) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
    }

    if (stableRounds >= 3) return cards;
    lastCount = cards.length;
  }

  return await getEventCards(page);
}


async function clickEventCardByIndex(page, index, expectedMeta) {
  return await page.evaluate(({ index, expectedMeta }) => {
    function normalize(s) {
      return String(s || "").replace(/\s+/g, " ").trim();
    }

    function normalizeComparableTitle(value) {
      return String(value || "")
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }

    function strongTitleMatch(a, b) {
      const na = normalizeComparableTitle(a);
      const nb = normalizeComparableTitle(b);
      if (!na || !nb) return false;
      if (na === nb) return true;
      if (na.length >= 12 && nb.length >= 12) {
        return na.includes(nb) || nb.includes(na);
      }
      return false;
    }

    function venueKeyFromText(text) {
      if (/Marstall Salon/i.test(text)) return "marstall-salon";
      if (/Zur schönen Aussicht|Schöne Aussicht|Zur schoenen Aussicht|Schoene Aussicht/i.test(text)) return "aussicht";
      if (/Marstall/i.test(text)) return "marstall";
      if (/Cuvilli/i.test(text)) return "cuv";
      if (/Residenztheater/i.test(text)) return "resi";
      return "other";
    }

    function findCardContainer(el) {
      let container = el;

      for (let i = 0; i < 10 && container; i++) {
        const blockText = normalize(container.innerText || container.textContent || "");
        const hasDate = /\b\d{1,2}\.\d{1,2}\.\d{4}\b/.test(blockText) || /\b(Mon|Tue|Wed|Thu|Fri|Sat|Sun)\./i.test(blockText);
        const hasTime = /\b\d{1,2}:\d{2}\b/.test(blockText);
        const hasVenue = /Residenztheater|Cuvilli|Marstall/i.test(blockText);
        const hasStatus = /Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out|verkauft/i.test(blockText);

        if (blockText.length > 40 && blockText.length < 450 && hasStatus && (hasDate || hasTime) && hasVenue) {
          return container;
        }

        container = container.parentElement;
      }

      return null;
    }

    function extractEventMeta(blockText, venueKey) {
      const text = normalize(blockText || "");
      const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
      const timeMatch = text.match(/(\d{1,2}:\d{2})/);

      let beforeDate = dateMatch ? text.slice(0, dateMatch.index).trim() : text;
      beforeDate = beforeDate
        .replace(/\b(Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out)\b/gi, "")
        .trim();

      const subtitleMarkers = [
        " Ein Spiel ",
        " Nach ",
        " Von ",
        " nach ",
        " von ",
        " Based ",
        " A play ",
      ];

      let title = beforeDate;
      for (const marker of subtitleMarkers) {
        const pos = title.indexOf(marker);
        if (pos > 0) {
          title = title.slice(0, pos).trim();
        }
      }

      title = title.replace(/\s+/g, " ").trim() || "Vorstellung";

      const date = dateMatch
        ? `${dateMatch[3]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`
        : "date-unknown";

      const time = timeMatch ? timeMatch[1].replace(":", "-") : "time-unknown";

      return {
        title,
        normalizedTitle: normalizeComparableTitle(title),
        date,
        time,
        venue: venueKey || "venue-unknown",
      };
    }

    const statusElements = [...document.querySelectorAll("button, a, [role='button'], span, div, p")]
      .map((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return { el, text, r, style };
      })
      .filter(({ text, r, style }) => {
        if (!text) return false;
        if (style.display === "none" || style.visibility === "hidden") return false;
        if (r.width <= 0 || r.height <= 0) return false;

        return /^(Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out)$|\bAusverkauft\b|\bverkauft\b/i.test(text);
      });

    const cards = [];

    for (const item of statusElements) {
      const container = findCardContainer(item.el);
      if (!container) continue;

      const cr = container.getBoundingClientRect();
      const blockText = normalize(container.innerText || container.textContent || "");

      cards.push({
        container,
        blockText,
        isSoldOut: /ausverkauft|sold out/i.test(blockText),
        hasTickets: /\b(Karten|Restkarten|Tickets|Remaining tickets)\b/i.test(blockText) && !/ausverkauft|sold out/i.test(blockText),
        venue: venueKeyFromText(blockText),
        meta: extractEventMeta(blockText, venueKeyFromText(blockText)),
        y: cr.top + window.scrollY,
      });
    }

    cards.sort((a, b) => a.y - b.y);
    const card = cards.find((currentCard) => {
      return (
        currentCard.meta.date === expectedMeta.date &&
        currentCard.meta.time === expectedMeta.time &&
        currentCard.venue === expectedMeta.venue &&
        strongTitleMatch(currentCard.meta.title, expectedMeta.title)
      );
    });

    if (!card) {
      return {
        ok: false,
        reason: "expected_event_not_found",
        count: cards.length,
        expectedMeta,
      };
    }

    if (card.isSoldOut || !card.hasTickets) {
      return {
        ok: false,
        reason: "soldout",
        count: cards.length,
        blockText: card.blockText,
        venue: card.venue
      };
    }

    const buttons = [...card.container.querySelectorAll("button, a, [role='button']")]
      .map((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        const r = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);

        return { el, text, r, style };
      })
      .filter(({ text, r, style }) => {
        return (
          /^(Karten|Restkarten|Tickets|Remaining tickets)$/i.test(text) &&
          r.width > 40 &&
          r.height > 20 &&
          style.display !== "none" &&
          style.visibility !== "hidden"
        );
      });

    if (!buttons.length) {
      return {
        ok: false,
        reason: "no_ticket_button",
        count: cards.length,
        blockText: card.blockText,
        venue: card.venue,
        matchedMeta: card.meta,
      };
    }

    const target = buttons[buttons.length - 1].el;
    const href =
      target.getAttribute("href") ||
      target.closest("a")?.getAttribute("href") ||
      target.dataset?.href ||
      null;

    if (!href) {
      target.scrollIntoView({
        block: "center",
        inline: "center"
      });

      target.click();
    }

    return {
      ok: true,
      count: cards.length,
      blockText: card.blockText,
      venue: card.venue,
      matchedMeta: card.meta,
      href,
      clicked: !href,
    };
  }, { index, expectedMeta });
}

function detectVenue(pageText) {
  if (/Marstall Salon/i.test(pageText)) return "marstall-salon";
  if (/Zur schönen Aussicht|Schöne Aussicht|Zur schoenen Aussicht|Schoene Aussicht/i.test(pageText)) return "aussicht";
  if (/Marstall/i.test(pageText)) return "marstall";
  if (/Cuvilli/i.test(pageText)) return "cuv";
  if (/Residenztheater/i.test(pageText)) return "resi";
  return "other";
}

function safeFilePart(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue")
    .replace(/Ä/g, "Ae")
    .replace(/Ö/g, "Oe")
    .replace(/Ü/g, "Ue")
    .replace(/ß/g, "ss")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "unknown";
}





function extractEventMeta(blockText, venueKey) {
  const text = String(blockText || "").replace(/\s+/g, " ").trim();

  const dateMatch = text.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  const timeMatch = text.match(/(\d{1,2}:\d{2})/);

  let beforeDate = dateMatch ? text.slice(0, dateMatch.index).trim() : text;

  beforeDate = beforeDate
    .replace(/\b(Karten|Restkarten|Tickets|Remaining tickets|Ausverkauft|Sold out)\b/gi, "")
    .trim();

  const subtitleMarkers = [
    " Ein Spiel ",
    " Nach ",
    " Von ",
    " nach ",
    " von ",
    " Based ",
    " A play ",
  ];

  let title = beforeDate;

  for (const marker of subtitleMarkers) {
    const pos = title.indexOf(marker);
    if (pos > 0) {
      title = title.slice(0, pos).trim();
    }
  }

  title = title.replace(/\s+/g, " ").trim();

  if (!title) {
    title = "Vorstellung";
  }

  const date = dateMatch
    ? `${dateMatch[3]}-${dateMatch[2].padStart(2, "0")}-${dateMatch[1].padStart(2, "0")}`
    : "date-unknown";

  const time = timeMatch ? timeMatch[1].replace(":", "-") : "time-unknown";

  return {
    title,
    date,
    time,
    venue: venueKey || "venue-unknown",
  };
}


function isPastCaptureWindow(meta) {
  if (!meta.date || !meta.time) return false;
  if (meta.date === "date-unknown" || meta.time === "time-unknown") return false;

  const [year, month, day] = meta.date.split("-").map(Number);
  const [hour, minute] = meta.time.replace("-", ":").split(":").map(Number);

  const start = new Date(year, month - 1, day, hour, minute, 0, 0);
  const cutoff = new Date(start.getTime() - 120 * 60 * 1000);
  const now = new Date();

  return now > cutoff;
}

async function prepareSeatmap(page, venue) {
  console.log("Klicke Zoom + ...");

  const zoomPlus = page.locator(".leaflet-control-zoom-in, a[title='Zoom in'], a:has-text('+')");

  await zoomPlus.first().waitFor({ state: "visible", timeout: 15000 });

  const zoomSteps = 4;

  for (let z = 0; z < zoomSteps; z++) {
    await zoomPlus.first().click({ force: true });
    await page.waitForTimeout(350);
  }

  if (venue === "cuv") {
    console.log("Cuv: Repaint durch kleinen Drag triggern");
    await page.mouse.move(700, 700);
    await page.mouse.down();
    await page.mouse.move(735, 700, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  } else {
    await page.waitForTimeout(900);
  }

  let dragDistance = 130;
  if (venue === "resi") dragDistance = 260;
  if (venue === "cuv") dragDistance = 180;

  console.log(`Verschiebe Saalplan nach rechts (${dragDistance}px)`);

  await page.mouse.move(390, 820);
  await page.mouse.down();
  await page.mouse.move(390 + dragDistance, 820, { steps: 25 });
  await page.mouse.up();

  await page.waitForTimeout(500);
}

async function saveSeatmapImage(page, filename, options = {}) {
  const { returnAfter = true } = options;
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
    setTimeout(() => window.dispatchEvent(new Event("resize")), 500);
  });

  console.log("Warte nach Layout-Vergrößerung auf Leaflet-Tiles ...");
  await waitForSeatmapReady(page, 6000);
  await page.waitForTimeout(1200);

  const debugAssets = await page.evaluate(() => {
    const canvases = [...document.querySelectorAll(".leaflet-container canvas, canvas")].map((canvas, index) => {
      try {
        return { index, ok: true, width: canvas.width, height: canvas.height, dataUrl: canvas.toDataURL("image/png") };
      } catch (e) {
        return { index, ok: false, width: canvas.width, height: canvas.height, error: String(e), dataUrl: null };
      }
    });
    return { canvases };
  });

  const mainCanvas = debugAssets.canvases.find((c) => c.ok && c.dataUrl);

  if (mainCanvas?.dataUrl) {
    const base64 = mainCanvas.dataUrl.split(",")[1];
    fs.writeFileSync(filename, Buffer.from(base64, "base64"));
    console.log(`Direkter Canvas-Export gespeichert: ${filename}`);

    if (returnAfter) {
      console.log("Zurück zur Veranstaltungsliste ...");
      await returnToEventList(page);
    }
  } else {
    await page.locator(".leaflet-container").first().screenshot({ path: filename });
    console.log(`Fallback Seatmap-Element-Screenshot gespeichert: ${filename}`);

    if (returnAfter) {
      console.log("Zurück zur Veranstaltungsliste ...");
      await returnToEventList(page);
    }
  }
}

async function renderImageUrlToPng(page, imageUrl, filename) {
  const renderPage = await page.context().newPage();

  try {
    await renderPage.setViewportSize({ width: 1200, height: 1200 });
    await renderPage.setContent(`
      <!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <style>
            html, body {
              margin: 0;
              padding: 0;
              background: transparent;
              width: max-content;
              height: max-content;
              overflow: hidden;
            }
            #seatmap {
              display: block;
              margin: 0;
              padding: 0;
              image-rendering: auto;
            }
          </style>
        </head>
        <body>
          <img id="seatmap" alt="seatmap preview" />
        </body>
      </html>
    `);

    await renderPage.evaluate((src) => {
      const image = document.getElementById("seatmap");
      image.src = src;
    }, imageUrl);

    await renderPage.waitForFunction(() => {
      const image = document.getElementById("seatmap");
      return image && image.complete && image.naturalWidth > 0 && image.naturalHeight > 0;
    }, { timeout: 15000 });

    const dimensions = await renderPage.evaluate(() => {
      const image = document.getElementById("seatmap");
      return {
        width: image.naturalWidth,
        height: image.naturalHeight,
      };
    });

    await renderPage.setViewportSize({
      width: Math.max(1, Math.ceil(dimensions.width)),
      height: Math.max(1, Math.ceil(dimensions.height)),
    });

    await renderPage.locator("#seatmap").screenshot({ path: filename });
  } finally {
    await renderPage.close().catch(() => {});
  }
}

async function tryOpenPreviewAsset(page) {
  const hasPreviewClickTarget = await page.evaluate(() => {
    function normalize(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    const root = [...document.querySelectorAll("section, article, div, main, form")]
      .filter((el) => {
        const text = normalize(el.innerText || el.textContent || "");
        const rect = el.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 120) return false;
        return /Saalplan-Vorschau|Seating chart preview/i.test(text) && /Platzgruppe/i.test(text);
      })
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectA.width * rectA.height - rectB.width * rectB.height;
      })[0];

    if (!root) return false;

    const clickable = root.querySelector("a img, a svg, a canvas, [role='button'] img, [role='button'] svg, [role='button'] canvas");
    const target = clickable?.closest("a, button, [role='button']") || null;
    if (!target) return false;

    const label = normalize(target.innerText || target.textContent || "");
    if (/^\+|-|In den Warenkorb|Add to shopping cart|Internet|Erm[aä]ßigungen|More ticket options$/i.test(label)) {
      return false;
    }

    target.setAttribute("data-codex-preview-click-target", "true");
    return true;
  });

  if (!hasPreviewClickTarget) {
    return false;
  }

  try {
    await page.locator("[data-codex-preview-click-target='true']").first().click({ force: true });
    await page.waitForLoadState("networkidle", { timeout: 3000 }).catch(() => {});
    await page.waitForTimeout(600);
    return true;
  } catch {
    return false;
  }
}

async function savePreviewSeatmapImage(page, filename) {
  console.log("Extrahiere Saalplan-Vorschau ...");
  await tryOpenPreviewAsset(page);

  const previewData = await page.evaluate(() => {
    function normalize(text) {
      return String(text || "").replace(/\s+/g, " ").trim();
    }

    function findPreviewRoot() {
      const candidates = [...document.querySelectorAll("section, article, div, main, form")]
        .filter((el) => {
          const text = normalize(el.innerText || el.textContent || "");
          const rect = el.getBoundingClientRect();
          if (rect.width < 200 || rect.height < 120) return false;
          return /Saalplan-Vorschau|Seating chart preview/i.test(text) && /Platzgruppe/i.test(text);
        })
        .sort((a, b) => {
          const rectA = a.getBoundingClientRect();
          const rectB = b.getBoundingClientRect();
          return rectA.width * rectA.height - rectB.width * rectB.height;
        });

      return candidates[0] || null;
    }

    function toAbsolute(url) {
      try {
        return new URL(url, window.location.href).toString();
      } catch {
        return null;
      }
    }

    const root = findPreviewRoot();
    if (!root) {
      return { ok: false, reason: "preview_root_not_found" };
    }

    root.setAttribute("data-codex-preview-root", "true");

    const imageCandidates = [...root.querySelectorAll("img")]
      .map((image) => {
        const rect = image.getBoundingClientRect();
        const src = toAbsolute(image.currentSrc || image.src || image.getAttribute("src"));
        return {
          image,
          src,
          naturalWidth: image.naturalWidth || 0,
          naturalHeight: image.naturalHeight || 0,
          rectWidth: Math.round(rect.width),
          rectHeight: Math.round(rect.height),
          score: Math.max(image.naturalWidth || 0, Math.round(rect.width)) * Math.max(image.naturalHeight || 0, Math.round(rect.height)),
        };
      })
      .filter((item) => item.src)
      .sort((a, b) => b.score - a.score);

    if (imageCandidates.length) {
      return {
        ok: true,
        kind: "image",
        src: imageCandidates[0].src,
        naturalWidth: imageCandidates[0].naturalWidth,
        naturalHeight: imageCandidates[0].naturalHeight,
      };
    }

    const canvas = [...root.querySelectorAll("canvas")]
      .sort((a, b) => b.width * b.height - a.width * a.height)[0];
    if (canvas) {
      try {
        return {
          ok: true,
          kind: "canvas",
          dataUrl: canvas.toDataURL("image/png"),
        };
      } catch (error) {
        return { ok: false, reason: String(error) };
      }
    }

    const svg = [...root.querySelectorAll("svg")]
      .sort((a, b) => {
        const rectA = a.getBoundingClientRect();
        const rectB = b.getBoundingClientRect();
        return rectB.width * rectB.height - rectA.width * rectA.height;
      })[0];
    if (svg) {
      svg.setAttribute("data-codex-preview-svg", "true");
      return {
        ok: true,
        kind: "svg",
      };
    }

    return {
      ok: true,
      kind: "screenshot",
    };
  });

  if (!previewData.ok) {
    throw new Error(`Preview extraction failed: ${previewData.reason}`);
  }

  if (previewData.kind === "canvas" && previewData.dataUrl) {
    const base64 = previewData.dataUrl.split(",")[1];
    fs.writeFileSync(filename, Buffer.from(base64, "base64"));
    console.log(`Canvas-Vorschau gespeichert: ${filename}`);
    return;
  }

  if (previewData.kind === "image" && previewData.src) {
    if (previewData.src.startsWith("data:")) {
      const base64 = previewData.src.split(",")[1];
      fs.writeFileSync(filename, Buffer.from(base64, "base64"));
      console.log(`Direktes Preview-Bild gespeichert: ${filename}`);
      return;
    }

    await renderImageUrlToPng(page, previewData.src, filename);
    console.log(`Preview-Bild als PNG gespeichert: ${filename}`);
    return;
  }

  const previewLocator = page.locator("[data-codex-preview-root='true']").first();
  if (previewData.kind === "svg") {
    const svgLocator = page.locator("[data-codex-preview-svg='true']").first();
    if (await svgLocator.count()) {
      await svgLocator.screenshot({ path: filename });
      console.log(`SVG-Vorschau als PNG gespeichert: ${filename}`);
      return;
    }
  }

  await previewLocator.screenshot({ path: filename });
  console.log(`Preview-Container-Screenshot gespeichert: ${filename}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  const context = await browser.newContext({
    viewport: { width: 1600, height: 1200 },
    deviceScaleFactor: 4,
  });

  const listPage = await context.newPage();
  const detailPage = await context.newPage();
  ensureOutputDir();
  await openStartPage(listPage);

  let pngCount = 0;
  let soldOutTxtCount = 0;
  let noSeatmapTxtCount = 0;
  let ignoredT120Count = 0;
  let discoveredTotal = 0;

  for (let i = 0; i < MAX_EVENTS; i++) {
    const cards = await ensureEventListReady(listPage, i);
    discoveredTotal = Math.max(discoveredTotal, cards.length);
    if (cards.length <= i) {
      console.log(`\nKeine weitere Vorstellung an Index ${i + 1} gefunden. Stoppe.`);
      break;
    }

    const card = cards[i];
    const meta = card.meta || extractEventMeta(card.blockText, card.venue);
    const baseName = `${meta.venue}_${safeFilePart(meta.title)}_${meta.date}_${meta.time}`;

    console.log(`\n=== Vorstellung ${i + 1}/${Math.max(discoveredTotal, i + 1)}: ${baseName} ===`);
    console.log(`Expected: ${meta.title} / ${meta.date} / ${meta.time} / ${meta.venue}`);

    if (isPastCaptureWindow(meta)) {
      console.log("Später als T-120min vor Beginn -> komplett ignoriert");
      ignoredT120Count += 1;
      continue;
    }

    if (card.isSoldOut || !card.hasTickets) {
      const txtName = writeMarkerFile(baseName, "Ausverkauft");
      soldOutTxtCount += 1;
      console.log(`Ausverkauft-Datei gespeichert: ${txtName}`);
      continue;
    }

    await ensureEventListReady(listPage, i);

    const clickResult = await clickEventCardByIndex(
      listPage,
      i,
      meta
    );
    console.log("Klick-Ergebnis:", JSON.stringify(clickResult, null, 2));
    if (clickResult.matchedMeta) {
      console.log(
        `Matched: ${clickResult.matchedMeta.title} / ${clickResult.matchedMeta.date} / ${clickResult.matchedMeta.time} / ${clickResult.matchedMeta.venue} / ${String(clickResult.blockText || "").slice(0, 120)}`
      );
    }

    if (!clickResult.ok) {
      const markerText = clickResult.reason === "expected_event_not_found"
        ? "Erwartete Vorstellung nicht gefunden"
        : "Ausverkauft";
      const txtName = writeMarkerFile(baseName, markerText);
      if (clickResult.reason === "expected_event_not_found") {
        noSeatmapTxtCount += 1;
      } else {
        soldOutTxtCount += 1;
      }
      console.log(`Nicht ladbar -> Textdatei gespeichert: ${txtName}`);
      continue;
    }

    const eventPage = clickResult.href ? detailPage : listPage;

    if (clickResult.href) {
      const targetUrl = new URL(clickResult.href, START_URL).toString();
      await detailPage.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await detailPage.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
      await detailPage.waitForTimeout(400);
    } else {
      await listPage.waitForLoadState("domcontentloaded", { timeout: 10000 }).catch(() => {});
      await listPage.waitForTimeout(700);
    }

    const pageText = await eventPage.locator("body").innerText();
    let venue = detectVenue(pageText);

    if (venue === "other" && /Marstall/i.test(clickResult.blockText || "")) venue = "marstall";
    if (venue === "other" && /Cuvilli/i.test(clickResult.blockText || "")) venue = "cuv";
    if (venue === "other" && /Residenztheater/i.test(clickResult.blockText || "")) venue = "resi";

    console.log("Venue:", venue);
    // marstall-salon + aussicht werden jetzt aktiv verarbeitet
    // und sollen PNGs erzeugen statt ignored/unsupported zu werden

    if (!["resi", "cuv", "marstall", "marstall-salon", "aussicht"].includes(venue)) {
      console.log("Andere Spielstätte → überspringe");
      const txtName = writeMarkerFile(baseName, "Keine Seatmap");
      noSeatmapTxtCount += 1;
      console.log(`Unbekannte Venue ohne Seatmap-Verarbeitung -> Textdatei gespeichert: ${txtName}`);
      if (!clickResult.href) {
        await returnToEventList(eventPage);
      }
      continue;
    }

    console.log("Warte auf Seatmap oder Saalplan-Vorschau...");
    const seatmapState = await waitForSeatmapOrPreview(eventPage, 12000);

    if (seatmapState.mode === "preview") {
      await savePreviewSeatmapImage(eventPage, outputPath(`${baseName}.png`));
      pngCount += 1;
      if (!clickResult.href) {
        await returnToEventList(eventPage);
      }
      continue;
    }

    if (seatmapState.mode !== "seatmap") {
      const txtName = writeMarkerFile(baseName, "Keine Seatmap");
      noSeatmapTxtCount += 1;
      console.log(`Keine Seatmap -> Textdatei gespeichert: ${txtName}`);
      if (!clickResult.href) {
        await returnToEventList(eventPage);
      }
      continue;
    }

    await prepareSeatmap(eventPage, venue);
    await saveSeatmapImage(eventPage, outputPath(`${baseName}.png`), { returnAfter: !clickResult.href });
    pngCount += 1;
  }

  const totalOutputFiles = pngCount + soldOutTxtCount + noSeatmapTxtCount;
  console.log(`\nOutput folder: ${OUTPUT_DIR}`);
  console.log(`Total events found: ${discoveredTotal}`);
  console.log(`Ignored due to T-120: ${ignoredT120Count}`);
  console.log(`PNG count: ${pngCount}`);
  console.log(`Ausverkauft TXT: ${soldOutTxtCount}`);
  console.log(`Keine Seatmap TXT: ${noSeatmapTxtCount}`);
  console.log(`Total output files: ${totalOutputFiles}`);

  await browser.close();
})();
