# Bacchus Session Report

Simple web app that queries Firestore `sensorReadings` by `sessionId` and exports a PDF.

## Setup

1. Install dependencies:

```bash
npm install
```

2. Make sure you are logged into Google Cloud with access to the Bacchus project:

```bash
gcloud auth login
gcloud config set project bacchus-mobile-app
```

3. Start the app (API + UI):

```bash
npm run dev
```

Open http://localhost:5173/

## Usage

1. Paste one or more session IDs (comma-separated or one per line).
2. Click **Fetch readings**.
3. Click **Download PDF**.

## How access works

Firestore security rules block the browser Firebase SDK. This app uses a local Express API (`server/index.js`) that queries Firestore with your `gcloud` user token (project IAM), so mobile app rules stay unchanged.

## Query

Equivalent to the console query:

`sensorReadings` where `sessionId == "<your session id>"`

Multiple IDs use Firestore `IN` (batched in groups of 30).
