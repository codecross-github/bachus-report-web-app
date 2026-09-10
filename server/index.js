import express from "express";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PROJECT_ID = "bacchus-mobile-app";
const COLLECTION = "sensorReadings";
const IN_QUERY_LIMIT = 30;
const PORT = 5174;

/** @type {{ token: string, expiresAt: number } | null} */
let cachedToken = null;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && cachedToken.expiresAt > now + 60_000) {
    return cachedToken.token;
  }

  try {
    const { stdout } = await execFileAsync("gcloud", [
      "auth",
      "print-access-token",
    ]);
    const token = stdout.trim();
    if (!token) throw new Error("Empty access token from gcloud");
    // Access tokens typically last ~1 hour
    cachedToken = { token, expiresAt: now + 50 * 60 * 1000 };
    return token;
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

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, projectId: PROJECT_ID });
});

app.post("/api/readings", async (req, res) => {
  try {
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

app.listen(PORT, () => {
  console.log(`Bacchus API listening on http://localhost:${PORT}`);
});
