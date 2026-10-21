/**
 * KV write-budget regression test for agently-mail.
 *
 * Workers Free plan allows 1,000 KV writes/day; the first implementation burned ~79%
 * of it (one write per 2-minute cron tick + 3 writes per hourly token refresh). This
 * test pins down the fixed behaviour:
 *
 *   - idle cron tick .................. 0 writes (3 reads)
 *   - one new inbox message ........... 1 write, then 0 again
 *   - legacy single-id `seen` value ... upgraded to an id array
 *   - legacy access_token/refresh_token + 401 ... migrated into auth_bundle in 2 writes
 *   - token refresh (bundle mode) ..... 2 writes (lock + auth_bundle) + 1 delete
 *
 * Run from the repo root:   node test/kv-budget.test.mjs
 * Requires Node.js >= 22.18 (native TypeScript type stripping); on older versions run
 * `node --experimental-strip-types test/kv-budget.test.mjs`.
 */

const worker = (await import(new URL("../src/index.ts", import.meta.url).href)).default;

class FakeKV {
  constructor(seed = {}) {
    this.map = new Map(Object.entries(seed));
    this.ops = [];
  }
  async get(key, type) {
    this.ops.push(["get", key]);
    const v = this.map.get(key);
    if (v == null) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key, value /*, opts */) {
    this.ops.push(["put", key]);
    this.map.set(key, value);
  }
  async delete(key) {
    this.ops.push(["delete", key]);
    this.map.delete(key);
  }
  count(op) {
    return this.ops.filter(([o]) => o === op).length;
  }
  writes() {
    return this.count("put");
  }
  resetOps() {
    this.ops = [];
  }
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

let inbox = [];
const meAlias = "alias_test";
let authCalls = 0;
let rejectAccess = null; // access token that should be answered with 401
const refreshed = { access_token: "new_access", refresh_token: "new_refresh" };

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  if (u.host === "auth.agent.qq.com") {
    authCalls++;
    return json(refreshed);
  }
  if (u.host === "hermux-license-api.pages.dev") return json({ ok: true });
  if (u.host === "api.agent.qq.com") {
    const auth = String((init.headers ?? {})["Authorization"] ?? "");
    if (u.pathname === "/v1/me") return json({ data: { aliases: [{ alias_id: meAlias, is_primary: true }] } });
    if (u.pathname.endsWith("/messages")) {
      if (rejectAccess && auth === `Bearer ${rejectAccess}`) return new Response("unauthorized", { status: 401 });
      return json({ data: inbox.map((id) => ({ message_id: id })) });
    }
    return json({});
  }
  throw new Error(`unexpected fetch ${url}`);
};

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail });
}

// ── steady state: inbox unchanged → cron must not write ─────────────────────────────
{
  const kv = new FakeKV({
    auth_bundle: JSON.stringify({ access: "a1", refresh: "r1" }),
    alias_id: meAlias,
    last_seen_msg_id: JSON.stringify(["m3", "m2", "m1"]),
  });
  inbox = ["m3", "m2", "m1"];
  await worker.scheduled({}, { TOKEN_STORE: kv });
  check("idle cron: 0 writes", kv.writes() === 0, `writes=${kv.writes()} ops=${JSON.stringify(kv.ops)}`);
  check("idle cron: 3 reads", kv.count("get") === 3, `reads=${kv.count("get")}`);
}

// ── one new mail → exactly one write, id set extended ──────────────────────────────
{
  const kv = new FakeKV({
    auth_bundle: JSON.stringify({ access: "a1", refresh: "r1" }),
    alias_id: meAlias,
    last_seen_msg_id: JSON.stringify(["m3", "m2", "m1"]),
  });
  inbox = ["m4", "m3", "m2"];
  await worker.scheduled({}, { TOKEN_STORE: kv });
  const seen = JSON.parse(kv.map.get("last_seen_msg_id"));
  check("new mail: 1 write", kv.writes() === 1, `writes=${kv.writes()}`);
  check("new mail: seen contains m4", seen.includes("m4"), JSON.stringify(seen));
  kv.resetOps();
  await worker.scheduled({}, { TOKEN_STORE: kv });
  check("new mail then idle: 0 writes", kv.writes() === 0, `writes=${kv.writes()}`);
}

// ── legacy single-id `seen` value → upgraded to array (one migration write) ────────
{
  const kv = new FakeKV({
    auth_bundle: JSON.stringify({ access: "a1", refresh: "r1" }),
    alias_id: meAlias,
    last_seen_msg_id: "m3", // legacy raw id
  });
  inbox = ["m3", "m2", "m1"];
  await worker.scheduled({}, { TOKEN_STORE: kv });
  const seen = JSON.parse(kv.map.get("last_seen_msg_id") ?? "[]");
  check("legacy seen: one migration write", kv.writes() === 1, `writes=${kv.writes()}`);
  check(
    "legacy seen: upgraded to full id array",
    Array.isArray(seen) && ["m3", "m2", "m1"].every((id) => seen.includes(id)),
    JSON.stringify(seen)
  );
  kv.resetOps();
  await worker.scheduled({}, { TOKEN_STORE: kv });
  check("legacy seen then idle: 0 writes", kv.writes() === 0, `writes=${kv.writes()}`);
}

// ── legacy token keys + 401 → migrated into auth_bundle, old keys removed ──────────
{
  const kv = new FakeKV({
    access_token: "old_access",
    refresh_token: "old_refresh",
    alias_id: meAlias,
    last_seen_msg_id: JSON.stringify(["m1"]),
  });
  inbox = ["m1"];
  rejectAccess = "old_access";
  await worker.scheduled({}, { TOKEN_STORE: kv });
  const ops = kv.ops.map(([o, k]) => `${o}:${k}`);
  const bundle = JSON.parse(kv.map.get("auth_bundle") ?? "null");
  check("migration: bundle written", bundle?.access === "new_access" && bundle?.refresh === "new_refresh", JSON.stringify(bundle));
  check("migration: legacy keys deleted", !kv.map.has("access_token") && !kv.map.has("refresh_token"), ops.join(","));
  check("migration: exactly 2 writes (lock + bundle)", kv.writes() === 2, `writes=${kv.writes()} ops=${ops.join(",")}`);
  check("migration: 3 deletes (lock + 2 legacy)", kv.count("delete") === 3, ops.join(","));
  rejectAccess = null;
}

// ── token refresh in bundle mode → 2 writes, 1 delete, one auth exchange ──────────
{
  const kv = new FakeKV({
    auth_bundle: JSON.stringify({ access: "old_access", refresh: "r1" }),
    alias_id: meAlias,
    last_seen_msg_id: JSON.stringify(["m1"]),
  });
  inbox = ["m1"];
  rejectAccess = "old_access";
  authCalls = 0;
  await worker.scheduled({}, { TOKEN_STORE: kv });
  check("bundle refresh: 2 writes (lock + bundle)", kv.writes() === 2, `writes=${kv.writes()} ops=${JSON.stringify(kv.ops)}`);
  check("bundle refresh: 1 delete (lock)", kv.count("delete") === 1, `deletes=${kv.count("delete")}`);
  check("bundle refresh: auth called once", authCalls === 1, `authCalls=${authCalls}`);
  rejectAccess = null;
}

for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : "  ->  " + r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
