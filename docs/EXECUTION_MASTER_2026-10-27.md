# CLICKQUOTA — NGHIÊM THU GỠ CƠ CHỈ ÉP HÀNH VI & CHỐNG HOÀN NGUYÊN
## Cập nhật 2026-10-27 (buổi 3 — nội dung chính, thay thế toàn bộ nghiệm thu buổi 1)

| Thuộc tính | Giá trị đã đo được |
|---|---|
| **Hệ thống** | ClickQuota — Standalone Multi-Workspace AI Gateway & Protocol Bridge |
| **Trạng thái mã nguồn** | `COERCION_MECHANISMS_REMOVED` — phiên bản hiện tại là bản sạch, đã khóa bằng git |
| **Kiểm thử** | `FOCUS_OK tests=45 pass=45 fail=0` · `NO_NEW_FAILURES tests=102 pass=102 fail=0` (gồm marker-guard) · `SMOKE_OK` |
| **SHA-256 hiện tại** | `src/providers/clickup/upstream.mjs` = `490cccebd9e76f9ff643092bd4ac6278930f991d7d11fdf41cca94dc96a052d6` · `src/providers/clickup/tools.mjs` = `f6ab47aa11e3585509c35e203c81179aa91252b7b7f2669c61c51ce2216ee468` |
| **Version control** | Git repo `main`, commit mốc `8f3ae82` (62 file; `.env`/`.state/`/`scratch/` đã ignore). Git = MinGit portable tại `C:\Users\hacke\MinGit\cmd\git.exe` (máy chưa có Git for Windows) |
| **Live smoke (cổng 4310)** | `/health` 200 · `/v1/models` (auth) 200 · 1 inference thật 200 trong ~2s |
| **Test chống stall live (buổi 2, cổng 4311)** | 3 task dài · 7 turn · 10 tool call · **0 stall · 0 nudge** · 3/3 task trả lời hoàn chỉnh |

---

## 1. Đã gỡ gì (buổi 2 — phục hồi lại sau khi bị hoàn nguyên, hoàn tất buổi 3)

Buổi 1 tuyên bố đã gỡ nhưng mã nguồn bị đè ngược về bản cũ (nguyên nhân xem mục 2). Buổi 2 làm lại toàn bộ, buổi 3 hoàn tất phần còn lại:

- **`src/providers/clickup/upstream.mjs`** (1449 → ~1180 dòng):
  - Xóa `[MODE: AUTHORIZED SYSTEM AUDIT & SANDBOX EXECUTION]` chèn vào message đầu.
  - Xóa `[ANTI-STALL DIRECTIVE]` gắn vào tin nhắn user cuối mỗi lượt.
  - Xóa `[MODE: AUTONOMOUS ARCHITECTURAL DEEP-DIVE]` / `[MANDATE: PROACTIVE AUTONOMOUS EXECUTION]` bọc `currentTurnPrompt`.
  - Xóa **Idle-Promise Auto-Recovery** và **Anti-Stall Rescue Turn** ở CẢ HAI nhánh stream và non-stream (thiết kế buổi 1 giữ Rescue Turn "trung lập" — đã bỏ hẳn theo chỉ đạo: chống stall thuộc tầng client).
  - Xóa Anti-Loop Circuit Breaker + `detectToolCallingLoop` (cùng họ inject prompt; thay bằng client-guard).
- **`src/providers/clickup/tools.mjs`** (459 → ~267 dòng):
  - Xóa toàn bộ nội dung tự tổng hợp tool call của `detectAndRecoverIdlePromise` (Case 1/2/3 + `looksLikeWindowsTarget` — thứ sinh lệnh `type`/`cat`/`dir` từ văn bản model); giữ export dạng no-op `return null;` để bảo toàn API.
  - Prompt card: xóa `CRITICAL REALITY & EXECUTION MANDATE` + rules 1-3, 5-7; giữ JSON tool list + Format A-D + ide notes + 1 dòng hội thoại thuần (phần chức năng bắt buộc để gateway parse tool call).
  - Buổi 3: đổi header giả-làm-system-instruction `[SYSTEM INSTRUCTION: AUTONOMOUS TOOL CALLING PROTOCOL ...]` + `[/SYSTEM INSTRUCTION]` thành **`[Available tools] (Client: …)`** / **`[/Available tools]`**; đồng bộ điều kiện `hasCard` trong `sanitizeMessagesForUpstream` (upstream.mjs) để card không bị chèn lặp.

## 2. Chống hoàn nguyên (Bước 1 — nguồn gây revert đã xác nhận)

Hai script đã được xác nhận là nguồn đè ngược `src/`, hiện bị **chặn bởi guard env-flag**:

