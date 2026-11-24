const $ = id => document.getElementById(id);
const S = {
  view: 'shop',
  net: 'ALL',
  proto: 'ALL',
  site: {},
  products: [],
  members: 0,
  activeServers: 0,
  user: null,
  credit: 0,
  orders: [],
  tickets: [],
  topups: [],
  // Admin state
  atab: 'users',
  adminSettings: null,
  adminUsers: [],
  userSearch: '',
  selectedUserDetail: null,
  adminServers: [],
  editingServerId: null,
  serverTestResult: null,
  adminTopups: [],
  adminCoupons: [],
  adminOrders: [],
  adminTickets: [],
  editingProductId: null,
  msg: null
};

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fdate = iso => {
  try {
    return new Date(iso).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return iso || '';
  }
};
const fdt = iso => {
  try {
    return new Date(iso).toLocaleString('th-TH', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso || '';
  }
};

async function api(path, opt = {}) {
  const r = await fetch('/api' + path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...opt,
    body: opt.body ? JSON.stringify(opt.body) : undefined
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || 'เกิดข้อผิดพลาด');
  return d;
}

function readImg(file, maxW = 1200) {
  return new Promise((res, rej) => {
    if (!file) return res('');
    if (!file.type.startsWith('image/')) return rej(new Error('กรุณาเลือกไฟล์รูปภาพ'));
    const rd = new FileReader();
    rd.onload = () => {
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, maxW / im.width);
        const cv = document.createElement('canvas');
        cv.width = Math.round(im.width * sc);
        cv.height = Math.round(im.height * sc);
        cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
        res(cv.toDataURL('image/jpeg', 0.85));
      };
      im.onerror = () => rej(new Error('อ่านรูปภาพไม่สำเร็จ'));
      im.src = rd.result;
    };
    rd.readAsDataURL(file);
  });
}

function showMsg(type, text) {
  S.msg = { type, text };
  render();
  setTimeout(() => {
    if (S.msg && S.msg.text === text) {
      S.msg = null;
      render();
    }
  }, 5000);
}

function msgHtml() {
  return S.msg ? `<div class="msg ${S.msg.type}">${esc(S.msg.text)}</div>` : '';
}

function go(v) {
  S.view = v;
  S.msg = null;
  if (v === 'admin') {
    loadAdminTab(S.atab);
  }
  render();
}

function setAdminTab(t) {
  S.atab = t;
  S.msg = null;
  S.editingProductId = null;
  S.editingServerId = null;
  S.selectedUserDetail = null;
  S.serverTestResult = null;
  loadAdminTab(t);
  render();
}

