const API_VERSION = "v27.0";
const GRAPH = `https://graph.facebook.com/${API_VERSION}`;
const REQUIRED_SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_read_user_content",
  "pages_manage_posts",
  "instagram_basic",
  "instagram_content_publish",
  "instagram_manage_comments",
  "instagram_manage_messages"
];

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }
  });

function b64url(bytes) {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s) {
  const t = s.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(t + "=".repeat((4 - t.length % 4) % 4)), c => c.charCodeAt(0));
}
async function hmac(value, secret) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}
async function encrypt(value, secret) {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  if (raw.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must be base64 for exactly 32 bytes");
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: b64url(iv), data: b64url(ciphertext) });
}
async function decrypt(payload, secret) {
  const raw = Uint8Array.from(atob(secret), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["decrypt"]);
  const parsed = JSON.parse(payload);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64url(parsed.iv) }, key, fromB64url(parsed.data));
  return JSON.parse(new TextDecoder().decode(plain));
}
function cookie(name, value, maxAge) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}
function getCookie(request, name) {
  return (request.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(name + "="))?.slice(name.length + 1);
}
async function graphGet(path, params = {}) {
  const url = new URL(GRAPH + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const response = await fetch(url);
  const body = await response.json();
  if (!response.ok || body.error) throw new Error(body.error?.message || "Meta API request failed");
  return body;
}
async function loadConnection(env) {
  const encrypted = await env.META_KV.get("meta-connection");
  if (!encrypted) return null;
  return decrypt(encrypted, env.TOKEN_ENCRYPTION_KEY);
}
async function requireApi(request, env) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.API_KEY || auth !== `Bearer ${env.API_KEY}`) return false;
  return true;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return json({ ok: true, service: "Online4Tech Meta Connector", version: "1.0.0" });
      }

      if (request.method === "GET" && url.pathname === "/auth/start") {
        if (!env.META_APP_ID || !env.META_APP_SECRET || !env.OAUTH_STATE_SECRET) return json({ error: "OAuth secrets are not configured" }, 503);
        const redirectUri = `${url.origin}/auth/callback`;
        const nonce = b64url(crypto.getRandomValues(new Uint8Array(24)));
        const signature = await hmac(nonce, env.OAUTH_STATE_SECRET);
        const state = `${nonce}.${signature}`;
        const login = new URL(`https://www.facebook.com/${API_VERSION}/dialog/oauth`);
        login.searchParams.set("client_id", env.META_APP_ID);
        login.searchParams.set("redirect_uri", redirectUri);
        login.searchParams.set("response_type", "code");
        login.searchParams.set("scope", REQUIRED_SCOPES.join(","));
        login.searchParams.set("state", state);
        return Response.redirect(login.toString(), 302);
      }

      if (request.method === "GET" && url.pathname === "/auth/callback") {
        const state = url.searchParams.get("state") || "";
        const [nonce, signature] = state.split(".");
        if (!nonce || !signature || signature !== await hmac(nonce, env.OAUTH_STATE_SECRET || "")) return json({ error: "Invalid OAuth state" }, 400);
        const code = url.searchParams.get("code");
        if (!code) return json({ error: url.searchParams.get("error_description") || "Meta authorization was cancelled" }, 400);
        const redirectUri = `${url.origin}/auth/callback`;
        const tokenUrl = new URL(`${GRAPH}/oauth/access_token`);
        tokenUrl.searchParams.set("client_id", env.META_APP_ID);
        tokenUrl.searchParams.set("client_secret", env.META_APP_SECRET);
        tokenUrl.searchParams.set("redirect_uri", redirectUri);
        tokenUrl.searchParams.set("code", code);
        const shortResponse = await fetch(tokenUrl);
        const shortToken = await shortResponse.json();
        if (!shortResponse.ok || shortToken.error) return json({ error: shortToken.error?.message || "Could not exchange authorization code" }, 400);

        const longUrl = new URL(`${GRAPH}/oauth/access_token`);
        longUrl.searchParams.set("grant_type", "fb_exchange_token");
        longUrl.searchParams.set("client_id", env.META_APP_ID);
        longUrl.searchParams.set("client_secret", env.META_APP_SECRET);
        longUrl.searchParams.set("fb_exchange_token", shortToken.access_token);
        const longResponse = await fetch(longUrl);
        const longToken = await longResponse.json();
        if (!longResponse.ok || longToken.error) return json({ error: longToken.error?.message || "Could not exchange long-lived token" }, 400);

        const pages = await graphGet("/me/accounts", {
          fields: "id,name,access_token,instagram_business_account{id,username}",
          access_token: longToken.access_token
        });
        const connection = {
          connected_at: new Date().toISOString(),
          user_token: longToken.access_token,
          token_expires_in: longToken.expires_in || null,
          pages: pages.data || []
        };
        await env.META_KV.put("meta-connection", await encrypt(connection, env.TOKEN_ENCRYPTION_KEY));
        return new Response(`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Online4Tech</title><body style="font-family:Arial;background:#0b1220;color:#fff;padding:40px;line-height:1.8"><h2>تم ربط Meta بنجاح</h2><p>تم حفظ الاتصال بشكل مشفّر. تقدر تقفل الصفحة وترجع للشات.</p></body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }

      if (url.pathname.startsWith("/api/")) {
        if (!await requireApi(request, env)) return json({ error: "Unauthorized" }, 401);
        if (request.method === "GET" && url.pathname === "/api/status") {
          const connection = await loadConnection(env);
          return json({ connected: !!connection, pages_count: connection?.pages?.length || 0, connected_at: connection?.connected_at || null });
        }
        if (request.method === "GET" && url.pathname === "/api/pages") {
          const connection = await loadConnection(env);
          if (!connection) return json({ error: "Meta account is not connected" }, 409);
          return json({ pages: (connection.pages || []).map(p => ({
            id: p.id, name: p.name,
            instagram: p.instagram_business_account ? { id: p.instagram_business_account.id, username: p.instagram_business_account.username || null } : null
          })) });
        }
        return json({ error: "Endpoint not implemented yet" }, 404);
      }
      return json({ error: "Not found" }, 404);
    } catch (error) {
      return json({ error: error?.message || "Unexpected error" }, 500);
    }
  }
};