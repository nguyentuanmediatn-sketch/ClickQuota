# BÁO CÁO ĐIỀU TRA KỸ THUẬT & KIẾN TRÚC PROXY CHO CLICKUP UPSTREAM

**Ngày:** 2026-10-29 · **Phạm vi:** Toàn bộ provider ClickUp trong ClickQuota (`src/providers/clickup/*`, `src/server.mjs`, protocols, tools) + thực nghiệm live probing trực tiếp GraphQL gateway + phân tích 3.304 request thật trong `.state/logs/` (24–29/10).

**Phương pháp:** (1) Static audit toàn bộ mã nguồn provider; (2) Live probe qua gateway local (`/v1/chat/completions`, `/v1/messages`) và probe **trực tiếp** GraphQL `frontdoor-search.clickup-sg.com/graphql/gateway` bằng token mint từ pool; (3) Forensic log traffic production 5 ngày. Scripts probe lưu tại `scratch/probe-http.mjs`, `probe-direct.mjs`, `probe-direct2.mjs`, `probe-direct3.mjs`, `probe-quota-diag.mjs`; kết quả JSON tại `scratch/probe-*-results.json`.

> Lưu ý vận hành: toàn bộ probe dùng tài khoản ClickUp của pool (21 workspace / 2 account). ClickUp ToS không cho phép dùng Brain API ngoài app — đây là rủi ro chấp nhận trước của hệ thống; báo cáo tối ưu kỹ thuật trong khuôn khổ đó, không khuyến khích mở rộng quy mô tài khoản.

---

## TRỤ CỘT 1 — MODEL INVENTORY & BẢN CHẤT UPSTREAM

### 1.1. Endpoint & xác thực (đo trực tiếp, confirmed)

| Thành phần | Giá trị đo được |
|---|---|
| Gateway GraphQL | `https://frontdoor-search.clickup-sg.com/graphql/gateway` (region SG, behind CloudFront — header `via: 1.1 …cloudfront.net`) |
| Token exchange | `GET https://api.clickup.com/v2/sd/team/{teamId}/access-token` với `Authorization: Bearer <session JWT>` → `{ accessToken, origin, expiresIn }` (TTL mặc định 300s, gateway cache với margin 30s) |
| Mint session token | `POST https://id.app.clickup.com/data/v3/workspaces/{workspaceId}/authentication/access_tokens` (body rỗng, `Cookie` account + optional `Authorization: Bearer cu_refresh`) → `{ token, expiration, attachment_token }`, **rotate Set-Cookie** phải merge lại cookie account |
| Refresh | `POST https://id.app.clickup.com/auth/v1/refresh` (Bearer refresh-token hoặc Cookie mode) |
| User inventory | `GET https://frontdoor-prod-ap-southeast-1-1.clickup.com/user/v1/user?include_teams=true` |
| Quota/entitlement | GraphQL query `GetAIEntitlements` (daily `ai_fair_use_daily_limit` = 450.000, weekly = 1.125.000, `checkFairUseBlocked(feature:"ai_request")`, reset `00:00 UTC` = 07:00 VN — đo `resetsAt: 2026-10-30T00:00:00.000Z`) |
| Headers bắt buộc | `authorization: Bearer <gateway token>`, `Origin: https://app.clickup.com`, `Referer: https://app.clickup.com/`, `clickup-surface: client`, `clickup-client-version: 3.83.0` |
| Rate-limit | Theo workspace (429 streak → cooldown 30/120/300s trong pool), fair-use theo workspace + ẩn (xem 1.4); concurrency thực tế giới hạn bởi pool: `maxConcurrentPerWorkspace = 3` |

### 1.2. Model ID hợp lệ ở upstream (live matrix 27 ID, 30 request)

