# Hướng dẫn Release tự động lên GitHub

## Cách hoạt động

GitHub Actions sẽ tự động build và tạo release khi bạn push tag version lên GitHub.

## Các bước thực hiện

### 1. Commit và push code

```bash
git add .
git commit -m "Prepare for release v1.0.0"
git push origin main
```

### 2. Tạo và push tag

```bash
# Tạo tag với version mới
git tag v1.0.0

# Push tag lên GitHub
git push origin v1.0.0
```

### 3. GitHub Actions sẽ tự động:

- ✅ Build app trên Windows, macOS, và Linux
- ✅ Tạo các file cài đặt:
  - **Windows**: `.exe` (NSIS installer) và portable
  - **macOS**: `.dmg` và `.zip`
  - **Linux**: `.AppImage`, `.deb`, `.rpm`
- ✅ Tạo GitHub Release với tất cả các file
- ✅ Upload artifacts

### 4. Kiểm tra Release

Sau khi workflow chạy xong (khoảng 10-15 phút), vào:
```
https://github.com/xtapo/Titan-XT/releases
```

Bạn sẽ thấy release mới với tất cả các file cài đặt.

## Chạy thủ công (không cần tag)

1. Vào GitHub repository
2. Click tab **Actions**
3. Chọn workflow **Build and Release**
4. Click **Run workflow**
5. Chọn branch và click **Run workflow**

## Cập nhật version

Trước khi tạo release, nhớ cập nhật version trong:

1. **app/package.json**:
```json
{
  "version": "1.0.0"
}
```

2. **app/src/shared/constants.ts**:
```typescript
export const APP_VERSION = '1.0.0';
```

## Lưu ý

### Windows
- Không cần code signing certificate (nhưng Windows sẽ cảnh báo "Unknown publisher")
- Để tắt cảnh báo, cần mua certificate (~$200/năm)

### macOS
- Cần Apple Developer account ($99/năm) để sign app
- Nếu không sign, user phải click chuột phải > Open để chạy lần đầu
- Để enable signing, thêm secrets vào GitHub:
  - `MAC_CERT`: Base64 của certificate (.p12)
  - `MAC_CERT_PASSWORD`: Password của certificate

### Linux
- Không cần signing
- AppImage chạy được trên mọi distro
- .deb cho Ubuntu/Debian
- .rpm cho Fedora/RedHat

## Troubleshooting

### Workflow failed
- Kiểm tra logs trong tab Actions
- Đảm bảo `GITHUB_TOKEN` có quyền write (Settings > Actions > General > Workflow permissions)

### Release không tạo được
- Kiểm tra tag format phải là `v*.*.*` (ví dụ: v1.0.0)
- Đảm bảo repository settings cho phép GitHub Actions tạo releases

### Build failed trên một platform
- Kiểm tra logs của platform đó
- Có thể tạm thời disable platform bằng cách comment out trong workflow

## Auto-update (Tùy chọn)

Để enable auto-update trong app:

1. Thêm vào [main/index.ts](app/src/main/index.ts):
```typescript
import { autoUpdater } from 'electron-updater';

app.whenReady().then(() => {
  // Check for updates
  autoUpdater.checkForUpdatesAndNotify();
});
```

2. Install dependency:
```bash
cd app
npm install electron-updater
```

3. User sẽ được thông báo khi có version mới và tự động download + cài đặt.

## Semantic Versioning

Sử dụng format: `MAJOR.MINOR.PATCH`

- **MAJOR** (1.0.0): Breaking changes
- **MINOR** (0.1.0): New features, backwards compatible
- **PATCH** (0.0.1): Bug fixes

Ví dụ:
- `v1.0.0` - Release đầu tiên
- `v1.0.1` - Bug fix
- `v1.1.0` - Thêm tính năng mới
- `v2.0.0` - Breaking changes
