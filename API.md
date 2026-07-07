# agently-mail Worker — 调用文档

代理腾讯 Agently Mail(`bahtyar@agent.qq.com`)的收发能力。所有请求必须带共享密钥鉴权。

## 接入

| | |
|---|---|
| **Base URL** | `https://agently-mail.bahtyar153.workers.dev` |
| **鉴权** | `Authorization: Bearer <API_TOKEN>`(每个请求都要) |
| **请求体** | 除 `GET /me` 外,均 `POST` + `application/json` |
| **无/错 token** | 返回 `401 Unauthorized` |

```bash
export API_TOKEN="<你的共享密钥>"        # 见下方"获取密钥"
export BASE="https://agently-mail.bahtyar153.workers.dev"
```

> Token 即 worker secret `API_TOKEN`。**忘了就重置**:`wrangler secret put API_TOKEN < 新token文件` 后 `wrangler deploy`。
>
> ⚠️ 这是 **Worker 自身的**密钥,不是 agent.qq.com 的 token。Worker 后端的 `access_token`/`refresh_token`
> 怎么拿、怎么写进 KV,见 **README.md「获取 agent.qq.com 的 token」**(三种方法 + Termux 注意事项)。

---

## 1. 当前账号 `GET /me`

返回别名、scope、配额、附件限制。`alias_id` 由 Worker 自动解析并缓存,调用方不用管。

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" $BASE/me
```

```jsonc
{ "data": { "aliases": [{ "alias_id": "alias_…", "email": "bahtyar@agent.qq.com", "is_primary": true }],
            "rate_limits": { "requests_per_minute": 10, "requests_per_hour": 200, "daily_send_quota": 50 },
            "constraints": { "max_attachment_size_bytes": "20971520", "max_attachment_count": 50 } } }
```

## 2. 列邮件 `POST /list`

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"limit":10,"dir":"inbox"}' $BASE/list
```

| 字段 | 说明 |
|---|---|
| `limit` | 每页条数,最大 50 |
| `dir` | `inbox` \| `sent` \| `trash` \| `spam` |
| `cursor` | 翻页:用上一页返回的 `pagination.next_cursor` |

返回 `data[]`(摘要:`message_id`/`subject`/`snippet`/`from`/`is_read`/`created_at`)+ `pagination.{has_more,next_cursor}`。

## 3. 读全文 `POST /read`

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":"msg_xxx"}' $BASE/read
```

返回 `data.{body, body_format, from, to, cc, bcc, attachments[], created_at, …}`。
大附件无 `attachment_id`,改用 `download_url`(直接给用户);普通附件有 `attachment_id`。

## 4. 搜索 `POST /search`

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"q":"报告","search_in":"SEARCH_IN_SUBJECT","limit":10}' $BASE/search
```

| 字段 | 说明 |
|---|---|
| `q` | 关键词(必填) |
| `search_in` | `SEARCH_IN_ALL` \| `SEARCH_IN_SUBJECT` \| `SEARCH_IN_CONTENT` |
| `limit` / `cursor` | 同 list;翻页时**必须带上原来的 `q`** |

## 5. 发邮件(两阶段)`POST /send` → `POST /send/confirm`

agent.qq.com 要求二次确认:第一次请求返回 `confirmation_token` + 摘要(此时**尚未投递**);第二次带 token 才真正发。

**Phase 1 — 请求确认:**

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "to": ["alice@example.com"],
    "cc": [],
    "bcc": [],
    "subject": "你好",
    "body": "<p>来自 agently-mail Worker</p>",
    "body_format": "HTML",
    "attachments": []
  }' $BASE/send
```

```jsonc
{ "phase": 1,
  "confirmation_token": "ctk_xxxxxxxx-xxxx-…",
  "summary": { "action": "send", "from": "bahtyar@agent.qq.com", "to": ["alice@example.com"], "subject": "你好" } }
```

**Phase 2 — 提交投递**(把 Phase 1 的**原 msg 原样**放进 `msg`,加上 `confirmation_token`):

```bash
curl -s -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{
    "msg": {
      "to": ["alice@example.com"], "cc": [], "bcc": [],
      "subject": "你好", "body": "<p>来自 agently-mail Worker</p>",
      "body_format": "HTML", "attachments": []
    },
    "confirmation_token": "ctk_xxxxxxxx-xxxx-…"
  }' $BASE/send/confirm
```

```jsonc
{ "phase": 2, "queued": true }
```

`queued:true` 即已进投递队列。`confirmation_token` 约 3 分钟过期,过期需重新 Phase 1。

### 收件人 / 正文 / 附件字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `to` / `cc` / `bcc` | `string[]` | 邮箱地址数组(可空 `[]`) |
| `subject` | string | 主题 |
| `body` | string | 正文,最大 1MB |
| `body_format` | `"HTML"` \| `"PLAIN"` | 大写 |
| `attachments` | `object[]` | `{filename, content_type, size, sha1(hex), content(base64)}`;最大 50 个 / 共 20MB |

---

## 内部行为说明

- **Token 自动刷新**:access_token 约 1 小时过期;遇 `401` Worker 自动用 refresh_token 刷新(`refresh_token` 每次轮换,Worker 自动落回 KV)。调用方无感。
- **配额**:10 请求/分钟、200/小时、每日发信 50 封(agent.qq.com 侧限制,非 Worker)。
- **常驻收件推送**:当前 cron 关闭。需要新邮件推送时,在 `wrangler.jsonc` 加 `"triggers":{"crons":["*/2 * * * *"]}` 并在 `scheduled()` 里接 Queue/webhook。
- **底层**:Worker 透传到 `https://api.agent.qq.com/v1/...`,只加 `Authorization: Bearer <agent.qq access_token>`,无签名。

## 获取共享密钥 `API_TOKEN`

首次部署时已生成并存为 worker secret。本地若保存过 `.api_token` 文件即是。若丢失,重置:

```bash
python3 -c "import secrets;print(secrets.token_hex(32))" > .api_token
wrangler secret put API_TOKEN < .api_token
wrangler deploy
```
