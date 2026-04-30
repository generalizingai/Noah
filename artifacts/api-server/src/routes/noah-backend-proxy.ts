import { Router, type Request, type Response } from "express";
import { Readable } from "stream";

const router = Router();
const NOAH_BACKEND = "http://localhost:8001";

// Headers that must be forwarded to the backend so SSE / auth / content
// negotiation work correctly.
const FORWARD_HEADERS = ["authorization", "content-type", "accept", "accept-encoding"];

router.all(/(.*)/, async (req: Request, res: Response) => {
  const qs = req.url.includes("?") ? "?" + req.url.split("?").slice(1).join("?") : "";
  const targetUrl = `${NOAH_BACKEND}${req.path}${qs}`;

  try {
    const headers: Record<string, string> = {};
    for (const name of FORWARD_HEADERS) {
      const val = req.headers[name];
      if (val) headers[name] = Array.isArray(val) ? val.join(", ") : val;
    }

    const isBodyMethod = !["GET", "HEAD", "OPTIONS"].includes(req.method.toUpperCase());
    const body = isBodyMethod && Object.keys(req.body || {}).length > 0
      ? JSON.stringify(req.body)
      : undefined;

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      body,
    });

    const contentType = upstream.headers.get("content-type") || "";
    res.status(upstream.status);

    if (contentType.includes("text/event-stream")) {
      // ── SSE streaming: pipe bytes directly, never buffer ──────────────────
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");    // disable nginx buffering
      res.flushHeaders();

      if (!upstream.body) {
        res.end();
        return;
      }

      const nodeStream = Readable.fromWeb(upstream.body as import("stream/web").ReadableStream);
      nodeStream.pipe(res, { end: true });
      req.on("close", () => nodeStream.destroy());
      nodeStream.on("error", () => { if (!res.writableEnded) res.end(); });

    } else if (contentType.includes("application/json")) {
      const data: unknown = await upstream.json();
      res.json(data);
    } else {
      const text = await upstream.text();
      res.type(contentType || "text/plain").send(text);
    }
  } catch {
    if (!res.headersSent) {
      res.status(502).json({ error: "Noah backend unavailable" });
    }
  }
});

export default router;
