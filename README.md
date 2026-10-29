# Jot

A minimal note-taking web app for iPad and desktop. Write by hand with Apple Pencil or type Markdown. Notes save on the device instantly, work offline, and sync to a private GitHub repo you own.

- **Quick capture:** the app opens on a blank page in `inbox/`. Sort notes into folders later, or never.
- **Handwriting:** a fountain pen or ballpoint in three sizes, a highlighter, an eraser, and a lasso to move, resize, recolor or delete writing. Draw a line or shape and hold the Pencil still to snap it clean. Pinch to zoom; ink stays sharp at any zoom.
- **Handwritten notes** are saved as `.svg`, so they display as images on GitHub too. **Typed notes** are plain `.md`.
- **Sync** is one commit per sync to your notes repo, so its history doubles as a backup. If a note was edited on two devices, both versions are kept as separate files, so nothing is overwritten.

## Setup

### 1. Make a notes repo and token

1. Create a **private** repo on GitHub, e.g. `notes`. It can be empty.
2. Create a [fine-grained token](https://github.com/settings/personal-access-tokens/new):
   - Repository access: **Only select repositories** → your notes repo
   - Permissions → Repository → **Contents: Read and write**

### 2. Host the app on GitHub Pages

This repo (the app code, not your notes) deploys itself with the included workflow:

1. Push this project to its own GitHub repo, e.g. `note-taker`. It holds no secrets, so it can be public. (Pages on a private repo needs GitHub Pro, which is free with the Student Developer Pack.)
2. In that repo: **Settings → Pages → Source: GitHub Actions**.
3. Every push to `main` tests, builds and deploys to `https://<you>.github.io/note-taker/`.

### 3. Install it

- **iPad:** open the URL in Safari → Share → **Add to Home Screen**. Then open the home-screen app and enter your repo and token in settings (the sliders icon in the ☰ menu). The installed app has its own storage separate from Safari, so set it up inside the app.
- **Windows/Mac:** open the URL in Chrome or Edge → install icon in the address bar. Enter the same repo and token.

The token stays on each device and is only ever sent to `api.github.com`.

## Using it

| | |
|---|---|
| ☰ | Folders and notes. **+** on a folder starts a note there; the folder icon makes a new folder |
| Note title | Rename, move to another folder, or delete |
| Pen / T | New handwritten / text note |
| Dot | Sync status: green synced, amber waiting, red failed, hollow offline or not set up. Tap to sync now |

On the ink page:

| | |
|---|---|
| Pencil (or mouse) | Writes with the chosen tool |
| One finger | Scrolls |
| Two fingers | Pinch to zoom; tap to undo |
| Three fingers | Tap to redo |
| Pen tool, tapped again | Switches between fountain pen (width follows pressure) and ballpoint (even width) |
| A color, tapped again | Opens a picker to change it |
| Lasso | Circle writing to select it. Drag it to move, drag the corner circle to resize, tap a color to recolor it, or delete it |
| Draw and hold | Snaps a line, circle, ellipse, triangle or box into a clean shape. Turn it off in settings |

Your palm can rest on the screen while you write. Ctrl/⌘+Z and Ctrl/⌘+Shift+Z undo and redo, Ctrl+scroll or a trackpad pinch zooms, and Delete removes a selection.

## Development

```sh
npm install
npm run dev      # http://localhost:5173, plus a LAN address you can open on the iPad
npm test         # sync engine tests
npm run build
```

Opening the LAN address on the iPad is the quickest way to try Pencil changes. Windows may ask to allow Node through the firewall. Offline mode only works in the built, deployed app.

## How it's built

| File | What it does |
|---|---|
| `src/main.ts` | UI: editors, drawer, dialogs, when to save and sync |
| `src/ink.ts` | Handwriting page: tools, zoom, lasso, undo, drawing to a canvas |
| `src/strokes.ts` | Pressure-sensitive stroke outlines ([perfect-freehand](https://github.com/steveruizok/perfect-freehand)), hit tests, SVG load/save |
| `src/shapes.ts` | Recognizes held strokes as lines, ellipses and polygons |
| `src/gestures.ts` | Finger scrolling, pinch zoom, multi-finger taps, palm rejection |
| `src/store.ts` | IndexedDB storage on the device |
| `src/sync.ts` | Sync engine: pull, conflict handling, push. Talks to any `Remote` |
| `src/github.ts` | The GitHub `Remote` (Git Data API, one commit per sync) |

`Remote` is the extension point. A peer-to-peer [Iroh](https://iroh.computer) transport for live device-to-device sync, or a server at home, would be another implementation of it.
