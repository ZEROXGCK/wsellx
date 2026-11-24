const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Pool } = require('pg');
const { Client: SshClient } = require('ssh2');

const {
  DATABASE_URL,
  JWT_SECRET,
  DATA_KEY,
  ADMIN_USERNAME,
  NOTIFY_WEBHOOK_URL,
  TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID
} = process.env;

if (!DATABASE_URL || !JWT_SECRET || !DATA_KEY || DATA_KEY.length !== 64) {
  console.error('ตั้งค่า DATABASE_URL, JWT_SECRET, DATA_KEY (hex 64 ตัว) ใน .env ก่อน');
  process.exit(1);
}

const KEY = Buffer.from(DATA_KEY, 'hex');
const pool = new Pool({ connectionString: DATABASE_URL });
const PROD = process.env.NODE_ENV === 'production';

class HttpErr extends Error {
  constructor(s, m, code) {
    super(m);
    this.status = s;
    this.code = code;
  }
}

// ---------- encryption & helpers ----------
const enc = t => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const b = Buffer.concat([c.update(String(t), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), b]).toString('base64');
};

const dec = s => {
  try {
    const b = Buffer.from(String(s), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    return '[ถอดรหัสไม่ได้]';
  }
};

const xfetch = (u, o = {}) => fetch(u, { ...o, signal: AbortSignal.timeout(15000) });
const rnd = n => Array.from(crypto.randomBytes(n), x => 'abcdefghjkmnpqrstuvwxyz23456789'[x % 31]).join('');
const genRefCode = () => 'NP' + rnd(6).toUpperCase();
const fmtDur = h => h === 24 ? '24 ชั่วโมง' : h % 24 === 0 ? (h / 24) + ' วัน' : h + ' ชั่วโมง';
const parseDur = s => {
  const m = String(s).match(/(\d+(?:\.\d+)?)\s*(ชั่วโมง|ชม|วัน|d|h)?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  return Math.round(/วัน|d/i.test(m[2] || '') ? n * 24 : n);
};

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

const audit = (actor, action, detail, ip) =>
  pool.query(
    'INSERT INTO audit_log(actor_id,action,detail,ip) VALUES($1,$2,$3,$4)',
    [actor, action, detail ? JSON.stringify(detail) : null, ip || null]
  ).catch(() => {});

const balanceOf = async id => {
  const r = await pool.query('SELECT credit_balance FROM users WHERE id=$1', [id]);
  return r.rows[0] ? +r.rows[0].credit_balance : 0;
};

async function getSettingsMap(client = pool, includeSecret = false) {
  const sql = includeSecret
    ? 'SELECT key, value, is_secret FROM settings'
    : 'SELECT key, value FROM settings WHERE NOT is_secret';
  const rows = (await client.query(sql)).rows;
  const out = {};
  for (const r of rows) {
    out[r.key] = includeSecret && r.is_secret ? dec(r.value) : r.value;
  }
  return out;
}

async function notifyExternal(text) {
  const jobs = [];
  if (NOTIFY_WEBHOOK_URL) {
    jobs.push(
      xfetch(NOTIFY_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: text, text })
      }).catch(() => {})
    );
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
    jobs.push(
      xfetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text })
      }).catch(() => {})
    );
  }
  if (jobs.length) await Promise.allSettled(jobs);
}

// =====================================================
// 3x-ui / X-UI API Connector (รองรับ Base Path และ Session Cookie)
// =====================================================
function normalizePanelUrl(rawUrl) {
  return String(rawUrl || '').trim().replace(/\/+$/, '');
}

async function login3xui(server) {
  const baseUrl = normalizePanelUrl(server.panel_url);
  if (!baseUrl) throw new HttpErr(400, 'ยังไม่ได้ตั้งค่า Panel URL ของเซิร์ฟเวอร์');
  const password = server.panel_pass_enc ? dec(server.panel_pass_enc) : '';

  const res = await xfetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: server.panel_user || '',
      password
    }).toString()
  });

  if (!res.ok) {
    throw new HttpErr(502, `เชื่อมต่อ 3x-ui ไม่สำเร็จ (HTTP ${res.status})`);
  }

  const data = await res.json().catch(() => ({}));
  if (!data || data.success !== true) {
    throw new HttpErr(401, data?.msg || 'ชื่อผู้ใช้หรือรหัสผ่าน 3x-ui ไม่ถูกต้อง');
  }

  // ดึง Session Cookie (รองรับทั้ง Node 20+ getSetCookie และ fallback header)
  let cookieHeader = '';
  if (typeof res.headers.getSetCookie === 'function') {
    const cookies = res.headers.getSetCookie();
    cookieHeader = cookies.map(c => c.split(';')[0]).join('; ');
  } else {
    const rawCookie = res.headers.get('set-cookie') || '';
    cookieHeader = rawCookie.split(',').map(c => c.trim().split(';')[0]).filter(Boolean).join('; ');
  }

  if (!cookieHeader) {
    throw new HttpErr(502, 'ล็อกอิน 3x-ui สำเร็จแต่ไม่ได้รับ Session Cookie');
  }

  return { baseUrl, cookieHeader };
}

async function test3xuiServer(server) {
  const { baseUrl, cookieHeader } = await login3xui(server);
  const listRes = await xfetch(`${baseUrl}/panel/api/inbounds/list`, {
    headers: { Cookie: cookieHeader }
  });
  if (!listRes.ok) {
    throw new HttpErr(502, `ดึงรายการ Inbound ไม่สำเร็จ (HTTP ${listRes.status})`);
  }
  const listData = await listRes.json().catch(() => ({}));
  const inbounds = Array.isArray(listData.obj) ? listData.obj : [];
  const targetInbound = inbounds.find(x => Number(x.id) === Number(server.inbound_id));

  return {
    ok: true,
    inboundCount: inbounds.length,
    inbounds: inbounds.map(x => ({
      id: x.id,
      remark: x.remark || `Inbound #${x.id}`,
      port: x.port,
      protocol: x.protocol,
      enable: x.enable,
      network: summarizeInbound(x).network,
      security: summarizeInbound(x).security
    })),
    matchedInbound: targetInbound
      ? (({ id, remark, port, protocol, network, security }) => ({ id, remark, port, protocol, network, security }))(summarizeInbound(targetInbound))
      : null
  };
}

const parseJsonSafe = v => {
  try { return typeof v === 'string' ? JSON.parse(v) : (v || {}); } catch { return {}; }
};

// อ่านค่าจริงของ inbound จาก 3x-ui (network / security / path / sni / reality ฯลฯ)
// เพื่อสร้างลิงก์ให้ตรงกับที่เซิร์ฟเวอร์ใช้งานจริง ไม่เดาว่าเป็น WebSocket เสมอ
function summarizeInbound(ib) {
  const ss = parseJsonSafe(ib.streamSettings);
  const st = parseJsonSafe(ib.settings);
  const network = String(ss.network || 'tcp').toLowerCase();
  const security = String(ss.security || 'none').toLowerCase();
  const tls = ss.tlsSettings || {};
  const rl = ss.realitySettings || {};
  const first = v => Array.isArray(v) ? (v[0] || '') : (v || '');
  const hdrHost = h => {
    if (!h) return '';
    const v = h.Host ?? h.host;
    return Array.isArray(v) ? (v[0] || '') : (v || '');
  };

  const info = {
    id: ib.id, remark: ib.remark, port: ib.port, enable: ib.enable,
    protocol: String(ib.protocol || '').toLowerCase(),
    network, security,
    path: '', host: '', serviceName: '', authority: '', mode: '', headerType: 'none',
    sni: '', fp: '', alpn: '', pbk: '', sid: '', spx: '',
    clients: Array.isArray(st.clients) ? st.clients : []
  };

  if (network === 'ws') {
    info.path = ss.wsSettings?.path || '/';
    info.host = ss.wsSettings?.host || hdrHost(ss.wsSettings?.headers);
  } else if (network === 'httpupgrade') {
    info.path = ss.httpupgradeSettings?.path || '/';
    info.host = ss.httpupgradeSettings?.host || hdrHost(ss.httpupgradeSettings?.headers);
  } else if (network === 'xhttp' || network === 'splithttp') {
    const x = ss.xhttpSettings || ss.splithttpSettings || {};
    info.path = x.path || '/';
    info.host = x.host || hdrHost(x.headers);
    info.mode = x.mode || '';
  } else if (network === 'grpc') {
    info.serviceName = ss.grpcSettings?.serviceName || '';
    info.authority = ss.grpcSettings?.authority || '';
  } else if (network === 'tcp') {
    const h = ss.tcpSettings?.header;
    if (h && h.type === 'http') {
      info.headerType = 'http';
      const req = h.request || {};
      info.path = first(req.path) || '/';
      info.host = hdrHost(req.headers);
    }
  }

  if (security === 'tls') {
    info.sni = tls.serverName || '';
    info.fp = tls.settings?.fingerprint || tls.fingerprint || '';
    info.alpn = Array.isArray(tls.alpn) ? tls.alpn.join(',') : (tls.alpn || '');
  } else if (security === 'reality') {
    info.sni = first(rl.serverNames);
    info.fp = rl.settings?.fingerprint || rl.fingerprint || 'chrome';
    info.pbk = rl.settings?.publicKey || rl.publicKey || '';
    info.sid = first(rl.shortIds);
    info.spx = rl.settings?.spiderX || rl.spiderX || '';
  }
  return info;
}

