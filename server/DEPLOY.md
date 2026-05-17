# Hướng dẫn Deploy Server lên Linux

## Yêu cầu

- Linux server (Ubuntu/Debian/CentOS)
- Node.js 20+ hoặc Docker
- Port 3456 mở (hoặc port tùy chỉnh)

---

## Phương pháp 1: Deploy trực tiếp với Node.js

### Bước 1: Cài đặt Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs
```

### Bước 2: Clone và setup

```bash
# Clone repository
git clone https://github.com/xtapo/Titan-XT.git
cd Titan-XT/server

# Install dependencies
npm install

# Build
npm run build
```

### Bước 3: Chạy với PM2 (Recommended)

```bash
# Cài PM2
sudo npm install -g pm2

# Start server
pm2 start dist/index.js --name titan-xt-server

# Auto start khi reboot
pm2 startup
pm2 save

# Xem logs
pm2 logs titan-xt-server

# Restart
pm2 restart titan-xt-server

# Stop
pm2 stop titan-xt-server
```

### Bước 4: Cấu hình Firewall

```bash
# Ubuntu/Debian (UFW)
sudo ufw allow 3456/tcp
sudo ufw reload

# CentOS/RHEL (firewalld)
sudo firewall-cmd --permanent --add-port=3456/tcp
sudo firewall-cmd --reload
```

---

## Phương pháp 2: Deploy với Docker (Recommended)

### Bước 1: Cài Docker

```bash
# Ubuntu/Debian
curl -fsSL https://get.docker.com -o get-docker.sh
sudo sh get-docker.sh

# Cài Docker Compose
sudo apt-get install docker-compose-plugin
```

### Bước 2: Clone và build

```bash
git clone https://github.com/xtapo/Titan-XT.git
cd Titan-XT/server

# Build và chạy
docker compose up -d

# Xem logs
docker compose logs -f

# Restart
docker compose restart

# Stop
docker compose down
```

### Bước 3: Auto start khi reboot

Docker container đã được cấu hình `restart: unless-stopped`, sẽ tự động start khi server reboot.

---

## Phương pháp 3: Deploy với Systemd Service

### Tạo service file

```bash
sudo nano /etc/systemd/system/titan-xt-server.service
```

Nội dung:

```ini
[Unit]
Description=Titan-XT Signal Server
After=network.target

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/Titan-XT/server
ExecStart=/usr/bin/node dist/index.js
Restart=always
RestartSec=10
StandardOutput=syslog
StandardError=syslog
SyslogIdentifier=titan-xt-server
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

### Kích hoạt service

```bash
# Reload systemd
sudo systemctl daemon-reload

# Enable auto start
sudo systemctl enable titan-xt-server

# Start service
sudo systemctl start titan-xt-server

# Check status
sudo systemctl status titan-xt-server

# Xem logs
sudo journalctl -u titan-xt-server -f
```

---

## Cấu hình Nginx Reverse Proxy (Optional)

Nếu muốn dùng domain name và HTTPS:

```bash
# Cài Nginx
sudo apt-get install nginx

# Tạo config
sudo nano /etc/nginx/sites-available/titan-xt
```

Nội dung:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # WebSocket support
    location /socket.io/ {
        proxy_pass http://localhost:3456;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Enable site:

```bash
sudo ln -s /etc/nginx/sites-available/titan-xt /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### Cài SSL với Let's Encrypt

```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d your-domain.com
```

---

## Cấu hình Environment Variables

Tạo file `.env` trong thư mục server:

```bash
cd server
nano .env
```

Nội dung:

```env
PORT=3456
NODE_ENV=production
```

---

## Monitoring và Logs

### PM2 Monitoring

```bash
# Dashboard
pm2 monit

# Logs
pm2 logs titan-xt-server --lines 100

# Metrics
pm2 show titan-xt-server
```

### Docker Logs

```bash
# Real-time logs
docker compose logs -f

# Last 100 lines
docker compose logs --tail=100
```

### Systemd Logs

```bash
# Real-time logs
sudo journalctl -u titan-xt-server -f

# Last 100 lines
sudo journalctl -u titan-xt-server -n 100
```

---

## Update Server

### PM2

```bash
cd Titan-XT/server
git pull
npm install
npm run build
pm2 restart titan-xt-server
```

### Docker

```bash
cd Titan-XT/server
git pull
docker compose down
docker compose up -d --build
```

### Systemd

```bash
cd Titan-XT/server
git pull
npm install
npm run build
sudo systemctl restart titan-xt-server
```

---

## Troubleshooting

### Port đã được sử dụng

```bash
# Kiểm tra process đang dùng port 3456
sudo lsof -i :3456

# Kill process
sudo kill -9 <PID>
```

### Server không start

```bash
# Kiểm tra logs
pm2 logs titan-xt-server
# hoặc
docker compose logs
# hoặc
sudo journalctl -u titan-xt-server -n 50
```

### Không kết nối được từ client

1. Kiểm tra firewall
2. Kiểm tra server có đang chạy không
3. Kiểm tra port có mở không
4. Kiểm tra client config có đúng IP/domain không

---

## Cloud Providers

### AWS EC2

1. Launch EC2 instance (Ubuntu 22.04)
2. Security Group: Mở port 3456
3. SSH vào instance và follow hướng dẫn trên

### DigitalOcean Droplet

1. Tạo Droplet (Ubuntu 22.04)
2. Firewall: Mở port 3456
3. SSH vào droplet và follow hướng dẫn trên

### Google Cloud Platform

1. Tạo VM instance (Ubuntu 22.04)
2. Firewall rules: Mở port 3456
3. SSH vào VM và follow hướng dẫn trên

### Azure VM

1. Tạo Virtual Machine (Ubuntu 22.04)
2. Network Security Group: Mở port 3456
3. SSH vào VM và follow hướng dẫn trên

---

## Performance Tips

1. **Sử dụng PM2 cluster mode** (nếu có nhiều CPU cores):
   ```bash
   pm2 start dist/index.js -i max --name titan-xt-server
   ```

2. **Enable compression** trong Express (đã có trong code)

3. **Sử dụng Redis** cho session storage nếu scale nhiều instances

4. **Monitor resource usage**:
   ```bash
   htop
   # hoặc
   pm2 monit
   ```

---

## Security Checklist

- ✅ Firewall chỉ mở port cần thiết
- ✅ Sử dụng HTTPS với SSL certificate
- ✅ Cập nhật OS và packages thường xuyên
- ✅ Sử dụng non-root user để chạy app
- ✅ Rate limiting (đã có trong code)
- ✅ CORS configuration đúng
- ✅ Không expose sensitive info trong logs
