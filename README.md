# Seatmap GitHub Test v3

Robuster Klick-Test:
- öffnet Ticketshop
- speichert Startseite
- dump aller Buttons/Links
- klickt ersten sichtbaren Karten/Restkarten-Button per Playwright und als Fallback per DOM-Event
- speichert Screenshot/HTML/URL nach Klick

Lokal:

```bash
npm install
npx playwright install chromium
npm run capture
```