async function fetchInbound(baseUrl, cookieHeader, inboundId) {
  try {
    const r = await xfetch(`${baseUrl}/panel/api/inbounds/get/${Number(inboundId)}`, {
      headers: { Cookie: cookieHeader }
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || !d || !d.obj) return null;
    return summarizeInbound(d.obj);
  } catch {
    return null;
  }
}

// ib = ผลจาก summarizeInbound (ถ้าอ่านจาก 3x-ui ไม่ได้ จะ fallback ไปใช้ค่าที่ตั้งในหน้าแอดมิน = WebSocket)
function buildClientLink(server, meta, ib = null) {
  const proto = String(ib?.protocol || server.protocol || 'vless').toLowerCase();
  const host = server.host;
  const p = ib || {
    port: server.public_port || 443,
    network: 'ws',
    security: server.tls_enabled ? 'tls' : 'none',
    path: server.ws_path || '/',
    host: server.sni || host,
    sni: server.sni || host,
    serviceName: '', authority: '', mode: '', headerType: 'none', fp: '', alpn: '', pbk: '', sid: '', spx: ''
  };
  const port = server.public_port || p.port || 443;
  const sni = server.sni || p.sni || (p.security === 'none' ? '' : host);
  const wsHost = p.host || sni || host;
  const net = p.network === 'splithttp' ? 'xhttp' : p.network;
  const uri = encodeURIComponent;
  const remark = uri(meta.remark);

  if (proto === 'vmess') {
    const vmessObj = {
      v: '2', ps: meta.remark, add: host, port: String(port),
      id: meta.uuid, aid: '0', scy: 'auto',
      net,
      type: net === 'grpc' ? 'gun' : (p.headerType || 'none'),
      host: net === 'grpc' ? (p.authority || '') : wsHost,
      path: net === 'grpc' ? p.serviceName : (p.path || '/'),
      tls: p.security === 'tls' ? 'tls' : '',
      sni: p.security === 'tls' ? sni : '',
      alpn: p.alpn || '',
      fp: p.fp || ''
    };
    return 'vmess://' + Buffer.from(JSON.stringify(vmessObj)).toString('base64');
  }

  const q = [];
  const add = (k, v) => { if (v !== undefined && v !== null && v !== '') q.push(`${k}=${uri(v)}`); };
  add('type', net);
  if (proto === 'vless') add('encryption', 'none');
  add('security', p.security);

  if (net === 'ws' || net === 'httpupgrade' || net === 'xhttp') {
    add('path', p.path || '/');
    add('host', wsHost);
    if (net === 'xhttp') add('mode', p.mode);
  } else if (net === 'grpc') {
    add('serviceName', p.serviceName);
    add('authority', p.authority);
    add('mode', 'gun');
  } else if (net === 'tcp') {
    add('headerType', p.headerType || 'none');
    if (p.headerType === 'http') { add('path', p.path); add('host', p.host); }
  }

  if (p.security === 'tls') {
    add('sni', sni);
    add('fp', p.fp);
    add('alpn', p.alpn);
  } else if (p.security === 'reality') {
    add('sni', sni);
    add('fp', p.fp || 'chrome');
    add('pbk', p.pbk);
    add('sid', p.sid);
    add('spx', p.spx);
  }
  if (proto === 'vless' && net === 'tcp' && (p.security === 'tls' || p.security === 'reality')) {
    add('flow', 'xtls-rprx-vision');
  }

  return `${proto}://${uri(meta.uuid)}@${host}:${port}?${q.join('&')}#${remark}`;
}

// =====================================================
// SSH Connector (สร้าง/ต่ออายุ user จริงบนเซิร์ฟเวอร์ผ่าน ssh2)
// ต้องใช้ root หรือ user ที่ sudo ได้โดยไม่ถาม password
// =====================================================
function sshExec(server, cmd) {
  return new Promise((resolve, reject) => {
    if (!server.ssh_user || !server.ssh_pass_enc) {
      return reject(new HttpErr(400, 'ยังไม่ได้ตั้งค่า SSH User/Password ของเซิร์ฟเวอร์นี้'));
    }
    const c = new SshClient();
    let out = '', err = '';
    const timer = setTimeout(() => { c.end(); reject(new HttpErr(504, 'SSH หมดเวลาเชื่อมต่อ')); }, 25000);
    const fail = e => { clearTimeout(timer); c.end(); reject(e instanceof HttpErr ? e : new HttpErr(502, 'SSH: ' + e.message)); };
    c.on('ready', () => c.exec(cmd, (e, st) => {
      if (e) return fail(e);
      st.on('data', d => { out += d; });
      st.stderr.on('data', d => { err += d; });
      st.on('close', code => {
        clearTimeout(timer); c.end();
        code === 0 ? resolve(out.trim()) : reject(new HttpErr(502, 'คำสั่ง SSH ล้มเหลว: ' + (err || out).trim().slice(0, 200)));
      });
    }));
    c.on('error', fail);
    c.connect({ host: server.host, port: server.ssh_port || 22, username: server.ssh_user, password: dec(server.ssh_pass_enc), readyTimeout: 15000 });
  });
}
const sshDate = ms => new Date(ms + 864e5).toISOString().slice(0, 10); // +1 วัน กันตัดก่อนเวลา
const sshCreateUser = (server, user, pass, expMs) =>
  sshExec(server, `useradd -M -s /bin/false -e ${sshDate(expMs)} ${user} && echo '${user}:${pass}' | chpasswd`);
const SAFE_USER = /^[A-Za-z0-9_.-]{1,40}$/;
const needSafeUser = u => {
  if (!SAFE_USER.test(String(u || ''))) throw new HttpErr(400, 'ชื่อ user ไม่ปลอดภัย/ไม่ถูกต้อง');
  return u;
};
const sshExtendUser = (server, user, expMs) =>
  sshExec(server, `chage -E ${sshDate(expMs)} ${needSafeUser(user)} && (usermod -U ${user} 2>/dev/null || true)`);

// ปิดบัญชีบนเซิร์ฟเวอร์จริง
//   mode 'disable' = ล็อก/ปิดไว้ชั่วคราว (หมดอายุ — ต่ออายุแล้วเปิดกลับได้)
//   mode 'delete'  = ลบทิ้ง (คืนเงิน)
async function deprovisionAccount(server, ord, mode) {
  if (!server || !ord.client_email) return 'skipped';

  if (server.type === '3xui') {
    if (!ord.client_uuid) return 'skipped';
    const { baseUrl, cookieHeader } = await login3xui(server);
    const inboundId = Number(ord.inbound_id || server.inbound_id || 1);

    if (mode === 'delete') {
      const r = await xfetch(`${baseUrl}/panel/api/inbounds/${inboundId}/delClient/${encodeURIComponent(ord.client_uuid)}`, {
        method: 'POST',
        headers: { Cookie: cookieHeader }
      });
      const d = await r.json().catch(() => ({}));
      if (r.status === 404) return 'already_gone';
      if (!r.ok || d.success === false) throw new HttpErr(502, d?.msg || `ลบ Client บน 3x-ui ไม่สำเร็จ (HTTP ${r.status})`);
      return 'deleted';
    }

    // disable: อ่าน client เดิมมาแก้เฉพาะ enable/expiry เพื่อไม่ทำให้ subId/flow/limit หาย
    const ib = await fetchInbound(baseUrl, cookieHeader, inboundId);
    if (!ib) throw new HttpErr(502, 'อ่านข้อมูล Inbound จาก 3x-ui ไม่ได้');
    const cur = ib.clients.find(x => x.id === ord.client_uuid || x.password === ord.client_uuid || x.email === ord.client_email);
    if (!cur) return 'already_gone';
    if (cur.enable === false) return 'already_disabled';
    const r = await xfetch(`${baseUrl}/panel/api/inbounds/updateClient/${encodeURIComponent(ord.client_uuid)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({ clients: [{ ...cur, enable: false }] })
      })
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.success === false) throw new HttpErr(502, d?.msg || `ปิด Client บน 3x-ui ไม่สำเร็จ (HTTP ${r.status})`);
    return 'disabled';
  }

  if (server.type === 'ssh') {
    const u = needSafeUser(ord.client_email);
    if (mode === 'delete') {
      await sshExec(server, `pkill -KILL -u ${u} 2>/dev/null; userdel -f ${u} 2>/dev/null; if id -u ${u} >/dev/null 2>&1; then exit 1; else exit 0; fi`);
      return 'deleted';
    }
    await sshExec(server, `id -u ${u} >/dev/null 2>&1 || exit 0; usermod -L ${u} && chage -E 0 ${u}; rc=$?; pkill -KILL -u ${u} 2>/dev/null; exit $rc`);
    return 'disabled';
  }
  return 'skipped';
}

async function provisionFromServer(server, pl, username, existingMeta = null) {
  const hours = Number(pl.duration_hours || 24);
  const expiryTimeMs = existingMeta?.baseExpiryMs
    ? existingMeta.baseExpiryMs + hours * 3600e3
    : Date.now() + hours * 3600e3;

  if (!server) throw new HttpErr(503, 'แพ็กเกจนี้ยังไม่ได้ผูกเซิร์ฟเวอร์ที่เปิดใช้งาน (ระบบไม่ได้หักเครดิต)');

  // กรณี 3x-ui Panel
  if (server.type === '3xui') {
    const { baseUrl, cookieHeader } = await login3xui(server);
    const inboundId = Number(pl.inbound_id || server.inbound_id || 1);
    const ib = await fetchInbound(baseUrl, cookieHeader, inboundId);
    const realProto = String(ib?.protocol || server.protocol || 'vless').toLowerCase();
    const clientUuid = existingMeta?.clientUuid || crypto.randomUUID();
    const clientEmail = existingMeta?.clientEmail || `np_${username}_${rnd(5)}`;
    // ต่ออายุ: ใช้ค่าเดิมของ client (subId/flow/limit) ไม่สุ่มใหม่
    const prev = existingMeta?.clientUuid
      ? ib?.clients.find(x => x.id === clientUuid || x.password === clientUuid)
      : null;
    const subId = prev?.subId || rnd(12);
    const useVision = realProto === 'vless' && ib && ib.network === 'tcp' && ['tls', 'reality'].includes(ib.security);

    const clientObj = {
      ...(prev || {}),
      id: clientUuid,
      flow: useVision ? 'xtls-rprx-vision' : '',
      email: clientEmail,
      limitIp: prev?.limitIp ?? 2,
      totalGB: prev?.totalGB ?? 0,
      expiryTime: expiryTimeMs,
      enable: true,
      tgId: prev?.tgId ?? '',
      subId
    };
    if (realProto === 'trojan') clientObj.password = clientUuid;

    const endpoint = existingMeta?.clientUuid
      ? `${baseUrl}/panel/api/inbounds/updateClient/${clientUuid}`
      : `${baseUrl}/panel/api/inbounds/addClient`;

    const res = await xfetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader
      },
      body: JSON.stringify({
        id: inboundId,
        settings: JSON.stringify({ clients: [clientObj] })
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) {
      throw new HttpErr(502, data?.msg || 'สร้าง/ต่ออายุบัญชีบน 3x-ui ไม่สำเร็จ (ระบบไม่ได้หักเครดิต)');
    }

    const link = buildClientLink(server, {
      uuid: clientUuid,
      remark: `${pl.network}-${clientEmail}`
    }, ib);

    return {
      accountText: link,
      clientEmail,
      clientUuid,
      inboundId
    };
  }

  // กรณี SSH / UDP Server หรือ fallback
  const u = existingMeta?.clientEmail || ('np' + rnd(6));
  const pw = rnd(8);
  if (!existingMeta) await sshCreateUser(server, u, pw, expiryTimeMs);
  const host = server.host;
  const sshPort = server.ssh_port || 22;
  const udpPort = server.udp_port || '1-65535';
  const sni = server.sni || '';

  if (server.template && server.template.trim()) {
    const txt = server.template
      .replace(/\{host\}/g, host)
      .replace(/\{user\}/g, u)
      .replace(/\{pass\}/g, pw)
      .replace(/\{ssh_port\}/g, String(sshPort))
      .replace(/\{udp_port\}/g, String(udpPort))
      .replace(/\{sni\}/g, sni)
      .replace(/\{network\}/g, pl.network)
      .replace(/\{protocol\}/g, pl.protocol);
    return { accountText: txt, clientEmail: u, clientUuid: null };
  }

  if (pl.protocol === 'V2RAY') {
    const uid = existingMeta?.clientUuid || crypto.randomUUID();
    return {
      accountText: `vless://${uid}@${host}:443?type=ws&security=tls#${pl.network}-${u}`,
      clientEmail: u,
      clientUuid: uid
    };
  }

  return {
    accountText: `Host: ${host}\nPort: ${pl.protocol === 'UDP' ? udpPort : sshPort}\nUser: ${u}\nPass: ${pw}${sni ? '\nSNI: ' + sni : ''}`,
    clientEmail: u,
    clientUuid: null
  };
}

// ตรวจสลิปอัตโนมัติ (อ่านค่าตั้งค่าจากตาราง settings)
// slip_provider: generic (ส่ง JSON กลาง {proof, amount}) | easyslip | slipok
const EASYSLIP_URL = 'https://api.easyslip.com/v1/verify';
const amountOk = (paid, want) => Number.isFinite(paid) && Math.abs(paid - want) < 0.01;

async function verifySlipAuto(proof, amount) {
  const settings = await getSettingsMap(pool, true);
  const mode = settings.slip_mode || 'manual';
  const provider = String(settings.slip_provider || 'generic').toLowerCase();
  let verifyUrl = (settings.slip_verify_url || '').trim();
  const apiKey = (settings.slip_api_key || '').trim();

  if (provider === 'easyslip' && !verifyUrl) verifyUrl = EASYSLIP_URL;
  if (mode === 'manual' || !verifyUrl) {
    return { checked: false, valid: false, note: 'รอแอดมินตรวจสอบสลิป' };
  }

  const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(String(proof));
  const mime = m ? m[1] : 'image/jpeg';
  const b64 = m ? m[2] : '';

  try {
    // ---- EasySlip: POST JSON {data: base64}, Authorization: Bearer ----
    if (provider === 'easyslip') {
      const r = await xfetch(verifyUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
        body: JSON.stringify({ data: b64, checkDuplicate: true })
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.status !== 200 || !body.data) {
        return { checked: true, valid: false, note: 'EasySlip: ' + (body.message || `HTTP ${r.status}`) };
      }
      const paid = Number(body.data.amount?.amount);
      const valid = amountOk(paid, amount);
      return {
        checked: true, valid, transRef: body.data.transRef || null,
        note: valid ? 'ตรวจสลิปผ่านอัตโนมัติ (EasySlip)' : `ยอดในสลิป ${paid} ไม่ตรงกับยอดที่แจ้ง ${amount}`
      };
    }

    // ---- SlipOK: POST multipart (files, amount, log), header x-authorization ----
    // verifyUrl = https://api.slipok.com/api/line/apikey/<BRANCH_ID>
    if (provider === 'slipok') {
      const fd = new FormData();
      fd.append('files', new Blob([Buffer.from(b64, 'base64')], { type: mime }), 'slip.' + (mime.split('/')[1] || 'jpg'));
      fd.append('amount', String(amount));
      fd.append('log', 'true');
      const r = await xfetch(verifyUrl, { method: 'POST', headers: { 'x-authorization': apiKey }, body: fd });
      const body = await r.json().catch(() => ({}));
      if (!r.ok || body.success !== true || body.data?.success === false) {
        return { checked: true, valid: false, note: 'SlipOK: ' + (body.message || `HTTP ${r.status}`) };
      }
      const paid = body.data?.amount !== undefined ? Number(body.data.amount) : amount;
      const valid = amountOk(paid, amount);
      return {
        checked: true, valid, transRef: body.data?.transRef || null,
        note: valid ? 'ตรวจสลิปผ่านอัตโนมัติ (SlipOK)' : `ยอดในสลิป ${paid} ไม่ตรงกับยอดที่แจ้ง ${amount}`
      };
    }

    // ---- generic: JSON กลาง ----
    const r = await xfetch(verifyUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: 'Bearer ' + apiKey, 'x-api-key': apiKey } : {})
      },
      body: JSON.stringify({ proof, amount })
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      return { checked: true, valid: false, note: body.message || `API ตรวจสลิปตอบกลับ ${r.status}` };
    }
    const valid = Boolean(body.valid === true || body.success === true || body.data?.valid === true);
    return {
      checked: true,
      valid,
      transRef: body.data?.transRef || body.transRef || null,
      note: body.message || (valid ? 'ตรวจสอบสลิปผ่านอัตโนมัติ' : 'ยอดเงินหรือสลิปไม่ตรงเงื่อนไข')
    };
  } catch (e) {
    return { checked: true, valid: false, note: 'เชื่อมต่อ API ตรวจสลิปไม่ได้: ' + e.message };
  }
}

