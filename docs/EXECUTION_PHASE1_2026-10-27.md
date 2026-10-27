# BIÊN BẢN NGHIỆM THU TRIỂN KHAI GIAI ĐOẠN 1
## KHÓA SUY DIỄN TOOL CALL TỪ VĂN XUÔI & CHUẨN HÓA GIAO THỨC AN TOÀN

| Thuộc tính | Giá trị nghiệm thu |
|---|---|
| **Dự án** | ClickQuota — Enterprise Multi-Workspace AI Gateway |
| **Giai đoạn** | Giai đoạn 1 (Phase 1): Strict Explicit Tool Calling & Prose Hallucination Lock |
| **Ngày thực hiện** | 2026-10-27 |
| **Trạng thái nghiệm thu** | `PHASE1_ACCEPTED_LOCAL` |
| **Trạng thái triển khai** | `NOT_DEPLOYED` (Chỉ nghiệm thu local; không restart gateway, không gọi live ClickUp) |
| **Môi trường thực thi** | Node.js `v24.19.0`, PowerShell `7.6.5`, Windows 11 (Non-Git workspace) |
| **Cơ chế an ninh mạng** | `scripts/net-guard.mjs` cưỡng bức chặn mọi egress ngoài loopback (`127.0.0.1`, `localhost`) |

---

## 1. Tóm tắt mục tiêu & Quyết định kỹ thuật

### 1.1. Vấn đề giải quyết
Trong phiên bản trước, `src/providers/clickup/tools.mjs` chứa hàm `detectAndRecoverIdlePromise`:
- Khi model sinh văn xuôi chứa từ khóa kế hoạch, cảnh báo hoặc lời từ chối (ví dụ: `"Plan: Don't run git push, it's risky; run command only after approval."`), regex tách từ đơn đã ngắt chuỗi sai tại dấu nháy đơn (`'`) của từ `"Don't"`, dẫn tới việc tự động tổng hợp một tool call `Bash` với command rác nguy hiểm: `"t run git push, it"`.
- Đồng thời, cơ chế Anti-Stall Rescue turn trong `src/providers/clickup/upstream.mjs` ép buộc model:
  `"You MUST invoke the appropriate tool using Format A or Format B right now to execute your action!"`, khiến model bị ép phải bịa lệnh shell ngay cả khi đang từ chối hoặc cần người dùng xác nhận.

### 1.2. Quyết định kỹ thuật đã chốt và thực hiện
1. **Khóa 100% tự động suy diễn lệnh từ văn bản tự do:**
   - Hàm `detectAndRecoverIdlePromise` trong `tools.mjs` được hạ cấp thành no-op (luôn trả về `null`), giữ nguyên export công khai để bảo vệ tính tương thích ngược của API module.
   - Xóa bỏ hoàn toàn hàm `looksLikeWindowsTarget` cùng toàn bộ logic trích xuất Regex Case 1 (đọc file), Case 2 (chạy command), Case 3 (quét thư mục/mã nguồn).
2. **Gỡ bỏ khối ép gọi tool trong Gateway Upstream:**
   - Xóa bỏ khối gọi `detectAndRecoverIdlePromise` tại cả hai luồng xử lý: Streaming (SSE) và Non-Streaming.
   - Thay thế câu lệnh cứu hộ Anti-Stall cứu nguy (Rescue Turn) bằng chỉ thị trung lập, an toàn:
     `"Review the user's request and your previous response. If the task requires a tool and its arguments are known, emit a supported explicit tool-call format. If you are refusing, warning, advising, or need clarification, respond with text. Do not invent a command, a path, or authorization."`
3. **Chỉ chấp nhận Tool Call có cấu trúc tường minh:**
   - Format A: Chuẩn JSON `{"tool_calls": [...]}`
   - Format B: Tool Call XML `<tool_call>{...}</tool_call>`
   - Format C: Single call JSON `{"name": "...", "arguments": {...}}`
   - Format D: Bracket syntax `[Tool Call: Name({...})]`
   - AntML: Thẻ XML `<invoke name="...">...</invoke>`