**HỢP LỆ (16)** — `AIRequest` trả completion:
`gpt-6-astra` · `gpt-6-luna` · `gpt-6.1-sol` · `gpt-5.6-terra` · `gpt-5.6-luna` · `claude-opus-5-5` · `claude-opus-5` · `claude-opus-4-6` · `claude-sonnet-5-5` · `claude-haiku-5-5` · `google/gemini-4-argon` · `google/gemini-3.8-flash` · `google/gemini-3.5-flash-lite` · `global.anthropic.claude-opus-5-5` · `global.anthropic.claude-opus-5` · `gemini-2.5-pro` (bất ổn định — 1 OK / 4 lần thử, xem 1.3)

**KHÔNG HỢP LỆ (10 + fake)** — trả `INTERNAL_SERVER_ERROR` (serviceName `ai`), **không phải** `ai_model_disabled`:
`super-agent` · `super-agent-builder` · `brain` · `gpt-4o` · `gpt-4o-mini` · `gpt-5.4` · `claude-3-7-sonnet` · `claude-haiku-4-5` · `claude-sonnet-4-5` · `o3` · `totally-fake-model-xyz`

**Bản chất phía sau model ID:** ClickUp Brain là **trạm định tuyến multi-vendor** (GPT/Anthropic/Gemini) — payload nhận `model` + `selectedModel`, trả `completionString` + `reasoning` (reasoning riêng biệt, giả lập dạng OpenAI o-series). Không có bằng chứng fine-tune riêng; hành vi văn bản khớp base model tương ứng. `super-agent(-builder)` **không phải model ID** cho `CHAT_COMPLETION` — là khái niệm agent phía app (500 khi ép vào field `model`).

### 1.3. Bất ổn định & ẩn

- `gemini-2.5-pro`: matrix 1 lần OK (1.19s), 3 lần thử sau đó đều 500 ISE → **không đưa vào fallback chain**.
- `claude-haiku-5-5`: hợp lệ và nhanh nhất trong đợt probe (1.16s cho tiny prompt) — ứng viên **Fast/Summarizer tier** chưa được khai thác (traffic thật chỉ 1 request).
- `/v1/models` của gateway quảng cáo 33 ID (21 ClickUp + 12 Muse); nhiều ID ClickUp trong danh sách là **alias chết** ở upstream (super-agent, brain, gpt-4o…) nhưng vô hại qua gateway vì `resolveClickUpModel()` ánh xạ gần hết về `claude-opus-5-5` / `google/gemini-4-argon`.

### 1.4. PHÁT HIỆN QUAN TRỌNG NHẤT — Hạn mức ẩn & entitlement "nói dối"

Workspace `1100380000020790` ("ZCode Test's Workspace"):
- `GetAIEntitlements` → `checkFairUseBlocked: false`, `daily.usage: 0`, `dailyLeft: 450000`, `weekly.usage: 0`.
- Nhưng **mọi** `AIRequest` trên workspace này → `USAGE_QUOTA_EXCEEDED` (HTTP 200 + GraphQL errors array).
- Workspace khác **cùng account** (`1100320000021072`) chạy bình thường → hạn mức ẩn này **theo workspace**, không theo account, và **không hiển thị** trong entitlement query.

Hệ quả trực tiếp cho pool hiện tại (bug chu kỳ): `fetchWorkspaceQuota()` thấy entitlement "available" → mở cooldown → balancer đẩy request vào workspace chết → `USAGE_QUOTA_EXCEEDED` → cooldown tới nửa đêm → 15 phút sau audit revival lại… lặp vô hạn, đốt 1 vòng failover mỗi chu kỳ. Đây là nguồn một phần 48 error thật của `claude-opus-5-5` trong log.

---

## TRỤ CỘT 2 — WIRE PROTOCOL & PAYLOAD MECHANICS

### 2.1. Request (đo trực tiếp)

```graphql
query AIRequest($type: AIRequestType!, $input: JSONObject!) {
  aiRequest(type: $type, input: $input) {
    completionString
    reasoning
    errors
  }
}
```
```json
{
  "operationName": "AIRequest",
  "variables": {
    "type": "CHAT_COMPLETION",
    "input": {
      "model": "claude-opus-5-5",
      "selectedModel": "claude-opus-5-5",
      "prompt": "<lượt hiện tại>",
      "text": "<giống prompt>",
      "messages": [{ "role": "user|assistant", "content": "..." }],
      "workspaceId": "1100320000021072",
      "maxTokens": 8192
    }
  }
}
```

