import { Router } from "express";

const router = Router();

const OMI_API_BASE = "https://api.omi.me";

type OmiApp = Record<string, unknown> & { id: string };

let approvedAppsCache: OmiApp[] | null = null;
let cacheTimestamp: number | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

async function fetchApprovedApps(): Promise<OmiApp[]> {
  const now = Date.now();
  if (approvedAppsCache && cacheTimestamp && now - cacheTimestamp < CACHE_TTL_MS) {
    return approvedAppsCache;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(`${OMI_API_BASE}/v1/approved-apps?include_reviews=true`, {
      signal: controller.signal,
      headers: { "Accept-Encoding": "gzip" },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      if (approvedAppsCache) return approvedAppsCache;
      throw new Error(`Failed to fetch apps: ${response.statusText}`);
    }

    const raw: unknown = await response.json();
    if (!Array.isArray(raw)) {
      throw new Error("Unexpected response shape from Omi API: expected array");
    }
    const data = raw as OmiApp[];
    approvedAppsCache = data;
    cacheTimestamp = now;
    return data;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    if (approvedAppsCache) return approvedAppsCache;
    throw error;
  }
}

router.get("/omi/apps", async (_req, res) => {
  try {
    const apps = await fetchApprovedApps();
    res.json(apps);
  } catch {
    res.status(502).json({ error: "Failed to fetch apps from Omi API" });
  }
});

router.get("/omi/apps/:id", async (req, res) => {
  try {
    const apps = await fetchApprovedApps();
    const app = apps.find((a) => a.id === req.params.id);
    if (!app) {
      res.status(404).json({ error: "App not found" });
      return;
    }
    res.json(app);
  } catch {
    res.status(502).json({ error: "Failed to fetch app" });
  }
});

export default router;
