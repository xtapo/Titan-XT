# Debug Guide - Sửa lỗi màn hình đen

## Vấn đề đã được sửa

### 1. ConnectionManager không được khởi tạo
**Vấn đề:** Ứng dụng không bao giờ tạo instance của `ConnectionManager`, dẫn đến không có kết nối WebRTC thực sự.

**Đã sửa trong:** [app/src/renderer/main.ts](app/src/renderer/main.ts)
- Khởi tạo `ConnectionManager` khi app start
- Kết nối đến signal server
- Lưu instance vào `window.connectionManager` để các component khác sử dụng

### 2. Session page chỉ mô phỏng kết nối
**Vấn đề:** [app/src/renderer/pages/session.ts](app/src/renderer/pages/session.ts) chỉ có code mô phỏng với `setTimeout`, không gọi WebRTC thực sự.

**Đã sửa:** Thay thế code mô phỏng bằng việc gọi `connectionManager.connectToPartner()` thực sự.

### 3. Screen capture API không đúng
**Vấn đề:** Sử dụng API cũ `getUserMedia` với `chromeMediaSource: 'screen'` không hoạt động trong Electron hiện đại.

**Đã sửa trong:** [app/src/renderer/lib/connection.ts](app/src/renderer/lib/connection.ts)
- Thay đổi sang sử dụng `getDisplayMedia()` API chuẩn
- Cấu hình đúng constraints cho screen capture

### 4. Thiếu quyền screen capture
**Vấn đề:** Electron window không có quyền truy cập screen capture.

**Đã sửa trong:** [app/src/main/index.ts](app/src/main/index.ts)
- Thêm `webSecurity: false` vào `webPreferences`

## Cách test

### Bước 1: Chạy Signal Server
```bash
cd server
npm install
npm run dev
```
Server sẽ chạy tại `http://localhost:3456`

### Bước 2: Chạy Electron App
Mở terminal mới:
```bash
cd app
npm install
npm run dev
```

### Bước 3: Test kết nối
1. Mở 2 instance của app (hoặc dùng 2 máy khác nhau)
2. Máy A: Ghi lại ID và Password hiển thị
3. Máy B: Nhập ID và Password của máy A, click "Kết nối"
4. Máy A: Sẽ nhận được yêu cầu kết nối và bắt đầu chia sẻ màn hình
5. Máy B: Sẽ thấy màn hình của máy A (không còn màn hình đen)

## Các vấn đề có thể gặp

### Lỗi: "Không thể kết nối server"
- Kiểm tra server có đang chạy không
- Kiểm tra port 3456 có bị chiếm không
- Xem console log trong DevTools

### Lỗi: "Không thể chia sẻ màn hình"
- Trình duyệt/Electron sẽ hiện popup xin quyền screen capture
- Chọn màn hình muốn chia sẻ và click "Share"
- Nếu không thấy popup, kiểm tra quyền trong system settings

### Video vẫn đen
- Mở DevTools (F12) và xem Console log
- Kiểm tra WebRTC connection state
- Kiểm tra ICE candidates có được trao đổi không
- Có thể cần cấu hình TURN server nếu 2 máy ở mạng khác nhau

## Kiểm tra logs

### Browser Console
```javascript
// Kiểm tra connection manager
console.log(window.connectionManager);

// Kiểm tra peer connection state
console.log(window.connectionManager?.peer?.connectionState);
```

### Server logs
Server sẽ log các sự kiện:
- `register` - Khi client đăng ký
- `connect-request` - Khi có yêu cầu kết nối
- `signal` - Khi trao đổi WebRTC signals

## Ngày sửa
2026-05-16
