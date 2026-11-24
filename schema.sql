-- =====================================================
-- Wselx / VPN Shop Schema v3.0 (PostgreSQL 13+)
-- รัน: psql -d yourdb -f schema.sql
-- =====================================================
BEGIN;

-- ---------- users ----------
CREATE TABLE IF NOT EXISTS users (
    id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username          VARCHAR(50)   NOT NULL UNIQUE,
    password_hash     TEXT          NOT NULL,
    role              VARCHAR(10)   NOT NULL DEFAULT 'user'
                      CHECK (role IN ('user', 'admin')),
    is_banned         BOOLEAN       NOT NULL DEFAULT FALSE,
    note              TEXT,
    credit_balance    NUMERIC(12,2) NOT NULL DEFAULT 0
                      CHECK (credit_balance >= 0),
    referral_code     VARCHAR(20)   UNIQUE,
    referred_by       BIGINT        REFERENCES users(id) ON DELETE SET NULL,
    referral_rewarded BOOLEAN       NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- ---------- credit_ledger ----------
CREATE TABLE IF NOT EXISTS credit_ledger (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT        NOT NULL REFERENCES users(id),
    amount        NUMERIC(12,2) NOT NULL CHECK (amount <> 0),
    type          VARCHAR(16)   NOT NULL
                  CHECK (type IN ('topup', 'purchase', 'refund', 'adjust', 'bonus', 'referral')),
    ref_id        BIGINT,
    note          TEXT,
    balance_after NUMERIC(12,2),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger (user_id, created_at DESC);

-- ---------- vps_servers (3x-ui / SSH / UDP) ----------
CREATE TABLE IF NOT EXISTS vps_servers (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name            VARCHAR(100) NOT NULL,
    type            VARCHAR(20)  NOT NULL CHECK (type IN ('3xui', 'ssh')),
    host            VARCHAR(255) NOT NULL,
    panel_url       TEXT,                         -- เช่น https://vpn.domain.com:2053/secretpath
    panel_user      VARCHAR(100),
    panel_pass_enc  TEXT,                         -- เข้ารหัส AES-256-GCM
    inbound_id      INTEGER      DEFAULT 1,
    protocol        VARCHAR(20)  DEFAULT 'vless', -- vless, vmess, trojan, ssh, udp
    ws_path         VARCHAR(255) DEFAULT '/',
    sni             VARCHAR(255) DEFAULT '',
    public_port     INTEGER,                      -- ว่าง = ใช้พอร์ตจริงของ inbound
    ssh_port        INTEGER      DEFAULT 22,
    udp_port        VARCHAR(50)  DEFAULT '1-65535',
    tls_enabled     BOOLEAN      NOT NULL DEFAULT TRUE,
    template        TEXT,
    is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
    last_status     VARCHAR(20)  DEFAULT 'unknown',
    last_checked_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- products ----------
CREATE TABLE IF NOT EXISTS products (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    server_id   BIGINT       REFERENCES vps_servers(id) ON DELETE SET NULL,
    network     VARCHAR(50)  NOT NULL,
    protocol    VARCHAR(50)  NOT NULL,
    title       VARCHAR(150) NOT NULL,
    description TEXT,
    image_url   TEXT,
    badge       VARCHAR(30),
    is_hidden   BOOLEAN      NOT NULL DEFAULT FALSE
);

-- ---------- plans ----------
CREATE TABLE IF NOT EXISTS plans (
    id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id     BIGINT        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    name           VARCHAR(100)  NOT NULL,
    duration_hours INTEGER       NOT NULL CHECK (duration_hours > 0),
    price          NUMERIC(12,2) NOT NULL CHECK (price >= 0)
);
CREATE INDEX IF NOT EXISTS idx_plans_product ON plans (product_id);

-- ---------- coupons ----------
CREATE TABLE IF NOT EXISTS coupons (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            VARCHAR(50)  NOT NULL UNIQUE,
    percent         INTEGER      NOT NULL CHECK (percent BETWEEN 1 AND 100),
    remaining_uses  INTEGER      NOT NULL DEFAULT 1 CHECK (remaining_uses >= 0),
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- orders ----------
CREATE TABLE IF NOT EXISTS orders (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id       BIGINT        NOT NULL REFERENCES users(id),
    plan_id       BIGINT        NOT NULL REFERENCES plans(id),
    server_id     BIGINT        REFERENCES vps_servers(id) ON DELETE SET NULL,
    client_email  VARCHAR(150),
    client_uuid   VARCHAR(100),
    price_paid    NUMERIC(12,2) NOT NULL CHECK (price_paid >= 0),
    coupon_id     BIGINT        REFERENCES coupons(id),
    account_data  TEXT          NOT NULL,
    expires_at    TIMESTAMPTZ   NOT NULL,
    reminded_at   TIMESTAMPTZ,
    status        VARCHAR(12)   NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'expired', 'refunded', 'cancelled')),
    created_at    TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_orders_user    ON orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_expires ON orders (expires_at) WHERE status = 'active';

-- ---------- topups ----------
CREATE TABLE IF NOT EXISTS topups (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id      BIGINT        NOT NULL REFERENCES users(id),
    method       VARCHAR(12)   NOT NULL CHECK (method IN ('bank', 'truemoney')),
    amount       NUMERIC(12,2) NOT NULL CHECK (amount > 0),
    bonus_amount NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (bonus_amount >= 0),
    slip_hash    TEXT          NOT NULL UNIQUE,
    proof        TEXT,
    verify_note  TEXT,
    status       VARCHAR(12)   NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
    verified_by  VARCHAR(12)   CHECK (verified_by IN ('auto', 'admin')),
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_topups_user   ON topups (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_topups_status ON topups (status) WHERE status = 'pending';

-- ---------- support_tickets ----------
CREATE TABLE IF NOT EXISTS support_tickets (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES users(id),
    order_id    BIGINT       REFERENCES orders(id) ON DELETE SET NULL,
    subject     VARCHAR(150) NOT NULL,
    message     TEXT         NOT NULL,
    reply       TEXT,
    status      VARCHAR(12)  NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'answered', 'closed')),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tickets_user ON support_tickets (user_id, created_at DESC);

-- ---------- reviews ----------
CREATE TABLE IF NOT EXISTS reviews (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id     BIGINT       NOT NULL REFERENCES users(id),
    product_id  BIGINT       NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    rating      INTEGER      NOT NULL CHECK (rating BETWEEN 1 AND 5),
    comment     TEXT         NOT NULL,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (user_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_reviews_product ON reviews (product_id, created_at DESC);

-- ---------- settings ----------
CREATE TABLE IF NOT EXISTS settings (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT         NOT NULL,
    is_secret  BOOLEAN      NOT NULL DEFAULT FALSE
);

-- ---------- audit_log ----------
CREATE TABLE IF NOT EXISTS audit_log (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    actor_id    BIGINT       REFERENCES users(id) ON DELETE SET NULL,
    action      VARCHAR(100) NOT NULL,
    detail      JSONB,
    ip          INET,
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor_id, created_at DESC);

-- =====================================================
-- Trigger: ปรับ users.credit_balance อัตโนมัติและป้องกันแก้/ลบ ledger
-- =====================================================
CREATE OR REPLACE FUNCTION apply_ledger_entry() RETURNS trigger AS $$
BEGIN
    UPDATE users
       SET credit_balance = credit_balance + NEW.amount
     WHERE id = NEW.user_id
 RETURNING credit_balance INTO NEW.balance_after;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'User % not found', NEW.user_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_apply_ledger ON credit_ledger;
CREATE TRIGGER trg_apply_ledger
BEFORE INSERT ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION apply_ledger_entry();

CREATE OR REPLACE FUNCTION forbid_ledger_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'credit_ledger is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ledger_immutable ON credit_ledger;
CREATE TRIGGER trg_ledger_immutable
BEFORE UPDATE OR DELETE ON credit_ledger
FOR EACH ROW EXECUTE FUNCTION forbid_ledger_change();

-- ค่าเริ่มต้นการตั้งค่า
INSERT INTO settings (key, value, is_secret) VALUES
    ('name', 'Wselx Shop', FALSE),
    ('title', E'เติมแพ็กเกจเน็ตความเร็วสูง\nสร้างบัญชีอัตโนมัติใน 3 วินาที', FALSE),
    ('sub', 'เลือกโปรที่ตรงกับเครือข่ายของคุณ จ่ายด้วยเครดิต รับไฟล์และลิงก์เชื่อมต่อทันที', FALSE),
    ('open', '2026-07-01', FALSE),
    ('min_topup_amount', '20', FALSE),
    ('bonus_min_amount', '100', FALSE),
    ('bonus_percent', '5', FALSE),
    ('referral_reward', '10', FALSE),
    ('slip_mode', 'manual', FALSE),
    ('slip_provider', 'generic', FALSE),
    ('slip_verify_url', '', FALSE),
    ('slip_auto_approve', 'false', FALSE)
ON CONFLICT (key) DO NOTHING;

-- v3.1: SSH credentials สำหรับสร้าง user จริง
ALTER TABLE vps_servers ADD COLUMN IF NOT EXISTS ssh_user VARCHAR(100);
ALTER TABLE vps_servers ADD COLUMN IF NOT EXISTS ssh_pass_enc TEXT;

-- v3.2: ปิดบัญชีจริงตอนหมดอายุ/คืนเงิน, กันสลิปซ้ำด้วยเลขอ้างอิงธุรกรรม, public_port ว่างได้
-- (รันซ้ำได้ปลอดภัย — ถ้าอัปเกรดจาก v3.1 ให้รัน: psql "$DATABASE_URL" -f schema.sql)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deprovisioned_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deprov_tried_at  TIMESTAMPTZ;
ALTER TABLE topups ADD COLUMN IF NOT EXISTS trans_ref TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ux_topups_trans_ref ON topups (trans_ref) WHERE trans_ref IS NOT NULL;
ALTER TABLE vps_servers ALTER COLUMN public_port DROP DEFAULT;
-- เลือก inbound ต่อแพ็กเกจ (ดึงรายการจาก 3x-ui) และจำ inbound ที่ใช้จริงในแต่ละออเดอร์
ALTER TABLE products ADD COLUMN IF NOT EXISTS inbound_id INTEGER;
ALTER TABLE orders   ADD COLUMN IF NOT EXISTS inbound_id INTEGER;

COMMIT;