async function catalog() {
  const p = (await pool.query(`
    SELECT p.*, s.name AS server_name, s.type AS server_type
    FROM products p
    LEFT JOIN vps_servers s ON s.id = p.server_id
    WHERE NOT p.is_hidden
    ORDER BY p.id
  `)).rows;
  const pl = (await pool.query('SELECT * FROM plans ORDER BY price,id')).rows;
  const rv = (await pool.query(`
    SELECT r.id, r.product_id, r.rating, r.comment, r.created_at, u.username
    FROM reviews r JOIN users u ON u.id = r.user_id
    ORDER BY r.id DESC LIMIT 200
  `)).rows;

  return p.map(x => {
    const prodReviews = rv.filter(k => k.product_id === x.id);
    const avg = prodReviews.length
      ? +(prodReviews.reduce((acc, item) => acc + Number(item.rating), 0) / prodReviews.length).toFixed(1)
      : null;
    return {
      id: x.id,
      serverId: x.server_id,
      serverName: x.server_name || '',
      serverType: x.server_type || '',
      inboundId: x.inbound_id || null,
      net: x.network,
      proto: x.protocol,
      title: x.title,
      desc: x.description || '',
      img: x.image_url || '',
      badge: x.badge || '',
      ratingAvg: avg,
      ratingCount: prodReviews.length,
      reviews: prodReviews.slice(0, 10).map(k => ({
        id: k.id,
        user: k.username,
        rating: k.rating,
        comment: k.comment,
        at: k.created_at
      })),
      plans: pl
        .filter(k => k.product_id === x.id)
        .map(k => ({ id: k.id, n: k.name, d: fmtDur(k.duration_hours), hours: k.duration_hours, p: +k.price }))
    };
  });
}

// ---------- app ----------
const app = express();
if (PROD) app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ['https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: PROD ? [] : null
    }
  }
}));

app.use(express.json({ limit: '12mb' }), cookieParser());
app.use('/api', rateLimit({ windowMs: 15 * 60e3, limit: 600 }));
const authLimit = rateLimit({ windowMs: 60e3, limit: 10, message: { error: 'ลองบ่อยเกินไป รอสักครู่' } });
const w = f => (q, s, n) => f(q, s, n).catch(n);

const setCookie = (s, id) => s.cookie('tk', jwt.sign({ id }, JWT_SECRET, { expiresIn: '7d' }), {
  httpOnly: true,
  sameSite: 'strict',
  secure: PROD,
  maxAge: 7 * 864e5
});

const loadUser = w(async (q, s, n) => {
  try {
    const { id } = jwt.verify(q.cookies.tk || '', JWT_SECRET);
    q.user = (await pool.query('SELECT id,username,role,is_banned,referral_code FROM users WHERE id=$1', [id])).rows[0] || null;
  } catch {
    q.user = null;
  }
  n();
});

app.use(loadUser);
const need = (q, s, n) => {
  if (!q.user) return s.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  if (q.user.is_banned) return s.status(403).json({ error: 'บัญชีนี้ถูกระงับการใช้งาน กรุณาติดต่อแอดมิน' });
  n();
};
const adm = (q, s, n) => q.user.role === 'admin' ? n() : s.status(403).json({ error: 'เฉพาะแอดมิน' });