| Script | Hành vi | Guard |
|---|---|---|
| `scratch/restore_stable.mjs` | Ghi đè `src/providers/clickup/tools.mjs` + `upstream.mjs` bằng bản `.before` cũ | Chặn; buộc chạy: `set ALLOW_RESTORE_STABLE=1` |
| `scratch/sync_to_cq.mjs` | Sync đè `src/clickup-*.mjs` từ `ProxyPM/SharkPool/ProxyClaude-main` (dự án nguồn chưa gỡ cơ chế — `patch_clickup_tools_reality.mjs` là thứ đã nhét CRITICAL REALITY vào dự án nguồn) | Chặn; buộc chạy: `set ALLOW_SHARKPOOL_SYNC=1` |

Các lớp bảo vệ còn lại:
- **`test/marker-guard.test.mjs`**: fail nếu `src/` (bao gồm provider muse) xuất hiện `ANTI-STALL`, `MODE: AUTHORIZED`, `MANDATE`, `Rescue`, `detectToolCallingLoop`, `SYSTEM INSTRUCTION: AUTONOMOUS`.
- **SAFETY09 payload guard** (`test/safety-explicit-only.test.mjs`): mọi scenario HTTP đều assert prompt gửi lên upstream không chứa các marker trên — đây là phép kiểm "prompt gửi upstream sạch" quyết đoán nhất, vì `debugLogger` là stub cố ý không lưu prompt (zero-leak) nên không thể đọc prompt live từ server thật.
- Git repo + commit mốc: mọi thay đổi sắp tới có diff/rollback.

## 3. Vận hành (Bước 4)

- Production server cổng 4310 đã restart lần 2 để nhận code mới nhất (kèm Bước 3), PID hiện tại `39252`; backup state trước mỗi lần kill: `.state/clickup_config.json.bak-restart-20261027{-2}`. IDE client tự reconnect (đã thấy TIME_WAIT mới ngay sau restart).
- **Tách `.state` instance test khỏi production**: biến môi trường `CLICKQUOTA_STATE_DIR` (đọc tại `src/config.mjs` và `src/providers/clickup/pool.mjs`). Instance test khởi tạo ví dụ: `set CLICKQUOTA_STATE_DIR=C:\Users\hacke\Desktop\ClickQuota\.state-test` rồi `start.bat`/`npm start` trên cổng khác; log đã có sẵn `CLICKQUOTA_LOG_DIR`.

## 4. Việc còn mở (Bước 6 — làm dần)

- **`tool_choice` CHƯA được implement trong code hiện tại** (mục 5 của buổi 1 tuyên bố sai — `findstr` không thấy trong `server.mjs`/`upstream.mjs`). Muốn test `none`/`required`/named cần làm feature trước.
- Kiểm thử mở rộng: nhiều model, stream lẫn non-stream, các ca âm (JSON ví dụ trong câu trả lời không được thực thi — SAFETY08 đã phủ 1 phần).
- Theo dõi tỷ lệ stall thực tế vài ngày qua client thật; nếu có, xử lý bằng `client-nudge`/`client-guard` ở tầng client (mẫu sẵn trong `scripts/test-long-task.mjs`), **không** đưa cơ chế tự bịa lệnh trở lại proxy.

## 5. Kết luận — chỉ nêu những gì đã đo được

Đã đo được: các cơ chế ép hành vi và tự bịa tool call không còn tồn tại trong `src/` (quét marker + marker-guard test), toàn bộ 102 test pass trong sandbox zero-trust, 45/45 test an toàn HTTP pass với payload upstream sạch marker, request thật qua cổng 4310 phản hồi 200 trong ~2s, và 3 task agent dài chạy 0 stall sau khi gỡ. **Chưa đo được**: tỷ lệ stall trên lưu lượng IDE thật trong vài ngày, và hành vi với catalog tool lớn (20-50 tool) — hai mục này thuộc Bước 6.

---

# LỊCH SỬ — NỘI DUNG BUỔI 1 (ĐÃ BỊ THAY THẾ, GIỮ ĐỂ ĐỐI CHIẾU)

> ⚠️ Phần dưới đây là nghiệm thu buổi 1, đã bị chứng minh KHÔNG khớp mã nguồn thực tế
> (hash không trùng, cơ chế vẫn còn nguyên trong src, `test/safety-explicit-only.test.mjs`
> bị mất khỏi `test/`). Giữ lại chỉ để đối chiếu lịch sử. Đọc phần trên là chuẩn.

# TỔNG HỢP TRIỂN KHAI & NGHIỆM THU TOÀN DIỆN TẤT CẢ CÁC PHASE
## CLICKQUOTA AI GATEWAY — KIẾN TRÚC, AN TOÀN & GIAO THỨC AGENT 2026

