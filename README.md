# Bacchus Session Report

Web app that queries Firestore `sensorReadings` by `sessionId` and exports a PDF.

Live UI: https://codecross-github.github.io/bachus-report-web-app/

GitHub Pages only serves the static UI. Fetch readings calls a Cloud Run API, which checks `REPORT_ACCESS_PASSWORD` and queries Firestore.

## Local setup

1. Install dependencies:

```bash
npm install
```

2. Copy `.env.example` to `.env` and set `REPORT_ACCESS_PASSWORD`. Do not prefix it with `VITE_` or it will be baked into the frontend bundle.

3. Log into Google Cloud with access to the Bacchus project:

```bash
gcloud auth login
gcloud config set project bacchus-mobile-app
```

4. Start the app (API + UI):

```bash
npm run dev
```

Open http://localhost:5173/

## Usage

1. Paste one or more session IDs (comma-separated or one per line).
2. Enter the access password.
3. Click **Fetch readings**.
4. Click **Download PDF**.

## How access works

Firestore security rules block the browser Firebase SDK. The API (`server/index.js`) queries Firestore with Google credentials (local `gcloud`, or the Cloud Run service account in production).

## Query

Equivalent to the console query:

`sensorReadings` where `sessionId == "<your session id>"`

Multiple IDs use Firestore `IN` (batched in groups of 30).

## Deploy

- **UI:** push to `main`. GitHub Actions builds with `VITE_BASE=/bachus-report-web-app/` and publishes Pages.
- **API:** `./scripts/deploy-api.sh` (requires `gcloud` and `.env`).
