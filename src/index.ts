/**
 * agently-mail — Cloudflare Worker driving Tencent Agently Mail (agent.qq.com).
 *
 * Protocol VERIFIED live (2026-07-07) against @tencent-qqmail/agently-cli 1.0.7
 * and the real api.agent.qq.com / auth.agent.qq.com endpoints:
 *   - Data API:  https://api.agent.qq.com/v1/...   — server checks ONLY Authorization: Bearer
 *   - Auth:      https://auth.agent.qq.com  (OAuth2 device flow + form-encoded refresh)
 *   - client_id is a PUBLIC constant baked into the CLI binary — not secret, no app_secret needed.
 *   - Refresh ROTATES refresh_token on every call (persist the new one immediately).
 *   - Send is two-phase: POST (no token) → HTTP ~400 {error.code:"CONFIRMATION_REQUIRED",
 *     error.details.confirmation_token, error.details.operation_summary}; re-POST the SAME body
 *     + confirmation_token to commit (→ {queued:true}).
 */

export interface Env {
  TOKEN_STORE: KVNamespace; // holds the live (rotating) access_token + refresh_token + alias_id
  API_TOKEN: string; // shared secret gating this Worker's own HTTP API (wrangler secret)
  // optional: override the public client_id if Tencent ever rotates it
  AGENTLY_CLIENT_ID?: string;
}

const API = "https://api.agent.qq.com";
const AUTH = "https://auth.agent.qq.com";
const CLIENT_ID = "cli_002e8cd1e54a3889"; // public, embedded in the CLI binary
const UA = "agently-cli/1.0.7 (linux/arm64)";

const K = { access: "access_token", refresh: "refresh_token", alias: "alias_id", seen: "last_seen_msg_id", lock: "refreshing" };

// ── refresh (form-encoded, no app_secret; rt rotates) ─────────────────────────────────
async function refreshOnce(env: Env): Promise<string | null> {
  if (await env.TOKEN_STORE.get(K.lock)) {
    await new Promise((r) => setTimeout(r, 800));
    return env.TOKEN_STORE.get(K.access); // coalesce concurrent 401s onto one refresh
  }
  await env.TOKEN_STORE.put(K.lock, "1", { expirationTtl: 60 }); // KV min ttl is 60s
  try {
    const rt = await env.TOKEN_STORE.get(K.refresh);
    if (!rt) return null;
    const r = await fetch(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: rt,
        client_id: env.AGENTLY_CLIENT_ID ?? CLIENT_ID,
        clientversion: "1.0.7",
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token: string; refresh_token: string; expires_in?: number };
    await env.TOKEN_STORE.put(K.access, j.access_token, { expirationTtl: j.expires_in ?? 3600 });
    await env.TOKEN_STORE.put(K.refresh, j.refresh_token); // ROTATION
    return j.access_token;
  } catch {
    return null; // refresh hiccup → degrade to 401, never 500 the endpoint
  } finally {
    await env.TOKEN_STORE.delete(K.lock);
  }
}

// ── one /v1 call, auto-refresh on 401 ─────────────────────────────────────────────────
async function v1(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const at = await env.TOKEN_STORE.get(K.access);
  const go = (token: string) =>
    fetch(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": UA,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(init.headers as Record<string, string>),
      },
    });
  let r = await go(at!);
  if (r.status === 401) {
    const nt = await refreshOnce(env);
    if (nt) r = await go(nt);
  }
  return r;
}

async function aliasId(env: Env): Promise<string> {
  const cached = await env.TOKEN_STORE.get(K.alias);
  if (cached) return cached;
  const r = await v1(env, "/v1/me");
  const j = (await r.json()) as any;
  const primary = j.data.aliases.find((a: any) => a.is_primary) ?? j.data.aliases[0];
  if (!primary?.alias_id) throw new Error("no alias in /v1/me");
  await env.TOKEN_STORE.put(K.alias, primary.alias_id);
  return primary.alias_id;
}

interface SendMsg {
  to: string[]; cc?: string[]; bcc?: string[];
  subject: string; body: string; body_format?: "HTML" | "PLAIN";
  attachments?: any[];
}
const rcpt = (x?: string[]) => (x ?? []).map((email) => ({ email }));
const sendBody = (m: SendMsg, token?: string) => ({
  to: rcpt(m.to), cc: rcpt(m.cc), bcc: rcpt(m.bcc),
  subject: m.subject, body: m.body, body_format: m.body_format ?? "HTML",
  attachments: m.attachments ?? [],
  ...(token ? { confirmation_token: token } : {}),
});

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // ponytail: single shared-secret gate. Every route requires it.
    if (req.headers.get("Authorization") !== `Bearer ${env.API_TOKEN}`) {
      return new Response("Unauthorized", { status: 401 });
    }
    const url = new URL(req.url);
    const body: any = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const aid = await aliasId(env).catch((e: any) => ({ error: e.message }));
    if (typeof aid !== "string") return json(aid, 500);

    try {
      switch (url.pathname) {
        case "/me":
          return json(await (await v1(env, "/v1/me")).json());

        case "/list": {
          const q = new URLSearchParams();
          if (body.limit) q.set("limit", String(Math.min(50, body.limit)));
          if (body.cursor) q.set("cursor", body.cursor);
          if (body.dir) q.set("dir", body.dir);
          return json(await (await v1(env, `/v1/aliases/${aid}/messages?${q}`)).json());
        }

        case "/read":
          return json(await (await v1(env, `/v1/aliases/${aid}/messages/${body.id}`)).json());

        case "/search": {
          const q = new URLSearchParams({ q: body.q });
          if (body.limit) q.set("limit", String(Math.min(50, body.limit)));
          if (body.search_in) q.set("search_in", body.search_in);
          if (body.cursor) q.set("cursor", body.cursor);
          return json(await (await v1(env, `/v1/aliases/${aid}/messages/search?${q}`)).json());
        }

        // phase 1 → {confirmation_token, summary}; phase 2 (same msg + token) → {queued}
        case "/send": {
          const r = await v1(env, `/v1/aliases/${aid}/messages/send`, {
            method: "POST", body: JSON.stringify(sendBody(body)),
          });
          const j = (await r.json()) as any;
          const det = j.error?.details ?? j.data; // CONFIRMATION_REQUIRED wraps in error.details
          return json({ phase: 1, confirmation_token: det?.confirmation_token, summary: det?.operation_summary });
        }
        case "/send/confirm": {
          const r = await v1(env, `/v1/aliases/${aid}/messages/send`, {
            method: "POST", body: JSON.stringify(sendBody(body.msg, body.confirmation_token)),
          });
          const j = (await r.json()) as any;
          return json({ phase: 2, queued: j.queued === true || j.ok === true, raw: j });
        }

        default:
          return json({ routes: ["/me", "/list", "/read", "/search", "/send", "/send/confirm"] });
      }
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  },

  // poll inbox every 2 min (beta cap: 10 req/min, 200/h)
  async scheduled(_e: ScheduledEvent, env: Env): Promise<void> {
    const aid = await aliasId(env).catch(() => null);
    if (!aid) return;
    const seen = await env.TOKEN_STORE.get(K.seen);
    const j = await (await v1(env, `/v1/aliases/${aid}/messages?limit=20&dir=inbox`)).json() as any;
    const fresh = (j.data ?? []).filter((m: any) => m.message_id !== seen).map((m: any) => m.message_id);
    if (fresh.length) {
      await env.TOKEN_STORE.put(K.seen, fresh[0]);
      console.log(`new mail: ${fresh.join(",")}`); // → wire a Queue/webhook to push to your agent
    }
  },
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
