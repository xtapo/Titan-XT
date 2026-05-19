# Titan-XT Quick Connect — Browser Extension

Tiện ích thanh công cụ trình duyệt cho Titan-XT. Bấm icon (hoặc Ctrl+Shift+Y), gõ Partner ID, mở phiên xem trên một tab mới.

## Tính năng

- Quick connect popup: ID + password → mở viewer ở tab mới
- Lịch sử kết nối gần đây (8 mục, lưu cục bộ trong `chrome.storage.local`)
- Phím tắt mặc định **Ctrl+Shift+Y** (đổi được trong `chrome://extensions/shortcuts`)
- Context menu: bôi đen 9 chữ số bất kỳ → chuột phải → "Mở Titan-XT với …"
- Cài đặt được signal server + viewer URL

## Bảo mật

- Mật khẩu **không bao giờ** được lưu vào `chrome.storage` hoặc URL — chỉ giữ trong DOM của popup. Khi tab viewer mở, người dùng nhập lại mật khẩu trên trang viewer (cùng cơ chế challenge-response của Titan-XT).
- Permissions tối thiểu: `storage`, `tabs`, `contextMenus`. Không có `<all_urls>` host permission.

## Cài đặt thủ công (developer mode)

1. Mở `chrome://extensions/`
2. Bật **Developer mode** ở góc phải trên
3. Bấm **Load unpacked**, chọn thư mục `extension/`
4. Icon Titan-XT xuất hiện trên thanh công cụ

## Cấu trúc

```
extension/
├── manifest.json       Manifest V3
├── popup.html          Popup UI (320×420)
├── popup.css
├── popup.js            Quick-connect logic + recents
├── background.js       Service worker (context menu, settings)
└── icons/
    └── icon.svg        Single SVG mark, scaled at install
```

## Đóng gói cho store

Khi đăng lên Chrome Web Store / Firefox Add-ons, cần thay `icons/icon.svg` bằng các kích thước PNG (16/32/48/128) — Chrome Web Store yêu cầu PNG. Tạo bằng:

```bash
# Cần ImageMagick
for size in 16 32 48 128; do
  magick convert -background none -resize ${size}x${size} icons/icon.svg icons/icon-${size}.png
done
```

## Kiểm thử

1. Cài extension theo hướng dẫn ở trên
2. Bấm icon → popup hiện ra → gõ ID 9 chữ số → bấm Kết nối
3. Kiểm tra tab mới mở `?id=...` đúng partner ID
4. Bấm "Cài đặt" → đổi viewer URL → lưu → kết nối lại để xác nhận URL mới được dùng
5. Bôi đen "123 456 789" trên trang bất kỳ → chuột phải → chọn "Mở Titan-XT với …" → tab mới phải mở viewer với ID đã chọn