async function loadAdminTab(t) {
  if (!S.user || S.user.role !== 'admin') return;
  try {
    if (t === 'users') S.adminUsers = await api('/admin/users?q=' + encodeURIComponent(S.userSearch || ''));
    if (t === 'servers') S.adminServers = await api('/admin/servers');
    if (t === 'add' || t === 'edit') S.adminServers = await api('/admin/servers');
    if (t === 'topups') S.adminTopups = await api('/admin/topups');
    if (t === 'coupons') S.adminCoupons = await api('/admin/coupons');
    if (t === 'orders') S.adminOrders = await api('/admin/orders');
    if (t === 'tickets') S.adminTickets = await api('/admin/tickets');
    if (t === 'site' || t === 'slip') S.adminSettings = await api('/admin/settings');
    render();
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function refreshAll() {
  const [siteData, meData] = await Promise.all([api('/site'), api('/me')]);
  S.site = siteData.site || {};
  S.products = siteData.products || [];
  S.members = siteData.members || 0;
  S.activeServers = siteData.activeServers || 0;
  S.user = meData.user || null;
  S.credit = meData.credit || 0;
  S.orders = meData.orders || [];
  S.tickets = meData.tickets || [];
  S.topups = meData.topups || [];
  document.title = S.site.name || 'Wselx Shop';
  render();
}

// =====================================================
// TOPBAR & FOOTER
// =====================================================
function renderBar() {
  const s = S.site;
  const navBtn = (id, label) =>
    `<button aria-current="${S.view === id ? 'page' : 'false'}" onclick="go('${id}')">${label}</button>`;

  let right = '';
  if (S.user) {
    right = `
      <button class="pill" onclick="go('topup')">💳 ${money(S.credit)} ฿</button>
      <span style="font-size:13.5px;font-weight:600;color:var(--sub)">@${esc(S.user.username)}</span>
      <button class="btn ghost sm" onclick="logout()">ออก</button>
    `;
  } else {
    right = `<button class="btn sm" onclick="go('auth')">เข้าสู่ระบบ / สมัครสมาชิก</button>`;
  }

  $('bar').innerHTML = `
    <div class="brand" onclick="go('shop')">
      ${s.logo ? `<img src="${esc(s.logo)}" alt="logo">` : `<div class="logo-fallback">NP</div>`}
      <span>${esc(s.name || 'Wselx Shop')}</span>
    </div>
    <nav>
      ${navBtn('shop', 'แพ็กเกจ')}
      ${S.user ? navBtn('topup', 'เติมเงิน') : ''}
      ${S.user ? navBtn('history', 'ประวัติ & ไฟล์') : ''}
      ${S.user ? navBtn('support', 'แจ้งปัญหา') : ''}
      ${S.user && S.user.role === 'admin' ? navBtn('admin', '⚙️ หลังบ้าน') : ''}
    </nav>
    ${right}
  `;

  $('foot').innerHTML = `
    <div><b>${esc(s.name || 'Wselx Shop')}</b> • ระบบจำหน่าย VPN / SSH / 3x-ui อัตโนมัติ</div>
    <div>${s.line ? `ติดต่อแอดมิน: <b>${esc(s.line)}</b>` : 'พร้อมให้บริการตลอด 24 ชั่วโมง'}</div>
  `;
}

// =====================================================
// CUSTOMER: SHOP VIEW
// =====================================================
function viewShop() {
  const s = S.site;
  const nets = ['ALL', 'AIS', 'TRUE', 'dtac'];
  const protos = ['ALL', 'V2RAY', 'SSH', 'UDP'];

  const list = S.products.filter(p =>
    (S.net === 'ALL' || p.net === S.net) &&
    (S.proto === 'ALL' || p.proto === S.proto)
  );

  const cards = list.map(p => {
    const minP = p.plans.length ? Math.min(...p.plans.map(x => x.p)) : 0;
    return `
      <div class="card">
        ${p.img ? `<img src="${esc(p.img)}" alt="${esc(p.title)}">` : ''}
        <div class="b">
          <div class="tags">
            <span class="tag ${esc(p.net)}">${esc(p.net)}</span>
            <span class="tag">${esc(p.proto)}</span>
            ${p.badge ? `<span class="tag promo">${esc(p.badge)}</span>` : ''}
            ${p.serverName ? `<span class="tag srv">⚡ ${esc(p.serverName)}</span>` : ''}
          </div>
          <h3>${esc(p.title)}</h3>
          <p>${esc(p.desc || 'เชื่อมต่อเสถียร รองรับความเร็วสูง สร้างบัญชีทันทีหลังชำระเงิน')}</p>
          ${p.ratingCount ? `<div style="font-size:12.5px;margin-bottom:8px"><span class="stars">★</span> <b>${p.ratingAvg}</b> (${p.ratingCount} รีวิว)</div>` : ''}
          <div class="foot">
            <div class="price"><small>เริ่มต้น </small>${money(minP)} ฿</div>
            <button class="btn sm" onclick="openBuy(${p.id})">เลือกแพ็กเกจ</button>
          </div>
        </div>
      </div>
    `;
  }).join('');

  return `
    <section class="hero">
      <div>
        <h1>${esc(s.title || 'เติมแพ็กเกจเน็ตความเร็วสูง\nสร้างบัญชีอัตโนมัติใน 3 วินาที').replace(/\n/g, '<br>')}</h1>
        <p>${esc(s.sub || 'เลือกโปรที่ตรงกับเครือข่ายของคุณ จ่ายด้วยเครดิต รับไฟล์และลิงก์เชื่อมต่อทันที')}</p>
        <div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn" onclick="go('${S.user ? 'topup' : 'auth'}')">${S.user ? '💳 เติมเครดิตเลย' : '🚀 เริ่มต้นใช้งาน'}</button>
          ${S.user ? `<button class="btn ghost" onclick="go('history')">📦 ดูบัญชีของฉัน (${S.orders.length})</button>` : ''}
        </div>
        <div class="stats">
          <div><b>${S.members.toLocaleString()}</b><span>สมาชิกทั้งหมด</span></div>
          <div><b>${S.products.length}</b><span>แพ็กเกจพร้อมขาย</span></div>
          <div><b>${S.activeServers}</b><span>เซิร์ฟเวอร์ออนไลน์</span></div>
          <div><b>${esc(s.open || '2026')}</b><span>เปิดให้บริการ</span></div>
        </div>
      </div>
      <div>
        ${s.hero
          ? `<img src="${esc(s.hero)}" alt="Hero">`
          : `<div style="background:linear-gradient(135deg,#1e3a8a,#2563eb,#0ea5e9);color:#fff;border-radius:16px;padding:28px;min-height:220px;display:flex;flex-direction:column;justify-content:center">
              <div style="font-size:13px;opacity:.85;margin-bottom:6px">AUTO PROVISIONING SYSTEM</div>
              <div style="font-size:22px;font-weight:800;margin-bottom:8px">3x-ui & SSH Real-Time</div>
              <div style="font-size:13.5px;opacity:.9">ระบบสร้างบัญชีและไฟล์อัตโนมัติทันทีหลังชำระเงิน ไม่ต้องรอแอดมิน</div>
            </div>`
        }
      </div>
    </section>

    ${s.promo ? `<div class="promo"><img src="${esc(s.promo)}" alt="Promotion"></div>` : ''}
    ${msgHtml()}

    <div class="filters">
      <div class="seg">
        ${nets.map(n => `<button aria-pressed="${S.net === n}" onclick="S.net='${n}';render()">${n === 'ALL' ? 'ทุกเครือข่าย' : n}</button>`).join('')}
      </div>
      <div class="seg">
        ${protos.map(pr => `<button aria-pressed="${S.proto === pr}" onclick="S.proto='${pr}';render()">${pr === 'ALL' ? 'ทุกโปรโตคอล' : pr}</button>`).join('')}
      </div>
    </div>

    ${list.length ? `<div class="grid">${cards}</div>` : `<div class="section-card empty">ไม่พบแพ็กเกจในหมวดหมู่ที่เลือก</div>`}
  `;
}

function openBuy(prodId) {
  const p = S.products.find(x => x.id === prodId);
  if (!p) return;
  $('dlgBody').innerHTML = `
    <h3>${esc(p.title)}</h3>
    <div class="tags">
      <span class="tag ${esc(p.net)}">${esc(p.net)}</span>
      <span class="tag">${esc(p.proto)}</span>
      ${p.serverName ? `<span class="tag srv">เซิร์ฟเวอร์: ${esc(p.serverName)}</span>` : ''}
    </div>
    <p style="color:var(--sub);font-size:13.5px;margin:6px 0 12px">${esc(p.desc || '')}</p>
    <div class="plans">
      ${p.plans.map((pl, idx) => `
        <label>
          <input type="radio" name="planId" value="${pl.id}" ${idx === 0 ? 'checked' : ''}>
          <span style="flex:1"><b>${esc(pl.n)}</b> <small style="color:var(--sub)">(${esc(pl.d)})</small></span>
          <b style="color:var(--brand)">${money(pl.p)} ฿</b>
        </label>
      `).join('')}
    </div>
    <label>โค้ดส่วนลด (ถ้ามี)</label>
    <input id="buyCoupon" placeholder="กรอกโค้ดส่วนลด เช่น SAVE10">
    <div id="buyErr"></div>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:18px">
      <button class="btn ghost" onclick="$('dlg').close()">ยกเลิก</button>
      <button class="btn" id="btnDoBuy" onclick="doBuy()">ยืนยันสั่งซื้อ</button>
    </div>
    ${p.reviews && p.reviews.length ? `
      <div style="margin-top:18px;padding-top:14px;border-top:1px solid var(--line)">
        <b style="font-size:13.5px">รีวิวจากผู้ใช้งาน (${p.ratingCount})</b>
        ${p.reviews.map(r => `
          <div class="review-item">
            <div><b>${esc(r.user)}</b> <span class="stars">${'★'.repeat(r.rating)}</span></div>
            <div style="color:var(--sub)">${esc(r.comment)}</div>
          </div>
        `).join('')}
      </div>
    ` : ''}
  `;
  $('dlg').showModal();
}

async function doBuy() {
  if (!S.user) {
    $('dlg').close();
    go('auth');
    return;
  }
  const el = document.querySelector('input[name="planId"]:checked');
  if (!el) return;
  const btn = $('btnDoBuy');
  btn.disabled = true;
  btn.textContent = 'กำลังสร้างบัญชี...';
  try {
    const res = await api('/buy', {
      method: 'POST',
      body: { planId: Number(el.value), coupon: $('buyCoupon').value }
    });
    $('dlg').close();
    await refreshAll();
    S.view = 'history';
    showMsg('ok', `สั่งซื้อสำเร็จ! ออเดอร์ #${res.order} สร้างบัญชีเรียบร้อยแล้ว`);
  } catch (e) {
    $('buyErr').innerHTML = `<div class="msg bad">${esc(e.message)}</div>`;
    btn.disabled = false;
    btn.textContent = 'ยืนยันสั่งซื้อ';
  }
}

// =====================================================
// CUSTOMER: TOPUP, HISTORY, SUPPORT, AUTH
// =====================================================
function viewTopup() {
  if (!S.user) return viewAuth();
  const s = S.site;
  const minTopup = Number(s.min_topup_amount || 20);
  const bonusMin = Number(s.bonus_min_amount || 100);
  const bonusPct = Number(s.bonus_percent || 0);

  return `
    <div class="panel">
      <h2>💳 เติมเครดิตเข้าบัญชี</h2>
      <div style="display:flex;justify-content:space-between;align-items:center;padding:12px 14px;background:var(--brand-soft);border-radius:12px;margin-bottom:14px">
        <span>ยอดเครดิตคงเหลือ</span>
        <b style="font-size:20px;color:var(--brand)">${money(S.credit)} ฿</b>
      </div>
      ${s.bankName || s.bankNo ? `
        <div style="padding:12px 14px;border:1px solid var(--line);border-radius:12px;margin-bottom:14px;font-size:13.5px">
          <div><b>ช่องทางโอนเงิน:</b> ${esc(s.bankName || '-')}</div>
          <div><b>เลขบัญชี / พร้อมเพย์:</b> <span style="font-size:16px;font-weight:800;color:var(--brand)">${esc(s.bankNo || '-')}</span></div>
          <div><b>ชื่อบัญชี:</b> ${esc(s.bankHolder || '-')}</div>
        </div>
      ` : ''}
      <div class="hint" style="margin-bottom:10px">
        • เติมเงินขั้นต่ำ <b>${money(minTopup)} บาท</b>
        ${bonusPct > 0 ? `<br>• โปรโมชั่น: เติมตั้งแต่ <b>${money(bonusMin)} บาท</b> รับโบนัสเพิ่มทันที <b>+${bonusPct}%</b>` : ''}
      </div>
      ${msgHtml()}
      <label>ช่องทางการเติมเงิน</label>
      <select id="tpMethod" onchange="toggleTopupMethod()">
        <option value="bank">โอนผ่านธนาคาร / สแกน QR (แนบสลิป)</option>
        <option value="truemoney">ซองอั่งเปา TrueMoney Wallet</option>
      </select>

      <label>จำนวนเงิน (บาท) — ขั้นต่ำ ${minTopup} บาท</label>
      <input id="tpAmount" type="number" min="${minTopup}" step="1" value="${Math.max(minTopup, 50)}">
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px">
        ${[minTopup, 50, 100, 300, 500].filter((v, i, a) => v >= minTopup && a.indexOf(v) === i).map(v =>
          `<button type="button" class="btn ghost sm" onclick="$('tpAmount').value=${v}">${v} ฿</button>`
        ).join('')}
      </div>

      <div id="tpBankBox">
        <label>อัปโหลดรูปสลิปโอนเงิน</label>
        <input id="tpSlipFile" type="file" accept="image/*">
      </div>
      <div id="tpTmnBox" style="display:none">
        <label>ลิงก์ซองอั่งเปา TrueMoney</label>
        <input id="tpTmnUrl" placeholder="https://gift.truemoney.com/campaign/?v=...">
      </div>

      <button class="btn" style="width:100%;margin-top:16px" id="btnTopup" onclick="submitTopup()">แจ้งเติมเงิน</button>

      ${S.topups.length ? `
        <h3 style="margin-top:26px;font-size:15.5px">ประวัติการเติมเงินล่าสุด</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>วันที่</th><th>ช่องทาง</th><th>ยอดเงิน</th><th>สถานะ</th></tr></thead>
            <tbody>
              ${S.topups.map(t => `
                <tr>
                  <td>${fdt(t.created_at)}</td>
                  <td>${t.method === 'bank' ? 'โอนธนาคาร' : 'TrueMoney'}</td>
                  <td><b>${money(t.amount)} ฿</b>${Number(t.bonus_amount) > 0 ? ` <small style="color:var(--ok)">(+${money(t.bonus_amount)})</small>` : ''}</td>
                  <td><span class="tag ${t.status === 'approved' ? 'ok' : t.status === 'rejected' ? 'bad' : 'promo'}">${t.status}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : ''}
    </div>
  `;
}

function toggleTopupMethod() {
  const m = $('tpMethod').value;
  $('tpBankBox').style.display = m === 'bank' ? 'block' : 'none';
  $('tpTmnBox').style.display = m === 'truemoney' ? 'block' : 'none';
}

async function submitTopup() {
  const method = $('tpMethod').value;
  const amount = parseFloat($('tpAmount').value);
  const btn = $('btnTopup');
  btn.disabled = true;
  try {
    let proof = '';
    if (method === 'bank') {
      const f = $('tpSlipFile').files[0];
      if (!f) throw new Error('กรุณาเลือกรูปสลิปโอนเงิน');
      proof = await readImg(f, 1000);
    } else {
      proof = $('tpTmnUrl').value.trim();
    }
    const res = await api('/topup', { method: 'POST', body: { method, amount, proof } });
    await refreshAll();
    if (res.autoApproved) {
      showMsg('ok', `ตรวจสอบสลิปสำเร็จ! เติมเครดิต ${money(amount + (res.bonusAmount || 0))} บาท เข้าบัญชีเรียบร้อย`);
    } else {
      showMsg('ok', 'ส่งข้อมูลแจ้งเติมเงินเรียบร้อยแล้ว ระบบจะปรับยอดให้ทันทีหลังตรวจสอบ');
    }
  } catch (e) {
    showMsg('bad', e.message);
  } finally {
    if ($('btnTopup')) $('btnTopup').disabled = false;
  }
}

function copyText(txt) {
  navigator.clipboard.writeText(txt).then(() => showMsg('ok', 'คัดลอกข้อมูลเชื่อมต่อเรียบร้อยแล้ว'));
}

function downloadConfig(filename, content) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function viewHistory() {
  if (!S.user) return viewAuth();
  const s = S.site;
  return `
    ${msgHtml()}
    <div class="section-card">
      <h3>🎁 ชวนเพื่อนรับเครดิตฟรี</h3>
      <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between">
        <div>
          รหัสแนะนำของคุณ: <b style="font-size:17px;color:var(--brand)">${esc(S.user.referral_code || '-')}</b>
          <div class="hint">รับโบนัส ${money(s.referral_reward || 10)} ฿ เมื่อเพื่อนสมัครด้วยรหัสนี้และเติมเงินครั้งแรก • ชวนแล้ว ${S.user.referral_count || 0} คน</div>
        </div>
        <button class="btn ghost sm" onclick="copyText('${esc(S.user.referral_code || '')}')">คัดลอกรหัสแนะนำ</button>
      </div>
    </div>

    <div class="section-card">
      <h3>📦 บัญชีและไฟล์แพ็กเกจของฉัน (${S.orders.length})</h3>
      ${S.orders.length ? S.orders.map(o => `
        <div style="border:1px solid var(--line);border-radius:12px;padding:15px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;align-items:center">
            <div>
              <b>#${o.id} • ${esc(o.n)}</b>
              <span class="tag ${esc(o.net)}">${esc(o.net)}</span>
              <span class="tag">${esc(o.proto)}</span>
            </div>
            <span class="tag ${o.status === 'active' ? 'ok' : o.status === 'refunded' ? 'promo' : 'bad'}">${o.status.toUpperCase()}</span>
          </div>
          <div class="hint">สั่งซื้อเมื่อ ${fdt(o.t)} • หมดอายุ <b>${fdt(o.exp)}</b> • จ่าย ${money(o.p)} ฿</div>
          <div class="acct">${esc(o.a)}</div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px">
            <button class="btn sm" onclick="copyText(${JSON.stringify(o.a)})">📋 คัดลอกลิงก์/บัญชี</button>
            <button class="btn ghost sm" onclick="downloadConfig('wselx-order-${o.id}.txt', ${JSON.stringify(o.a)})">⬇️ ดาวน์โหลดไฟล์ (.txt)</button>
            ${o.status !== 'refunded' ? `<button class="btn ghost sm" onclick="renewOrder(${o.id}, ${o.planPrice})">🔄 ต่ออายุ (${money(o.planPrice)} ฿)</button>` : ''}
            <button class="btn ghost sm" onclick="openReview(${o.productId}, ${JSON.stringify(o.n)})">⭐ ให้คะแนนรีวิว</button>
          </div>
        </div>
      `).join('') : `<div class="empty">ยังไม่มีประวัติการสั่งซื้อ <br><br><button class="btn sm" onclick="go('shop')">เลือกดูแพ็กเกจ</button></div>`}
    </div>
  `;
}

async function renewOrder(orderId, price) {
  if (!confirm(`ยืนยันต่ออายุคำสั่งซื้อ #${orderId} ในราคา ${money(price)} บาท?`)) return;
  try {
    const res = await api(`/orders/${orderId}/renew`, { method: 'POST' });
    await refreshAll();
    showMsg('ok', `ต่ออายุคำสั่งซื้อ #${orderId} สำเร็จ! หมดอายุใหม่ ${fdt(res.newExpiresAt)}`);
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function openReview(productId, title) {
  $('dlgBody').innerHTML = `
    <h3>รีวิวแพ็กเกจ: ${esc(title)}</h3>
    <label>คะแนนความพึงพอใจ</label>
    <select id="rvRating">
      <option value="5">★★★★★ (5 - ดีเยี่ยม)</option>
      <option value="4">★★★★☆ (4 - ดี)</option>
      <option value="3">★★★☆☆ (3 - ปานกลาง)</option>
      <option value="2">★★☆☆☆ (2 - พอใช้)</option>
      <option value="1">★☆☆☆☆ (1 - ควรปรับปรุง)</option>
    </select>
    <label>ความคิดเห็น</label>
    <textarea id="rvComment" rows="3" placeholder="ความเร็วเน็ตเป็นอย่างไรบ้าง แชร์ประสบการณ์ให้เพื่อนสมาชิก..."></textarea>
    <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px">
      <button class="btn ghost" onclick="$('dlg').close()">ปิด</button>
      <button class="btn" onclick="submitReview(${productId})">บันทึกรีวิว</button>
    </div>
  `;
  $('dlg').showModal();
}

async function submitReview(productId) {
  try {
    await api('/reviews', {
      method: 'POST',
      body: { productId, rating: Number($('rvRating').value), comment: $('rvComment').value }
    });
    $('dlg').close();
    await refreshAll();
    showMsg('ok', 'ขอบคุณสำหรับรีวิวของคุณ!');
  } catch (e) {
    alert(e.message);
  }
}

function viewSupport() {
  if (!S.user) return viewAuth();
  return `
    <div class="panel" style="max-width:720px">
      <h2>🛠️ แจ้งปัญหาการใช้งาน / ติดต่อแอดมิน</h2>
      ${msgHtml()}
      <label>อ้างอิงคำสั่งซื้อ (ถ้ามี)</label>
      <select id="tkOrder">
        <option value="">-- ไม่ระบุคำสั่งซื้อ --</option>
        ${S.orders.map(o => `<option value="${o.id}">#${o.id} - ${esc(o.n)}</option>`).join('')}
      </select>
      <label>หัวข้อปัญหา</label>
      <input id="tkSubject" placeholder="เช่น เชื่อมต่อไม่ได้ / ขอเปลี่ยนเซิร์ฟเวอร์">
      <label>รายละเอียด</label>
      <textarea id="tkMsg" rows="3" placeholder="อธิบายปัญหาที่พบ เครือข่ายที่ใช้ หรือข้อความ Error..."></textarea>
      <button class="btn" style="margin-top:14px" onclick="submitTicket()">ส่งแจ้งปัญหา</button>

      <h3 style="margin-top:28px;font-size:16px">รายการแจ้งปัญหาของคุณ (${S.tickets.length})</h3>
      ${S.tickets.length ? S.tickets.map(t => `
        <div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-top:10px">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <b>#${t.id} • ${esc(t.subject)}</b>
            <span class="tag ${t.status === 'answered' ? 'ok' : t.status === 'closed' ? '' : 'promo'}">${t.status}</span>
          </div>
          <div class="hint">${fdt(t.created_at)}</div>
          <p style="margin:8px 0 0;font-size:14px">${esc(t.message)}</p>
          ${t.reply ? `<div class="msg ok" style="margin-top:10px"><b>ตอบกลับจากแอดมิน:</b> ${esc(t.reply)}</div>` : ''}
        </div>
      `).join('') : `<div class="empty">ยังไม่มีประวัติการแจ้งปัญหา</div>`}
    </div>
  `;
}

async function submitTicket() {
  try {
    await api('/tickets', {
      method: 'POST',
      body: {
        orderId: $('tkOrder').value ? Number($('tkOrder').value) : null,
        subject: $('tkSubject').value,
        message: $('tkMsg').value
      }
    });
    await refreshAll();
    showMsg('ok', 'ส่งเรื่องแจ้งปัญหาเรียบร้อยแล้ว แอดมินจะรีบตรวจสอบให้ครับ');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function viewAuth() {
  return `
    <div class="panel" style="max-width:440px">
      <h2>เข้าสู่ระบบ / สมัครสมาชิก</h2>
      ${msgHtml()}
      <label>ชื่อผู้ใช้ (ภาษาอังกฤษหรือตัวเลข 3-30 ตัว)</label>
      <input id="auUser" autocomplete="username" placeholder="username">
      <label>รหัสผ่าน (อย่างน้อย 8 ตัวอักษร)</label>
      <input id="auPass" type="password" autocomplete="current-password" placeholder="••••••••">
      <label>รหัสแนะนำเพื่อน (เฉพาะสมัครใหม่ / ไม่บังคับ)</label>
      <input id="auRef" placeholder="เช่น NPXXXXXX">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px">
        <button class="btn" onclick="doAuth('login')">เข้าสู่ระบบ</button>
        <button class="btn ghost" onclick="doAuth('register')">สมัครสมาชิกใหม่</button>
      </div>
    </div>
  `;
}

async function doAuth(mode) {
  try {
    await api('/' + mode, {
      method: 'POST',
      body: {
        username: $('auUser').value,
        password: $('auPass').value,
        referralCode: $('auRef').value
      }
    });
    await refreshAll();
    S.view = 'shop';
    showMsg('ok', mode === 'login' ? 'เข้าสู่ระบบสำเร็จ' : 'สมัครสมาชิกเรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function logout() {
  await api('/logout', { method: 'POST' });
  await refreshAll();
  go('shop');
}

// =====================================================
// ADMIN DASHBOARD (ORGANIZED SIDEBAR + FULL CONTROLS)
// =====================================================
function viewAdmin() {
  if (!S.user || S.user.role !== 'admin') {
    return `<div class="section-card empty">เฉพาะผู้ดูแลระบบ (Admin) เท่านั้น</div>`;
  }

  const pendingTopups = S.adminTopups.length;
  const openTickets = S.adminTickets.filter(t => t.status === 'open').length;

  const navBtn = (id, label, badgeCount = 0) => `
    <button aria-pressed="${S.atab === id}" onclick="setAdminTab('${id}')">
      <span>${label}</span>
      ${badgeCount > 0 ? `<span class="cnt">${badgeCount}</span>` : ''}
    </button>
  `;

  let content = '';
  if (S.atab === 'users') content = adminUsersTab();
  else if (S.atab === 'servers') content = adminServersTab();
  else if (S.atab === 'add' || S.atab === 'edit') content = adminProductsTab();
  else if (S.atab === 'topups') content = adminTopupsTab();
  else if (S.atab === 'coupons') content = adminCouponsTab();
  else if (S.atab === 'orders') content = adminOrdersTab();
  else if (S.atab === 'tickets') content = adminTicketsTab();
  else if (S.atab === 'slip') content = adminSlipApiTab();
  else if (S.atab === 'site') content = adminSiteTab();

  return `
    <div class="kpi-grid">
      <div class="kpi"><span>สมาชิกทั้งหมด</span><b>${S.members.toLocaleString()} คน</b></div>
      <div class="kpi"><span>เซิร์ฟเวอร์เชื่อมต่อ</span><b>${S.activeServers} เครื่อง</b></div>
      <div class="kpi"><span>แพ็กเกจเปิดขาย</span><b>${S.products.length} รายการ</b></div>
      <div class="kpi"><span>สลิปรอตรวจสอบ</span><b style="color:${pendingTopups ? 'var(--bad)' : 'var(--ok)'}">${pendingTopups} รายการ</b></div>
    </div>

    <div class="admin-wrap">
      <aside class="admin-nav">
        <div class="nav-group">ผู้ใช้งาน & เซิร์ฟเวอร์</div>
        ${navBtn('users', '👥 จัดการผู้ใช้งาน')}
        ${navBtn('servers', '🖥️ เซิร์ฟเวอร์ 3x-ui / SSH')}

        <div class="nav-group">สินค้า & โปรโมชั่น</div>
        ${navBtn('add', '➕ เพิ่มแพ็กเกจใหม่')}
        ${navBtn('edit', '📦 จัดการแพ็กเกจ')}
        ${navBtn('coupons', '🎟️ คูปองส่วนลด')}

        <div class="nav-group">การเงิน & บริการ</div>
        ${navBtn('topups', '💰 ตรวจสลิปเติมเงิน', pendingTopups)}
        ${navBtn('orders', '🧾 ออเดอร์ / คืนเงิน')}
        ${navBtn('tickets', '💬 แจ้งปัญหาลูกค้า', openTickets)}

        <div class="nav-group">ตั้งค่าระบบ</div>
        ${navBtn('slip', '🔌 API ตรวจสลิป')}
        ${navBtn('site', '⚙️ ตั้งค่าเว็บ & รูปภาพ')}
      </aside>

      <div>
        ${msgHtml()}
        ${content}
      </div>
    </div>
  `;
}

// --- 1. Admin: จัดการผู้ใช้งาน ---
function adminUsersTab() {
  const detail = S.selectedUserDetail;
  return `
    <div class="section-card">
      <h3>
        <span>👥 จัดการผู้ใช้งานที่สมัครสมาชิก (${S.adminUsers.length})</span>
        <div style="display:flex;gap:8px;max-width:300px;width:100%">
          <input id="uSearchInput" value="${esc(S.userSearch)}" placeholder="ค้นหาชื่อผู้ใช้ / รหัสแนะนำ..." onkeydown="if(event.key==='Enter')searchUsers()">
          <button class="btn sm" onclick="searchUsers()">ค้นหา</button>
        </div>
      </h3>

      ${detail ? `
        <div style="background:#f8fafc;border:1px solid #cbd5e1;border-radius:14px;padding:18px;margin-bottom:18px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
            <div>
              <b style="font-size:17px">@${esc(detail.user.username)}</b>
              <span class="tag ${detail.user.role === 'admin' ? 'srv' : ''}">${detail.user.role}</span>
              ${detail.user.is_banned ? `<span class="tag bad">ถูกระงับบัญชี</span>` : `<span class="tag ok">ปกติ</span>`}
              <div class="hint">สมัครเมื่อ ${fdt(detail.user.created_at)} • รหัสแนะนำ: ${esc(detail.user.referral_code || '-')} • เครดิตคงเหลือ: <b>${money(detail.user.credit_balance)} ฿</b></div>
            </div>
            <button class="btn ghost sm" onclick="S.selectedUserDetail=null;render()">ปิดรายละเอียด</button>
          </div>

          <div class="row2">
            <div style="background:#fff;padding:14px;border-radius:12px;border:1px solid var(--line)">
              <b style="font-size:14px">💳 ปรับยอดเครดิต (เพิ่ม / หัก)</b>
              <label>จำนวนเงิน (+ เพิ่มเครดิต, - หักเครดิต)</label>
              <input id="adjAmt" type="number" step="0.01" placeholder="เช่น 50 หรือ -20">
              <label>หมายเหตุ (บันทึกลงบัญชีแยกประเภท)</label>
              <input id="adjNote" placeholder="เช่น เติมเครดิตชดเชย / ปรับยอด">
              <button class="btn sm" style="margin-top:10px" onclick="adjustUserCredit(${detail.user.id})">บันทึกปรับยอดเครดิต</button>
            </div>

            <div style="background:#fff;padding:14px;border-radius:12px;border:1px solid var(--line)">
              <b style="font-size:14px">🛡️ สิทธิ์การใช้งาน & รหัสผ่าน</b>
              <div class="row2">
                <div>
                  <label>บทบาท</label>
                  <select id="editURole">
                    <option value="user" ${detail.user.role === 'user' ? 'selected' : ''}>สมาชิกทั่วไป (user)</option>
                    <option value="admin" ${detail.user.role === 'admin' ? 'selected' : ''}>แอดมิน (admin)</option>
                  </select>
                </div>
                <div>
                  <label>สถานะบัญชี</label>
                  <select id="editUBan">
                    <option value="false" ${!detail.user.is_banned ? 'selected' : ''}>เปิดใช้งานปกติ</option>
                    <option value="true" ${detail.user.is_banned ? 'selected' : ''}>ระงับการใช้งาน (แบน)</option>
                  </select>
                </div>
              </div>
              <label>ตั้งรหัสผ่านใหม่ (เว้นว่างถ้าไม่เปลี่ยน)</label>
              <input id="editUPass" type="password" placeholder="อย่างน้อย 8 ตัวอักษร">
              <label>บันทึกโน้ตแอดมิน</label>
              <input id="editUNote" value="${esc(detail.user.note || '')}" placeholder="บันทึกเพิ่มเติมเกี่ยวกับลูกค้ารายนี้">
              <button class="btn sm ok" style="margin-top:10px" onclick="saveUserEdit(${detail.user.id})">บันทึกข้อมูลผู้ใช้</button>
            </div>
          </div>

          <div class="row2" style="margin-top:14px">
            <div>
              <b style="font-size:13.5px">ประวัติออเดอร์ล่าสุด (${detail.orders.length})</b>
              <div class="table-wrap" style="margin-top:6px">
                <table>
                  <thead><tr><th>#</th><th>แพ็กเกจ</th><th>จ่าย</th><th>สถานะ</th></tr></thead>
                  <tbody>
                    ${detail.orders.length ? detail.orders.map(o => `
                      <tr>
                        <td>#${o.id}</td>
                        <td>${esc(o.title)} - ${esc(o.plan_name)}</td>
                        <td>${money(o.price_paid)} ฿</td>
                        <td><span class="tag ${o.status === 'active' ? 'ok' : 'bad'}">${o.status}</span></td>
                      </tr>
                    `).join('') : `<tr><td colspan="4" class="empty">ไม่มีออเดอร์</td></tr>`}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <b style="font-size:13.5px">ความเคลื่อนไหวเครดิต (${detail.ledger.length})</b>
              <div class="table-wrap" style="margin-top:6px">
                <table>
                  <thead><tr><th>รายการ</th><th>จำนวน</th><th>คงเหลือ</th></tr></thead>
                  <tbody>
                    ${detail.ledger.length ? detail.ledger.map(l => `
                      <tr>
                        <td>${esc(l.note || l.type)}<br><small style="color:var(--sub)">${fdt(l.created_at)}</small></td>
                        <td style="color:${l.amount >= 0 ? 'var(--ok)' : 'var(--bad)'};font-weight:700">${l.amount >= 0 ? '+' : ''}${money(l.amount)}</td>
                        <td>${money(l.balance_after)} ฿</td>
                      </tr>
                    `).join('') : `<tr><td colspan="3" class="empty">ไม่มีประวัติเครดิต</td></tr>`}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      ` : ''}

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>ชื่อผู้ใช้</th>
              <th>สิทธิ์ / สถานะ</th>
              <th>เครดิตคงเหลือ</th>
              <th>เติมสะสม / ซื้อสะสม</th>
              <th>ออเดอร์</th>
              <th>วันที่สมัคร</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            ${S.adminUsers.length ? S.adminUsers.map(u => `
              <tr>
                <td>#${u.id}</td>
                <td><b>${esc(u.username)}</b>${u.note ? `<br><small style="color:var(--sub)">📝 ${esc(u.note)}</small>` : ''}</td>
                <td>
                  <span class="tag ${u.role === 'admin' ? 'srv' : ''}">${u.role}</span>
                  ${u.is_banned ? `<span class="tag bad">แบน</span>` : `<span class="tag ok">ปกติ</span>`}
                </td>
                <td><b style="color:var(--brand)">${money(u.credit_balance)} ฿</b></td>
                <td>${money(u.total_topup)} / ${money(u.total_spent)} ฿</td>
                <td>${u.order_count}</td>
                <td>${fdate(u.created_at)}</td>
                <td><button class="btn sm ghost" onclick="inspectUser(${u.id})">ดูข้อมูล / แก้ไข</button></td>
              </tr>
            `).join('') : `<tr><td colspan="8" class="empty">ไม่พบข้อมูลผู้ใช้งาน</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function searchUsers() {
  S.userSearch = $('uSearchInput').value;
  S.adminUsers = await api('/admin/users?q=' + encodeURIComponent(S.userSearch));
  render();
}

async function inspectUser(uid) {
  try {
    S.selectedUserDetail = await api('/admin/users/' + uid);
    render();
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function adjustUserCredit(uid) {
  try {
    const amount = parseFloat($('adjAmt').value);
    const note = $('adjNote').value;
    await api(`/admin/users/${uid}/adjust-credit`, { method: 'POST', body: { amount, note } });
    await inspectUser(uid);
    S.adminUsers = await api('/admin/users?q=' + encodeURIComponent(S.userSearch || ''));
    await refreshAll();
    showMsg('ok', 'ปรับยอดเครดิตเรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function saveUserEdit(uid) {
  try {
    await api(`/admin/users/${uid}`, {
      method: 'PUT',
      body: {
        role: $('editURole').value,
        is_banned: $('editUBan').value === 'true',
        new_password: $('editUPass').value,
        note: $('editUNote').value
      }
    });
    await inspectUser(uid);
    S.adminUsers = await api('/admin/users?q=' + encodeURIComponent(S.userSearch || ''));
    showMsg('ok', 'บันทึกข้อมูลผู้ใช้งานเรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

// --- 2. Admin: จัดการเซิร์ฟเวอร์ 3x-ui / SSH ---
function adminServersTab() {
  const ed = S.editingServerId ? S.adminServers.find(x => x.id === S.editingServerId) : null;
  const srvType = ed ? ed.type : '3xui';

  return `
    <div class="section-card">
      <h3>
        <span>${ed ? `✏️ แก้ไขเซิร์ฟเวอร์: ${esc(ed.name)}` : '➕ เพิ่มเซิร์ฟเวอร์ VPS (3x-ui / SSH)'}</span>
        ${ed ? `<button class="btn ghost sm" onclick="S.editingServerId=null;render()">ยกเลิกแก้ไข</button>` : ''}
      </h3>
      <div class="hint" style="margin-bottom:10px">
        รองรับการเชื่อมต่อ <b>3x-ui / X-UI Panel API</b> (สร้าง Client และต่ออายุอัตโนมัติพร้อมส่งลิงก์ VLESS/VMess/Trojan) และเซิร์ฟเวอร์ <b>SSH / UDP</b>
      </div>

      <div class="row3">
        <div>
          <label>ชื่อเรียกเซิร์ฟเวอร์</label>
          <input id="svName" value="${esc(ed?.name || '')}" placeholder="เช่น SG-01 (3x-ui VLESS)">
        </div>
        <div>
          <label>ประเภทเซิร์ฟเวอร์</label>
          <select id="svType" onchange="toggleSrvFields()">
            <option value="3xui" ${srvType === '3xui' ? 'selected' : ''}>3x-ui / X-UI Panel API</option>
            <option value="ssh" ${srvType === 'ssh' ? 'selected' : ''}>SSH / UDP Server</option>
          </select>
        </div>
        <div>
          <label>Host / IP / Domain เชื่อมต่อ</label>
          <input id="svHost" value="${esc(ed?.host || '')}" placeholder="เช่น sg1.yourdomain.com">
        </div>
      </div>

      <div id="box3xui" style="display:${srvType === '3xui' ? 'block' : 'none'}">
        <div class="row3">
          <div>
            <label>3x-ui Panel URL (รวมพอร์ตและ Base Path)</label>
            <input id="svPanelUrl" value="${esc(ed?.panel_url || '')}" placeholder="https://sg1.domain.com:2053/secret">
          </div>
          <div>
            <label>Panel Username</label>
            <input id="svPanelUser" value="${esc(ed?.panel_user || '')}" placeholder="admin">
          </div>
          <div>
            <label>Panel Password ${ed ? '(เว้นว่างถ้าไม่เปลี่ยน)' : ''}</label>
            <input id="svPanelPass" type="password" placeholder="••••••••">
          </div>
        </div>

        <div class="hint" style="margin:8px 0">
          ✅ กรอกแค่นี้พอ — โปรโตคอล / พอร์ต / path / TLS / Reality ระบบอ่านจาก Inbound จริงอัตโนมัติ
          และเลือก Inbound ตอน <b>เพิ่มแพ็กเกจ</b> (ระบบดึงรายการที่สร้างไว้ใน 3x-ui มาให้เลือก)
        </div>
        <details ${(ed?.public_port || ed?.sni) ? 'open' : ''}>
          <summary style="cursor:pointer;font-size:13px;color:var(--sub)">ตั้งค่าขั้นสูง (ไม่จำเป็น)</summary>
          <div class="row2">
            <div>
              <label>บังคับพอร์ตภายนอก (เว้นว่าง = ใช้พอร์ตของ Inbound)</label>
              <input id="svPubPort" type="number" value="${ed?.public_port || ''}" placeholder="ใช้เมื่อมี proxy/CDN หน้า inbound">
            </div>
            <div>
              <label>บังคับ SNI / Host (เว้นว่าง = ใช้ค่าของ Inbound)</label>
              <input id="svSni" value="${esc(ed?.sni || '')}" placeholder="เช่น bug.ais.co.th">
            </div>
          </div>
        </details>
      </div>

      <div id="boxSsh" style="display:${srvType === 'ssh' ? 'block' : 'none'}">
        <div class="row3">
          <div>
            <label>SSH Port</label>
            <input id="svSshPort" type="number" value="${ed?.ssh_port || 22}">
          </div>
          <div>
            <label>UDP Port</label>
            <input id="svUdpPort" value="${esc(ed?.udp_port || '1-65535')}">
          </div>
          <div>
            <label>SNI / Payload Host</label>
            <input id="svSshSni" value="${esc(ed?.sni || '')}" placeholder="เช่น bug.true.th">
          </div>
        </div>
        <div class="row2">
          <div>
            <label>SSH Login User (root หรือ sudo) — ใช้สร้างบัญชีลูกค้าจริงบนเซิร์ฟเวอร์</label>
            <input id="svSshUser" value="${esc(ed?.ssh_user || 'root')}" placeholder="root">
          </div>
          <div>
            <label>SSH Login Password ${ed?.has_ssh_pass ? '(เว้นว่างถ้าไม่เปลี่ยน)' : ''}</label>
            <input id="svSshPass" type="password" placeholder="••••••••" autocomplete="new-password">
          </div>
        </div>
        <label>รูปแบบข้อความส่งมอบบัญชี (ใช้ตัวแปร {host} {user} {pass} {ssh_port} {udp_port} {sni})</label>
        <textarea id="svTemplate" rows="3" placeholder="Host: {host}&#10;Port: {ssh_port}&#10;User: {user}&#10;Pass: {pass}">${esc(ed?.template || '')}</textarea>
      </div>

      <div style="display:flex;gap:10px;align-items:center;margin-top:16px">
        <button class="btn" onclick="saveServer(${ed ? ed.id : 'null'})">${ed ? '💾 บันทึกการแก้ไขเซิร์ฟเวอร์' : '➕ บันทึกเพิ่มเซิร์ฟเวอร์'}</button>
        <label style="margin:0;display:inline-flex;align-items:center;gap:6px;cursor:pointer">
          <input type="checkbox" id="svActive" style="width:auto" ${ed?.is_active !== false ? 'checked' : ''}> เปิดใช้งานเซิร์ฟเวอร์นี้
        </label>
      </div>
    </div>

    ${S.serverTestResult ? `
      <div class="section-card" style="border-color:var(--ok)">
        <h3>✅ ผลการทดสอบเชื่อมต่อ: ${esc(S.serverTestResult.name)}</h3>
        ${S.serverTestResult.inbounds ? `
          <div style="font-size:13.5px;margin-bottom:8px">
            ล็อกอิน 3x-ui สำเร็จ! พบทั้งหมด <b>${S.serverTestResult.inboundCount}</b> Inbounds:
            ${S.serverTestResult.matchedInbound
              ? `<span class="tag ok">ตรงกับ Inbound ID #${S.serverTestResult.matchedInbound.id} (${esc(S.serverTestResult.matchedInbound.remark)} - ${esc(S.serverTestResult.matchedInbound.network)}/${esc(S.serverTestResult.matchedInbound.security)} - พอร์ต ${S.serverTestResult.matchedInbound.port}) — ลิงก์จะสร้างตามค่านี้</span>`
              : `<span class="tag bad">⚠️ ไม่พบ Inbound ID ที่ระบุ กรุณาตรวจสอบเลข ID ด้านล่าง</span>`
            }
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Inbound ID</th><th>ชื่อ (Remark)</th><th>โปรโตคอล</th><th>Network / Security</th><th>พอร์ต</th><th>สถานะ</th></tr></thead>
              <tbody>
                ${S.serverTestResult.inbounds.map(ib => `
                  <tr>
                    <td><b>#${ib.id}</b></td>
                    <td>${esc(ib.remark)}</td>
                    <td>${esc(ib.protocol)}</td>
                    <td>${esc(ib.network || '-')} / ${esc(ib.security || '-')}</td>
                    <td>${ib.port}</td>
                    <td><span class="tag ${ib.enable ? 'ok' : 'bad'}">${ib.enable ? 'เปิด' : 'ปิด'}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        ` : `<div class="acct">${esc(S.serverTestResult.sample || '')}</div>`}
      </div>
    ` : ''}

    <div class="section-card">
      <h3>🖥️ รายการเซิร์ฟเวอร์ทั้งหมด (${S.adminServers.length})</h3>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>ชื่อเซิร์ฟเวอร์</th>
              <th>ประเภท</th>
              <th>Host / Inbound</th>
              <th>สถานะเชื่อมต่อ</th>
              <th>จัดการ</th>
            </tr>
          </thead>
          <tbody>
            ${S.adminServers.length ? S.adminServers.map(sv => `
              <tr>
                <td><b>${esc(sv.name)}</b><br><small style="color:var(--sub)">${esc(sv.panel_url || sv.host)}</small></td>
                <td><span class="tag srv">${sv.type.toUpperCase()}</span></td>
                <td>${esc(sv.host)}<br><small style="color:var(--sub)">${sv.type === '3xui' ? `Inbound #${sv.inbound_id} (${sv.protocol})` : `SSH:${sv.ssh_port} / UDP:${sv.udp_port}`}</small></td>
                <td>
                  <span class="tag ${sv.last_status === 'online' ? 'ok' : sv.last_status === 'error' ? 'bad' : ''}">${sv.last_status}</span>
                  ${!sv.is_active ? `<span class="tag bad">ปิดใช้งาน</span>` : ''}
                </td>
                <td style="white-space:nowrap">
                  <button class="btn sm ok" onclick="testServer(${sv.id}, ${JSON.stringify(sv.name)})">🔌 ทดสอบเชื่อมต่อ</button>
                  <button class="btn sm ghost" onclick="S.editingServerId=${sv.id};render()">แก้ไข</button>
                  <button class="btn sm danger" onclick="deleteServer(${sv.id})">ลบ</button>
                </td>
              </tr>
            `).join('') : `<tr><td colspan="5" class="empty">ยังไม่มีเซิร์ฟเวอร์ VPS กรุณาเพิ่มด้านบน</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function toggleSrvFields() {
  const t = $('svType').value;
  $('box3xui').style.display = t === '3xui' ? 'block' : 'none';
  $('boxSsh').style.display = t === 'ssh' ? 'block' : 'none';
}

async function saveServer(id) {
  const type = $('svType').value;
  const body = {
    name: $('svName').value,
    type,
    host: $('svHost').value,
    panel_url: $('svPanelUrl').value,
    panel_user: $('svPanelUser').value,
    panel_pass: $('svPanelPass').value,
    ...(type === '3xui' ? { public_port: Number($('svPubPort').value) } : {}),
    sni: type === '3xui' ? $('svSni').value : $('svSshSni').value,
    ssh_port: Number($('svSshPort').value),
    ssh_user: $('svSshUser').value,
    ssh_pass: $('svSshPass').value,
    udp_port: $('svUdpPort').value,
    template: $('svTemplate').value,
    is_active: $('svActive').checked
  };
  try {
    if (id) await api('/admin/servers/' + id, { method: 'PUT', body });
    else await api('/admin/servers', { method: 'POST', body });
    S.editingServerId = null;
    S.adminServers = await api('/admin/servers');
    await refreshAll();
    showMsg('ok', id ? 'แก้ไขเซิร์ฟเวอร์เรียบร้อยแล้ว' : 'เพิ่มเซิร์ฟเวอร์ใหม่เรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function testServer(id, name) {
  try {
    const res = await api(`/admin/servers/${id}/test`, { method: 'POST' });
    S.serverTestResult = { name, ...res };
    S.adminServers = await api('/admin/servers');
    showMsg('ok', `เชื่อมต่อเซิร์ฟเวอร์ "${name}" สำเร็จ!`);
  } catch (e) {
    S.serverTestResult = null;
    S.adminServers = await api('/admin/servers');
    showMsg('bad', 'ทดสอบไม่ผ่าน: ' + e.message);
  }
}

async function deleteServer(id) {
  if (!confirm('ยืนยันลบเซิร์ฟเวอร์นี้?')) return;
  try {
    await api('/admin/servers/' + id, { method: 'DELETE' });
    S.adminServers = await api('/admin/servers');
    await refreshAll();
    showMsg('ok', 'ลบเซิร์ฟเวอร์เรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

// --- 3. Admin: เพิ่ม / แก้ไขแพ็กเกจ ---
// กล่องเลือก Inbound (ดึงจาก 3x-ui ของเซิร์ฟเวอร์ที่เลือก)
function inboundBoxHtml(st) {
  if (!st) return '';
  if (st.loading) return `<div class="hint">⏳ กำลังดึงรายการ Inbound จาก 3x-ui...</div>`;
  if (st.error) return `<div class="hint" style="color:var(--bad)">⚠️ ${esc(st.error)}</div>`;
  if (!st.list) return '';
  if (!st.list.length) return `<div class="hint" style="color:var(--bad)">⚠️ ยังไม่มี Inbound ใน 3x-ui นี้ กรุณาสร้างก่อน</div>`;
  const sel = st.selected || (st.list.find(x => x.enable) || st.list[0]).id;
  return `
    <label>เลือก Inbound ที่ใช้สร้างบัญชีลูกค้า (ดึงจาก 3x-ui — พบ ${st.list.length} รายการ)</label>
    <select id="pdInbound">
      ${st.list.map(ib => `<option value="${ib.id}" ${Number(ib.id) === Number(sel) ? 'selected' : ''}>
        #${ib.id} ${esc(ib.remark)} — ${esc(ib.protocol)} / ${esc(ib.network)} / ${esc(ib.security)} • พอร์ต ${ib.port}${ib.enable ? '' : ' (ปิดอยู่)'}
      </option>`).join('')}
    </select>`;
}

async function loadInboundBox(serverId) {
  const box = $('pdInboundBox');
  const sv = S.adminServers.find(x => Number(x.id) === Number(serverId));
  const keep = S.pdInboundState?.selected || null;
  if (!box) return;
  if (!sv || sv.type !== '3xui') { S.pdInboundState = null; box.innerHTML = ''; return; }
  S.pdInboundState = { loading: true, selected: keep };
  box.innerHTML = inboundBoxHtml(S.pdInboundState);
  try {
    const r = await api(`/admin/servers/${sv.id}/inbounds`);
    S.pdInboundState = { list: r.inbounds, selected: keep };
  } catch (e) {
    S.pdInboundState = { error: e.message };
  }
  const b2 = $('pdInboundBox');
  if (b2) b2.innerHTML = inboundBoxHtml(S.pdInboundState);
}

function adminProductsTab() {
  const ed = S.editingProductId ? S.products.find(x => x.id === S.editingProductId) : null;
  const planLines = ed
    ? ed.plans.map(pl => `${pl.n}, ${pl.hours} ชม, ${pl.p}`).join('\n')
    : 'รายวัน, 24 ชม, 15\n7 วัน, 7 วัน, 59\n30 วัน, 30 วัน, 159';

  // เปิดฟอร์มแก้ไขแพ็กเกจของ 3x-ui → โหลดรายการ inbound มาให้เลือกทันที
  S.pdInboundState = { loading: false, list: null, selected: ed?.inboundId || null, error: '' };
  const edServer = ed ? S.adminServers.find(sv => Number(sv.id) === Number(ed.serverId)) : null;
  if (edServer && edServer.type === '3xui') setTimeout(() => loadInboundBox(edServer.id), 0);

  return `
    ${S.atab === 'add' || ed ? `
      <div class="section-card">
        <h3>
          <span>${ed ? `✏️ แก้ไขแพ็กเกจ: ${esc(ed.title)}` : '➕ เพิ่มแพ็กเกจใหม่'}</span>
          ${ed ? `<button class="btn ghost sm" onclick="S.editingProductId=null;render()">ยกเลิกแก้ไข</button>` : ''}
        </h3>
        <div class="row3">
          <div>
            <label>เครือข่าย</label>
            <select id="pdNet">
              ${['AIS', 'TRUE', 'dtac'].map(n => `<option value="${n}" ${ed?.net === n ? 'selected' : ''}>${n}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>โปรโตคอล</label>
            <select id="pdProto">
              ${['V2RAY', 'SSH', 'UDP'].map(pr => `<option value="${pr}" ${ed?.proto === pr ? 'selected' : ''}>${pr}</option>`).join('')}
            </select>
          </div>
          <div>
            <label>ผูกเซิร์ฟเวอร์สร้างบัญชีอัตโนมัติ</label>
            <select id="pdServer" onchange="loadInboundBox(this.value)">
              <option value="">-- สร้างบัญชีจำลองพื้นฐาน --</option>
              ${S.adminServers.map(sv => `<option value="${sv.id}" ${Number(ed?.serverId) === Number(sv.id) ? 'selected' : ''}>${esc(sv.name)} (${sv.type.toUpperCase()})</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="pdInboundBox">${inboundBoxHtml(S.pdInboundState)}</div>

        <div class="row2">
          <div>
            <label>ชื่อแพ็กเกจ</label>
            <input id="pdTitle" value="${esc(ed?.title || '')}" placeholder="เช่น AIS No-Limit 3x-ui ไฟเบอร์">
          </div>
          <div>
            <label>ป้ายโปรโมชั่น (Badge)</label>
            <input id="pdBadge" value="${esc(ed?.badge || '')}" placeholder="เช่น ขายดี / แนะนำ / ลดราคา">
          </div>
        </div>

        <label>รายละเอียดแพ็กเกจ</label>
        <textarea id="pdDesc" rows="2" placeholder="ระบุความเร็ว การรองรับเกม/สตรีมมิ่ง หรือเงื่อนไขโปรเน็ต...">${esc(ed?.desc || '')}</textarea>

        <label>ตัวเลือกราคาและระยะเวลา (บรรทัดละ 1 ราคา: ชื่อแพ็กเกจ, ระยะเวลา, ราคา)</label>
        <textarea id="pdPlans" rows="4">${esc(planLines)}</textarea>

        <label>รูปแบนเนอร์แพ็กเกจ</label>
        <input id="pdImgFile" type="file" accept="image/*">
        ${ed?.img ? `<img class="img-prev" src="${esc(ed.img)}">` : ''}

        <button class="btn" style="margin-top:16px" onclick="saveProductForm(${ed ? ed.id : 'null'})">${ed ? '💾 บันทึกการแก้ไขแพ็กเกจ' : '➕ เปิดขายแพ็กเกจ'}</button>
      </div>
    ` : ''}

    <div class="section-card">
      <h3>📦 แพ็กเกจที่เปิดขายอยู่ (${S.products.length})</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>แพ็กเกจ</th><th>เครือข่าย / โปรโตคอล</th><th>เซิร์ฟเวอร์</th><th>ตัวเลือกราคา</th><th>จัดการ</th></tr></thead>
          <tbody>
            ${S.products.length ? S.products.map(p => `
              <tr>
                <td><b>${esc(p.title)}</b> ${p.badge ? `<span class="tag promo">${esc(p.badge)}</span>` : ''}</td>
                <td><span class="tag ${esc(p.net)}">${esc(p.net)}</span> <span class="tag">${esc(p.proto)}</span></td>
                <td>${p.serverName ? `<span class="tag srv">${esc(p.serverName)}</span>${p.inboundId ? ` <span class="tag">Inbound #${p.inboundId}</span>` : ''}` : '-'}</td>
                <td>${p.plans.map(pl => `${esc(pl.n)} (${money(pl.p)}฿)`).join(', ')}</td>
                <td style="white-space:nowrap">
                  <button class="btn sm ghost" onclick="S.editingProductId=${p.id};render()">แก้ไข</button>
                  <button class="btn sm danger" onclick="hideProduct(${p.id})">ซ่อน/ลบ</button>
                </td>
              </tr>
            `).join('') : `<tr><td colspan="5" class="empty">ยังไม่มีแพ็กเกจ</td></tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function saveProductForm(id) {
  try {
    const lines = $('pdPlans').value.split('\n').map(l => l.trim()).filter(Boolean);
    const plans = lines.map(l => {
      const [n, d, p] = l.split(',').map(x => x.trim());
      return { n, d, p };
    });
    const sv = S.adminServers.find(x => Number(x.id) === Number($('pdServer').value));
    if (sv && sv.type === '3xui' && !($('pdInbound') && $('pdInbound').value)) {
      throw new Error('กรุณาเลือก Inbound ที่จะใช้สร้างบัญชีสำหรับแพ็กเกจนี้');
    }
    const f = $('pdImgFile').files[0];
    const img = f ? await readImg(f, 900) : undefined;
    const body = {
      serverId: $('pdServer').value ? Number($('pdServer').value) : null,
      inboundId: $('pdInbound') && $('pdInbound').value ? Number($('pdInbound').value) : null,
      net: $('pdNet').value,
      proto: $('pdProto').value,
      title: $('pdTitle').value,
      badge: $('pdBadge').value,
      desc: $('pdDesc').value,
      plans,
      ...(img !== undefined ? { img } : {})
    };
    if (id) await api('/admin/products/' + id, { method: 'PUT', body });
    else await api('/admin/products', { method: 'POST', body });
    S.editingProductId = null;
    await refreshAll();
    showMsg('ok', id ? 'บันทึกแก้ไขแพ็กเกจเรียบร้อย' : 'เพิ่มแพ็กเกจใหม่เรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function hideProduct(id) {
  if (!confirm('ยืนยันซ่อน/ลบแพ็กเกจนี้จากหน้าร้าน?')) return;
  try {
    await api('/admin/products/' + id, { method: 'DELETE' });
    await refreshAll();
    showMsg('ok', 'ซ่อนแพ็กเกจเรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

// --- 4. Admin: เติมเงิน / คูปอง / คืนเงิน / แจ้งปัญหา ---
function adminTopupsTab() {
  return `
    <div class="section-card">
      <h3>💰 รายการแจ้งเติมเงินรอตรวจสอบ (${S.adminTopups.length})</h3>
      ${S.adminTopups.length ? S.adminTopups.map(t => `
        <div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px;display:flex;gap:14px;flex-wrap:wrap;justify-content:space-between;align-items:center">
          <div>
            <b>#${t.id} • @${esc(t.username)}</b> • <span class="tag">${t.method}</span>
            <div style="font-size:16px;font-weight:800;color:var(--brand);margin:4px 0">
              ${money(t.amount)} ฿ ${Number(t.bonus_amount) > 0 ? `<small style="color:var(--ok)">(+โบนัส ${money(t.bonus_amount)} ฿)</small>` : ''}
            </div>
            <div class="hint">${fdt(t.created_at)} ${t.verify_note ? `• หมายเหตุ: ${esc(t.verify_note)}` : ''}</div>
            ${t.method === 'truemoney' ? `<div class="acct">${esc(t.proof)}</div>` : ''}
          </div>
          ${t.method === 'bank' && t.proof ? `<img src="${esc(t.proof)}" style="width:120px;height:150px;object-fit:cover;border-radius:10px;border:1px solid var(--line);cursor:pointer" onclick="window.open(this.src)">` : ''}
          <div style="display:flex;gap:8px">
            <button class="btn ok sm" onclick="actTopup(${t.id}, 'approve')">✅ อนุมัติ</button>
            <button class="btn danger sm" onclick="actTopup(${t.id}, 'reject')">❌ ปฏิเสธ</button>
          </div>
        </div>
      `).join('') : `<div class="empty">ไม่มีรายการเติมเงินค้างตรวจสอบ</div>`}
    </div>
  `;
}

async function actTopup(id, act) {
  try {
    await api(`/admin/topups/${id}/${act}`, { method: 'POST' });
    S.adminTopups = await api('/admin/topups');
    await refreshAll();
    showMsg('ok', act === 'approve' ? 'อนุมัติเติมเงินเรียบร้อย' : 'ปฏิเสธรายการเรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function adminCouponsTab() {
  return `
    <div class="section-card">
      <h3>🎟️ สร้างคูปองส่วนลดใหม่</h3>
      <div class="row3">
        <div>
          <label>โค้ดส่วนลด</label>
          <input id="cpCode" placeholder="เช่น VIP20">
        </div>
        <div>
          <label>ส่วนลด (%)</label>
          <input id="cpPct" type="number" min="1" max="100" value="10">
        </div>
        <div>
          <label>จำนวนสิทธิ์ที่ใช้ได้</label>
          <input id="cpUses" type="number" min="1" value="50">
        </div>
      </div>
      <button class="btn" style="margin-top:14px" onclick="createCoupon()">สร้างคูปอง</button>
    </div>

    <div class="section-card">
      <h3>รายการคูปองทั้งหมด (${S.adminCoupons.length})</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>โค้ด</th><th>ส่วนลด</th><th>คงเหลือ</th><th>จัดการ</th></tr></thead>
          <tbody>
            ${S.adminCoupons.map(c => `
              <tr>
                <td><b>${esc(c.code)}</b></td>
                <td>${c.percent}%</td>
                <td>${c.remaining_uses} สิทธิ์</td>
                <td>${c.remaining_uses > 0 ? `<button class="btn danger sm" onclick="disableCoupon(${c.id})">ปิดใช้งาน</button>` : `<span class="tag">หมดสิทธิ์</span>`}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function createCoupon() {
  try {
    await api('/admin/coupons', {
      method: 'POST',
      body: {
        code: $('cpCode').value,
        percent: Number($('cpPct').value),
        remaining_uses: Number($('cpUses').value)
      }
    });
    S.adminCoupons = await api('/admin/coupons');
    showMsg('ok', 'สร้างคูปองส่วนลดเรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

async function disableCoupon(id) {
  await api('/admin/coupons/' + id, { method: 'DELETE' });
  S.adminCoupons = await api('/admin/coupons');
  render();
}

function adminOrdersTab() {
  return `
    <div class="section-card">
      <h3>🧾 ประวัติคำสั่งซื้อล่าสุด & คืนเครดิต (${S.adminOrders.length})</h3>
      <div class="table-wrap">
        <table>
          <thead><tr><th>#</th><th>ผู้ซื้อ</th><th>แพ็กเกจ</th><th>ยอดจ่าย</th><th>สถานะ</th><th>จัดการ</th></tr></thead>
          <tbody>
            ${S.adminOrders.map(o => `
              <tr>
                <td>#${o.id}</td>
                <td>@${esc(o.username)}</td>
                <td>${esc(o.title)} - ${esc(o.plan_name)}<br><small style="color:var(--sub)">${fdt(o.created_at)}</small></td>
                <td><b>${money(o.price_paid)} ฿</b></td>
                <td><span class="tag ${o.status === 'active' ? 'ok' : o.status === 'refunded' ? 'promo' : 'bad'}">${o.status}</span></td>
                <td>${o.status !== 'refunded' ? `<button class="btn danger sm" onclick="refundOrder(${o.id})">คืนเครดิต</button>` : '-'}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

async function refundOrder(id) {
  if (!confirm(`ยืนยันคืนเครดิตคำสั่งซื้อ #${id}?\nระบบจะลบบัญชีนี้บนเซิร์ฟเวอร์ด้วย`)) return;
  // ค่าเริ่มต้น: คืนเฉพาะราคาออเดอร์แรก — เลือกรวมค่าต่ออายุได้
  const includeRenewals = confirm('คืนรวมค่าต่ออายุที่เคยจ่ายด้วยหรือไม่?\n\nOK = คืนทั้งหมด (ซื้อครั้งแรก + ต่ออายุ)\nCancel = คืนเฉพาะราคาซื้อครั้งแรก');
  const call = force => api(`/admin/orders/${id}/refund`, { method: 'POST', body: { includeRenewals, force } });
  try {
    let r;
    try {
      r = await call(false);
    } catch (e) {
      if (!/ปิดบัญชีบนเซิร์ฟเวอร์ไม่สำเร็จ/.test(e.message)) throw e;
      if (!confirm(`${e.message}\n\nคืนเงินต่อเลยโดยไม่ปิดบัญชีบนเซิร์ฟเวอร์? (ต้องไปลบ client/user เองภายหลัง)`)) throw e;
      r = await call(true);
    }
    S.adminOrders = await api('/admin/orders');
    await refreshAll();
    showMsg('ok', `คืนเครดิตคำสั่งซื้อ #${id} จำนวน ${money(r.amount)} ฿ แล้ว` + (r.account === 'failed_forced' ? ' (แต่ยังปิดบัญชีบนเซิร์ฟเวอร์ไม่สำเร็จ ต้องลบเอง)' : ''));
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function adminTicketsTab() {
  return `
    <div class="section-card">
      <h3>💬 รายการแจ้งปัญหาจากลูกค้า (${S.adminTickets.length})</h3>
      ${S.adminTickets.length ? S.adminTickets.map(t => `
        <div style="border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px">
          <div style="display:flex;justify-content:space-between">
            <b>#${t.id} • @${esc(t.username)} — ${esc(t.subject)}</b>
            <span class="tag ${t.status === 'open' ? 'bad' : 'ok'}">${t.status}</span>
          </div>
          <div class="hint">${fdt(t.created_at)} ${t.order_id ? `• ออเดอร์ #${t.order_id}` : ''}</div>
          <p style="margin:8px 0">${esc(t.message)}</p>
          <div style="display:flex;gap:8px">
            <input id="tkReply_${t.id}" value="${esc(t.reply || '')}" placeholder="พิมพ์ข้อความตอบกลับลูกค้า...">
            <button class="btn sm" onclick="replyTicket(${t.id})">ส่งคำตอบ</button>
          </div>
        </div>
      `).join('') : `<div class="empty">ไม่มีรายการแจ้งปัญหา</div>`}
    </div>
  `;
}

async function replyTicket(id) {
  try {
    await api(`/admin/tickets/${id}/reply`, {
      method: 'POST',
      body: { reply: $('tkReply_' + id).value, status: 'answered' }
    });
    S.adminTickets = await api('/admin/tickets');
    showMsg('ok', 'บันทึกการตอบกลับเรียบร้อย');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

// --- 5. Admin: ตั้งค่า API ตรวจสลิป & ตั้งค่าเว็บ ---
function adminSlipApiTab() {
  const st = S.adminSettings || S.site;
  return `
    <div class="section-card">
      <h3>🔌 ตั้งค่า API ตรวจสลิปอัตโนมัติ (External Slip Verify API)</h3>
      <label>โหมดการตรวจสอบสลิป</label>
      <select id="stSlipMode">
        <option value="manual" ${(st.slip_mode || 'manual') === 'manual' ? 'selected' : ''}>ตรวจมือโดยแอดมิน (Manual)</option>
        <option value="external" ${st.slip_mode === 'external' ? 'selected' : ''}>เชื่อมต่อ External API ตรวจสลิปอัตโนมัติ</option>
      </select>

      <label>ผู้ให้บริการตรวจสลิป</label>
      <select id="stSlipProvider">
        <option value="generic" ${(st.slip_provider || 'generic') === 'generic' ? 'selected' : ''}>กำหนดเอง (ส่ง JSON {proof, amount})</option>
        <option value="easyslip" ${st.slip_provider === 'easyslip' ? 'selected' : ''}>EasySlip (ปล่อย URL ว่างได้)</option>
        <option value="slipok" ${st.slip_provider === 'slipok' ? 'selected' : ''}>SlipOK (URL: https://api.slipok.com/api/line/apikey/รหัสสาขา)</option>
      </select>

      <label>Slip Verify API Endpoint URL</label>
      <input id="stSlipUrl" value="${esc(st.slip_verify_url || '')}" placeholder="EasySlip เว้นว่างได้ / SlipOK ใส่ URL ที่มีรหัสสาขา">

      <label>API Key / Bearer Token ${st.has_slip_api_key ? '(บันทึกคีย์ไว้แล้ว กรอกใหม่หากต้องการเปลี่ยน)' : ''}</label>
      <input id="stSlipKey" type="password" placeholder="ใส่ API Key ของผู้ให้บริการตรวจสลิป">

      <label>การอนุมัติยอดเงินอัตโนมัติ</label>
      <select id="stSlipAuto">
        <option value="true" ${String(st.slip_auto_approve) === 'true' ? 'selected' : ''}>อนุมัติเครดิตทันทีเมื่อ API ตรวจผ่าน (Auto-Approve)</option>
        <option value="false" ${String(st.slip_auto_approve) !== 'true' ? 'selected' : ''}>ตรวจผ่าน API แต่รอแอดมินกดอนุมัติ</option>
      </select>

      <button class="btn" style="margin-top:16px" onclick="saveSlipApiSettings()">💾 บันทึกการตั้งค่า API</button>
    </div>
  `;
}

async function saveSlipApiSettings() {
  try {
    await api('/admin/site', {
      method: 'PUT',
      body: {
        slip_mode: $('stSlipMode').value,
        slip_provider: $('stSlipProvider').value,
        slip_verify_url: $('stSlipUrl').value,
        slip_api_key: $('stSlipKey').value,
        slip_auto_approve: $('stSlipAuto').value
      }
    });
    S.adminSettings = await api('/admin/settings');
    await refreshAll();
    showMsg('ok', 'บันทึกการตั้งค่า API ตรวจสลิปเรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function adminSiteTab() {
  const s = S.adminSettings || S.site;
  return `
    <div class="section-card">
      <h3>⚙️ ตั้งค่าเว็บไซต์ รูปภาพ และเงื่อนไขการเติมเงิน</h3>
      <div class="row2">
        <div>
          <label>ชื่อเว็บไซต์ / ร้านค้า</label>
          <input id="stName" value="${esc(s.name || '')}">
        </div>
        <div>
          <label>ลิงก์ / ไอดีติดต่อแอดมิน (LINE / Telegram)</label>
          <input id="stLine" value="${esc(s.line || '')}" placeholder="@wselx">
        </div>
      </div>

      <label>หัวข้อหลักหน้าแรก (Hero Title)</label>
      <textarea id="stTitle" rows="2">${esc(s.title || '')}</textarea>

      <label>คำอธิบายรองหน้าแรก</label>
      <input id="stSub" value="${esc(s.sub || '')}">

      <div class="row3">
        <div>
          <label>เติมเงินขั้นต่ำ (บาท)</label>
          <input id="stMinTopup" type="number" min="1" value="${esc(s.min_topup_amount || '20')}">
        </div>
        <div>
          <label>ยอดขั้นต่ำรับโบนัส (บาท)</label>
          <input id="stBonusMin" type="number" min="0" value="${esc(s.bonus_min_amount || '100')}">
        </div>
        <div>
          <label>โบนัสเติมเงิน (%)</label>
          <input id="stBonusPct" type="number" min="0" max="100" value="${esc(s.bonus_percent || '5')}">
        </div>
      </div>

      <div class="row3">
        <div>
          <label>ชื่อธนาคาร / พร้อมเพย์</label>
          <input id="stBankName" value="${esc(s.bankName || '')}" placeholder="กสิกรไทย / PromptPay">
        </div>
        <div>
          <label>เลขที่บัญชี / เบอร์พร้อมเพย์</label>
          <input id="stBankNo" value="${esc(s.bankNo || '')}">
        </div>
        <div>
          <label>ชื่อบัญชีผู้รับโอน</label>
          <input id="stBankHolder" value="${esc(s.bankHolder || '')}">
        </div>
      </div>

      <div class="row2">
        <div>
          <label>โบนัสแนะนำเพื่อน (บาท)</label>
          <input id="stRefReward" type="number" min="0" value="${esc(s.referral_reward || '10')}">
        </div>
        <div>
          <label>วันที่เปิดให้บริการ (แสดงหน้าแรก)</label>
          <input id="stOpen" value="${esc(s.open || '2026-07-01')}">
        </div>
      </div>

      <div class="row3">
        <div>
          <label>โลโก้เว็บไซต์</label>
          <input id="stLogoFile" type="file" accept="image/*">
          ${s.logo ? `<img class="img-prev" src="${esc(s.logo)}">` : ''}
        </div>
        <div>
          <label>แบนเนอร์หลักหน้าแรก</label>
          <input id="stHeroFile" type="file" accept="image/*">
          ${s.hero ? `<img class="img-prev" src="${esc(s.hero)}">` : ''}
        </div>
        <div>
          <label>แบนเนอร์โปรโมชั่นหน้าแรก</label>
          <input id="stPromoFile" type="file" accept="image/*">
          ${s.promo ? `<img class="img-prev" src="${esc(s.promo)}">` : ''}
        </div>
      </div>

      <button class="btn" style="margin-top:18px" onclick="saveSiteSettings()">💾 บันทึกการตั้งค่าทั้งหมด</button>
    </div>
  `;
}

async function saveSiteSettings() {
  try {
    const body = {
      name: $('stName').value,
      line: $('stLine').value,
      title: $('stTitle').value,
      sub: $('stSub').value,
      min_topup_amount: $('stMinTopup').value,
      bonus_min_amount: $('stBonusMin').value,
      bonus_percent: $('stBonusPct').value,
      bankName: $('stBankName').value,
      bankNo: $('stBankNo').value,
      bankHolder: $('stBankHolder').value,
      referral_reward: $('stRefReward').value,
      open: $('stOpen').value
    };
    const fLogo = $('stLogoFile').files[0];
    const fHero = $('stHeroFile').files[0];
    const fPromo = $('stPromoFile').files[0];
    if (fLogo) body.logo = await readImg(fLogo, 300);
    if (fHero) body.hero = await readImg(fHero, 1200);
    if (fPromo) body.promo = await readImg(fPromo, 1200);

    await api('/admin/site', { method: 'PUT', body });
    S.adminSettings = await api('/admin/settings');
    await refreshAll();
    showMsg('ok', 'บันทึกการตั้งค่าเว็บไซต์เรียบร้อยแล้ว');
  } catch (e) {
    showMsg('bad', e.message);
  }
}

function render() {
  renderBar();
  const views = {
    shop: viewShop,
    topup: viewTopup,
    history: viewHistory,
    support: viewSupport,
    auth: viewAuth,
    admin: viewAdmin
  };
  $('app').innerHTML = (views[S.view] || viewShop)();
}

refreshAll().catch(e => {
  $('app').innerHTML = `<div class="section-card empty">ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้: ${esc(e.message)}</div>`;
});
