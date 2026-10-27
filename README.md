# ClickQuota

Ứng dụng Node.js độc lập, tách ClickUp AI provider từ SharkPool. Cung cấp endpoint OpenAI (`/v1/chat/completions`) và Anthropic (`/v1/messages`), pool nhiều workspace ClickUp có cân bằng tải, và trang Admin để quản lý tài khoản/workspace.

Yêu cầu: Node.js >= 22.15. Dependency runtime duy nhất: `gpt-tokenizer` 4.0.0.

## Chạy

Windows: bấm đúp `start.bat` (file khởi động duy nhất). Script kiểm tra Node >= 22.15, tự chạy `npm ci` nếu thiếu `node_modules`, tạo `.state`, nạp `.env` rồi chạy server.

Hoặc chạy tay:

```powershell
npm ci --omit=dev --ignore-scripts
npm start
```

Địa chỉ mặc định: http://127.0.0.1:4310 (Admin: `/admin`, health: `/health`). Địa chỉ thật được in ở dòng `ClickQuota listening at ..`.

### Copy sang máy khác

Copy cả thư mục (có thể bỏ `node_modules`, máy mới sẽ tự cài; cần có mạng và npm). Muốn bắt đầu sạch thì không copy `.state` và `.env`. Nếu copy `.state` thì cookie/token đi theo, hãy coi đó là bí mật.

## Cấu hình

Sao chép `.env.example` thành `.env` (tùy chọn):

- `CLICKQUOTA_HOST`: mặc định `127.0.0.1`.
- `CLICKQUOTA_PORT`: mặc định `4310`.
- `CLICKQUOTA_API_KEY`: bắt buộc khi bind ra ngoài loopback. Khi có key, gọi API bằng `Authorization: Bearer KEY` hoặc `x-api-key: KEY`. `/health` không cần key.

Trạng thái lưu tại `.state/clickup_config.json` (neo vào thư mục ClickQuota, không phụ thuộc thư mục chạy). Cookie và token lưu dạng plaintext trong file này: hạn chế quyền truy cập thư mục, không commit, không chia sẻ.

## Admin

Mở `/admin`. Từ máy chạy server (loopback) không cần key; từ máy khác phải gửi API key.

- **Thêm tài khoản**: dán chuỗi cookie hoặc lệnh cURL copy từ trình duyệt đã đăng nhập ClickUp. Hệ thống chỉ phân tích chuỗi bằng regex, không chạy lệnh shell. Cần có `cu_refresh` để gia hạn token và để tạo workspace.
- **Thêm workspace** thủ công bằng cURL/token.
- **Auto Recreate Pool**: với mỗi tài khoản, quét danh sách workspace, giữ workspace gốc (đầu tiên), **xóa** các workspace do hệ thống tự sinh cũ (tên khớp `emailprefix_NN` hoặc `zcode_NN`, và tài khoản là chủ sở hữu), tạo workspace mới (mặc định 10 mỗi tài khoản) rồi gọi API kích hoạt trial plan 23. Đây là thao tác thật trên tài khoản ClickUp, hãy dùng có chủ đích.
- Các nút gia hạn token, bật/tắt, xóa cooldown, test model.

API Admin không trả `token`, `cookie`, `cuRefresh`, `refreshToken`, `refreshCookie`, `initialToken`.

## Kết nối, API key và nhật ký

Thẻ **Connection & diagnostics** trên Admin hiển thị URL từ địa chỉ trình duyệt, endpoint đầy đủ, danh sách model từ API và ví dụ cURL có nút copy. Khóa dùng trong phiên Admin lưu trong `sessionStorage`; **Forget session key** xóa khóa của phiên, không xóa khóa server.

Thứ tự ưu tiên khóa server: `CLICKQUOTA_API_KEY` (hoặc `API_KEY`) trong môi trường, bao gồm `.env` được launcher nạp, rồi `.state/admin_settings.json`, cuối cùng là không có khóa. Khóa quản lý bằng Admin được lưu plaintext bằng ghi atomic; bảo vệ file như cookie/token. GET không trả khóa hiện hữu. Khóa sinh mới chỉ hiện một lần trong hộp thoại; đóng hộp thoại sẽ xóa nội dung khỏi giao diện.

Tạo/đổi/xoay khóa yêu cầu kết nối loopback trực tiếp, xác nhận thao tác và khóa hiện tại nếu đã cấu hình. Khóa môi trường không thể đổi qua Admin: sửa môi trường/.env rồi khởi động lại ClickQuota. Không sửa `.env` tự động. Ngoại lệ localhost kiểm tra peer, Host, Origin, Fetch Metadata và từ chối forwarded headers; truy cập qua proxy hoặc máy khác phải xác thực bằng khóa.

- GET `/admin/api/connection`: trạng thái/nguồn khóa, quyền đổi khóa, model; không chứa khóa.
- POST `/admin/api/key`: `action` là `generate`, `rotate` hoặc `set`, cùng `confirm: true`; `set` yêu cầu `key` dài 16–256 ký tự, không có khoảng trắng/control character.
- GET `/admin/api/logs?kind=request|debug`: hỗ trợ `requestId`, `limit` tối đa 200; request hỗ trợ `outcome=success|error|aborted`, debug hỗ trợ `code`.

Log request tại `.state/logs/request-log.jsonl`, debug tại `.state/logs/debug-log.jsonl`. Mỗi loại giữ file hiện tại tối đa 2 MiB và một file xoay `.1`, tổng khoảng 8 MiB cho cả hai loại; bộ nhớ giữ 500 dòng mỗi loại, API đọc tối đa 200. Có thể đặt `CLICKQUOTA_LOG_DIR` để đổi thư mục log. Lịch sử có giới hạn được nạp lại sau restart.