---

## 2. Toàn vẹn mã nguồn & Bảng băm SHA-256

Mọi thay đổi được kiểm soát chặt chẽ thông qua băm mật mã SHA-256 trước và sau khi can thiệp:

| Tệp tin | SHA-256 Trước can thiệp | SHA-256 Sau can thiệp | Trạng thái |
|---|---|---|---|
| `src/providers/clickup/tools.mjs` | `E9291224025F80CB2EE20BC7B43D186AB228437F12485C148D9611CB87666D66` | `B0CA9A83345B4056E569642FA9CD8D96E23B14B7529E61C127018B69E0F0F7D4` | Khớp 100% bản vá đã chốt |
| `src/providers/clickup/upstream.mjs` | `C3555805A9330E95D6AF1A3F2AE7710EA6E54AB612BD6733CF22E0F27B9D979B` | `2D1076E8B680032B9E43E938E6CC115EB62EB081CF672BAE795BB08685A65128` | Khớp 100% bản vá đã chốt |
| `test/safety-explicit-only.test.mjs` | *(Tạo mới)* | `38B33995B71F51C934856D0EEC956D675515C5F70368725916EC1DC39A6E9E4B` | 45 test an toàn & regression |
| `scratch/sop-phase1/run.mjs` | *(Tạo mới)* | `0F27C114E10EE310A305D641ABC34BE88002C6AB0BFDF4C95EFA885B9E83BF30` | Runner cách ly môi trường |
| `scripts/net-guard.mjs` | `F898827EAE6281B5ECE3BAD906E99260CB8C94A0E545A631FE3725921324AF8D` | `F898827EAE6281B5ECE3BAD906E99260CB8C94A0E545A631FE3725921324AF8D` | Nguyên vẹn, không chỉnh sửa |
| `scratch/sop-phase1/tools.mjs.before` | `E9291224025F80CB2EE20BC7B43D186AB228437F12485C148D9611CB87666D66` | *(Bảo lưu nguyên trạng)* | Checkpoint phục hồi |
| `scratch/sop-phase1/upstream.mjs.before` | `C3555805A9330E95D6AF1A3F2AE7710EA6E54AB612BD6733CF22E0F27B9D979B` | *(Bảo lưu nguyên trạng)* | Checkpoint phục hồi |

---

## 3. Quy trình thực nghiệm & Kết quả kiểm chứng 5 Cổng

Quá trình thực thi diễn ra theo đúng quy trình TDD & Zero-Trust Sandbox:
1. **Sandbox cách ly hoàn toàn:** Toàn bộ test được chạy trên bản sao chép thư mục tạm thời (`os.tmpdir()`), tự động lọc sạch toàn bộ biến môi trường nhạy cảm (`TOKEN`, `COOKIE`, `SECRET`, `API_KEY`) và tiêm cờ `--import=net-guard.mjs` để chặn hoàn toàn kết nối ra ngoài.
2. **Không ghi đè cấu hình sản xuất:** Tập tin `.state/clickup_config.json` trong workspace thật được bảo vệ nguyên vẹn; runner sử dụng file config rỗng tại thư mục tạm.

### Bảng tổng hợp 5 Cổng kiểm chứng:

