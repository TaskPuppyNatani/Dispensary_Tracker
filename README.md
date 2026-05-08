# Dispensary Tracker

A personal desktop app for tracking dispensary receipts. Scan or photograph a receipt, and the app uses OCR to automatically parse and log the dispensary name, date, and purchase details — all stored locally on your machine.

## Features

- **OCR receipt scanning** — uses Tesseract.js to read receipt images and extract purchase data
- **Dispensary matching** — fuzzy-matches OCR text against a known dispensary list to fill in location names automatically
- **Receipt history** — browse, edit, and delete past receipts stored in a local IndexedDB database
- **Export** — export your records as CSV or a ZIP backup
- **Import** — restore from a previous backup ZIP
- **Auto-backup** — optionally sync to a file on your device automatically
- **Themes & density** — light/dark mode and compact/comfortable layout options

## Installation

Download the latest installer from the [Releases](../../releases) page and run `Dispensary Tracker Setup x.x.x.exe`. The app installs to your local user profile and does not require admin rights.

## Development

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build Windows installer
npm run build
```

Requires [Node.js](https://nodejs.org) and [Electron](https://www.electronjs.org).

## Data & Privacy

All data is stored locally in your Windows user profile (`%AppData%\Dispensary Tracker`). Nothing is sent to any server.

