# CLICKQUOTA — BÁO CÁO NGHIỆM THU STREAMING ENGINE & ANTI-LAZY (2026-10-29)

| Thuộc tính | Giá trị |
|---|---|
| Phạm vi | 21 model ClickUp × OpenAI (`/v1/chat/completions`) + Anthropic (`/v1/messages`) × stream/non-stream |
| Kết quả | **STRESS BENCH ALL PASS: 84/84 combinations** · Full regression **228/228** · FOCUS 67/67 · SMOKE_OK |
| Harness | `test/stress-benchmark.test.mjs` — 5 bước benchmark mỗi combination, mock upstream zero-trust |
| Deploy | pm2 restart `clickquota` — live probe xác nhận tool call thật |

## 1. Streaming & Tool-Call Architecture

**Module mới `src/providers/clickup/sse-emitter.mjs`:**
- `sliceSafeUtf8` — không cắt đôi surrogate pair (tiếng Việt/emoji) trong mọi delta.
- `ensureValidArgsJson` — Stream Finalizer: JSON hỏng (thiếu ngoặc, bọc fence) được auto-repair bằng `repairJsonBuffer` trước khi đóng block; client không bao giờ nhận `partial_json` lỗi cú pháp.
- `emitOpenAiToolCallDeltas` — Protocol-exact OpenAI delta: chunk mở đầu `{index, id, type:"function", function:{name, arguments:""}}` → argument deltas từng phần (parallel calls index tăng dần) → chunk riêng `finish_reason:"tool_calls"` → `[DONE]`.
- `normalizeToolChoice` + `toolChoiceDirective` — `tool_choice` từ cả 2 giao thức: `none` (bỏ card + tắt parse), `required`/`any` (client directive), named (ép tool cụ thể).

**Zero-Leak:** nhánh không-calls phát text qua `stripPseudoToolMarkup` — markup `<invoke>`/`<tool_call>`/khối `<system>` bịa không bao giờ leak vào content; nhánh có-calls chỉ phát `preText` (text trước marker).

**Seamless Continuation (Anti-Lazy, Yêu cầu 3):** Pre-Commit Inspector dùng `checkAntiStallStoppage` (27+ pattern Intent-to-Act). Khi có tools + 0 tool call + intent detected → ĐÚNG 1 hidden follow-up upstream với ghi chú `[CONTINUATION]` trung lập (model TỰ quyết định phát tool call — gateway không bao giờ tự bịa, kế thừa ràng buộc an toàn 2026-10-27). Heartbeat giữ sống qua continuation (chạy trước `cleanup()`). Cap 1 lần — model vẫn hứa suông thì stream text gốc bình thường.

**flush mode:** `?flush=1` / `x-flush: 1` — delay 0, chunk 4096 (TTFT thấp nhất có thể; lưu ý cấu trúc: upstream ClickUp non-streaming nên TTFT tối thiểu = thời gian upstream trả completion, đây là giới hạn phía nguồn).

**Long-context:** lịch sử tool_call/tool_result serialize giữ `tool_call_id` + `is_error` (B2/B4/B5 harness kiểm chứng với tool_result 400 dòng + needle đầu/giữa/cuối).

## 2. Model-by-Model Verification Matrix (84/84 PASS)

Mỗi dòng = 4 combinations (OpenAI Stream / OpenAI Non-Stream / Anthropic Stream / Anthropic Non-Stream), mỗi combination gồm đủ 5 bước B1–B5: **PASS**.

| Model ID | OAI Stream | OAI Non-Stream | ANT Stream | ANT Non-Stream | Long-Context (B2/B5) | Anti-Lazy (B3) | Final |
|---|---|---|---|---|---|---|---|
| super-agent-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| super-agent-builder-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-6-astra-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-6-luna-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-6.1-sol-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-5.6-terra-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-5.6-luna-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-opus-5-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-opus-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-opus-4-6-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-sonnet-5-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-3-7-sonnet-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-haiku-5-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| claude-haiku-4-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| google/gemini-4-argon-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| google/gemini-3.8-flash-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| google/gemini-3.5-flash-lite-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| global.anthropic.claude-opus-5-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| global.anthropic.claude-opus-5-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| gpt-4o-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |
| brain-CL | PASS | PASS | PASS | PASS | PASS | PASS | **PASS** |

Bằng chứng tự động: `node --test --test-reporter=tap test/stress-benchmark.test.mjs` → `[STRESS BENCH] ALL PASS: 84/84 combinations` (log lưu `scratch/bench-run.log`).

## 3. Files Created / Modified

| File | Thay đổi |
|---|---|
| `src/providers/clickup/sse-emitter.mjs` | **MỚI** — sliceSafeUtf8, ensureValidArgsJson, emitOpenAiToolCallDeltas, normalizeToolChoice, toolChoiceDirective |
| `src/providers/clickup/upstream.mjs` | OpenAI delta emission, Anthropic repair + sliceSafe mọi delta loop, tool_choice gate, Seamless Continuation (stream + non-stream), flush mode, parse guard toolParsingEnabled |
| `src/providers/clickup/tools.mjs` | EXECUTION MODEL block trong prompt card (từ fix trước, phục vụ anti-lazy) |
| `test/stress-benchmark.test.mjs` | **MỚI** — harness 84 combinations × 5 bước |
| `test/intent-and-tool-healing.test.mjs` | Prompt Card test khóa khối EXECUTION MODEL |
| `test/safety-explicit-only.test.mjs` | Parser SSE theo chuẩn OpenAI delta; expectedUpstreamCalls promise=2 (continuation) |

## 4. Fix loop đã chạy (Bước 3 — Stress Test & Fix Loop)

1. `repairJsonBuffer` import sai nguồn → chuyển sang `tools/json-repair.mjs`.
2. `url is not defined` trong upstream (flushMode) → dùng `req.url`.
3. Safety test parser SSE cũ không hiểu delta → viết lại gom theo index (chuẩn client OpenAI).
4. Harness mock origin thiếu port → `ECONNREFUSED :80` → origin = base có port.
5. Harness assert `index` cho non-stream (chuẩn OpenAI non-stream không có index) → assert theo mode.
6. Harness key mismatch `stopReason`/`finishReason` → chuẩn hóa trong callGateway.

Kết quả cuối: **0 fail trên 84/84 benchmark + 228/228 regression.**