| Cổng kiểm chứng | Lệnh thực thi | Tổng số test | Đạt (Pass) | Lỗi (Fail) | Đánh giá & Bằng chứng xác nhận |
|---|---|---:|---:|---:|---|
| **1. Baseline** | `node scratch/sop-phase1/run.mjs baseline` | 59 | 52 | 7 | Xác lập mốc ban đầu trước khi sửa code. 7 lỗi là các test phụ thuộc mạng ClickUp ngoài. |
| **2. Red Phase** | `node scratch/sop-phase1/run.mjs red` | 45 | 21 | 24 | Chạy suite kiểm thử an toàn mới trên mã nguồn cũ. Phát hiện chính xác 24 lỗi tổng hợp tool sai, bao gồm `SAFETY01 unit warning_with_stall`. |
| **3. Focused Phase** | `node scratch/sop-phase1/run.mjs focus` | 45 | 45 | 0 | Chạy suite kiểm thử an toàn trên mã nguồn đã vá. **100% test an toàn vượt qua**. |
| **4. Full Regression** | `node scratch/sop-phase1/run.mjs full` | 104 | 97 | 7 | Kiểm thử toàn diện toàn bộ dự án. **Không phát sinh bất kỳ lỗi mới nào**. 7 lỗi còn lại trùng khớp 100% với danh sách Baseline. |
| **5. Smoke Alert** | `node scratch/sop-phase1/run.mjs smoke` | 1 | 1 | 0 | Kiểm tra khả năng khởi động của Telegram notifier khi không có config. Thoát mã 0, không rò rỉ secret. |

---

## 4. Chi tiết 45 Ca kiểm thử An toàn (Focused Suite)

### 4.1. 8 Ca kiểm thử Đơn vị (Unit Tests)
- `SAFETY01`: `"Plan: Don't run git push, it's risky; run command only after approval."` &rarr; `detectAndRecoverIdlePromise` trả về `null` (Loại bỏ triệt để lỗi tách từ tại dấu nháy đơn `'` của `"Don't"`).
- `SAFETY02`: `"Plan: I cannot execute `npm test`."` &rarr; `null` (Không diễn giải lệnh trong backtick của câu từ chối).
- `SAFETY03`: `"Plan: You should run command "npm test" only after approval."` &rarr; `null` (Không diễn giải câu khuyến nghị/lời khuyên).
- `SAFETY04`: `"Plan: I will run command "npm test" now."` &rarr; `null` (Không tự tổng hợp tool từ lời hứa hẹn trong tương lai).
- `SAFETY05`: `"I will read C:\repo\package.json now."` &rarr; `null` (Không tự động mở file từ lời nói suông).
- `SAFETY06`: `"Let me inspect the project structure now."` &rarr; `null` (Không tự động chạy `dir` hoặc `ls`).
- `SAFETY07`: `"Tôi sẽ đọc C:\repo\package.json ngay bây giờ."` &rarr; `null` (Không tổng hợp tool từ lời hứa tiếng Việt).
- `SAFETY08`: `"Plan: Execute "git status" after the user approves."` &rarr; `null` (Không diễn giải lệnh chờ phê duyệt).

### 4.2. 36 Kịch bản Ma trận HTTP (Integration Matrix)
Ma trận gồm: 2 Endpoint (`/v1/messages`, `/v1/chat/completions`) &times; 2 Giao thức (Non-Stream JSON, SSE Stream) &times; 9 Kịch bản phản hồi:
1. Cảnh báo kèm stall keyword &rarr; 0 tool calls, HTTP 200, stop reason chuẩn (`stop` / `end_turn`).
2. Từ chối kèm backtick &rarr; 0 tool calls, HTTP 200.
3. Lời khuyên kèm command &rarr; 0 tool calls, HTTP 200.
4. Hứa chạy command &rarr; Kích hoạt Anti-Stall Rescue an toàn, 0 tool calls được tự bịa.
5. Hứa đọc file path &rarr; Kích hoạt Anti-Stall Rescue an toàn, 0 tool calls được tự bịa.
6. Chuẩn JSON Format A (`{"tool_calls": [...]}`) &rarr; Trích xuất đúng 1 tool call `Bash("printf safety-ok")`.
7. Bracket Format D (`[Tool Call: Bash(...)]`) &rarr; Trích xuất đúng 1 tool call `Bash("printf safety-ok")`.
8. XML Format B (`<tool_call>{...}</tool_call>`) &rarr; Trích xuất đúng 1 tool call `Bash("printf safety-ok")`.
9. AntML (`<invoke name="Bash">...`) &rarr; Trích xuất đúng 1 tool call `Bash("printf safety-ok")`.