Đã kiểm chứng bằng controlled experiment:
- **KHÔNG gửi field `tools`** — gửi → `INTERNAL_SERVER_ERROR` (không tools control → 200). Upstream không có native tool-calling.
- **KHÔNG gửi field `system`** — được nhận (200) nhưng **im lặng bỏ qua** (system "trả lời tiếng Pháp" → output tiếng Anh). System prompt phải nằm trong `messages[0]` role user hoặc `prompt`.
- `messages` chỉ nhận vai `user`/`assistant` phẳng (không role `system`, `tool`); tool_use/tool_result phải serialize thành văn bản `<tool_call>`/`<tool_result>` — gateway đã làm đúng điều này (`serializeMessageContent`).
- `AIRequestType`: chỉ `CHAT_COMPLETION` hợp lệ. `TOOLS_COMPLETION` → 500 ISE kể cả với model hợp lệ.
- `maxTokens`: giá trị lớn (32k) không gây lỗi nhưng vô nghĩa vì bức tường 29s (2.3).

### 2.2. Response & Streaming

- Response là **một JSON duy nhất** — `content-type: application/json`, không `transfer-encoding: chunked`, không SSE, không WebSocket. **Upstream KHÔNG streaming.**
- Trường dữ liệu: `data.aiRequest.completionString` (văn bản trả lời), `data.aiRequest.reasoning` (reasoning tách riêng — gateway bọc `<thinking>` cho client), `data.aiRequest.errors` (mảng; `USAGE_QUOTA_EXCEEDED`, `AI_MODEL_DISABLED`, `FAIRUSEBLOCKED`…), `errors` (GraphQL-level, kèm `extensions.code` `INTERNAL_SERVER_ERROR`).
- Metadata: không có citations/usage/token counts — gateway tự ước lượng bằng `gpt-tokenizer/o200k_base`.
- **SSE phía client là giả lập**: gateway nhận đủ JSON rồi bơm typewriter (chunk 20–64 ký tự / 5–18ms; `?flush=1`/`x-flush:1` → chunk 4096 / delay 0). Đo cadence thực: TTFT client 16ms (heartbeat `: ping` 3s/lần), gap P90 1469ms (chờ upstream), sau đó burst chunk liên tiếp. Header `x-proxy-upstream-provider: clickup` + `x-proxy-upstream-model` gắn ở cả stream lẫn non-stream.

### 2.3. Sơ đồ luồng hiện tại

```
Client (Claude Code/Cline/ZCode…)
   │ POST /v1/messages | /v1/chat/completions | /v1/responses   (SSE thật từ phía client)
   ▼
ClickQuota server (4310) ── key-store, IDE detect, tool_choice normalize
   │ flatten messages → prompt-card tools → sanitize (45000/msg, budget 120k chars)
   ▼
clickupPool.acquire ── load balancer đa tầng (in-flight, queue, burst, cross-account, quota, LRU)
   │ mint/exchange token (cache 300s, dedupe)
   ▼
POST frontdoor-search.clickup-sg.com/graphql/gateway   ←══ MỘT JSON, KHÔNG stream
   │ parse completionString/reasoning/errors
   │ parseToolCallsFromText (XML/antml/JSON/bracket/Cline/DSML…) → mapper → heal params
   │ [anti-lazy] continuation 1 lần nếu "hứa suông"
   ▼
Typewriter SSE emitter (sliceSafeUtf8, repairJson, OpenAI delta / Anthropic block chuẩn)
```

---

## TRỤ CỘT 3 — TOOL-CALLING & ROOT CAUSE CÁC "BỆNH KINH NIÊN"

### 3.1. Native tool-call: KHÔNG TỒN TẠI