Request log chỉ theo dõi POST chat/messages: request ID, protocol/model, streaming, HTTP status, thời lượng, token ước lượng và kết quả. Lỗi SSE vẫn được đánh dấu lỗi kể cả HTTP 200. Không ghi prompt, response body, query string, cookie, Authorization hay khóa; request tải log không được ghi lại. Admin có hai tab, lọc, làm mới và tạm dừng tự tải.

**Kiểm thử an toàn:** không chạy toàn bộ suite trực tiếp khi dự án có `.state` thật. Một số test cũ import pool trước khi thay fixture và có thể kích hoạt gia hạn token. Dùng bản sao tạm chỉ chứa `src`, `test`, `scripts`, `node_modules`, `package.json`, `package-lock.json`; tạo `.state/clickup_config.json` rỗng (`{"workspaces":[],"accounts":[]}`), không copy `.env`, preload `scripts/net-guard.mjs` qua `NODE_OPTIONS=--import file:///../scripts/net-guard.mjs` rồi chạy suite. `scripts/smoke.mjs` tự tạo bản sao cách ly. Test dùng mock không xác minh ClickUp thật hay giao diện trình duyệt.

## Cảnh báo Telegram

Module `src/alert/` (bus sự kiện `events.mjs` + `telegram-notifier.mjs`). Đặt `TELEGRAM_BOT_TOKEN` và `TELEGRAM_CHAT_ID` trong `.env`; thiếu một trong hai thì module tự tắt, không lỗi, không gọi mạng.

- Cảnh báo khi upstream trả HTTP 429 hoặc 5xx (kể cả khi failover sang workspace khác thành công), khi Circuit Breaker của pool kích hoạt (3 lỗi liên tiếp) và khi workspace đó thoát cách ly.
- Chống spam: cùng workspace + cùng loại sự kiện + cùng mã HTTP chỉ gửi 1 lần mỗi 5 phút.
- Báo cáo định kỳ mỗi `CLICKQUOTA_TELEGRAM_DIGEST_HOURS` giờ (12 hoặc 24, mặc định 24): tổng request chat/messages, số lỗi, số request bị hủy, uptime, latency trung bình. Bộ đếm reset sau mỗi kỳ.
- Tin nhắn chỉ chứa mã băm ngắn của workspace ID, không chứa token, prompt, nội dung lỗi upstream.
- Gửi bất đồng bộ, timeout 5 giây, tối đa 2 request song song, hàng đợi tối đa 100 tin; lỗi gửi bị bỏ qua để không ảnh hưởng request.

Kiểm tra bot: `npm run test:telegram` (hoặc `node --env-file-if-exists=.env test-telegram.mjs`). Exit code 0 khi gửi thành công hoặc chưa cấu hình, 1 khi gửi thất bại.

## Tác vụ nền

Sau khi khởi động:

- Kiểm tra quota toàn bộ workspace sau 3 giây và mỗi 15 phút.
- Mỗi 30 phút gia hạn token còn dưới 6 giờ.
- Nếu toàn bộ workspace bị khóa/hết hạn trial, hệ thống có thể tự kích hoạt Auto Recreate (tối đa một lần mỗi 10 phút).

## Cân bằng tải

Mỗi request chọn workspace theo điểm: số request đang chạy, hàng đợi, thời điểm dùng gần nhất (tránh dồn liên tiếp vào một workspace), ưu tiên luân phiên giữa các tài khoản, và mức quota đã dùng. Workspace đang cooldown hoặc cạn quota bị loại. Nếu không còn workspace nào khả dụng, request lỗi ngay và nêu thời gian hồi phục sớm nhất; hệ thống **không** xóa cooldown cưỡng bức.

## API

- GET `/health`
- GET `/v1/models`: danh sách model alias, không xác minh quyền truy cập thực tế.
- POST `/v1/chat/completions`: JSON hoặc SSE.
- POST `/v1/messages`: JSON hoặc SSE.
- GET `/api/status`, POST `/api/quota/refresh`.
- `/admin/api/clickup/*`: API cho trang Admin.

`/v1/responses` không hỗ trợ (404). SSE được phát sau khi nhận đủ completion từ ClickUp, không phải streaming token gốc. Chưa có workspace thì chat trả 503.

## Kiểm thử

```powershell
npm test
node scripts/smoke.mjs
```

Các test dùng mock HTTP trên loopback. Chúng chứng minh logic parse cookie, cân bằng tải, phản hồi API và luồng tạo workspace với **upstream giả**. Chúng **không** chứng minh ClickUp thật chấp nhận luồng cookie-only, tạo workspace, kích trial hay cấp quota như mong đợi. Điều đó chỉ kiểm chứng được bằng cách chạy thật với tài khoản của bạn.

Quota hiển thị trước lần kiểm tra đầu tiên là giá trị ước lượng mặc định, không phải số đã xác nhận.

## Phạm vi tách

Sao chép clickup-upstream, clickup-pool, clickup-tools, tokens và regression test ClickUp từ SharkPool; tạo mới server, entrypoint, cấu hình, Admin và tests. Không có runtime import hay symlink tới SharkPool.

`source-baseline.json` và `scripts/verify-baseline.mjs` chỉ dùng để đối chiếu bản sao với nguồn lúc tách; hai script `restore-pool.py` và `isolate-provider.py` là công cụ chuyển đổi một lần, không phải phần chạy. Tool mapping/anti-stall giữ hành vi nguồn; client vẫn phải kiểm soát quyền thực thi công cụ.
