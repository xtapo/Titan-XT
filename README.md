# Titan-XT

Phần mềm hỗ trợ điều khiển máy tính từ xa. Xây dựng trên Electron + WebRTC, dùng signal server riêng để kết nối qua Internet hoặc LAN.

[![Release](https://img.shields.io/github/v/release/xtapo/Titan-XT?style=flat-square&color=2563eb)](https://github.com/xtapo/Titan-XT/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/xtapo/Titan-XT/total?style=flat-square&color=22c55e)](https://github.com/xtapo/Titan-XT/releases)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](#giấy-phép)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey?style=flat-square)](#tải-về)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?style=flat-square&logo=electron&logoColor=white)](https://www.electronjs.org/)

> Trạng thái: Đang phát triển — đã sẵn sàng cho hỗ trợ kỹ thuật trong nội bộ. Một số tính năng (ghi âm phiên, đa màn hình) còn ở giai đoạn thử nghiệm.

---

## Mục lục

- [Tính năng](#tính-năng)
- [Tải về](#tải-về)
- [Cách sử dụng](#cách-sử-dụng)
- [Kiến trúc](#kiến-trúc)
- [Phát triển](#phát-triển)
- [Đóng gói & phân phối](#đóng-gói--phân-phối)
- [Auto-update](#auto-update)
- [Bảo mật](#bảo-mật)
- [Đóng góp](#đóng-góp)
- [Giấy phép](#giấy-phép)

---

## Tính năng

| Nhóm | Chi tiết |
|---|---|
| Điều khiển | Xem & điều khiển chuột/bàn phím từ xa, chế độ chỉ-xem, hỗ trợ multi-monitor |
| Bảo mật | ID 9 số + mật khẩu 4 ký tự, xác thực challenge-response, kết nối WebRTC mã hoá đầu-cuối (DTLS-SRTP) |
| Cộng tác | Chat tích hợp, kéo-thả truyền file hai chiều, khay điều khiển nổi (UltraViewer-style) |
| Hệ thống | Tự khởi động cùng Windows, chạy nền dưới dạng tray icon, lệnh restart/shutdown/đăng xuất từ xa |
| Hiệu năng | WebRTC P2P (không qua server khi đã handshake xong), tự ẩn hình nền khi chia sẻ màn hình, **vẽ con trỏ chuột cục bộ (0ms latency)** |
| Mobile viewer | PWA chạy trên trình duyệt điện thoại — điều khiển host qua cử chỉ touch, xem [web-viewer/README.md](web-viewer/README.md) |
| Auto-update | Tự kiểm tra GitHub Releases, tải & cài đặt ngay trong app |
| UI | Giao diện tối, sổ địa chỉ "Máy của tôi", lịch sử kết nối |

### Tối ưu hóa Hiệu năng & Trải nghiệm (Core Performance)

* **Vẽ con trỏ chuột cục bộ (Zero-latency Cursor)**: Khác với các ứng dụng điều khiển từ xa truyền thống chụp và gửi hình ảnh con trỏ chuột từ Host về qua video WebRTC (gây hiện tượng trễ/nặng nề khi di chuyển chuột), Titan-XT sử dụng cơ chế tối ưu hóa nâng cao:
  * **Ẩn con trỏ chuột của Host**: Áp dụng thuộc tính `cursor: 'never'` trong các luồng bắt màn hình `getDisplayMedia` để ngăn hệ điều hành ghi đè con trỏ chuột vật lý của Host vào video stream.
  * **Vẽ con trỏ ảo phía Viewer**: Viewer tự động ẩn con trỏ mặc định và tự vẽ một con trỏ ảo `synthetic-cursor` (định dạng đồ họa vector SVG) trực tiếp trên giao diện bám sát chuyển động chuột của người dùng.
  * **Trải nghiệm mượt mà 0ms**: Giúp phản hồi chuyển động chuột mượt mà tức thì (0ms latency), loại bỏ hoàn toàn độ trễ mạng và lỗi hiển thị hai con trỏ chuột song song (double cursors).

---

## Tải về

Vào trang [Releases](https://github.com/xtapo/Titan-XT/releases/latest) và chọn:

| Hệ điều hành | File | Ghi chú |
|---|---|---|
| Windows | `Titan-XT Setup x.y.z.exe` | NSIS installer, cài per-machine, có Start Menu / Desktop shortcut |
| Windows | `Titan-XT x.y.z.exe` | Bản portable, không cần cài đặt |
| Windows | `Titan-XT-x.y.z-win.zip` | Nén thư mục, dùng cho IT triển khai bằng GPO |
| macOS | `Titan-XT-x.y.z.dmg` | Universal binary (Intel + Apple Silicon) |
| macOS | `Titan-XT-x.y.z-mac.zip` | Auto-update artifact |
| Linux | `.AppImage` / `.deb` / `.rpm` | x86_64 |

Sau khi cài, app sẽ tự kiểm tra phiên bản mới khi khởi động — không cần tải lại thủ công.

---

## Cách sử dụng

### Đối với khách hàng (host)

1. Mở Titan-XT, app sẽ hiển thị **Your ID** và **Password**.
2. Gửi cặp ID/Password cho kỹ thuật viên.
3. Khi có yêu cầu kết nối, app hiện hộp thoại xác nhận để khách hàng chấp nhận.

### Đối với kỹ thuật viên (viewer)

1. Mở Titan-XT, vào trang **Điều khiển máy khác**.
2. Nhập Partner ID (9 số) và Password (4 ký tự).
3. Chọn chế độ **Điều khiển từ xa** hoặc **Chỉ xem**, bấm **Kết nối**.
4. Sau khi kết nối, dùng thanh toolbar để chuyển màn hình, gửi file, chat, hoặc kết thúc phiên.

> Mật khẩu mới được sinh mỗi khi đổi phiên. Có thể bấm icon refresh cạnh password để đổi thủ công.

---

## Kiến trúc

```
Titan-XT/
├── app/                    Electron app (host + viewer trong cùng binary)
│   ├── src/main/           Main process: input, screen capture, IPC, updater
│   ├── src/renderer/       UI: Vite + TypeScript, không framework
│   ├── src/service/        Background supervisor (Windows scheduled task)
│   ├── src/worker/         SYSTEM-level worker cho input simulation
│   └── src/shared/         Protocol & types dùng chung
├── web-viewer/             PWA viewer chạy trên browser (mobile / iPad / desktop)
│   └── src/                Vite + TypeScript, dùng cùng signal server
├── server/                 Signal server: Node.js + Socket.io
│   └── src/                Registry (machine ↔ socket) + Signaling rooms
└── .github/workflows/      CI build & publish release
```

**Luồng kết nối:**

1. Cả host và viewer kết nối tới signal server qua Socket.io.
2. Viewer gửi yêu cầu (ID + password hash) → host nhận và xác nhận.
3. Hai bên trao đổi SDP/ICE candidates qua signal server.
4. WebRTC dựng kênh P2P → toàn bộ màn hình, input, chat, file đi trực tiếp giữa hai máy.

Signal server không thấy nội dung phiên — chỉ làm môi giới handshake.

---

## Phát triển

### Yêu cầu

- Node.js 20+
- npm 10+
- Windows 10/11, macOS 12+, hoặc Linux với Xorg
- Trên macOS: Xcode Command Line Tools (`xcode-select --install`)
- Trên Windows: VS Build Tools 2022 (cho `koffi` native module)

### Cài đặt

```bash
git clone https://github.com/xtapo/Titan-XT.git
cd Titan-XT

# Server
cd server && npm install && cd ..

# App
cd app && npm install && cd ..
```

### Chạy dev

Mở 2 terminal:

```bash
# Terminal 1 — signal server (port 3456)
cd server
npm run dev

# Terminal 2 — Electron app (renderer hot-reload qua Vite)
cd app
npm run dev
```

App sẽ tự kết nối tới `ws://localhost:3456`. Đổi `SIGNAL_SERVER_URL` trong [app/src/shared/constants.ts](app/src/shared/constants.ts) để trỏ đến server khác.

### Cấu trúc scripts

| Script (chạy trong `app/`) | Tác dụng |
|---|---|
| `npm run dev` | Build main + watch + start renderer + start Electron |
| `npm run build` | Compile TS main + build renderer |
| `npm run package:win` | Đóng gói Windows (.exe + portable + .zip) |
| `npm run package:mac` | Đóng gói macOS (.dmg + .zip) |
| `npm run package:linux` | Đóng gói Linux (AppImage + .deb + .rpm) |
| `npm run release:win` | Build + publish lên GitHub Releases |

---

## Đóng gói & phân phối

### Windows

```bash
cd app
npm run package:win
```

Output trong `app/release/`:
- `Titan-XT Setup x.y.z.exe` — NSIS installer (per-machine, đăng ký Scheduled Task)
- `Titan-XT x.y.z.exe` — Portable (không cài, không có background supervisor)
- `Titan-XT-x.y.z-win.zip` — ZIP của thư mục unpacked

> Installer không ký số sẽ hiện cảnh báo SmartScreen lần đầu cài. Để bỏ cảnh báo cần mua Code Signing Certificate (DigiCert, Sectigo) hoặc dùng Azure Trusted Signing.

### macOS

> Build macOS chỉ chạy được **trên macOS** do Apple yêu cầu `codesign` và `dmg-builder`.

Quyền cần cấp lần đầu chạy:

| Quyền | Dùng để | System Settings |
|---|---|---|
| Screen Recording | Chia sẻ màn hình | Privacy & Security → Screen Recording |
| Accessibility | Mô phỏng chuột/bàn phím | Privacy & Security → Accessibility |
| Automation | Lệnh restart/shutdown/logout | Privacy & Security → Automation |
| Microphone | Truyền âm thanh (tuỳ chọn) | Privacy & Security → Microphone |

Phải khởi động lại app sau khi cấp quyền.

**Code-signing & Notarization:**

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
export CSC_LINK="/path/to/DeveloperID.p12"
export CSC_KEY_PASSWORD="..."

cd app && npm run release:mac
```

Không có chứng chỉ vẫn build được, nhưng người dùng phải mở thủ công qua System Settings → Privacy & Security → Allow Anyway.

### Linux

```bash
cd app
npm run package:linux
```

AppImage chạy trực tiếp (`chmod +x` rồi double-click). `.deb` cài qua `sudo apt install ./Titan-XT.deb`.

---

## Auto-update

App tích hợp [electron-updater](https://www.electron.build/auto-update) trỏ tới GitHub Releases:

- Tự kiểm tra phiên bản mới sau 5 giây kể từ khi launch (chỉ ở bản đã cài).
- User bấm **"Tải về"** → app tự download installer trong background, hiển thị %.
- User bấm **"Cài đặt & Khởi động lại"** → app tự chạy NSIS installer, quit, cài đè, mở lại.
- Có nút **"Kiểm tra cập nhật"** ở footer Home và trong tray menu để check thủ công.

Để release phiên bản mới:

```bash
# 1. Bump version
cd app && npm version patch --no-git-tag-version

# 2. Commit + tag
git add app/package.json
git commit -m "release: vX.Y.Z"
git tag vX.Y.Z

# 3. Push — CI sẽ tự build & publish
git push origin main && git push origin vX.Y.Z
```

CI workflow tại [.github/workflows/release.yml](.github/workflows/release.yml) sẽ build trên `windows-latest` và publish artifacts lên Release của tag tương ứng.

---

## Bảo mật

- **Mật khẩu** không lưu plaintext, chỉ lưu hash (SHA-256) cùng nonce ngẫu nhiên mỗi phiên.
- **Xác thực** dùng challenge-response: viewer phải gửi đúng `HMAC(password, nonce)` trước khi host gửi SDP offer.
- **WebRTC** mã hoá toàn bộ media + data channels bằng DTLS-SRTP. Signal server không thể giải mã nội dung phiên.
- **Quyền cao** (input simulation, system actions): chạy qua worker LocalSystem riêng biệt, IPC qua named pipe có ACL chỉ cho phép user đã đăng nhập.

> Phát hiện lỗ hổng? Mở issue với label `security` hoặc gửi email cho maintainer thay vì public.

---

## Đóng góp

Pull request được hoan nghênh. Trước khi gửi:

1. Tạo branch từ `main`: `git checkout -b feat/your-feature`
2. Tuân thủ style hiện có (TS strict, không introduce framework UI mới ở renderer).
3. Build pass: `cd app && npm run build`
4. Mô tả PR rõ ràng: What/Why/Test plan.

Issue mới nên kèm: phiên bản app, OS, các bước reproduce, ảnh chụp màn hình nếu có.

---

## Giấy phép

MIT — xem [LICENSE](LICENSE).

---

<sub>Made with care by [@xtapo](https://github.com/xtapo). Logo, biểu tượng, và tên thương hiệu là tài sản của tác giả.</sub>