- Field `tools` trong input → 500 cứng (đo). Upstream không nhận OpenAI functions.
- Không có tool hijack trong đường `CHAT_COMPLETION` (model trả lời thẳng: "I can't read README.md because I don't have a read_file tool" khi không có card).
- Cơ chế hiện hành của gateway là đúng và duy nhất khả thi: **prompt card 4 format** (JSON array / `<tool_call>` XML / single JSON / bracket) + parse từ văn bản (`extractTextToolCalls` 9 lớp: tool_use/tool_call XML, antml `<invoke>`, bracket, DSML, `proxy_tool_calls`, Cline tags, Aider diff, `tool_calls` array, bare-JSON với guard 70% dominance) + parameter healing + bắt buộc resolve vào catalog client (an toàn P1-3 đã vá).

### 3.2. Root cause "Hứa suông" (Lazy Promise)

Chuỗi nguyên nhân đo được:
1. Model base (Claude/GPT) có "assistant reflex" — nói kế hoạch thay vì phát call khi prompt card không đủ cứng. Card hiện tại đã có khối `EXECUTION MODEL` (đúng hướng).
2. System prompt riêng của Brain không can thiệp đường này (không thấy dấu vết persona ClickUp trong completionString khi prompt card bật) — bệnh không đến từ ClickUp Brain override.
3. Không có stop-sequence/pre-fill ở upstream — gateway không thể ép token-level; **bắt buộc** dùng lớp ứng dụng. Hiện trạng: `checkAntiStallStoppage` 27+ pattern intent-to-act + hidden continuation `[CONTINUATION]` cap 1 lần — verified bằng stress bench 84/84 (B3 anti-lazy). Hướng còn thiếu: continuation hiện gửi nguyên payload + note; nên kèm directive `toolChoice` (đã có sẵn `toolChoiceDirective` — nối vào continuation để tăng tỷ lệ phát call).

### 3.3. Root cause mất ngữ cảnh / JSON hỏng khi hội thoại dài

- **Cắt cụt giữa tool-call JSON**: prompt lớn + maxTokens thấp → JSON tool call bị đứt → parser mất arguments → model đứng chờ result → "diễn kịch". Đã vá 2026-10-28 (sàn 4096 khi prompt > 16k tokens) — đúng gốc rễ.
- **sanitize budget 120k chars (~30k tokens)**: thấp hơn nhiều so với capacity thật của upstream (đo ≥ 1.9 triệu chars ≈ 475k tokens vẫn OK). Khi hội thoại dài, gateway tự nén trước khi upstream kịp tận dụng — đây là nguồn cảm giác "mất ngữ cảnh" nhiều hơn lỗi upstream.
- **Bức tường 29 giây (phát hiện mới, đo 5/5 lần):** generation vượt ~29s → upstream trả `completionString: ""` **không kèm error, không partial**. Trigger là thời gian sinh, không phải `maxTokens` (control 1→300 với maxTokens 4096 → OK 4.8s; long-gen bất kể maxTokens 1024/4096/8192/16384 → empty đúng 29.1s; xảy ra trên cả opus-5-5 lẫn gpt-6.1-sol). Đây là nguyên nhân sâu xa của các "completion rỗng" mà code fallback/compaction đã cố vá mù mờ.
- So sánh với **ZCode/GLM-5.3 (zcode-api)**: upstream Z.AI là Anthropic Messages passthrough — SSE token thật, tool_use native, system prompt thông suốt, concurrency 1/account. Toàn bộ tầng "giả lập" của ClickQuota (typewriter, text→toolcall, continuation) là **bắt buộc riêng cho ClickUp** vì upstream degrade; không phải lỗi thiết kế gateway.

---

## TRỤ CỘT 4 — GIỚI HẠN KỸ THUẬT (SỐ LIỆU ĐO THỰC TẾ)