// ---------- public ----------
app.get('/api/health', w(async (q, s) => {
  await pool.query('SELECT 1');
  const srvCount = +(await pool.query('SELECT count(*) FROM vps_servers WHERE is_active')).rows[0].count;
  s.json({ status: 'ok', time: new Date(), activeServers: srvCount });
}));

app.get('/api/site', w(async (q, s) => {
  const site = await getSettingsMap(pool, false);
  ['slip_verify_url', 'slip_auto_approve', 'slip_mode', 'slip_provider'].forEach(k => delete site[k]);
  const members = +(await pool.query('SELECT count(*) FROM users')).rows[0].count;
  const activeServers = +(await pool.query('SELECT count(*) FROM vps_servers WHERE is_active')).rows[0].count;
  s.json({ site, products: await catalog(), members, activeServers });
}));

// ---------- auth ----------
const DUMMY = bcrypt.hashSync('x', 10);

app.post('/api/register', authLimit, w(async (q, s) => {
  const u = String(q.body.username || '').trim();
  const p = String(q.body.password || '');
  const refCode = String(q.body.referralCode || '').trim().toUpperCase();

  if (!/^[A-Za-z0-9_.-]{3,30}$/.test(u)) throw new HttpErr(400, 'ชื่อผู้ใช้ 3-30 ตัว ใช้ได้เฉพาะ a-z 0-9 _ . -');
  if (p.length < 8) throw new HttpErr(400, 'รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร');

  const role = ADMIN_USERNAME && u === ADMIN_USERNAME ? 'admin' : 'user';
  const myRefCode = genRefCode();

  const newUser = await tx(async c => {
    let referrerId = null;
    if (refCode) {
      const refRow = (await c.query('SELECT id FROM users WHERE referral_code=$1', [refCode])).rows[0];
      if (!refRow) throw new HttpErr(400, 'ไม่พบรหัสแนะนำเพื่อนนี้');
      referrerId = refRow.id;
    }
    try {
      const r = await c.query(
        'INSERT INTO users(username,password_hash,role,referral_code,referred_by) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [u, await bcrypt.hash(p, 12), role, myRefCode, referrerId]
      );
      return r.rows[0];
    } catch (e) {
      throw e.code === '23505' ? new HttpErr(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว') : e;
    }
  });

  setCookie(s, newUser.id);
  audit(newUser.id, 'register', { referredBy: refCode || null }, q.ip);
  s.json({ ok: true });
}));

app.post('/api/login', authLimit, w(async (q, s) => {
  const r = (await pool.query('SELECT id,password_hash,is_banned FROM users WHERE username=$1', [String(q.body.username || '')])).rows[0];
  const ok = await bcrypt.compare(String(q.body.password || ''), r ? r.password_hash : DUMMY);
  if (!r || !ok) {
    audit(null, 'login_fail', { u: String(q.body.username || '').slice(0, 30) }, q.ip);
    throw new HttpErr(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }
  if (r.is_banned) throw new HttpErr(403, 'บัญชีนี้ถูกระงับการใช้งาน');
  setCookie(s, r.id);
  s.json({ ok: true });
}));

app.post('/api/logout', (q, s) => {
  s.clearCookie('tk');
  s.json({ ok: true });
});

app.get('/api/me', w(async (q, s) => {
  if (!q.user) return s.json({ user: null });

  let refCode = q.user.referral_code;
  if (!refCode) {
    refCode = genRefCode();
    await pool.query('UPDATE users SET referral_code=$1 WHERE id=$2', [refCode, q.user.id]);
  }

  const refCount = +(await pool.query('SELECT count(*) FROM users WHERE referred_by=$1', [q.user.id])).rows[0].count;
  const o = (await pool.query(`
    SELECT o.id, o.plan_id, o.price_paid, o.account_data, o.expires_at, o.status, o.created_at,
           p.id AS product_id, p.title, p.network, p.protocol, pl.name, pl.duration_hours, pl.price AS plan_price
    FROM orders o
    JOIN plans pl ON pl.id = o.plan_id
    JOIN products p ON p.id = pl.product_id
    WHERE o.user_id = $1
    ORDER BY o.id DESC LIMIT 100
  `, [q.user.id])).rows;

  const tickets = (await pool.query(`
    SELECT id, order_id, subject, message, reply, status, created_at, updated_at
    FROM support_tickets
    WHERE user_id = $1
    ORDER BY id DESC LIMIT 50
  `, [q.user.id])).rows;

  const topups = (await pool.query(`
    SELECT id, method, amount, bonus_amount, status, verified_by, verify_note, created_at
    FROM topups
    WHERE user_id = $1
    ORDER BY id DESC LIMIT 50
  `, [q.user.id])).rows;

  s.json({
    user: { ...q.user, referral_code: refCode, referral_count: refCount },
    credit: await balanceOf(q.user.id),
    orders: o.map(x => ({
      id: x.id,
      planId: x.plan_id,
      productId: x.product_id,
      t: x.created_at,
      n: x.title + ' – ' + x.name,
      net: x.network,
      proto: x.protocol,
      hours: x.duration_hours,
      planPrice: +x.plan_price,
      p: +x.price_paid,
      exp: x.expires_at,
      status: x.status,
      a: dec(x.account_data)
    })),
    tickets,
    topups
  });
}));

// ---------- user actions ----------
async function approveTopupInTx(c, topupId, actorType, adminId) {
  const t = (await c.query(`
    UPDATE topups
    SET status = 'approved', verified_by = $2
    WHERE id = $1 AND status = 'pending'
    RETURNING id, user_id, method, amount, bonus_amount
  `, [topupId, actorType])).rows[0];

  if (!t) throw new HttpErr(409, 'รายการนี้ถูกจัดการไปแล้ว');

  await c.query(
    "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'topup',$3,$4)",
    [t.user_id, t.amount, t.id, `เติมเงินผ่าน ${t.method} (${actorType})`]
  );

  if (+t.bonus_amount > 0) {
    await c.query(
      "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'bonus',$3,$4)",
      [t.user_id, t.bonus_amount, t.id, 'โบนัสเติมเงิน']
    );
  }

  const uRow = (await c.query(
    'SELECT id, username, referred_by, referral_rewarded FROM users WHERE id=$1 FOR UPDATE',
    [t.user_id]
  )).rows[0];

  if (uRow && uRow.referred_by && !uRow.referral_rewarded) {
    const settings = await getSettingsMap(c, false);
    const refReward = Math.max(0, parseFloat(settings.referral_reward || '0') || 0);
    if (refReward > 0) {
      await c.query(
        "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'referral',$3,$4)",
        [uRow.referred_by, refReward, t.id, `โบนัสแนะนำเพื่อน (${uRow.username})`]
      );
    }
    await c.query('UPDATE users SET referral_rewarded = TRUE WHERE id=$1', [uRow.id]);
  }

  if (adminId) {
    audit(adminId, 'topup_approve', { id: t.id, amount: +t.amount, bonus: +t.bonus_amount }, null);
  }
  return t;
}

app.post('/api/topup', need, w(async (q, s) => {
  const { method, proof } = q.body;
  const amount = Math.round(parseFloat(q.body.amount) * 100) / 100;
  const settings = await getSettingsMap(pool, false);
  const minTopup = Math.max(1, parseFloat(settings.min_topup_amount || '20') || 20);

  if (!['bank', 'truemoney'].includes(method)) throw new HttpErr(400, 'วิธีเติมเงินไม่ถูกต้อง');
  if (!(amount >= minTopup && amount <= 100000)) {
    throw new HttpErr(400, `ยอดเติมเงินขั้นต่ำ ${minTopup} บาท (สูงสุด 100,000 บาท)`);
  }
  if (typeof proof !== 'string' || !proof) throw new HttpErr(400, 'กรุณาแนบสลิปหรือลิงก์');
  if (method === 'bank' && !/^data:image\/(jpeg|png|webp);base64,/.test(proof)) {
    throw new HttpErr(400, 'ไฟล์สลิปต้องเป็นรูปภาพ');
  }
  if (method === 'truemoney' && !/^https:\/\/gift\.truemoney\.com\//.test(proof)) {
    throw new HttpErr(400, 'ลิงก์ซองอั่งเปาไม่ถูกต้อง');
  }

  const hash = crypto
    .createHash('sha256')
    .update(method === 'bank' ? Buffer.from(proof.split(',')[1], 'base64') : proof)
    .digest('hex');

  const bonusMin = Math.max(0, parseFloat(settings.bonus_min_amount || '0') || 0);
  const bonusPct = Math.max(0, Math.min(100, parseFloat(settings.bonus_percent || '0') || 0));
  const bonusAmount = bonusPct > 0 && amount >= bonusMin
    ? Math.round(amount * bonusPct) / 100
    : 0;

  let autoRes = { checked: false, valid: false, note: '' };
  if (method === 'bank') {
    autoRes = await verifySlipAuto(proof, amount);
  }

  const shouldAutoApprove =
    method === 'bank' &&
    String(settings.slip_auto_approve).toLowerCase() === 'true' &&
    autoRes.checked &&
    autoRes.valid;

  let topupId;
  try {
    const ins = await pool.query(
      'INSERT INTO topups(user_id,method,amount,bonus_amount,slip_hash,proof,verify_note,trans_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [q.user.id, method, amount, bonusAmount, hash, proof, autoRes.note || null, autoRes.transRef || null]
    );
    topupId = ins.rows[0].id;
  } catch (e) {
    throw e.code === '23505' ? new HttpErr(409, 'สลิป/ซองนี้เคยถูกใช้แล้ว') : e;
  }

  if (shouldAutoApprove) {
    await tx(c => approveTopupInTx(c, topupId, 'auto', null));
    audit(q.user.id, 'topup_auto_approved', { topupId, amount, bonusAmount }, q.ip);
    return s.json({ ok: true, autoApproved: true, bonusAmount, credit: await balanceOf(q.user.id) });
  }

  audit(q.user.id, 'topup_request', { topupId, amount, bonusAmount, method, autoNote: autoRes.note }, q.ip);
  await notifyExternal(`🔔 มีคำขอเติมเงินใหม่ #${topupId} โดย ${q.user.username} จำนวน ${amount.toFixed(2)} บาท (${method})`);
  s.json({ ok: true, autoApproved: false, bonusAmount, verifyNote: autoRes.note || '' });
}));

app.post('/api/buy', need, w(async (q, s) => {
  const code = String(q.body.coupon || '').trim().toUpperCase();
  const out = await tx(async c => {
    const pl = (await c.query(`
      SELECT pl.*, p.network, p.protocol, p.title, p.server_id, p.inbound_id
      FROM plans pl JOIN products p ON p.id = pl.product_id
      WHERE pl.id = $1 AND NOT p.is_hidden
    `, [parseInt(q.body.planId, 10) || 0])).rows[0];
    if (!pl) throw new HttpErr(404, 'ไม่พบแพ็กเกจ');

    let price = +pl.price;
    let cid = null;
    if (code) {
      const cp = (await c.query(`
        SELECT * FROM coupons
        WHERE code = $1 AND remaining_uses > 0 AND (expires_at IS NULL OR expires_at > now())
        FOR UPDATE
      `, [code])).rows[0];
      if (!cp) throw new HttpErr(400, 'โค้ดส่วนลดไม่ถูกต้องหรือหมดอายุ');
      price = Math.round(price * (100 - cp.percent)) / 100;
      cid = cp.id;
      await c.query('UPDATE coupons SET remaining_uses = remaining_uses - 1 WHERE id = $1', [cid]);
    }

    const bal = +(await c.query('SELECT credit_balance FROM users WHERE id = $1 FOR UPDATE', [q.user.id])).rows[0].credit_balance;
    if (bal < price) {
      throw new HttpErr(400, `เครดิตไม่พอ ต้องใช้ ${price} บาท เหลือ ${bal.toFixed(2)} บาท กรุณาเติมเงินก่อน`);
    }

    let server = null;
    if (pl.server_id) {
      server = (await c.query('SELECT * FROM vps_servers WHERE id = $1 AND is_active', [pl.server_id])).rows[0] || null;
    }

    const prov = await provisionFromServer(server, pl, q.user.username);
    const o = (await c.query(`
      INSERT INTO orders(user_id,plan_id,server_id,client_email,client_uuid,price_paid,coupon_id,account_data,expires_at,inbound_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now() + make_interval(hours => $9),$10)
      RETURNING id, expires_at
    `, [q.user.id, pl.id, server ? server.id : null, prov.clientEmail, prov.clientUuid, price, cid, enc(prov.accountText), pl.duration_hours, prov.inboundId ?? null])).rows[0];

    if (price > 0) {
      await c.query(
        "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'purchase',$3,$4)",
        [q.user.id, -price, o.id, `ซื้อ ${pl.title} – ${pl.name}`]
      );
    }

    return { account: prov.accountText, paid: price, order: o.id, expiresAt: o.expires_at };
  });

  audit(q.user.id, 'purchase', { order: out.order, paid: out.paid }, q.ip);
  s.json({ ...out, credit: await balanceOf(q.user.id) });
}));

// ต่ออายุออเดอร์เดิม (รองรับต่ออายุ Client เดิมบน 3x-ui)
app.post('/api/orders/:id/renew', need, w(async (q, s) => {
  const orderId = parseInt(q.params.id, 10);
  if (!(orderId > 0)) throw new HttpErr(400, 'รหัสคำสั่งซื้อไม่ถูกต้อง');

  const out = await tx(async c => {
    const ord = (await c.query(`
      SELECT o.*, pl.duration_hours, pl.price AS plan_price, pl.name AS plan_name,
             p.title, p.network, p.protocol, p.is_hidden, p.server_id AS product_server_id, p.inbound_id AS product_inbound_id
      FROM orders o
      JOIN plans pl ON pl.id = o.plan_id
      JOIN products p ON p.id = pl.product_id
      WHERE o.id = $1 AND o.user_id = $2
      FOR UPDATE
    `, [orderId, q.user.id])).rows[0];

    if (!ord) throw new HttpErr(404, 'ไม่พบคำสั่งซื้อ');
    if (ord.status === 'refunded' || ord.status === 'cancelled') {
      throw new HttpErr(400, 'คำสั่งซื้อนี้ถูกคืนเงินหรือยกเลิกแล้ว ไม่สามารถต่ออายุได้');
    }
    if (ord.is_hidden) throw new HttpErr(400, 'แพ็กเกจนี้ถูกปิดให้บริการชั่วคราว');

    const price = +ord.plan_price;
    const bal = +(await c.query('SELECT credit_balance FROM users WHERE id = $1 FOR UPDATE', [q.user.id])).rows[0].credit_balance;
    if (bal < price) {
      throw new HttpErr(400, `เครดิตไม่พอสำหรับต่ออายุ ต้องใช้ ${price} บาท เหลือ ${bal.toFixed(2)} บาท`);
    }

    const baseExp = new Date(ord.expires_at) > new Date() ? new Date(ord.expires_at) : new Date();
    const newExp = new Date(baseExp.getTime() + Number(ord.duration_hours) * 3600e3);

    const srvId = ord.server_id || ord.product_server_id;
    let server = null;
    if (srvId) {
      server = (await c.query('SELECT * FROM vps_servers WHERE id = $1 AND is_active', [srvId])).rows[0] || null;
    }

    if (server && server.type === '3xui' && ord.client_uuid) {
      await provisionFromServer(
        server,
        { network: ord.network, protocol: ord.protocol, duration_hours: ord.duration_hours, inbound_id: ord.inbound_id || ord.product_inbound_id },
        q.user.username,
        { clientUuid: ord.client_uuid, clientEmail: ord.client_email, baseExpiryMs: baseExp.getTime() }
      );
    }

    if (server && server.type === 'ssh' && ord.client_email) {
      await sshExtendUser(server, ord.client_email, newExp.getTime());
    }

    await c.query(
      "UPDATE orders SET expires_at = $1, status = 'active', reminded_at = NULL, deprovisioned_at = NULL, deprov_tried_at = NULL WHERE id = $2",
      [newExp.toISOString(), ord.id]
    );

    if (price > 0) {
      await c.query(
        "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'purchase',$3,$4)",
        [q.user.id, -price, ord.id, `ต่ออายุ ${ord.title} – ${ord.plan_name}`]
      );
    }

    return { orderId: ord.id, paid: price, newExpiresAt: newExp.toISOString() };
  });

  audit(q.user.id, 'order_renew', out, q.ip);
  s.json({ ok: true, ...out, credit: await balanceOf(q.user.id) });
}));

app.post('/api/tickets', need, w(async (q, s) => {
  const subject = String(q.body.subject || '').trim();
  const message = String(q.body.message || '').trim();
  const orderId = q.body.orderId ? parseInt(q.body.orderId, 10) : null;

  if (subject.length < 3 || subject.length > 150) throw new HttpErr(400, 'หัวข้อปัญหาต้องยาว 3-150 ตัวอักษร');
  if (message.length < 5 || message.length > 2000) throw new HttpErr(400, 'รายละเอียดปัญหาต้องยาว 5-2000 ตัวอักษร');

  let validOrderId = null;
  if (orderId) {
    const chk = await pool.query('SELECT id FROM orders WHERE id=$1 AND user_id=$2', [orderId, q.user.id]);
    if (!chk.rows.length) throw new HttpErr(400, 'ไม่พบคำสั่งซื้อที่อ้างอิง');
    validOrderId = orderId;
  }

  const ins = await pool.query(
    'INSERT INTO support_tickets(user_id,order_id,subject,message) VALUES($1,$2,$3,$4) RETURNING id, created_at',
    [q.user.id, validOrderId, subject, message]
  );

  audit(q.user.id, 'ticket_create', { ticketId: ins.rows[0].id, subject }, q.ip);
  await notifyExternal(`🎫 แจ้งปัญหาใหม่ #${ins.rows[0].id} จาก ${q.user.username}: ${subject}`);
  s.json({ ok: true, id: ins.rows[0].id });
}));

app.post('/api/reviews', need, w(async (q, s) => {
  const productId = parseInt(q.body.productId, 10);
  const rating = parseInt(q.body.rating, 10);
  const comment = String(q.body.comment || '').trim();

  if (!(productId > 0)) throw new HttpErr(400, 'ไม่พบสินค้า');
  if (!(rating >= 1 && rating <= 5)) throw new HttpErr(400, 'คะแนนรีวิวต้องอยู่ระหว่าง 1 ถึง 5 ดาว');
  if (comment.length < 2 || comment.length > 500) throw new HttpErr(400, 'ข้อความรีวิวต้องยาว 2-500 ตัวอักษร');

  const bought = await pool.query(`
    SELECT 1 FROM orders o
    JOIN plans pl ON pl.id = o.plan_id
    WHERE o.user_id = $1 AND pl.product_id = $2
    LIMIT 1
  `, [q.user.id, productId]);

  if (!bought.rows.length) {
    throw new HttpErr(403, 'สามารถรีวิวได้เฉพาะแพ็กเกจที่เคยสั่งซื้อแล้วเท่านั้น');
  }

  await pool.query(`
    INSERT INTO reviews(user_id, product_id, rating, comment)
    VALUES($1, $2, $3, $4)
    ON CONFLICT (user_id, product_id)
    DO UPDATE SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()
  `, [q.user.id, productId, rating, comment]);

  audit(q.user.id, 'review_upsert', { productId, rating }, q.ip);
  s.json({ ok: true });
}));

// =====================================================
// ADMIN ENDPOINTS
// =====================================================
const SITE_KEYS = [
  'name', 'logo', 'hero', 'promo', 'title', 'sub', 'open',
  'bankName', 'bankNo', 'bankHolder', 'line',
  'min_topup_amount', 'bonus_min_amount', 'bonus_percent', 'referral_reward',
  'slip_mode', 'slip_provider', 'slip_verify_url', 'slip_auto_approve'
];

app.get('/api/admin/settings', need, adm, w(async (q, s) => {
  const all = await getSettingsMap(pool, true);
  const { slip_api_key, ...safe } = all;
  s.json({ ...safe, has_slip_api_key: Boolean(slip_api_key) });
}));

app.put('/api/admin/site', need, adm, w(async (q, s) => {
  for (const k of SITE_KEYS) {
    if (typeof q.body[k] === 'string') {
      await pool.query(
        'INSERT INTO settings(key,value,is_secret) VALUES($1,$2,FALSE) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value',
        [k, q.body[k].slice(0, 2e6)]
      );
    }
  }
  if (typeof q.body.slip_api_key === 'string' && q.body.slip_api_key.trim()) {
    await pool.query(
      'INSERT INTO settings(key,value,is_secret) VALUES($1,$2,TRUE) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, is_secret=TRUE',
      ['slip_api_key', enc(q.body.slip_api_key.trim())]
    );
  }
  audit(q.user.id, 'site_update', null, q.ip);
  s.json({ ok: true });
}));

// ---------- Admin: จัดการผู้ใช้งาน (Users Management) ----------
app.get('/api/admin/users', need, adm, w(async (q, s) => {
  const search = String(q.body?.q || q.query.q || '').trim();
  const params = [];
  let where = '';
  if (search) {
    params.push(`%${search}%`);
    where = 'WHERE u.username ILIKE $1 OR u.referral_code ILIKE $1';
  }

  const rows = (await pool.query(`
    SELECT u.id, u.username, u.role, u.is_banned, u.note, u.credit_balance,
           u.referral_code, u.created_at,
           (SELECT count(*) FROM orders o WHERE o.user_id = u.id)::int AS order_count,
           (SELECT COALESCE(sum(price_paid), 0) FROM orders o WHERE o.user_id = u.id AND o.status <> 'refunded') AS total_spent,
           (SELECT COALESCE(sum(amount), 0) FROM topups t WHERE t.user_id = u.id AND t.status = 'approved') AS total_topup
    FROM users u
    ${where}
    ORDER BY u.id DESC
    LIMIT 200
  `, params)).rows;

  s.json(rows.map(r => ({
    ...r,
    credit_balance: +r.credit_balance,
    total_spent: +r.total_spent,
    total_topup: +r.total_topup
  })));
}));

app.get('/api/admin/users/:id', need, adm, w(async (q, s) => {
  const uid = parseInt(q.params.id, 10);
  const u = (await pool.query(`
    SELECT id, username, role, is_banned, note, credit_balance, referral_code, referred_by, created_at
    FROM users WHERE id = $1
  `, [uid])).rows[0];
  if (!u) throw new HttpErr(404, 'ไม่พบผู้ใช้งาน');

  const orders = (await pool.query(`
    SELECT o.id, o.price_paid, o.status, o.expires_at, o.created_at, o.client_email,
           p.title, pl.name AS plan_name
    FROM orders o
    JOIN plans pl ON pl.id = o.plan_id
    JOIN products p ON p.id = pl.product_id
    WHERE o.user_id = $1
    ORDER BY o.id DESC LIMIT 30
  `, [uid])).rows;

  const ledger = (await pool.query(`
    SELECT id, amount, type, ref_id, note, balance_after, created_at
    FROM credit_ledger
    WHERE user_id = $1
    ORDER BY id DESC LIMIT 30
  `, [uid])).rows;

  s.json({
    user: { ...u, credit_balance: +u.credit_balance },
    orders: orders.map(x => ({ ...x, price_paid: +x.price_paid })),
    ledger: ledger.map(x => ({ ...x, amount: +x.amount, balance_after: +x.balance_after }))
  });
}));

app.post('/api/admin/users/:id/adjust-credit', need, adm, w(async (q, s) => {
  const uid = parseInt(q.params.id, 10);
  const amount = Math.round(parseFloat(q.body.amount) * 100) / 100;
  const note = String(q.body.note || '').trim() || 'แอดมินปรับยอดเครดิต';
  if (!amount || Math.abs(amount) > 100000) throw new HttpErr(400, 'จำนวนเงินไม่ถูกต้อง');

  await tx(async c => {
    const u = (await c.query('SELECT id, credit_balance FROM users WHERE id = $1 FOR UPDATE', [uid])).rows[0];
    if (!u) throw new HttpErr(404, 'ไม่พบผู้ใช้งาน');
    if (+u.credit_balance + amount < 0) throw new HttpErr(400, 'ยอดเครดิตหลังหักต้องไม่ติดลบ');

    await c.query(
      "INSERT INTO credit_ledger(user_id,amount,type,note) VALUES($1,$2,'adjust',$3)",
      [uid, amount, note]
    );
  });

  audit(q.user.id, 'user_credit_adjust', { targetUserId: uid, amount, note }, q.ip);
  s.json({ ok: true, credit: await balanceOf(uid) });
}));

app.put('/api/admin/users/:id', need, adm, w(async (q, s) => {
  const uid = parseInt(q.params.id, 10);
  if (uid === q.user.id && q.body.is_banned === true) {
    throw new HttpErr(400, 'ไม่สามารถระงับบัญชีของตัวเองได้');
  }
  const role = ['user', 'admin'].includes(q.body.role) ? q.body.role : undefined;
  const isBanned = typeof q.body.is_banned === 'boolean' ? q.body.is_banned : undefined;
  const note = typeof q.body.note === 'string' ? q.body.note.slice(0, 500) : undefined;

  const cur = (await pool.query('SELECT role, is_banned, note FROM users WHERE id = $1', [uid])).rows[0];
  if (!cur) throw new HttpErr(404, 'ไม่พบผู้ใช้งาน');

  await pool.query(
    'UPDATE users SET role=$2, is_banned=$3, note=$4 WHERE id=$1',
    [uid, role ?? cur.role, isBanned ?? cur.is_banned, note ?? cur.note]
  );

  if (typeof q.body.new_password === 'string' && q.body.new_password.length >= 8) {
    await pool.query('UPDATE users SET password_hash=$2 WHERE id=$1', [uid, await bcrypt.hash(q.body.new_password, 12)]);
  }

  audit(q.user.id, 'user_update', { targetUserId: uid, role, isBanned }, q.ip);
  s.json({ ok: true });
}));

// ---------- Admin: จัดการเซิร์ฟเวอร์ VPS (3x-ui / SSH) ----------
app.get('/api/admin/servers', need, adm, w(async (q, s) => {
  const rows = (await pool.query(`
    SELECT id, name, type, host, panel_url, panel_user, ssh_user, (ssh_pass_enc IS NOT NULL) AS has_ssh_pass, inbound_id, protocol,
           ws_path, sni, public_port, ssh_port, udp_port, tls_enabled,
           template, is_active, last_status, last_checked_at, created_at
    FROM vps_servers
    ORDER BY id DESC
  `)).rows;
  s.json(rows);
}));

app.post('/api/admin/servers', need, adm, w(async (q, s) => {
  const b = q.body;
  const type = ['3xui', 'ssh'].includes(b.type) ? b.type : '3xui';
  const name = String(b.name || '').trim();
  const host = String(b.host || '').trim();
  if (!name || !host) throw new HttpErr(400, 'กรุณากรอกชื่อเซิร์ฟเวอร์และ Host / IP');
  if (type === '3xui' && (!String(b.panel_url || '').trim() || !String(b.panel_user || '').trim() || !b.panel_pass)) {
    throw new HttpErr(400, 'กรุณากรอก Panel URL, Username และ Password ของ 3x-ui');
  }

  const panelPassEnc = b.panel_pass ? enc(String(b.panel_pass)) : null;

  const ins = await pool.query(`
    INSERT INTO vps_servers(
      name, type, host, panel_url, panel_user, panel_pass_enc,
      inbound_id, protocol, ws_path, sni, public_port, ssh_port, udp_port,
      tls_enabled, template, is_active, ssh_user, ssh_pass_enc
    ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    RETURNING id
  `, [
    name,
    type,
    host,
    normalizePanelUrl(b.panel_url || ''),
    String(b.panel_user || '').trim(),
    panelPassEnc,
    parseInt(b.inbound_id, 10) || 1,
    String(b.protocol || 'vless').toLowerCase(),
    String(b.ws_path || '/').trim() || '/',
    String(b.sni || '').trim(),
    parseInt(b.public_port, 10) || null, // ว่าง = ใช้พอร์ตจริงของ inbound
    parseInt(b.ssh_port, 10) || 22,
    String(b.udp_port || '1-65535').trim() || '1-65535',
    b.tls_enabled !== false,
    String(b.template || ''),
    b.is_active !== false,
    String(b.ssh_user || '').trim() || null,
    b.ssh_pass ? enc(String(b.ssh_pass)) : null
  ]);

  audit(q.user.id, 'server_add', { id: ins.rows[0].id, name, type }, q.ip);
  s.json({ ok: true, id: ins.rows[0].id });
}));

app.put('/api/admin/servers/:id', need, adm, w(async (q, s) => {
  const id = parseInt(q.params.id, 10);
  const b = q.body;
  const cur = (await pool.query('SELECT * FROM vps_servers WHERE id = $1', [id])).rows[0];
  if (!cur) throw new HttpErr(404, 'ไม่พบเซิร์ฟเวอร์');

  const name = String(b.name ?? cur.name).trim();
  const host = String(b.host ?? cur.host).trim();
  const type = ['3xui', 'ssh'].includes(b.type) ? b.type : cur.type;
  const panelPassEnc = b.panel_pass && String(b.panel_pass).trim()
    ? enc(String(b.panel_pass).trim())
    : cur.panel_pass_enc;

  await pool.query(`
    UPDATE vps_servers SET
      name=$2, type=$3, host=$4, panel_url=$5, panel_user=$6, panel_pass_enc=$7,
      inbound_id=$8, protocol=$9, ws_path=$10, sni=$11, public_port=$12,
      ssh_port=$13, udp_port=$14, tls_enabled=$15, template=$16, is_active=$17, ssh_user=$18, ssh_pass_enc=$19
    WHERE id=$1
  `, [
    id,
    name,
    type,
    host,
    normalizePanelUrl(b.panel_url ?? cur.panel_url),
    String(b.panel_user ?? cur.panel_user).trim(),
    panelPassEnc,
    parseInt(b.inbound_id, 10) || cur.inbound_id,
    String(b.protocol ?? cur.protocol).toLowerCase(),
    String(b.ws_path ?? cur.ws_path).trim() || '/',
    String(b.sni ?? cur.sni).trim(),
    'public_port' in b ? (parseInt(b.public_port, 10) || null) : cur.public_port,
    parseInt(b.ssh_port, 10) || cur.ssh_port,
    String(b.udp_port ?? cur.udp_port).trim() || '1-65535',
    typeof b.tls_enabled === 'boolean' ? b.tls_enabled : cur.tls_enabled,
    String(b.template ?? cur.template ?? ''),
    typeof b.is_active === 'boolean' ? b.is_active : cur.is_active,
    typeof b.ssh_user === 'string' ? (b.ssh_user.trim() || null) : cur.ssh_user,
    b.ssh_pass && String(b.ssh_pass).trim() ? enc(String(b.ssh_pass).trim()) : cur.ssh_pass_enc
  ]);

  audit(q.user.id, 'server_edit', { id, name }, q.ip);
  s.json({ ok: true });
}));

app.delete('/api/admin/servers/:id', need, adm, w(async (q, s) => {
  await pool.query('DELETE FROM vps_servers WHERE id = $1', [q.params.id]);
  audit(q.user.id, 'server_delete', { id: q.params.id }, q.ip);
  s.json({ ok: true });
}));

// รายการ inbound ที่สร้างไว้ใน 3x-ui (ใช้ให้แอดมินเลือกตอนเพิ่มแพ็กเกจ)
app.get('/api/admin/servers/:id/inbounds', need, adm, w(async (q, s) => {
  const srv = (await pool.query('SELECT * FROM vps_servers WHERE id = $1', [parseInt(q.params.id, 10) || 0])).rows[0];
  if (!srv) throw new HttpErr(404, 'ไม่พบเซิร์ฟเวอร์');
  if (srv.type !== '3xui') throw new HttpErr(400, 'เซิร์ฟเวอร์นี้ไม่ใช่ 3x-ui');
  const r = await test3xuiServer(srv);
  s.json({ inbounds: r.inbounds });
}));

app.post('/api/admin/servers/:id/test', need, adm, w(async (q, s) => {
  const srv = (await pool.query('SELECT * FROM vps_servers WHERE id = $1', [q.params.id])).rows[0];
  if (!srv) throw new HttpErr(404, 'ไม่พบเซิร์ฟเวอร์');

  if (srv.type === '3xui') {
    try {
      const result = await test3xuiServer(srv);
      await pool.query("UPDATE vps_servers SET last_status='online', last_checked_at=now() WHERE id=$1", [srv.id]);
      return s.json(result);
    } catch (e) {
      await pool.query("UPDATE vps_servers SET last_status='error', last_checked_at=now() WHERE id=$1", [srv.id]);
      throw e;
    }
  }

  // ทดสอบสร้างข้อความตัวอย่างสำหรับ SSH/UDP
  try {
    const who = await sshExec(srv, 'id -u; command -v useradd chpasswd chage');
    const isRoot = who.split('\n')[0] === '0';
    await pool.query("UPDATE vps_servers SET last_status='online', last_checked_at=now() WHERE id=$1", [srv.id]);
    s.json({ ok: true, sample: `เชื่อมต่อ SSH สำเร็จ\nสิทธิ์ root: ${isRoot ? 'ใช่' : 'ไม่ใช่ (สร้าง user ไม่ได้)'}\n${who}` });
  } catch (e) {
    await pool.query("UPDATE vps_servers SET last_status='error', last_checked_at=now() WHERE id=$1", [srv.id]);
    throw e;
  }
}));

// ---------- Admin: จัดการแพ็กเกจ (Products) ----------
async function saveProduct(c, id, b) {
  const NET = ['AIS', 'TRUE', 'dtac'];
  const PRO = ['SSH', 'V2RAY', 'UDP'];
  if (!NET.includes(b.net) || !PRO.includes(b.proto) || !String(b.title || '').trim()) {
    throw new HttpErr(400, 'ข้อมูลแพ็กเกจไม่ครบ');
  }
  const plans = (b.plans || []).map(k => ({ n: String(k.n).trim(), h: parseDur(k.d), p: parseFloat(k.p) }));
  if (!plans.length || plans.some(k => !k.n || !(k.h > 0) || !(k.p >= 0))) {
    throw new HttpErr(400, 'ข้อมูลราคาไม่ถูกต้อง');
  }
  const badge = String(b.badge || '').trim().slice(0, 30);
  const serverId = b.serverId ? parseInt(b.serverId, 10) : null;
  const inboundId = serverId && b.inboundId ? (parseInt(b.inboundId, 10) || null) : null;

  if (id) {
    const img = b.img === undefined || b.img === null ? null : b.img;
    await c.query(
      'UPDATE products SET server_id=$2, network=$3, protocol=$4, title=$5, description=$6, badge=$7, image_url=COALESCE($8,image_url), inbound_id=$9 WHERE id=$1',
      [id, serverId, b.net, b.proto, b.title.trim(), b.desc || '', badge, img, inboundId]
    );
  } else {
    id = (await c.query(
      'INSERT INTO products(server_id,network,protocol,title,description,image_url,badge,inbound_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [serverId, b.net, b.proto, b.title.trim(), b.desc || '', b.img || null, badge, inboundId]
    )).rows[0].id;
  }

  for (const k of plans) {
    const u = await c.query('UPDATE plans SET duration_hours=$3, price=$4 WHERE product_id=$1 AND name=$2', [id, k.n, k.h, k.p]);
    if (!u.rowCount) {
      await c.query('INSERT INTO plans(product_id,name,duration_hours,price) VALUES($1,$2,$3,$4)', [id, k.n, k.h, k.p]);
    }
  }

  await c.query(
    'DELETE FROM plans WHERE product_id=$1 AND name<>ALL($2) AND id NOT IN (SELECT plan_id FROM orders)',
    [id, plans.map(k => k.n)]
  );
  return id;
}

app.post('/api/admin/products', need, adm, w(async (q, s) => {
  const id = await tx(c => saveProduct(c, null, q.body));
  audit(q.user.id, 'product_add', { id }, q.ip);
  s.json({ id });
}));

app.put('/api/admin/products/:id', need, adm, w(async (q, s) => {
  await tx(c => saveProduct(c, q.params.id, q.body));
  audit(q.user.id, 'product_edit', { id: q.params.id }, q.ip);
  s.json({ ok: true });
}));

app.delete('/api/admin/products/:id', need, adm, w(async (q, s) => {
  await pool.query('UPDATE products SET is_hidden=true WHERE id=$1', [q.params.id]);
  audit(q.user.id, 'product_hide', { id: q.params.id }, q.ip);
  s.json({ ok: true });
}));

// ---------- Admin: เติมเงิน / คูปอง / คืนเงิน / แจ้งปัญหา ----------
app.get('/api/admin/topups', need, adm, w(async (q, s) => {
  const rows = (await pool.query(`
    SELECT t.id, t.method, t.amount, t.bonus_amount, t.proof, t.verify_note, t.created_at, u.username
    FROM topups t JOIN users u ON u.id = t.user_id
    WHERE t.status = 'pending'
    ORDER BY t.id
  `)).rows;
  s.json(rows);
}));

app.post('/api/admin/topups/:id/:act', need, adm, w(async (q, s) => {
  const ok = q.params.act === 'approve';
  if (!ok && q.params.act !== 'reject') throw new HttpErr(400, 'bad request');

  await tx(async c => {
    if (ok) {
      await approveTopupInTx(c, q.params.id, 'admin', q.user.id);
    } else {
      const t = (await c.query(
        "UPDATE topups SET status='rejected', verified_by='admin' WHERE id=$1 AND status='pending' RETURNING id",
        [q.params.id]
      )).rows[0];
      if (!t) throw new HttpErr(409, 'รายการนี้ถูกจัดการไปแล้ว');
      audit(q.user.id, 'topup_reject', { id: t.id }, q.ip);
    }
  });

  s.json({ ok: true });
}));

app.get('/api/admin/coupons', need, adm, w(async (q, s) => {
  const rows = (await pool.query('SELECT id, code, percent, remaining_uses, expires_at, created_at FROM coupons ORDER BY id DESC LIMIT 100')).rows;
  s.json(rows);
}));

app.post('/api/admin/coupons', need, adm, w(async (q, s) => {
  const code = String(q.body.code || '').trim().toUpperCase();
  const percent = parseInt(q.body.percent, 10);
  const remainingUses = parseInt(q.body.remaining_uses, 10);
  const expiresAt = q.body.expires_at ? new Date(q.body.expires_at).toISOString() : null;

  if (!/^[A-Z0-9_-]{2,40}$/.test(code)) throw new HttpErr(400, 'โค้ดส่วนลดใช้ได้เฉพาะ A-Z 0-9 _ - ความยาว 2-40 ตัว');
  if (!(percent >= 1 && percent <= 100)) throw new HttpErr(400, 'ส่วนลดต้องอยู่ระหว่าง 1-100%');
  if (!(remainingUses >= 1)) throw new HttpErr(400, 'จำนวนสิทธิ์ต้องอย่างน้อย 1 ครั้ง');

  try {
    const r = await pool.query(
      'INSERT INTO coupons(code, percent, remaining_uses, expires_at) VALUES($1, $2, $3, $4) RETURNING id',
      [code, percent, remainingUses, expiresAt]
    );
    audit(q.user.id, 'coupon_create', { id: r.rows[0].id, code, percent }, q.ip);
    s.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    throw e.code === '23505' ? new HttpErr(409, 'โค้ดส่วนลดนี้มีอยู่แล้ว') : e;
  }
}));

app.delete('/api/admin/coupons/:id', need, adm, w(async (q, s) => {
  await pool.query('UPDATE coupons SET remaining_uses = 0 WHERE id = $1', [q.params.id]);
  audit(q.user.id, 'coupon_disable', { id: q.params.id }, q.ip);
  s.json({ ok: true });
}));

app.get('/api/admin/orders', need, adm, w(async (q, s) => {
  const rows = (await pool.query(`
    SELECT o.id, o.user_id, o.price_paid, o.status, o.expires_at, o.created_at,
           u.username, p.title, pl.name AS plan_name
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN plans pl ON pl.id = o.plan_id
    JOIN products p ON p.id = pl.product_id
    ORDER BY o.id DESC LIMIT 100
  `)).rows;
  s.json(rows);
}));

app.post('/api/admin/orders/:id/refund', need, adm, w(async (q, s) => {
  const orderId = parseInt(q.params.id, 10);
  if (!(orderId > 0)) throw new HttpErr(400, 'รหัสคำสั่งซื้อไม่ถูกต้อง');
  const force = q.body?.force === true;                    // คืนเงินต่อแม้ปิดบัญชีบนเซิร์ฟเวอร์ไม่สำเร็จ
  const includeRenewals = q.body?.includeRenewals === true; // รวมค่าต่ออายุด้วย (ค่าเริ่มต้น: คืนเฉพาะราคาออเดอร์แรก)

  const out = await tx(async c => {
    const ord = (await c.query(`
      SELECT id, user_id, price_paid, status, client_email, client_uuid, server_id, inbound_id
      FROM orders
      WHERE id = $1
      FOR UPDATE
    `, [orderId])).rows[0];

    if (!ord) throw new HttpErr(404, 'ไม่พบคำสั่งซื้อ');
    if (ord.status === 'refunded') throw new HttpErr(409, 'คำสั่งซื้อนี้คืนเงินไปแล้ว');

    let amount = +ord.price_paid;
    if (includeRenewals) {
      const sum = (await c.query(
        "SELECT COALESCE(-sum(amount), 0) AS s FROM credit_ledger WHERE type = 'purchase' AND ref_id = $1 AND user_id = $2",
        [ord.id, ord.user_id]
      )).rows[0].s;
      amount = Math.max(amount, +sum);
    }

    // ปิด/ลบบัญชีบนเซิร์ฟเวอร์ก่อน แล้วค่อยคืนเงิน
    let account = 'skipped';
    if (ord.server_id) {
      const server = (await c.query('SELECT * FROM vps_servers WHERE id = $1', [ord.server_id])).rows[0];
      if (server) {
        try {
          account = await deprovisionAccount(server, ord, 'delete');
        } catch (e) {
          if (!force) {
            throw new HttpErr(502, `ปิดบัญชีบนเซิร์ฟเวอร์ไม่สำเร็จ: ${e.message} (ยังไม่ได้คืนเงิน)`, 'DEPROV_FAILED');
          }
          account = 'failed_forced';
        }
      }
    }

    await c.query("UPDATE orders SET status = 'refunded', deprovisioned_at = now() WHERE id = $1", [ord.id]);
    if (amount > 0) {
      await c.query(
        "INSERT INTO credit_ledger(user_id,amount,type,ref_id,note) VALUES($1,$2,'refund',$3,$4)",
        [ord.user_id, amount, ord.id, `คืนเงินคำสั่งซื้อ #${ord.id}${includeRenewals ? ' (รวมค่าต่ออายุ)' : ''}`]
      );
    }
    return { amount, account };
  });

  audit(q.user.id, 'order_refund', { orderId, ...out, force, includeRenewals }, q.ip);
  s.json({ ok: true, ...out });
}));

app.get('/api/admin/tickets', need, adm, w(async (q, s) => {
  const rows = (await pool.query(`
    SELECT t.id, t.user_id, t.order_id, t.subject, t.message, t.reply, t.status, t.created_at, t.updated_at, u.username
    FROM support_tickets t JOIN users u ON u.id = t.user_id
    ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END, t.id DESC
    LIMIT 100
  `)).rows;
  s.json(rows);
}));

app.post('/api/admin/tickets/:id/reply', need, adm, w(async (q, s) => {
  const ticketId = parseInt(q.params.id, 10);
  const reply = String(q.body.reply || '').trim();
  const status = q.body.status === 'closed' ? 'closed' : 'answered';
  if (!reply) throw new HttpErr(400, 'กรุณากรอกข้อความตอบกลับ');

  const upd = await pool.query(
    'UPDATE support_tickets SET reply=$1, status=$2, updated_at=now() WHERE id=$3 RETURNING id',
    [reply, status, ticketId]
  );
  if (!upd.rows.length) throw new HttpErr(404, 'ไม่พบรายการแจ้งปัญหา');

  audit(q.user.id, 'ticket_reply', { ticketId, status }, q.ip);
  s.json({ ok: true });
}));

// ---------- static + errors ----------
app.use(express.static(require('path').join(__dirname, 'public')));

app.use((e, q, s, n) => {
  if (e instanceof HttpErr) return s.status(e.status).json({ error: e.message, code: e.code });
  if (e.type === 'entity.too.large') return s.status(413).json({ error: 'ไฟล์ใหญ่เกินไป' });
  console.error(e);
  s.status(500).json({ error: 'เซิร์ฟเวอร์ผิดพลาด ลองใหม่อีกครั้ง' });
});

// ปิดบัญชีที่หมดอายุจริงบนเซิร์ฟเวอร์ (3x-ui: disable client / SSH: lock user + kick session)
async function deprovisionExpired() {
  const rows = (await pool.query(`
    SELECT id, client_email, client_uuid, server_id, inbound_id
    FROM orders
    WHERE status = 'expired' AND deprovisioned_at IS NULL AND server_id IS NOT NULL
      AND (deprov_tried_at IS NULL OR deprov_tried_at < now() - interval '5 minutes')
    ORDER BY deprov_tried_at NULLS FIRST, id
    LIMIT 20
  `)).rows;

  for (const o of rows) {
    await pool.query('UPDATE orders SET deprov_tried_at = now() WHERE id = $1', [o.id]);
    try {
      const server = (await pool.query('SELECT * FROM vps_servers WHERE id = $1', [o.server_id])).rows[0];
      const result = server ? await deprovisionAccount(server, o, 'disable') : 'no_server';
      await pool.query("UPDATE orders SET deprovisioned_at = now() WHERE id = $1 AND status = 'expired'", [o.id]);
      audit(null, 'order_deprovision', { orderId: o.id, result }, null);
    } catch (e) {
      console.error(`ปิดบัญชีหมดอายุ order #${o.id} ไม่สำเร็จ:`, e.message);
    }
  }
}

let sweeping = false;
setInterval(async () => {
  if (sweeping) return;
  sweeping = true;
  try {
    await pool.query("UPDATE orders SET status='expired' WHERE status='active' AND expires_at < now()");
    await deprovisionExpired();
    const soonRows = (await pool.query(`
      SELECT o.id, o.expires_at, u.username, p.title, pl.name AS plan_name
      FROM orders o
      JOIN users u ON u.id = o.user_id
      JOIN plans pl ON pl.id = o.plan_id
      JOIN products p ON p.id = pl.product_id
      WHERE o.status = 'active'
        AND o.reminded_at IS NULL
        AND o.expires_at > now()
        AND o.expires_at <= now() + interval '24 hours'
      LIMIT 50
    `)).rows;

    for (const r of soonRows) {
      await notifyExternal(`⏰ แจ้งเตือนแพ็กเกจใกล้หมดอายุ: ออเดอร์ #${r.id} ของคุณ ${r.username} (${r.title} – ${r.plan_name}) จะหมดอายุ ${new Date(r.expires_at).toLocaleString('th-TH')}`);
      await pool.query('UPDATE orders SET reminded_at = now() WHERE id = $1', [r.id]);
    }
  } catch (err) {
    console.error(err);
  } finally {
    sweeping = false;
  }
}, 60e3);

// เตือนถ้ายังไม่มีแอดมินในระบบ: คนที่สมัครด้วยชื่อ ADMIN_USERNAME ก่อนจะได้เป็นแอดมิน
pool.query("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1").then(r => {
  if (!r.rows.length) {
    console.warn(ADMIN_USERNAME
      ? `⚠️  ยังไม่มีแอดมินในระบบ — สมัครบัญชีชื่อ "${ADMIN_USERNAME}" ทันทีหลังติดตั้ง ก่อนมีคนอื่นใช้ชื่อนี้`
      : '⚠️  ยังไม่มีแอดมิน และไม่ได้ตั้ง ADMIN_USERNAME ใน .env');
  }
}).catch(() => {});

app.listen(process.env.PORT || 3000, process.env.HOST || '0.0.0.0', () => console.log('Wselx Shop v3 พร้อมใช้งานที่', (process.env.HOST || '0.0.0.0') + ':' + (process.env.PORT || 3000)));
