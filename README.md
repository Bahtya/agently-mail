# agently-mail — agent.qq.com on Cloudflare Workers

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![status: live-verified](https://img.shields.io/badge/status-live--verified-brightgreen)](https://agently-mail.bahtyar153.workers.dev/me)

**Live worker:** <https://agently-mail.bahtyar153.workers.dev> ｜ **API docs:** [`API.md`](./API.md) ｜ **Status:** reverse-engineered & live-verified 2026-07-07

---

Drives Tencent **Agently Mail** (`@agent.qq.com`) directly from a Cloudflare Worker:
receive (list / read / search) + send (two-phase). Reverse-engineered from
`@tencent-qqmail/agently-cli` v1.0.7 and **verified live on 2026-07-07** against the
real `api.agent.qq.com` / `auth.agent.qq.com`.

**Verdict: feasible & verified.** The server enforces only `Authorization: Bearer` on
`/v1/*`. No TLS fingerprinting, no request signing, no websocket, no binary attestation.
The exact `curl` calls below were run successfully from a Termux device — a Worker's
`fetch()` is the same thing.

## Verified protocol (live, not guessed)

| Call | Shape |
|---|---|
| **Device-flow init** | `POST https://auth.agent.qq.com/oauth/device?func=1` body `{cli_agentname,cli_agentua,cli_hostname,cli_ua,cli_version}` → `{poll_url, browser_url, input_code, expires_in:600}` |
| **Device-flow poll** | `GET <poll_url>` (`…?func=2&device_code=…`) → `authorization_pending` until scan, then `{status:"authorized", app_id, access_token, refresh_token, expires_in:3600}` |
| **Refresh** | `POST https://auth.agent.qq.com/oauth/token` form-encoded `grant_type=refresh_token&refresh_token=…&client_id=cli_002e8cd1e54a3889&clientversion=1.0.7` → `{access_token, refresh_token, expires_in}`. **No app_secret.** Rotates refresh_token. |
| **Data** | `GET/POST https://api.agent.qq.com/v1/...` with header `Authorization: Bearer <access_token>` only. |
| **Send (2-phase)** | `POST /v1/aliases/{aid}/messages/send` (no token) → `{error:{code:"CONFIRMATION_REQUIRED", details:{confirmation_token:"ctk_…", operation_summary}}}`. Re-POST **same body + `confirmation_token`** → `{queued:true}`. |

`client_id` = `cli_002e8cd1e54a3889` — **public**, embedded in the CLI binary, same for everyone.
**No app_secret exists/needed** (contrary to the binary's vestigial struct tags).

## 获取 agent.qq.com 的 token(三种方法)

device flow 的核心是人扫微信二维码,**只需做一次**。目标:拿到 `access_token` + `refresh_token`
两个值(都不长期固定:access 约 1 小时过期、refresh 每次刷新轮换;Worker 部署后会自动维护,你不用管)。

### 方法 A:`agently-cli` 二进制(普通 macOS / Linux / Windows)

```bash
npm i -g @tencent-qqmail/agently-cli
agently-cli auth login      # 打开链接 → 微信扫码授权
agently-cli +me             # 确认登录成功
```
登录后 token 存进系统 keychain。要拿**明文**喂给 Worker,从 keychain 取;或更省事——直接用方法 B。
> ⚠️ **Termux / Android 上此二进制无法完成登录**:它在 `openSystemBrowser` 里调 `faccessat2`,
> 被 Android seccomp 拦 → `SIGSYS` 崩溃,且 `BROWSER=` 救不了(LookPath 先于它执行)。所以 Termux 上用方法 B。

### 方法 B:原始 device-flow `curl`(任何机器,含 Termux)— 推荐

```bash
# 1) 发起 device flow,记下返回里的 device_code
curl -s -X POST 'https://auth.agent.qq.com/oauth/device?func=1' \
  -H 'content-type: application/json' \
  -d '{"cli_agentname":"Claude Code","cli_agentua":"claude","cli_hostname":"localhost","cli_ua":"agently-cli/1.0.7","cli_version":"1.0.7"}'
# 返回: {"poll_url":"...?func=2&device_code=dc_xxx","browser_url":"...","input_code":"ic_xxx","expires_in":600}
# → 打开 browser_url,微信扫码授权(device_code 600 秒内有效)

# 2) 轮询拿 token
curl -s 'https://auth.agent.qq.com/oauth/device?func=2&device_code=dc_xxx'
# 未授权: {"status":"pending",...}
# 已授权: {"status":"authorized","app_id":"cli_002e8cd1e54a3889","access_token":"...","refresh_token":"...","expires_in":3600}
```
记下 `access_token` 和 `refresh_token`。(`app_id` 即公开常量 client_id,无需特别记。)

### 方法 C:已有 token 直接注入(`AGENTLY_ACCESS_TOKEN`)

若已从别处拿到 access_token(如 CLI keychain 导出),用 `agently-cli` 时设
`AGENTLY_ACCESS_TOKEN=<token>` 可跳过登录。但此法**只有 access_token、无 refresh_token**,
Worker 无法长期刷新,仅适合临时验证。

## 部署到 Cloudflare

```bash
wrangler kv:namespace create TOKEN_STORE      # 把返回的 id 填进 wrangler.jsonc
wrangler deploy
```

### 写入 token 到 KV(⚠️ Termux 上的坑)

`wrangler kv key put` 在 Termux/Android 上会 spawn workerd 子进程而失败(`Error: spawn …/workerd`)。
**改用 Cloudflare REST API** 直接写 KV(账号信息见 `wrangler whoami` / `wrangler kv namespace list`):

```bash
ACCT=<Account ID>                 # wrangler whoami
NS=<TOKEN_STORE 的 namespace id>  # wrangler kv namespace list
TOK="$CLOUDFLARE_API_TOKEN"       # wrangler 登录后此环境变量已设

curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/values/access_token?expiration_ttl=3600" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: text/plain" --data-binary "<access_token>"

curl -X PUT "https://api.cloudflare.com/client/v4/accounts/$ACCT/storage/kv/namespaces/$NS/values/refresh_token" \
  -H "Authorization: Bearer $TOK" -H "Content-Type: text/plain" --data-binary "<refresh_token>"
```
> `access_token` 加 `expiration_ttl=3600` 让 KV 自动过期(Worker 遇 401 会用 refresh_token 重刷并写回)。
> `refresh_token` 不设 TTL(长期有效,每次刷新轮换)。

### 设 Worker 自身鉴权密钥(API_TOKEN)+ 重置

```bash
python3 -c "import secrets;print(secrets.token_hex(32))" > .api_token   # 256-bit 共享密钥
wrangler secret put API_TOKEN < .api_token
wrangler deploy
# 丢了就重新生成、put、deploy;调用方用新 token(见 API.md)。
```

## Use

```
GET  /me
POST /list       {"limit":10,"dir":"inbox"}
POST /read       {"id":"msg_…"}
POST /search     {"q":"report","search_in":"SEARCH_IN_SUBJECT"}
POST /send       {"to":["a@b.com"],"subject":"Hi","body":"<b>hi</b>"}        → phase 1 (token+summary)
POST /send/confirm {"msg":{…same…},"confirmation_token":"ctk_…"}            → phase 2 (queued)
```

Cron `*/2 * * * *` polls the inbox and logs new `message_id`s (wire a Queue/webhook to
push to your agent).

## The one real risk — 已验证通过

**Cloudflare 出口 IP 信誉 vs 腾讯大陆 WAF**(服务器会设 `mmlas-verifyresult` 风控头)。
**已于 2026-07-07 实测:从 Cloudflare 边缘 `curl <worker>/me` 返回正常 `{"data":{...}}`,
未触发 403/429/timeout** —— CF 默认出口能直连 `api.agent.qq.com`。

若日后腾讯收紧风控导致 403/429/超时,解法:Cloudflare **Dedicated Egress IPs**
或经 CN 友好 VPS 中转。验证命令:`curl -H "Authorization: Bearer $API_TOKEN" <worker>/me`。
