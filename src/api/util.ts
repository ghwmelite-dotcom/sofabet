/**
 * Shared helpers for API handlers (JSON responses, sync-key guard).
 */

import { HttpError } from "../types";

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Endpoints that mutate state or expose private data require a matching
 * `Authorization: Bearer <key>` header when the SYNC_KEY secret is configured.
 * Unset = open (fine for local dev).
 */
export function requireSyncKey(env: Env, request: Request): void {
  const key = env.SYNC_KEY;
  if (!key) return;
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  const a = new TextEncoder().encode(presented);
  const b = new TextEncoder().encode(key);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b)) {
    throw new HttpError(401, "missing or invalid sync key (expected 'Authorization: Bearer <SYNC_KEY>')");
  }
}

/** Parse a JSON object request body or throw 400. */
export async function parseJsonBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new HttpError(400, "expected a JSON object body");
  }
  return body as Record<string, unknown>;
}
