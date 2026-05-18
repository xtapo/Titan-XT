# Titan-XT Web Viewer

PWA viewer cho Titan-XT — kết nối từ điện thoại / iPad / trình duyệt máy tính tới một host Titan-XT đang chạy.

Dùng cùng signal server, cùng cơ chế xác thực (ID 9 số + password 4 ký tự, challenge-response qua nonce), cùng kênh dữ liệu WebRTC như app desktop. Host không cần biết phía bên kia là Electron hay browser — wire protocol giống nhau.

## Tính năng

- Đăng nhập bằng Partner ID + Password (giống app desktop)
- Xem màn hình host qua WebRTC (auto-play, không cần plugin)
- Điều khiển bằng cử chỉ trackpad-style:
  - 1 ngón chạm → click trái
  - 2 ngón chạm → click phải
  - 1 ngón vuốt → di chuột tương đối
  - 2 ngón vuốt → cuộn (dọc/ngang)
  - Giữ rồi kéo → kéo thả (drag)
- Bàn phím ảo: Ctrl/Alt/Shift/Win + phím chức năng + nhập text qua bàn phím OS
- Đổi chất lượng (max → tiny, mặc định medium 720p để tiết kiệm 4G)
- Toàn màn hình + khoá landscape (browser hỗ trợ)
- Cài như native app qua "Add to Home Screen" (PWA)

## Phát triển

```bash
cd web-viewer
npm install
npm run dev          # http://localhost:5180
```

Truy cập từ điện thoại trong cùng LAN: `http://<ip-máy-dev>:5180` (Vite đã bật `--host`).

Chỉ định signal server khác qua biến môi trường:

```bash
VITE_SIGNAL_SERVER=https://signal.example.com npm run dev
```

## Build production

```bash
npm run build
# output: dist/
```

`dist/` là static — deploy lên bất kỳ static host nào (Cloudflare Pages, Netlify, Nginx, S3+CloudFront…). Nhớ:

- Phải serve qua **HTTPS** (WebRTC + service worker bắt buộc).
- Headers `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` không cần thiết — viewer chỉ nhận stream, không capture.
- Signal server (`SIGNAL_SERVER` mặc định `http://152.67.122.105:3456`) cần CORS cho phép origin của trang.

### Nginx ví dụ

```nginx
server {
  listen 443 ssl http2;
  server_name view.titan-xt.example.com;
  root /var/www/titan-xt-viewer;

  location / {
    try_files $uri /index.html;
  }

  # Long-cache hashed assets, no-cache shell
  location ~* \.(js|css|woff2|svg)$ {
    expires 1y;
    add_header Cache-Control "public, immutable";
  }
  location = /index.html {
    add_header Cache-Control "no-cache";
  }
}
```

## Cấu trúc

```
web-viewer/
├── index.html              Shell HTML (mobile viewport + PWA meta)
├── vite.config.ts          Vite + vite-plugin-pwa
├── public/favicon.svg      Icon (dùng cho PWA + tab)
└── src/
    ├── main.ts             Entry — login screen + session screen + glue
    ├── connection.ts       Socket.io client + WebRTC orchestration
    ├── webrtc.ts           Viewer-only RTCPeerConnection wrapper
    ├── touch-input.ts      Pointer Events → MouseMessage (gesture model)
    ├── constants.ts        Signal server URL + channel names + presets
    ├── protocol.ts         Wire types (subset của app/src/shared/protocol.ts)
    └── styles.css          Mobile-first dark UI
```

## Tương thích trình duyệt

| Trình duyệt | Trạng thái |
|---|---|
| iOS Safari 16+ | OK (cần tap-to-play lần đầu, autoplay bị chặn) |
| Chrome / Edge mobile | OK |
| Firefox mobile | OK (no Picture-in-Picture nhưng video bình thường) |
| Chrome / Edge desktop | OK (test dev) |

WebRTC H.264/VP8 được hỗ trợ rộng rãi — host vẫn ưu tiên H.264 nên hardware decode chạy mượt trên mobile.

## Bảo mật

- Password được hash SHA-256 cùng nonce do server sinh ngẫu nhiên trước khi rời browser. Plaintext không bao giờ chạm signal server.
- WebRTC bắt buộc DTLS-SRTP — toàn bộ video + data channel mã hoá end-to-end giữa browser và host.
- Web viewer dùng `machineId` ngẫu nhiên prefix `web` (vd `web123456789`) — không có hardware fingerprint.
- Service worker chỉ cache static asset; không cache request tới signal server.
