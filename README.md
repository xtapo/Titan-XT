# Titan-XT — Remote Desktop Support

Phần mềm hỗ trợ từ xa cho khách hàng, tương tự TeamViewer.

## Tính năng

- 🖥️ **Điều khiển từ xa** — Xem và điều khiển máy tính khách hàng
- 🔒 **Bảo mật** — ID + Password, challenge-response authentication
- 💬 **Chat** — Nhắn tin trong phiên hỗ trợ
- 📁 **Truyền file** — Kéo thả gửi file
- 🖥️ **Multi-monitor** — Chọn màn hình cụ thể
- 🌐 **Internet & LAN** — Hoạt động qua Internet hoặc mạng nội bộ
- 🎨 **Dark Premium UI** — Giao diện tối, hiện đại

## Cài đặt

```bash
# Install tất cả dependencies
npm install

# Hoặc install từng phần
cd server && npm install
cd app && npm install
```

## Chạy Development

```bash
# 1. Chạy Signal Server
cd server
npm run dev

# 2. Chạy Electron App (terminal khác)
cd app
npm run dev
```

## Build Production

```bash
# Build signal server
cd server && npm run build

# Build & package Electron app
cd app
npm run package:win     # Windows: NSIS + Portable + ZIP
npm run package:mac     # macOS:   DMG + ZIP (Universal: x64 + arm64)
npm run package:linux   # Linux:   AppImage + .deb + .rpm
```

### Build trên macOS

> Chỉ build được app `.dmg / .zip` cho macOS khi chạy **trên macOS**
> (yêu cầu của Apple — `codesign`, `dmg-builder`, …).
> Trên Windows / Linux chỉ tạo được app cho hệ tương ứng.

Trước khi build, đảm bảo:

1. macOS 12+ với Xcode Command Line Tools (`xcode-select --install`).
2. Node.js 20+ và Python 3 (cần để build native module `koffi`).
3. Nếu phân phối ra ngoài: chứng chỉ Apple Developer ID (xem dưới).

Lần đầu chạy app sẽ xin các quyền:

| Quyền | Dùng để | System Settings → |
|------|---------|-------------------|
| Screen Recording | Chia sẻ màn hình tới kỹ thuật viên | Privacy & Security → Screen Recording |
| Accessibility | Mô phỏng chuột/bàn phím từ xa | Privacy & Security → Accessibility |
| Automation | Lệnh restart / shutdown / logout | Privacy & Security → Automation |
| Microphone (tuỳ) | Truyền âm thanh trong phiên hỗ trợ | Privacy & Security → Microphone |

Cấp xong cần khởi động lại Titan-XT.

### Code-signing & Notarization (tuỳ chọn)

Để người dùng không gặp cảnh báo "App is damaged" khi mở:

```bash
export APPLE_ID="you@example.com"
export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
export APPLE_TEAM_ID="ABCDE12345"
export CSC_LINK="/path/to/DeveloperID.p12"
export CSC_KEY_PASSWORD="..."

cd app && npm run release:mac     # build + ký + notarize + publish lên GitHub
```

Không có chứng chỉ vẫn build được nhưng app sẽ chỉ chạy được khi
"Allow Anyway" trong System Settings → Privacy & Security.

## Kiến trúc

```
Titan-XT/
├── server/          # Signal Server (Node.js + Socket.io)
├── app/             # Electron App (Desktop)
│   ├── src/main/    # Main process (screen, input, identity)
│   ├── src/renderer/# UI (Vite + TypeScript)
│   └── src/shared/  # Shared types & protocol
└── README.md
```

## Cách sử dụng

1. **Khách hàng**: Mở Titan-XT → Gửi ID và Password cho kỹ thuật viên
2. **Kỹ thuật viên**: Mở Titan-XT → Nhập ID + Password → Kết nối → Điều khiển