---

## 5. Giải trình Danh mục 7 Lỗi tồn đọng từ Baseline

Trong cả hai lần chạy `baseline` (59 test) và `full` (104 test), hệ thống ghi nhận đúng 7 ca thất bại đã biết trước:

1. `two raw cookies with different user IDs become two distinct accounts`
2. `adding the same cookie twice updates instead of duplicating`
3. `cookies without identity claims do not collide on the same millisecond`
4. `workspaceId and initialToken survive persist and init roundtrip`
5. `Account isolation (no network, no state writes)`
6. `3. Auto-Recreate với 2 Cookie Tài khoản Mẹ: Tu dong x2 so luong workspace va kich MAX 23`
7. `Multi-Account Ingestion, x2 Quota Auto-Recreate, and Load Balancing`

**Nguyên nhân kỹ thuật đã xác nhận:**
- 7 ca kiểm thử này thuộc về module quản lý tài khoản ClickUp đa người dùng (`account-isolation.test.mjs` và `multi-account-loadbalance.test.mjs`).
- Các test này yêu cầu gửi yêu cầu HTTP thực tế tới máy chủ ClickUp thật (`https://api.clickup.com` và `https://id.app.clickup.com`) để xác minh cookie hoặc tạo workspace thật.
- Cơ chế `net-guard.mjs` chủ động chặn toàn bộ các kết nối ra ngoài này (`NETGUARD BLOCKED: outbound connection to ...`). Đây là hành vi bảo mật đúng thiết kế, đảm bảo kiểm thử cục bộ không can thiệp hoặc làm biến đổi dữ liệu thực tế trên tài khoản mẹ.

---

## 6. Hướng dẫn SOP Xác minh Nhanh trong 5 Giây (Micro-step SOP)

### Thao tác 1: Xác minh tính an toàn độc lập (Focus Test)
- **Input:** Terminal tại thư mục gốc `C:\Users\hacke\Desktop\ClickQuota`.
- **Exact Action:**
  ```powershell
  node scratch/sop-phase1/run.mjs focus
  ```
- **Expected Output:**
  ```text
  FOCUS_OK tests=45 pass=45 fail=0
  ```
- **Verify:** Dòng log xuất hiện `FOCUS_OK` và mã thoát của tiến trình bằng 0.

### Thao tác 2: Kiểm tra băm toàn vẹn file (Integrity Check)
- **Input:** PowerShell.
- **Exact Action:**
  ```powershell
  (Get-FileHash -Algorithm SHA256 .\src\providers\clickup\tools.mjs).Hash -eq 'B0CA9A83345B4056E569642FA9CD8D96E23B14B7529E61C127018B69E0F0F7D4' -and (Get-FileHash -Algorithm SHA256 .\src\providers\clickup\upstream.mjs).Hash -eq '2D1076E8B680032B9E43E938E6CC115EB62EB081CF672BAE795BB08685A65128'
  ```
- **Expected Output:**
  ```text
  True
  ```
- **Verify:** Kết quả trả về `True`.

---

## 7. Kết luận & Trạng thái Triển khai

- **Nghiệm thu Giai đoạn 1:** `PHASE1_ACCEPTED_LOCAL` — Lỗ hổng bảo mật suy diễn lệnh shell từ văn xuôi tự do và ép gọi tool call đã được vá triệt để và chứng minh bằng 45 ca kiểm thử an toàn tự động.
- **Trạng thái Triển khai:** `NOT_DEPLOYED` — Bản vá hiện lưu trữ an toàn trong working tree cục bộ. Chưa khởi động lại tiến trình gateway, chưa kích hoạt live test trên ClickUp thật, và không có thay đổi nào được push ra môi trường bên ngoài.
