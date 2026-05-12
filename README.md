# Seatmap GitHub Actions Test

Minimaler Test, ob GitHub Actions mit Playwright/Chromium den Staatstheater-Ticketshop laden und Screenshots speichern kann.

## Nutzung

1. ZIP entpacken.
2. Inhalt in ein GitHub-Repo legen.
3. Commit & Push:

```bash
git add .
git commit -m "Add seatmap GitHub Actions test"
git push
```

4. Auf GitHub: **Actions → Seatmap Screenshot Test → Run workflow**.
5. Nach dem Lauf: Artifact `seatmap-screenshots` herunterladen.

## Lokal testen

```bash
npm install
npx playwright install chromium
npm run capture
```
