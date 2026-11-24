#!/usr/bin/env bash
# =====================================================================
# Wselx Shop — สคริปต์ติดตั้ง/อัปเดตอัตโนมัติ (Ubuntu 20.04+ / Debian 11+)
#
# ติดตั้งครั้งแรก (รันเป็น root):
#   curl -fsSL https://raw.githubusercontent.com/USER/REPO/main/install.sh \
#     | sudo REPO_URL=https://github.com/USER/REPO.git bash
#   (สคริปต์จะถาม โดเมน / ชื่อแอดมิน / รหัสผ่านแอดมิน ระหว่างติดตั้ง — ใส่เป็นตัวแปร DOMAIN= ADMIN_USERNAME= ADMIN_PASSWORD= ล่วงหน้าก็ได้)
#
# อัปเดตเวอร์ชัน: รันคำสั่งเดิมซ้ำ (ไม่แตะ .env / ฐานข้อมูล / ข้อมูลลูกค้า)
#
# ตัวแปร (ไม่ใส่ = สคริปต์จะถามเอง):
#   REPO_URL        ที่อยู่ git ของร้าน (จำเป็น)       BRANCH  (ค่าเริ่มต้น main)
#   DOMAIN          โดเมนของร้าน (แนะนำ — ได้ HTTPS)    EMAIL   อีเมลสำหรับใบรับรอง Let's Encrypt
#   ADMIN_USERNAME / ADMIN_PASSWORD  บัญชีแอดมิน (ไม่ใส่ = ถามตอนติดตั้ง)   APP_DIR (ค่าเริ่มต้น /opt/wselx)
# =====================================================================
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/wselx}"
APP_USER="wselx"
DB_NAME="wselx"
DB_USER="wselx"
BRANCH="${BRANCH:-main}"
REPO_URL="${REPO_URL:-}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"
ADMIN_USERNAME="${ADMIN_USERNAME:-}"
PORT="${PORT:-3000}"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m[!] %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m[x] %s\033[0m\n' "$*" >&2; exit 1; }

# อ่านค่าจากคีย์บอร์ดได้แม้สั่งผ่าน curl | bash
ask() { # ask VAR "คำถาม" [ค่าเริ่มต้น]
  local var="$1" q="$2" def="${3:-}" ans=""
  if [ -z "${!var}" ] && [ -r /dev/tty ]; then
    read -r -p "$q${def:+ [$def]}: " ans </dev/tty || true
    printf -v "$var" '%s' "${ans:-$def}"
  elif [ -z "${!var}" ]; then
    printf -v "$var" '%s' "$def"
  fi
}

[ "$(id -u)" -eq 0 ] || die "ต้องรันด้วย root (ใส่ sudo นำหน้า)"
command -v apt-get >/dev/null || die "สคริปต์นี้รองรับ Ubuntu/Debian (apt) เท่านั้น"

ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
GEN_PASS=0
if [ -f "$APP_DIR/.env" ]; then
  # อัปเดตเวอร์ชัน: ใช้ค่าเดิม ไม่ถามซ้ำ
  UPDATING=1
  [ -n "$DOMAIN" ] || DOMAIN="$(grep '^SITE_DOMAIN=' "$APP_DIR/.env" | cut -d= -f2- || true)"
  [ -n "$REPO_URL" ] || REPO_URL="$(git -c safe.directory="$APP_DIR" -C "$APP_DIR" remote get-url origin 2>/dev/null || true)"
else
  UPDATING=0
  say "ตอบคำถามเพื่อติดตั้ง"
  ask REPO_URL "Git URL ของร้านค้า (เช่น https://github.com/USER/REPO.git)"
  ask DOMAIN "โดเมนของร้าน เช่น shop.example.com (ต้องชี้มาที่ IP เครื่องนี้แล้ว | เว้นว่าง = โหมดทดสอบ ไม่มี HTTPS)"
  if [ -n "$DOMAIN" ]; then ask EMAIL "อีเมลสำหรับใบรับรอง HTTPS (เว้นว่างได้)"; fi
  while :; do
    ask ADMIN_USERNAME "ชื่อผู้ใช้แอดมิน (3-30 ตัว a-z 0-9 _ . -)" "admin"
    [[ "$ADMIN_USERNAME" =~ ^[A-Za-z0-9_.-]{3,30}$ ]] && break
    warn "ชื่อผู้ใช้ไม่ถูกต้อง"; ADMIN_USERNAME=""
    [ -r /dev/tty ] || die "ADMIN_USERNAME ไม่ถูกต้อง"
  done
  if [ -z "$ADMIN_PASSWORD" ] && [ -r /dev/tty ]; then
    while :; do
      read -rs -p "รหัสผ่านแอดมิน (อย่างน้อย 8 ตัว): " P1 </dev/tty; echo
      read -rs -p "ยืนยันรหัสผ่านอีกครั้ง: " P2 </dev/tty; echo
      if [ "${#P1}" -ge 8 ] && [ "$P1" = "$P2" ]; then ADMIN_PASSWORD="$P1"; break; fi
      warn "รหัสผ่านสั้นกว่า 8 ตัว หรือสองครั้งไม่ตรงกัน ลองใหม่"
    done
  fi
  if [ -z "$ADMIN_PASSWORD" ]; then ADMIN_PASSWORD="$(openssl rand -base64 18 | tr -d '=+/' | cut -c1-16)"; GEN_PASS=1; fi
fi
[ -n "$REPO_URL" ] || die "ต้องระบุ REPO_URL"

# ---------- 1) แพ็กเกจพื้นฐาน ----------
say "ติดตั้งแพ็กเกจพื้นฐาน"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git gnupg openssl postgresql
if [ -n "$DOMAIN" ]; then apt-get install -y nginx certbot python3-certbot-nginx; fi

# ---------- 2) Node.js >= 20.6 ----------
node_ok() { command -v node >/dev/null && node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>20||(a===20&&b>=6)?0:1)'; }
if ! node_ok; then
  say "ติดตั้ง Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
node_ok || die "ติดตั้ง Node.js 20.6+ ไม่สำเร็จ"
NODE_BIN="$(command -v node)"

# ---------- 3) ดาวน์โหลดโค้ด ----------
say "ดาวน์โหลดโค้ดจาก $REPO_URL"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin "$APP_USER"
GIT="git -c safe.directory=$APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  $GIT -C "$APP_DIR" fetch --all --quiet
  $GIT -C "$APP_DIR" checkout "$BRANCH" --quiet
  $GIT -C "$APP_DIR" pull --ff-only --quiet
else
  [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ] && die "$APP_DIR มีไฟล์อยู่แล้วแต่ไม่ใช่ git repo"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"
[ -f server.js ] && [ -f schema.sql ] || die "ไม่พบ server.js/schema.sql ที่รากของ repo (ต้องอัปโหลดไฟล์ในโฟลเดอร์ wselx ไว้ที่ราก repo)"

# ---------- 4) .env + ฐานข้อมูล ----------
pg() { (cd / && runuser -u postgres -- "$@"); }
set_env() { # set_env KEY VALUE  (แก้ถ้ามีแล้ว ไม่มีก็เพิ่ม)
  if grep -q "^$1=" .env; then sed -i "s|^$1=.*|$1=$2|" .env; else echo "$1=$2" >> .env; fi
}
if [ ! -f .env ]; then
  say "สร้างไฟล์ .env และฐานข้อมูล"
  DB_PASS="$(openssl rand -hex 16)"
  systemctl enable --now postgresql >/dev/null 2>&1 || true
  if pg psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$DB_USER'" | grep -q 1; then
    pg psql -qc "ALTER ROLE $DB_USER WITH PASSWORD '$DB_PASS'"
  else
    pg psql -qc "CREATE ROLE $DB_USER LOGIN PASSWORD '$DB_PASS'"
  fi
  pg psql -tAc "SELECT 1 FROM pg_database WHERE datname='$DB_NAME'" | grep -q 1 \
    || pg createdb -O "$DB_USER" "$DB_NAME"
  cat > .env <<EOF
DATABASE_URL=postgres://$DB_USER:$DB_PASS@127.0.0.1:5432/$DB_NAME
JWT_SECRET=$(openssl rand -hex 32)
DATA_KEY=$(openssl rand -hex 32)
ADMIN_USERNAME=$ADMIN_USERNAME
SITE_DOMAIN=$DOMAIN
PORT=$PORT
HOST=127.0.0.1
NODE_ENV=production
NOTIFY_WEBHOOK_URL=
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
EOF
  FRESH=1
else
  say "พบ .env เดิม — ใช้ค่าเดิม (อัปเดตเวอร์ชัน)"
  FRESH=0
fi

# โหมดเครือข่าย: มีโดเมน = ผ่าน nginx+HTTPS / ไม่มี = ทดสอบผ่าน IP
if [ -n "$DOMAIN" ]; then
  set_env NODE_ENV production
  set_env HOST 127.0.0.1
else
  set_env NODE_ENV development   # cookie ล็อกอินแบบ secure ใช้ไม่ได้บน http
  set_env HOST 0.0.0.0
fi
chmod 600 .env

# ---------- 5) ติดตั้งไลบรารี + สร้าง/อัปเดตตาราง ----------
say "ติดตั้งไลบรารี Node"
npm install --omit=dev --no-audit --no-fund
say "สร้าง/อัปเดตตารางฐานข้อมูล"
DB_URL="$(grep '^DATABASE_URL=' .env | cut -d= -f2-)"
psql "$DB_URL" -v ON_ERROR_STOP=1 -q -f schema.sql

# สร้างบัญชีแอดมินให้เลย (ถ้ายังไม่มีแอดมินในระบบ) — ไม่ต้องรอสมัครเอง
if [ "$UPDATING" = 0 ] || [ -n "$ADMIN_PASSWORD" ]; then
  say "สร้างบัญชีแอดมิน"
  ADMIN_NAME="${ADMIN_USERNAME:-$(grep '^ADMIN_USERNAME=' .env | cut -d= -f2-)}" ADMIN_PW="$ADMIN_PASSWORD" DB_URL="$DB_URL" \
  node -e '
    const { Pool } = require("pg"), bcrypt = require("bcryptjs"), crypto = require("crypto");
    (async () => {
      const pool = new Pool({ connectionString: process.env.DB_URL });
      const ex = await pool.query("SELECT 1 FROM users WHERE role = $1 LIMIT 1", ["admin"]);
      if (ex.rows.length) { console.log("มีแอดมินอยู่แล้ว — ข้ามการสร้าง"); return pool.end(); }
      if (!process.env.ADMIN_PW) { console.log("ไม่ได้ตั้งรหัสผ่านแอดมิน — ข้าม (สมัครบัญชีชื่อ ADMIN_USERNAME เองแทน)"); return pool.end(); }
      const hash = await bcrypt.hash(process.env.ADMIN_PW, 12);
      const ref = "NP" + crypto.randomBytes(4).toString("hex").toUpperCase().slice(0, 6);
      await pool.query(
        "INSERT INTO users(username,password_hash,role,referral_code) VALUES($1,$2,$3,$4) ON CONFLICT (username) DO UPDATE SET password_hash = EXCLUDED.password_hash, role = $3",
        [process.env.ADMIN_NAME, hash, "admin", ref]);
      console.log("สร้างแอดมิน " + process.env.ADMIN_NAME + " เรียบร้อย");
      await pool.end();
    })().catch(e => { console.error(e.message); process.exit(1); });
  '
fi
chown -R "$APP_USER":"$APP_USER" "$APP_DIR"

# ---------- 6) บริการ systemd ----------
say "ตั้งค่าบริการ (systemd)"
cat > /etc/systemd/system/wselx.service <<EOF
[Unit]
Description=Wselx Shop
After=network.target postgresql.service

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
ExecStart=$NODE_BIN --env-file=.env server.js
Restart=always
RestartSec=3
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable wselx >/dev/null 2>&1
systemctl restart wselx

# ---------- 7) nginx + HTTPS ----------
if [ -n "$DOMAIN" ]; then
  say "ตั้งค่า nginx สำหรับ $DOMAIN"
  cat > /etc/nginx/sites-available/wselx <<EOF
server {
    listen 80;
    server_name $DOMAIN;
    client_max_body_size 15m;
    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/wselx /etc/nginx/sites-enabled/wselx
  nginx -t && systemctl reload nginx
  command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow 'Nginx Full' >/dev/null || true

  say "ขอใบรับรอง HTTPS (โดเมนต้องชี้มาที่ IP เครื่องนี้ก่อน)"
  CB_MAIL=(--register-unsafely-without-email); [ -n "$EMAIL" ] && CB_MAIL=(-m "$EMAIL")
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos "${CB_MAIL[@]}" --redirect; then
    URL="https://$DOMAIN"
  else
    URL="http://$DOMAIN"
    warn "ขอใบรับรอง HTTPS ไม่สำเร็จ (โดเมนอาจยังไม่ชี้มาที่เครื่องนี้) — ล็อกอินจะยังใช้ไม่ได้จนกว่าจะมี HTTPS"
    warn "แก้ DNS แล้วรันสคริปต์เดิมซ้ำ หรือรัน: certbot --nginx -d $DOMAIN"
  fi
else
  IP="$(curl -fsS https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')"
  URL="http://$IP:$PORT"
  command -v ufw >/dev/null && ufw status | grep -q "Status: active" && ufw allow "$PORT"/tcp >/dev/null || true
  warn "โหมดทดสอบ: ไม่มี HTTPS ห้ามใช้เก็บเงินจริง — ใส่ DOMAIN แล้วรันซ้ำเมื่อพร้อมเปิดขาย"
fi

sleep 2
systemctl is-active --quiet wselx || { journalctl -u wselx -n 30 --no-pager; die "บริการไม่ขึ้น ดู log ด้านบน"; }

say "ติดตั้งเสร็จแล้ว"
cat <<EOF

  เว็บร้านค้า : $URL
  โฟลเดอร์    : $APP_DIR
  ดู log      : journalctl -u wselx -f
  รีสตาร์ท    : systemctl restart wselx
  อัปเดต      : รันคำสั่งติดตั้งเดิมซ้ำ

  แอดมิน      : $(grep '^ADMIN_USERNAME=' .env | cut -d= -f2-)  (ล็อกอินด้วยรหัสผ่านที่ตั้งตอนติดตั้ง)
  สำรองไฟล์ $APP_DIR/.env — ถ้า DATA_KEY หาย รหัส panel/SSH และข้อมูลบัญชีลูกค้าจะถอดรหัสไม่ได้
EOF
if [ "$GEN_PASS" = 1 ]; then echo "  รหัสผ่านแอดมินที่สุ่มให้ (แสดงครั้งเดียว จดไว้แล้วเปลี่ยนภายหลัง): $ADMIN_PASSWORD"; fi
