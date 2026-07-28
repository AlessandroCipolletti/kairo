<p align="center">
  <img src="./public/kairo-mark.svg" alt="Kairo - Demo video recorder" width="120" height="120" />
</p>

<h1 align="center">Kairo - Demo video recorder</h1>

<p align="center">
  <strong>Easy screen recording with circular webcam PiP.</strong><br />
  Record your screen, face, and mic in the browser — review instantly, then download WebM or convert to MP4.
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-1FA2A0.svg" /></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-3178C6.svg?logo=typescript&logoColor=white" />
  <img alt="Vite" src="https://img.shields.io/badge/Vite-646CFF.svg?logo=vite&logoColor=white" />
  <img alt="Client-only" src="https://img.shields.io/badge/backend-none-E85D4C.svg" />
</p>

---

## Why Kairo - Demo video recorder?

Most “screen + camera” tools are heavy desktop apps or SaaS with uploads. **Kairo - Demo video recorder** is a tiny open-source web app that stays on your machine:

- Composites **full screen** + **circular webcam PiP** + **microphone** into one video
- Shows a **live preview** of the final look while you record
- Lets you **review the WebM in the page** before downloading
- Optionally converts to **MP4 in-browser** with ffmpeg.wasm (lazy-loaded)
- Deploys as a **cheap static site** on AWS (S3 + CloudFront) with one command

No accounts. No cloud video storage. No always-on servers.

## Features

- **Start / Stop recording** with browser permission prompts for screen, camera, and mic
- **Circular PiP** mirrored webcam in the corner of the composed frame
- **Live compose preview** while recording
- **In-page review player** as soon as you stop
- **Download WebM** immediately
- **Convert to MP4** — downloads the ffmpeg.wasm bundle on first use, then converts locally
- **Discard / Record again** without saving anything
- Works on **localhost** and on a deployed HTTPS URL

## Quick start

```bash
npm install
npm run dev
```

Open the printed localhost URL, click **Start recording**, grant screen + camera + mic, then **Stop** to review.

> Media capture APIs require a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts): `localhost` or HTTPS.

## Export flow

1. **Stop** — the finished WebM appears in an in-page player
2. Watch it and decide:
   - **Download WebM** — instant download
   - **Convert to MP4** — first click may download ~30MB of ffmpeg.wasm; later converts reuse it
   - **Discard / Record again** — clears the take and returns to idle

Recording and export are fully client-side. AWS is only for hosting the UI.

## Deploy to AWS (one command)

Cost-light static hosting: private **S3** + **CloudFront** (`PriceClass_100`, default `*.cloudfront.net` URL). No EC2, no database, no Route53.

1. Copy env template and fill credentials:

```bash
cp .env.example .env
```

```bash
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=eu-west-1
AWS_ACCOUNT_ID=
```

2. Deploy:

```bash
npm run deploy
```

This builds the app, bootstraps CDK if needed, deploys `KairoHostingStack`, and prints **SiteUrl**.

The stack is isolated from other resources in your account. For light personal use, the bill is typically pennies (often near free-tier).

## How it works

```text
getDisplayMedia ──┐
                  ├──► Canvas compose (screen + circular cam) ──► MediaRecorder ──► WebM
getUserMedia ─────┘                         └─ mic audio ──────┘
                                                                  │
                                              review / download / ffmpeg.wasm → MP4
```

No API server. The optional MP4 path uses `@ffmpeg/ffmpeg` loaded only when you click **Convert to MP4**.

## Browser support

Best on **Chromium** and **Firefox** desktop. Safari is best-effort (WebM / MediaRecorder support varies).

## Project scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Local Vite dev server |
| `npm run build` | Production build to `dist/` (relative asset paths; works at site root or in a subfolder) |
| `npm run preview` | Preview the production build |
| `npm run deploy` | Build + CDK bootstrap/deploy via `.env` |

MP4 conversion downloads `@ffmpeg/core` from jsDelivr on first use, then runs entirely in the browser. The host must allow that CDN (or conversion will fail after the download UI). For FTP uploads, deploy the whole `dist/` folder as-is.

## License

[MIT](./LICENSE)
