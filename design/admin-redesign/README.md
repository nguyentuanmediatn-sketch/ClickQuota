# ClickQuota Admin Redesign — Apple Design foundations

Bản thiết kế lại Admin Dashboard theo triết lý Apple *Designing Fluid Interfaces*, phân tách rành mạch hai phân hệ:

```
design/admin-redesign/
├── index.html              # App shell: sidebar /api + /log, topbar, spring drawer
├── styles/admin.css        # Design tokens (cq-*) + glass surfaces + responsive + a11y
├── assets/
│   ├── springs.js          # Spring engine: interruptible, velocity handoff, rubber-band
│   ├── virtual-list.js     # Fixed-row virtualization (mẫu react-virtual, ~70 dòng vanilla)
│   ├── mock-data.js        # Fixture dựa trên sản phẩm thật (endpoint/path/thống kê thật)
│   ├── router.js           # Hash router: pill trượt spring + view transition
│   ├── views-api.js        # /api/dashboard · /api/endpoints (+drawer, resize) · credentials · sandbox
│   ├── views-log.js        # /log/system · /log/api-audit (toolbar nổi, live tail, expandable JSON) · alerts
│   └── app.js              # Boot + lazy view builders + ⌘K
├── build-preview.mjs       # Bundle thành 1 file tự chứa để xem nhanh
└── README.md
```

## Chạy

Không cần build step — chỉ cần static server (ESM-free, classic scripts):

```powershell
npx serve design/admin-redesign
# hoặc: python -m http.server -d design/admin-redesign 8088
```

Mở `http://localhost:3000` (hoặc cổng tương ứng). Route là hash: `#/api/endpoints`, `#/log/api-audit`.

## Các nguyên lý Apple đã áp dụng và ở đâu

| Nguyên lý | Áp dụng |
|---|---|
| Response (phản hồi trên pointerdown) | Toggle switch, filter chip, alert acknowledge — tất cả flip ngay khi `pointerdown` |
| Direct manipulation 1:1 | Column resize (thuart chase grab offset), drawer drag-to-dismiss qua `setPointerCapture` |
| Interruptibility | `SpringValue.animateTo` luôn bắt đầu từ giá trị on-screen hiện tại + kế thừa velocity; đổi tab liên tục không giật |
| Springs (damping/response) | Mặc định `damping 1.0, response 0.35`; drawer/toggle mang quán tính `damping 0.8, response 0.3` |
| Velocity handoff | Nhả drawer: quyết định theo **velocity sign**, chuyển velocity nguyên vào spring |
| Rubber-banding | Kéo drawer ngược chiều quá biên → resistance tiến triển (`rubberband`) |
| Spatial consistency | Drawer slide từ phải; nav pill trượt từ vị trí hiện tại; view enter/exit cùng một trục |
| Materials & depth | Sidebar/topbar/toolbar/drawer `blur(20px) saturate(180%)` + viền bắt sáng 1px; không xếp 2 lớp kính sáng |
| Typography | system-ui; tiêu đề `-0.02em / 1.08`; log mono `SF Mono / JetBrains Mono` |
| Reduced motion / transparency | Engine đọc `prefers-reduced-motion` (jump-to-target); CSS cho cả hai media query |

## Tích hợp về production (bước tiếp theo)

- `assets/springs.js`, `virtual-list.js` là module thuần, drop-in vào `src/admin/`.
- Router `/api` + `/log` có thể map 1:1 vào tab hiện tại của admin: Dashboard→`/api/dashboard`, Keys→`/api/credentials`, Channels→`/api/endpoints` (workspace pool), Logs→`/log/api-audit`, Playground→`/api/sandbox`.
- Endpoint dữ liệu thật: `/admin/api/clickup/status`, `/admin/api/keys`, `/admin/api/logs?kind=request|debug` — mock-data.js mô phỏng đúng shape.
