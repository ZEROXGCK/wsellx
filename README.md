# Wselx Shop v3.2

ระบบร้านค้าจำหน่ายแพ็กเกจ VPN / SSH / 3x-ui อัตโนมัติ (Node.js + Express + PostgreSQL)

## โครงสร้างไฟล์
- `schema.sql` — สคีมาฐานข้อมูล PostgreSQL (รองรับตาราง `users`, `vps_servers`, `products`, `plans`, `orders`, `topups`, `coupons`, `support_tickets`, `reviews`, `credit_ledger`)
- `server.js` — Backend API พร้อมระบบเชื่อมต่อ **3x-ui / X-UI Panel API** (รองรับ Base Path, Session Cookie, เพิ่ม Client อัตโนมัติ, ต่ออายุ Client เดิม, ทดสอบการเชื่อมต่อและดึงรายการ Inbound) และระบบจัดการสมาชิกหลังบ้าน
- `public/index.html` & `public/app.js` — หน้าเว็บฝั่งลูกค้าและระบบหลังบ้านแอดมินที่จัดหมวดหมู่เป็นระเบียบ

## วิธีติดตั้งและรันใช้งาน
1. ติดตั้งแพ็กเกจ:
   ```bash
   npm install
   ```
2. สร้างไฟล์ `.env` จาก `.env.example` และกำหนดค่า `DATABASE_URL`, `JWT_SECRET`, `DATA_KEY` (hex 64 ตัว) และ `ADMIN_USERNAME`
3. สร้างตารางฐานข้อมูล:
   ```bash
   psql "$DATABASE_URL" -f schema.sql
   ```
4. เริ่มรันเซิร์ฟเวอร์:
   ```bash
   npm start
   ```

## อัปเกรดจาก v3.1 → v3.2
```bash
psql "$DATABASE_URL" -f schema.sql   # รันซ้ำได้ปลอดภัย (เพิ่มคอลัมน์ใหม่)
```

## สิ่งที่เปลี่ยนใน v3.2
- **คืนเงิน/หมดอายุ = ปิดบัญชีจริง**
  - คืนเงิน: ลบ client บน 3x-ui / ลบ user + ตัด session บน SSH ก่อนแล้วจึงคืนเครดิต ถ้าปิดบัญชีไม่สำเร็จจะไม่คืนเงิน (แอดมินเลือกบังคับคืนได้)
  - หมดอายุ: งานเบื้องหลังทุก 1 นาที จะ disable client / ล็อก user + ตัด session แล้วเปิดกลับอัตโนมัติเมื่อลูกค้าต่ออายุ
  - ค่าเริ่มต้นคืนเฉพาะ **ราคาซื้อครั้งแรก** แอดมินเลือก "รวมค่าต่ออายุ" ได้ตอนกดคืนเงิน
- **เพิ่มเซิร์ฟเวอร์ 3x-ui กรอกแค่ Host/IP, Panel URL, Username, Password** แล้วตอนเพิ่ม/แก้ไขแพ็กเกจ ระบบดึงรายการ Inbound จาก 3x-ui มาให้เลือก (แต่ละแพ็กเกจเลือก Inbound ต่างกันได้ และออเดอร์จำ Inbound ที่ใช้ไว้สำหรับต่ออายุ/ปิดบัญชี)
- **ลิงก์ 3x-ui สร้างจาก inbound จริง** อ่าน network (ws/tcp/grpc/httpupgrade/xhttp), security (tls/reality/none), path, SNI, Reality (pbk/sid/spx/fp) และพอร์ตจริง ช่อง *Public Port* ในหน้าแอดมินเว้นว่างได้ (ว่าง = ใช้พอร์ตของ inbound; กรอกเฉพาะกรณีมี proxy/CDN หน้า inbound) เซิร์ฟเวอร์เดิมที่เคยบันทึกเป็น 443 ให้เปิดแก้แล้วล้างช่องนี้
- **ตรวจสลิปอัตโนมัติ**: เลือกผู้ให้บริการได้ (กำหนดเอง / EasySlip / SlipOK) และกันสลิปซ้ำด้วยเลขอ้างอิงธุรกรรม (`transRef`) นอกเหนือจาก hash รูป
  - *ระบบเช็กยอดเงินเท่านั้น ยังไม่ได้เช็กว่าบัญชีผู้รับตรงกับร้าน*

## ข้อควรระวัง
- **ใบรับรอง self-signed ของ 3x-ui**: ต้องเปิด `NODE_TLS_REJECT_UNAUTHORIZED=0` ใน `.env` เอง ซึ่งมีผลกับทุกการเชื่อมต่อขาออกของแอป (รวม API ตรวจสลิป) ถ้าเป็นไปได้ให้ใช้โดเมน + Let's Encrypt กับ panel แทน
- **แอดมิน**: ใครสมัครด้วยชื่อตาม `ADMIN_USERNAME` ก่อนจะได้เป็นแอดมิน ให้สมัครบัญชีนั้นทันทีหลังติดตั้ง (เซิร์ฟเวอร์จะแจ้งเตือนในล็อกจนกว่าจะมีแอดมิน)
- SSH: ต้องใช้ root หรือ user ที่ sudo ได้โดยไม่ถามรหัส

## ติดตั้งอัตโนมัติด้วยสคริปต์ (Ubuntu/Debian)
1. อัปโหลดไฟล์ในโฟลเดอร์นี้ (ให้ `server.js`, `install.sh` อยู่ที่รากของ repo) ขึ้น GitHub
2. บน VPS ที่จะรันร้าน สั่ง (แก้ USER/REPO/โดเมนเป็นของคุณ):
```bash
curl -fsSL https://raw.githubusercontent.com/USER/REPO/main/install.sh \
  | sudo REPO_URL=https://github.com/USER/REPO.git bash
```
สคริปต์จะถาม **โดเมน, ชื่อแอดมิน และรหัสผ่านแอดมิน** แล้วสร้างบัญชีแอดมินให้เลย (ไม่ต้องสมัครเอง) สคริปต์ติดตั้ง Node/PostgreSQL/nginx, สร้างฐานข้อมูลและ `.env` (สุ่ม `DATA_KEY`/`JWT_SECRET` ให้), ขอ HTTPS ฟรี และตั้งให้รันอัตโนมัติ (systemd) — รันซ้ำเพื่ออัปเดตเวอร์ชันได้โดยไม่แตะข้อมูลเดิม