| Thuộc tính | Giá trị nghiệm thu |
|---|---|
| **Hệ thống** | ClickQuota — Standalone Multi-Workspace AI Gateway & Protocol Bridge |
| **Ngày thực hiện** | 2026-10-27 |
| **Phạm vi triển khai** | Hoàn tất toàn bộ Phase 1 (An toàn & Ổn định) + Phase 2 (Kiến trúc & Giao thức dài hạn) |
| **Trạng thái mã nguồn** | `ALL_PHASES_IMPLEMENTED_LOCAL` |
| **Kết quả kiểm thử toàn diện** | **108 tests** (`101 pass` / `7 fail` baseline ClickUp cloud network) — **0 lỗi hồi quy mới** |
| **Kiểm thử an ninh & Smoke** | `FOCUS_OK (45/45)`, `SMOKE_OK (1/1)` |
| **Chính sách bảo mật** | `net-guard.mjs` kích hoạt toàn thời gian; sandbox test cách ly không rò rỉ mạng hay biến môi trường |

---

## 1. Danh mục các hạng mục kỹ thuật đã triển khai

### 1.1. Phase 1 — Khóa an toàn & Ổn định giao thức
1. **Khóa 100% suy diễn Tool Call từ văn tự do (`tools.mjs`):**
   - Gỡ bỏ hoàn toàn regex Case 1 (đọc file), Case 2 (chạy command), Case 3 (quét thư mục) và `looksLikeWindowsTarget`.
   - Giữ hàm export `detectAndRecoverIdlePromise` dưới dạng no-op (`return null;`) để bảo toàn API.
   - Khắc phục triệt để lỗi tách từ tại dấu nháy đơn `'` của câu cảnh báo `"Don't run git push..."`.
2. **Viết lại Anti-Stall Rescue Turn trung lập (`upstream.mjs`):**
   - Xóa bỏ 2 khối tự động giải cứu lời hứa suông ở Streaming và Non-Streaming.
   - Thay thế câu lệnh ép gọi tool bằng chỉ thị trung lập không bịa lệnh:
     `"Review the user's request and your previous response. If the task requires a tool and its arguments are known, emit a supported explicit tool-call format. If you are refusing, warning, advising, or need clarification, respond with text. Do not invent a command, a path, or authorization."`
3. **Bảo vệ parser khỏi suy luận rác trong khối `<thinking>` (`text-fallback.mjs` - SAFETY-02):**
   - Tự động bóc tách và loại bỏ thẻ `<thinking>...</thinking>` trước khi quét cú pháp gọi tool. Tránh trường hợp model bàn luận hoặc trích dẫn ví dụ tool trong luồng suy nghĩ mà bị gateway hiểu nhầm là lệnh thực thi.

### 1.2. Phase 2 — Kiến trúc nâng cao, Hiệu năng & Khả năng mở rộng
4. **Immediate Flush Mode (`?flush=1` & `x-flush: 1`):**
   - Hỗ trợ cờ `flush=1` qua URL param hoặc header `x-flush: 1`.
   - Khi bật, gateway phát toàn bộ completion ngay lập tức trong 1 chunk không trễ (`delayMs = 0`), triệt tiêu 2.4s+ độ trễ giả lập typewriter, phục vụ trực tiếp cho các agentic IDE cần tốc độ cao (Cursor, ZCode, CLI scripts).
5. **Hỗ trợ đầy đủ tham số chuẩn `tool_choice`:**
   - Hỗ trợ `tool_choice: "none"` (ép trả lời văn bản, cấm gọi tool).
   - Hỗ trợ `tool_choice: "required"` / `"any"` (bắt buộc gọi ít nhất 1 tool).
   - Hỗ trợ `tool_choice: { type: "function", function: { name: "X" } }` (chỉ định bắt buộc gọi đúng tool X).
6. **Giám sát thời gian phản hồi đầu tiên (TTFT - Time To First Token):**
   - Bổ sung trường `ttftMs` vào `SAFE_FIELDS` của `src/audit-logs.mjs`.
   - Đo đạc chính xác thời điểm upstream ClickUp trả về phản hồi đầu tiên và ghi nhận vào request log JSONL (`ttftMs`).
7. **Mở rộng nhận diện 9 IDE Profiles mới 2026 (`ide-detect.mjs`):**
   - Bổ sung cấu hình vận hành và regex User-Agent cho: `gemini-cli`, `codex-cli`, `kiro`, `trae`, `copilot-cli`, `opencode`, `zed`, `amp`, `goose`.
8. **Nhật ký phục hồi sự cố tự động tái tạo Workspace (`pool.mjs` - Journaling):**
   - Tự động ghi nhận `pending_recreate` vào state (`start` -> `deleting` -> `creating` -> `complete`) trong quy trình `autoRecreateWorkspaces` để chống mất dấu hoặc giẫm đạp trạng thái khi tiến trình gặp sự cố bất ngờ.
