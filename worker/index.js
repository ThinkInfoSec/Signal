/**
 * Optional host for Signal. GitHub Pages cannot send framing headers.
 * `npx wrangler deploy` from the repo root serves the same files and adds them.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    const incoming = new URL(request.url);
    const assetUrl = new URL(request.url);
    if (incoming.pathname === "/api/news") assetUrl.pathname = "/news.json";
    const response = await env.ASSETS.fetch(new Request(assetUrl, request));
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("X-Frame-Options", "DENY");
    headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    headers.delete("Access-Control-Allow-Origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