| Hạng mục | Giá trị đo | Ghi chú |
|---|---|---|
| Input max (upstream) | **≥ 1.900.000 chars (~475k tokens) PASS** (60k→1.9MB đều trả đúng `SIZE-OK`/`BIG-OK`) | Chưa chạm trần; gateway tự cap 2 MiB body (`readBody`) + budget 120k chars |
| Input latency theo size | 60k=1.9s · 120k=3.8s · 240k=4.4s · 480k=8.4s · 900k=8.2s · 1.4MB=21s · 1.9MB=10.6s | Không tuyến tính hoàn toàn (shard?) |
| Max output | **Bức tường ~29s generation** → empty completion, không partial, không error | Trên opus-5-5 & gpt-6.1-sol; bất kể maxTokens. Ước tính trần thực dụng ~1.5–2k token output liên tục cho opus |
| TTFT thật (traffic 5 ngày, n=27 đo được) | p50 6.7s · p90 25.1s · max 28.1s (opus-5-5) | = thời gian upstream trả JSON (non-streaming) |
| Duration (traffic thật) | opus: p50 9.5s / p90 28.4s / max 147.8s · sol: p50 37.2s / max 118s · luna: p50 143.9s · sonnet-5-5: p50 68s · gemini-4-argon: p50 19.2s | Duration = chờ upstream + typewriter + (có thể) retry chain |
| Throughput hiệu dụng | opus ~21 tok/s end-to-end (n=493) · sol ~5.4 · gemini-4-argon ~2.2 (sample nhỏ) | ước từ output_tokens/duration |
| Lỗi thật 5 ngày | 782 request thật: 56 error (opus 48, gemini 2, other 6) — 7.2%; tổng log 3.304 entry (phần còn lại là mock test) | status thật 100% 200 ở lượt cuối (failover) |
| Rate limit | 429 theo workspace; pool cooldown 30/120/300s theo streak; chưa thấy 429 IP-level | bursts 66 req/2h không gây 429 |
| Quota khai báo | daily 450.000 / weekly 1.125.000, reset 00:00 UTC (07:00 VN) | **+ hạn mức ẩn theo workspace không hiển thị** (1.4) |
| Concurrency | 3/workspace (pool), pacing 45ms + burst penalty; token exchange TTL 300s | Token exchange đôi khi 500 `SHARD_PROXY_ON_ERR` (2 ws trong audit) — transient |
| Timeout | upstream request timeout gateway 120s; server.requestTimeout 180s | Đủ, vì upstream tự cắt ở ~29s đối với generation dài |

---

## TRỤ CỘT 5 — SWOT TỪNG MODEL (tổng hợp traffic thật + probe trực tiếp)

| Model (upstream ID) | Tốc độ (đo) | Độ tin cậy | Vai trò khuyến nghị |
|---|---|---|---|
| `claude-opus-5-5` | DUR p50 9.5s, ~21 tok/s, TTFT p50 6.7s | 488/536 (91%) — lỗi phần lớn do pool/quota, không phải model | **MAIN coding/agentic** — giữ nguyên làm xương sống (đang đúng) |
| `gpt-6.1-sol` | chậm: p50 37.2s, ~5.4 tok/s | 87/87 (100%) | **Sub-agent/Summarizer nền** — chạy ngầm, không interactive |
| `google/gemini-4-argon` | p50 19.2s (real), 6.2s (direct tiny) | 8/10 real | Fast-tier dự phòng; giữ fallback cuối cho gemini alias |
| `claude-haiku-5-5` | **nhanh nhất** (1.2–1.4s tiny) | 2/2 | ⭐ **Đề xuất: Fast/Summarizer/Tier-3** (title-gen, compaction, routing) — chưa khai thác |
| `claude-opus-5`, `global.anthropic.claude-opus-5(-5-5)` | 46–93s (sample nhỏ) | 8/8 | Fallback bậc 2 cho opus-5-5 khi empty (khả năng route shard khác né tường 29s — cần A/B) |
| `gpt-6-astra`, `gpt-5.6-terra`, `gpt-5.6-luna` | 1.0–1.9s tiny | 5/5 | Sẵn sàng, chưa có workload — đánh giá thêm trước khi giao vai |
| `gpt-6-luna` | **rất chậm** (p50 143.9s) | 3/3 | Chỉ fallback cuối; loại khỏi main path |
| `claude-sonnet-5-5` | chậm (p50 68s) | 8/8 | Fallback (đang đúng vị trí này) |
| `gemini-2.5-pro` | — | 1/4 (ISE) | **Loại bỏ** — bất ổn định |
| `super-agent(-builder)`, `brain`, `gpt-4o`, `claude-3-7-sonnet`, `claude-haiku-4-5`, `gpt-5.4`, `gpt-4o-mini`, `claude-sonnet-4-5`, `o3` | 500 ISE khi dùng raw | — | Chỉ tồn tại như alias gateway → `opus-5-5`; xóa khỏi `/v1/models` hoặc đánh dấu alias |