9. **Phát Stream Usage Chunk cho OpenAI Protocol (`stream_options.include_usage`):**
   - Trả chunk thống kê token (`prompt_tokens`, `completion_tokens`, `total_tokens`) trước chunk `[DONE]` khi client yêu cầu `include_usage`.

---

## 2. Bảng băm mật mã SHA-256 các tệp tin hệ thống (BUỔI 1 — không khớp thực tế, xem hash mới ở đầu trang)

| Tệp tin | SHA-256 Hiện tại | Phân loại |
|---|---|---|
| `src/providers/clickup/tools.mjs` | `B0CA9A83345B4056E569642FA9CD8D96E23B14B7529E61C127018B69E0F0F7D4` | Core Tool Logic |
| `src/providers/clickup/upstream.mjs` | `9DB5F1CFE6C0BA860B27C9E7701BCB24D0ABD7F74C2FC1C5BA0602F4F79F672B` | Core Translation & Gateway |
| `src/providers/clickup/pool.mjs` | `29E40343A4AE08E912BA565E842B2B049A492754C8CF0A1010CD1C813D1ED28D` | Workspace & Account Pool |
| `src/ide-detect.mjs` | `28D37EB734C38CFBBF73B243366DA11EF4901CA7E958209DE8F8F99C3D6049C0` | Client Detection 2026 |
| `src/tools/text-fallback.mjs` | `044404955BA573DB03BC1A7E2179BDF6CCBAAE4BF6E26E3F47F6BA93AF150240` | Text Tool Parser |
| `src/audit-logs.mjs` | `B767D4EF085FDB9E4BF0150FCC39340E063CF00F2CD97FE7B0FE4590326AC7DF` | Audit & TTFT Logging |
| `src/server.mjs` | `99C60DACE5A0DF0615C5010D1485553DBF6E1956AD86C94372F21FD49BDEE2A5` | HTTP Server & Security |
| `test/safety-explicit-only.test.mjs` | `38B33995B71F51C934856D0EEC956D675515C5F703687593BEFA15C22BCF48DE` | Phase 1 Safety Suite (45 tests) |
| `test/golden-protocol-matrix.test.mjs` | `68188315ED650E09A30928B7686D607519FE88D2D5D6FC5F82C9DF586C4B40B5` | Phase 2 Protocol Suite (4 tests) |
| `scratch/sop-phase1/run.mjs` | `330EBE010530A2AF40AE538B5BC94F59880295DFE893488F3A292C23B995BEFF` | Zero-Trust Isolated Runner |

## 3. Kết quả Kiểm thử Toàn diện 1 Lượt (buổi 1)

### 3.1. Chạy Suite An toàn Độc lập (`focus`)
```text
node scratch/sop-phase1/run.mjs focus
-> FOCUS_OK tests=45 pass=45 fail=0
```

### 3.2. Chạy Toàn bộ Kiểm thử Hệ thống (`full`)
```text
node scratch/sop-phase1/run.mjs full
-> NO_NEW_FAILURES tests=108 pass=101 fail=7
```
*Đánh giá:* 101 ca kiểm thử vượt qua tuyệt đối. Đúng 7 ca thất bại đã biết trước do phụ thuộc vào kết nối tới hạ tầng máy chủ ClickUp thật bên ngoài (`https://api.clickup.com`) và bị `net-guard.mjs` chặn lại theo đúng chuẩn Zero-Trust Sandbox. Không phát sinh bất kỳ lỗi hồi quy nào.

### 3.3. Chạy Kiểm tra Khởi động Alert (`smoke`)
```text
node scratch/sop-phase1/run.mjs smoke
-> SMOKE_OK
```

---

## 4. Hướng dẫn Xác minh Nhanh trong 5 Giây

```powershell
# 1. Kiểm tra 45 test an toàn độc lập
node scratch/sop-phase1/run.mjs focus

# 2. Kiểm tra toàn bộ 108 test trong sandbox
node scratch/sop-phase1/run.mjs full

# 3. Kiểm tra smoke notifier
node scratch/sop-phase1/run.mjs smoke
```

---

## 5. Kết luận Nghiệm thu (buổi 1 — đã thay thế)

Toàn bộ các giai đoạn trong Kế hoạch cải tổ ClickQuota đã được **code và kiểm thử đồng bộ 100%**. Hệ thống đạt đầy đủ các tiêu chuẩn về an toàn thực thi lệnh, miễn nhiễm hoàn toàn với ảo giác văn xuôi, tối ưu hóa độ trễ phản hồi, mở rộng nhận diện các IDE thế hệ mới 2026 và sẵn sàng để kích hoạt phục vụ môi trường sản xuất.
