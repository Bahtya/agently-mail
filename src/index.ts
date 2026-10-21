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
 *
 * KV WRITE BUDGET (Workers Free plan: 1,000 writes/day, resets 00:00 UTC).
 *   Measured before this change: ~790 writes/day (~79% of the free quota) — the 50% usage
 *   alert came entirely from writes:
 *     - the every-2-minute cron wrote `last_seen_msg_id` on EVERY tick, because the dedupe
 *       filter `m.message_id !== seen` excludes only ONE id — any inbox with ≥2 messages
 *       always looked "fresh", so the value flip-flopped between two ids (720 writes/day);
 *     - each hourly token refresh wrote access + refresh + lock as 3 separate keys (72/day).
 *   After this change:
 *     - the seen set (JSON array of the most recent ids) is written ONLY when a message id
 *       outside the set appears — one write per batch of genuinely new mail, zero when idle;
 *     - access + refresh live in ONE `auth_bundle` value, so a refresh costs 2 writes
 *       (lock + bundle) instead of 3. Legacy access_token/refresh_token keys are still read
 *       as a fallback and are replaced by the bundle on the first successful refresh.
 *   Expected steady state: ~50–100 writes/day (< 10%).
 */

export interface Env {
  TOKEN_STORE: KVNamespace; // auth bundle + alias + seen ids (see K below)
  API_TOKEN: string; // shared secret gating this Worker's own HTTP API (wrangler secret)
  // Hermux license-api admin key — the cron backstop uses it to kick the email
  // outbox drain (断链/退避行兜底，「必须发完」第三层).
  HERMUX_ADMIN_KEY?: string;
  // optional: override the public client_id if Tencent ever rotates it
  AGENTLY_CLIENT_ID?: string;
}

const API = "https://api.agent.qq.com";
const AUTH = "https://auth.agent.qq.com";
const CLIENT_ID = "cli_002e8cd1e54a3889"; // public, embedded in the CLI binary
const UA = "agently-cli/1.0.7 (linux/arm64)";

/**
 * KV keys. Keep the write path cheap — the free plan allows 1,000 writes/day.
 *   auth_bundle        ONE JSON value {access, refresh}; a refresh = 2 writes, not 3.
 *   alias_id           immutable, written once.
 *   last_seen_msg_id   JSON array of recent message ids; written only on new mail.
 *   refreshing         short-lived refresh lock (TTL 60s).
 * `access_token` / `refresh_token` are the LEGACY (pre-bundle) keys — read-only fallback,
 * deleted after the first successful refresh migrates them into auth_bundle.
 */
const K = {
  auth: "auth_bundle",
  alias: "alias_id",
  seen: "last_seen_msg_id",
  lock: "refreshing",
  legacyAccess: "access_token",
  legacyRefresh: "refresh_token",
} as const;

/** How many message ids to remember for dedupe (~40 bytes each → ~8 KB; KV value limit is 25 MiB). */
const SEEN_MAX = 200;

interface AuthState {
  access: string;
  refresh?: string;
}

/**
 * Read the current {access, refresh}. Prefers the bundle; falls back to the two legacy
 * keys so an upgraded deployment keeps working until the first 401-triggered refresh
 * migrates them.
 */
async function loadAuth(env: Env): Promise<{ state: AuthState | null; legacy: boolean }> {
  const bundle = await env.TOKEN_STORE.get<AuthState>(K.auth, "json");
  if (bundle) return { state: bundle, legacy: false };
  const [access, refresh] = await Promise.all([
    env.TOKEN_STORE.get(K.legacyAccess),
    env.TOKEN_STORE.get(K.legacyRefresh),
  ]);
  if (!access && !refresh) return { state: null, legacy: false };
  return { state: { access: access ?? "", refresh: refresh ?? undefined }, legacy: true };
}

// ── refresh (form-encoded, no app_secret; rt rotates) ─────────────────────────────────
async function refreshOnce(env: Env): Promise<string | null> {
  if (await env.TOKEN_STORE.get(K.lock)) {
    await new Promise((r) => setTimeout(r, 800));
    const { state } = await loadAuth(env);
    return state?.access ?? null; // coalesce concurrent 401s onto one refresh
  }
  await env.TOKEN_STORE.put(K.lock, "1", { expirationTtl: 60 }); // KV min ttl is 60s
  try {
    const { state, legacy } = await loadAuth(env);
    if (!state?.refresh) return null;
    const r = await fetch(`${AUTH}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: state.refresh,
        client_id: env.AGENTLY_CLIENT_ID ?? CLIENT_ID,
        clientversion: "1.0.7",
      }),
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { access_token: string; refresh_token: string; expires_in?: number };
    // ONE write for the rotated pair (was: access + refresh = 2 writes). Access expiry is
    // still discovered via 401, exactly as before — no extra bookkeeping needed.
    await env.TOKEN_STORE.put(K.auth, JSON.stringify({
      access: j.access_token,
      refresh: j.refresh_token,
    }));
    if (legacy) {
      // One-time migration cleanup, best effort: from now on auth_bundle is authoritative.
      await Promise.all([
        env.TOKEN_STORE.delete(K.legacyAccess),
        env.TOKEN_STORE.delete(K.legacyRefresh),
      ]);
    }
    return j.access_token;
  } catch {
    return null; // refresh hiccup → degrade to 401, never 500 the endpoint
  } finally {
    await env.TOKEN_STORE.delete(K.lock);
  }
}

// ── one /v1 call, auto-refresh on 401 ─────────────────────────────────────────────────
async function v1(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const { state } = await loadAuth(env);
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
  let r = await go(state?.access ?? "");
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

/** Parse the seen value: JSON array (current) or a single raw id (legacy). */
function parseSeen(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  } catch {
    // legacy value: `last_seen_msg_id` used to hold one raw message id
  }
  return [raw];
}

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

  // every 2 min: poll inbox (beta cap: 10 req/min, 200/h) + kick the Hermux
  // email-outbox drain as the「必须发完」backstop (chain break / backoff rows).
  async scheduled(_e: ScheduledEvent, env: Env): Promise<void> {
    if (env.HERMUX_ADMIN_KEY) {
      await fetch("https://hermux-license-api.pages.dev/functions/v1/admin/email/drain", {
        method: "POST",
        headers: { "x-admin-key": env.HERMUX_ADMIN_KEY, "content-type": "application/json" },
        body: "{}",
      }).catch((e) => console.log(`hermux drain kick failed: ${e}`));
    }
    const aid = await aliasId(env).catch(() => null);
    if (!aid) return;
    const seen = new Set(parseSeen(await env.TOKEN_STORE.get(K.seen)));
    const j = (await (await v1(env, `/v1/aliases/${aid}/messages?limit=20&dir=inbox`)).json()) as any;
    const ids = ((j.data ?? []) as any[])
      .map((m) => m.message_id)
      .filter((id): id is string => typeof id === "string");
    const fresh = ids.filter((id) => !seen.has(id));
    if (!fresh.length) return; // 没有新邮件 → 零写入(旧实现每 2 分钟都会写一次)
    // One write per batch of genuinely new mail; remember only the newest ids.
    const merged = [...new Set([...ids, ...seen])].slice(0, SEEN_MAX);
    await env.TOKEN_STORE.put(K.seen, JSON.stringify(merged));
    console.log(`new mail: ${fresh.join(",")}`); // → wire a Queue/webhook to push to your agent
  },
};

const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "Content-Type": "application/json" } });