Tỷ trọng traffic thật 5 ngày: opus-5-5 79.4% · gemini-4-argon 7.6% · sol 16.7% (real subset) — cấu hình vai trò hiện tại của gateway về cơ bản đúng.

---

## TRỤ CỘT 6 — KIẾN TRÚC PROXY TỐI ƯU (BLUEPRINT)

Nguyên tắc nền: upstream ClickUp là **GraphQL non-streaming, không tools, có tường 29s, quota hai lớp**. Mọi tối ưu phải xoay quanh 4 chân đế đó; không cố "ép" nó thành OpenAI native.

### 6.1. Khắc phục hạn mức ẩn (P0 — đang gây lỗi chu kỳ)

- **Canary quarantine:** workspace dính `USAGE_QUOTA_EXCEEDED` dù entitlement "available" ≥ 2 lần trong 30 phút → đánh dấu `stickyBlocked` 24h; chỉ `fetchWorkspaceQuota` canary 1 request/60 phút mới được mở lại. Sửa tại `pool.mjs` (`reportError`, `fetchWorkspaceQuota`).
- Không cho audit mở cooldown workspace có lỗi AIRequest gần nhất < 30 phút.

### 6.2. Sống chung với tường 29s (P0)

- **Clamp maxTokens mặc định 8192 → 2048** cho lượt đầu (output thực dụng của opus trong 29s); giữ 4096 sàn cho tool-call lớn như hiện tại.
- Trong `executeClickUpWithFallback`: khi candidate trả **empty sau ≥ 25s** → retry ngay candidate đó với `maxTokens=1024` + directive "trả lời gọn, chia nhỏ thành nhiều tool call" **trước khi** đổi model (đổi model không chữa được vì tường là chung).
- Client directive trong prompt card cho các tác vụ dài: *"When producing files longer than ~300 lines, emit multiple write/append tool calls instead of one giant block."*
- Thử nghiệm `claude-opus-5` / `global.anthropic.claude-opus-5` làm candidate bậc 2 (route shard khác có thể có ngưỡng riêng).

### 6.3. Tool-call: giữ kiến trúc hiện tại, siết 2 điểm (P1)

- Kiến trúc prompt-card + multi-format parser + healing + client-side validation là đúng optimum cho upstream này — **không thay đổi**.
- Nối `toolChoiceDirective()` vào continuation note (hiện continuation chưa mang directive required/named → tăng tỷ lệ phát call ở lượt ngầm).
- Chống JSON hỏng đã đủ 3 lớp (repair khi parse, healing param, `ensureValidArgsJson` khi emit) — giữ.

### 6.4. Ngữ cảnh: khai thác capacity thật (P1)

- Tăng `sanitizeMessagesForUpstream` budget **120k → 300k chars** (~75k tokens): upstream đo được nhận ≥ 475k tokens; giữ chiến lược giữ-first(message 0 chứa tools card) + rolling-recent + sàn cắt từng message 45k.
- Nén ngữ cảnh chủ động (compaction) chỉ khi tổng > budget; cân nhắc dùng `claude-haiku-5-5` làm máy tóm tắt rẻ/nhanh thay vì bỏ tin nhắn.
- `/v1/models`: tách rõ nhóm `alias` (raw id 500) để client không tưởng là model thật.

### 6.5. Streaming & TTFT (P2)

