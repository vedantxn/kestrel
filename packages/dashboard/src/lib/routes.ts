import {
  KestrelApiError,
  type KestrelClient,
} from "@kestrel/dashboard/lib/client";

/**
 * Route handlers an app mounts under its dashboard (P17, content safety in
 * `docs/lld/p17-dashboard.md`).
 */

const LIVE_TTL_MS = 30 * 60_000;

function errorResponse(e: unknown): Response {
  if (e instanceof KestrelApiError)
    return new Response(e.message, {
      status: e.status === 401 ? 401 : e.status === 404 ? 404 : 409,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  throw e;
}

/**
 * `GET .../sessions/{id}/live[?control=1]`: mint a view or control token and send the browser to
 * the API's viewer page, in its own tab. The token rides in the URL fragment, which is never
 * sent to a server or in a Referer.
 */
export async function liveViewResponse(
  client: KestrelClient,
  id: string,
  control: boolean,
): Promise<Response> {
  try {
    const t = await client.mintToken(id, {
      scope: control ? "control" : "view",
      ttlMs: LIVE_TTL_MS,
    });
    return new Response(null, {
      status: 303,
      headers: {
        location: t.url,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * `GET .../sessions/{id}/recording`: the video, streamed from the API as a download. Never shown
 * inline from the dashboard's origin (HLD 8.14).
 */
export async function recordingResponse(
  client: KestrelClient,
  id: string,
): Promise<Response> {
  try {
    const res = await client.recording(id);
    const headers = new Headers({
      "content-type": "video/mp4",
      "content-disposition": `attachment; filename="${id.replace(/[^A-Za-z0-9_]/g, "")}.mp4"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    });
    const length = res.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(res.body, { status: 200, headers });
  } catch (e) {
    return errorResponse(e);
  }
}
