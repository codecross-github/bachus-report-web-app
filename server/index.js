import express from "express";
import { timingSafeEqual } from "node:crypto";
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

try {
  process.loadEnvFile(resolve(process.cwd(), ".env"));
} catch {
  // .env is optional; REPORT_ACCESS_PASSWORD can also come from the environment
}

const execFileAsync = promisify(execFile);
const PROJECT_ID = "bacchus-mobile-app";
const COLLECTION = "sensorReadings";
const IN_QUERY_LIMIT = 30;
const PORT = Number(process.env.PORT) || 5174;
const ACCESS_PASSWORD = process.env.REPORT_ACCESS_PASSWORD || "";
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGIN || "https://codecross-github.github.io")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
);

function passwordsMatch(provided, expected) {
  const expectedBuf = Buffer.from(String(expected), "utf8");
  const providedBuf = Buffer.from(String(provided ?? ""), "utf8");
  if (!expectedBuf.length || providedBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(providedBuf, expectedBuf);
}

/** @type {{ token: string, expiresAt: number } | null} */
let cachedToken = null;

async function getMetadataAccessToken() {
  const res = await fetch(
    "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
    {
      headers: { "Metadata-Flavor": "Google" },
      signal: AbortSignal.timeout(1500),
    }
  );
  if (!res.ok) return null;
  const data = await res.json();
  if (!data.access_token) return null;
  const expiresInMs = Number(data.expires_in || 3600) * 1000;
  return {
    token: data.access_token,
    expiresAt: Date.now() + Math.max(expiresInMs - 60_000, 60_000),
  };
}

async function getGcloudAccessToken() {
  const { stdout } = await execFileAsync("gcloud", ["auth", "print-access-token"]);
  const token = stdout.trim();
  if (!token) throw new Error("Empty access token from gcloud");
  return { token, expiresAt: Date.now() + 50 * 60 * 1000 };
}

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  try {
    const fromMetadata = await getMetadataAccessToken();
    if (fromMetadata) {
      cachedToken = fromMetadata;
      return cachedToken.token;
    }
  } catch {
    // Not running on GCP; fall back to local gcloud.
  }

  try {
    cachedToken = await getGcloudAccessToken();
    return cachedToken.token;
  } catch (err) {
    throw new Error(
      `Could not get Google access token. Run: gcloud auth login\n${err.message}`
    );
  }
}

function decodeValue(value) {
  if (value == null) return null;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("mapValue" in value) {
    const fields = value.mapValue.fields || {};
    return Object.fromEntries(
      Object.entries(fields).map(([k, v]) => [k, decodeValue(v)])
    );
  }
  if ("arrayValue" in value) {
    return (value.arrayValue.values || []).map(decodeValue);
  }
  return value;
}

function documentToReading(doc) {
  const id = doc.name.split("/").pop();
  const fields = doc.fields || {};
  const data = Object.fromEntries(
    Object.entries(fields).map(([k, v]) => [k, decodeValue(v)])
  );
  return { id, ...data };
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function buildQuery(sessionIds) {
  if (sessionIds.length === 1) {
    return {
      structuredQuery: {
        from: [{ collectionId: COLLECTION }],
        where: {
          fieldFilter: {
            field: { fieldPath: "sessionId" },
            op: "EQUAL",
            value: { stringValue: sessionIds[0] },
          },
        },
      },
    };
  }

  return {
    structuredQuery: {
      from: [{ collectionId: COLLECTION }],
      where: {
        fieldFilter: {
          field: { fieldPath: "sessionId" },
          op: "IN",
          value: {
            arrayValue: {
              values: sessionIds.map((id) => ({ stringValue: id })),
            },
          },
        },
      },
    },
  };
}

async function fetchReadings(sessionIds) {
  const token = await getAccessToken();
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:runQuery`;
  const readings = [];

  for (const batch of chunk(sessionIds, IN_QUERY_LIMIT)) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildQuery(batch)),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Firestore query failed (${res.status}): ${text}`);
    }

    const rows = await res.json();
    for (const row of rows) {
      if (row.document) readings.push(documentToReading(row.document));
    }
  }

  readings.sort((a, b) => (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0));
  return readings;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, X-Report-Password"
    );
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, projectId: PROJECT_ID });
});

app.post("/api/readings", async (req, res) => {
  try {
    if (!ACCESS_PASSWORD) {
      res.status(503).json({
        error:
          "Access password is not configured. Set REPORT_ACCESS_PASSWORD in .env.",
      });
      return;
    }

    const providedPassword =
      req.get("x-report-password") ?? req.body?.password ?? "";
    if (!passwordsMatch(providedPassword, ACCESS_PASSWORD)) {
      res.status(401).json({ error: "Invalid access password." });
      return;
    }

    const raw = req.body?.sessionIds;
    const sessionIds = Array.isArray(raw)
      ? [...new Set(raw.map((id) => String(id).trim()).filter(Boolean))]
      : [];

    if (!sessionIds.length) {
      res.status(400).json({ error: "Provide at least one sessionId." });
      return;
    }

    const readings = await fetchReadings(sessionIds);
    res.json({
      sessionIds,
      count: readings.length,
      readings,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message || "Failed to fetch readings." });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Bacchus API listening on port ${PORT}`);
  if (!ACCESS_PASSWORD) {
    console.warn(
      "REPORT_ACCESS_PASSWORD is not set. Fetch readings will return 503."
    );
  }
});
