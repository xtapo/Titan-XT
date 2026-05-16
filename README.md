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

# Build & package Electron app (.exe)
cd app && npm run package:win
```

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