- Chấp nhận TTFT floor = thời gian upstream (không thể thấp hơn với non-streaming source). Đã có `flush=1` — tích hợp mặc định cho client agent (header `x-flush:1`) thay vì typewriter 5–18ms.
- Giữ heartbeat 3s; cân nhắc gửi trước `response.created` + khối thinking placeholder **chỉ khi** `reasoning` được trả (hiện reasoning chỉ có sau khi đủ JSON — không stream được, giữ nguyên).

### 6.6. Cân bằng tải & failover (giữ nguyên nền tảng, bổ sung nhỏ)

- Balancer đa tầng hiện tại (in-flight/queue/burst/cross-account/quota/LRU + session affinity 12h) đã vượt chuẩn so với nhu cầu upstream — giữ.
- Bổ sung: failover **không retry cùng model khi lỗi là INTERNAL_SERVER_ERROR invalid-model** (phân biệt bằng `extensions.code` thay vì message) — tránh đốt attempt vô ích; đưa `claude-opus-5` vào chuỗi fallback opus.

### 6.7. Soi 参考 ZCode/GLM-5.3 (zcode-api)

| Khía cạnh | ClickUp upstream | ZCode (GLM-5.3) |
|---|---|---|
| Giao thức | GraphQL `AIRequest`, 1 JSON | Anthropic Messages passthrough |
| Streaming | Không (giả lập) | SSE token thật |
| Tools | Không — prompt-card + parse text | tool_use native |
| System prompt | Bị ignore qua field; phải nhồi messages | Thông suốt |
| Context | ≥ 475k tokens (đo) | ~200k chuẩn |
| Concurrency | 3/workspace × N workspace | 1/account |
| Điểm chết | Tường 29s, quota ẩn, ISE thay vì 4xx | 3012/3009 → cooldown account |

Kết luận: hai provider bổ sung vai trò — ClickUp cho context cực dài + dự phòng pool lớn; GLM cho interactive agentic chất lượng giao thức. Không hợp nhất cơ chế tool; mỗi provider giữ transport riêng.

---

## KẾ HOẠCH HÀNH ĐỘNG (ROADMAP)

**P0 — trong ngày (chặn lỗi thật đang chạy):**
1. Sticky-quarantine workspace quota-ẩn (`pool.mjs`: `reportError` + guard trong `fetchWorkspaceQuota`). Kiểm chứng: workspace 0790 không còn được chọn; không còn chu kỳ error 15 phút.
2. Clamp `maxTokens` mặc định 2048 + retry-lower-maxTokens khi empty ≥ 25s (`upstream.mjs`: `handleClickUpRequest`, `executeClickUpWithFallback`).
3. Xóa/đánh dấu alias-dead khỏi `/v1/models` (`upstream.mjs: CLICKUP_MODELS`).

**P1 — trong tuần:**
4. Budget 300k chars cho `sanitizeMessagesForUpstream` + test hồi quy long-context (mở rộng `test/stress-benchmark`).
5. Nối `toolChoiceDirective` vào continuation; A/B tỷ lệ tool-call phát thành công trước/sau.
6. Thêm `claude-opus-5` vào fallback opus; thêm `claude-haiku-5-5` làm máy title/summarize.
7. Phân biệt lỗi `extensions.code=INTERNAL_SERVER_ERROR` (invalid model) → fail model ngay không retry workspace.

**P2 — cải tiến liên tục:**
8. Telemetry: log riêng `upstreamWaitMs` (tách khỏi typewriter) + đếm empty-completion theo model để theo dõi tường 29s theo thời gian.
9. Thu thập TTFT/success cho `gpt-6-astra`, `gpt-5.6-*` với workload thật để mở rộng tier.
10. Canary script định kỳ (dùng lại `scratch/probe-direct*.mjs`) chạy hằng ngày — phát hiện sớm model ID bị retire hay thay đổi hành vi.

**Đã kiểm chứng đi kèm báo cáo:** `node --test` regression 228/228 (docs trước), stress bench 84/84 (bench-run.log), live probe HTTP 5/5 pass, live matrix 30 request upstream — toàn bộ bằng chứng lưu `scratch/probe-*-results.json`.
