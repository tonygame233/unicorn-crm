import { Hono } from 'hono';
import { cors } from 'hono/cors';

// JWT thuần Web Crypto — tương thích 100% Cloudflare Workers
async function jwtSign(payload, secret) {
  const enc = new TextEncoder();
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body   = b64url(JSON.stringify(payload));
  const data   = `${header}.${body}`;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return `${data}.${b64urlBytes(new Uint8Array(sig))}`;
}
async function jwtVerify(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('bad token');
  const [header, body, sig] = parts;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const sigBytes = Uint8Array.from(atob(sig.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(`${header}.${body}`));
  if (!ok) throw new Error('invalid signature');
  return JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/')));
}
function b64url(str) {
  return btoa(unescape(encodeURIComponent(str))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlBytes(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const app = new Hono();
app.use('*', cors({ origin: '*' }));

// Stub socket.io — trả về JS rỗng để tránh lỗi 404 HTML block trang
app.get('/socket.io/socket.io.js', (c) =>
  new Response('/* socket.io stub — app uses polling instead */', {
    headers: { 'Content-Type': 'application/javascript' }
  })
);

// Service Worker — handle notification click để focus tab cũ thay vì mở tab mới
app.get('/sw.js', (c) => new Response(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(clients.claim()));

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const leadId = event.notification.data?.leadId || null;
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Tìm tab CRM đang mở
      const crm = list.find(c => c.url.startsWith(self.location.origin));
      if (crm) {
        if (leadId) crm.postMessage({ type: 'OPEN_CHAT', leadId });
        return crm.focus();
      }
      // Không có tab nào → mở mới
      return clients.openWindow(self.location.origin + (leadId ? '?chat=' + leadId : ''));
    })
  );
});
`, { headers: { 'Content-Type': 'application/javascript', 'Service-Worker-Allowed': '/' } }));

// ─── PASSWORD (Web Crypto PBKDF2) ─────────────────────────────────────────────
async function hashPwd(pwd) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(pwd), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('unicorn_crm_2026'), iterations: 10000 },
    key, 256
  );
  return [...new Uint8Array(bits)].map(b => b.toString(16).padStart(2, '0')).join('');
}
const checkPwd = async (pwd, hash) => (await hashPwd(pwd)) === hash;

// ─── SEED TÀI KHOẢN MẶC ĐỊNH ─────────────────────────────────────────────────
async function seedIfEmpty(env) {
  const row = await env.DB.prepare('SELECT COUNT(*) as c FROM users').first();
  if (row.c > 0) return;
  const hash = await hashPwd('123456');
  for (const [email, name, role] of [
    ['admin@unicorn.com', 'Admin', 'admin'],
    ['sale@unicorn.com', 'Sale', 'sale'],
    ['support@unicorn.com', 'Support', 'support'],
    ['mkt@unicorn.com', 'Marketing', 'mkt'],
  ]) {
    await env.DB.prepare('INSERT OR IGNORE INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
      .bind(email, hash, name, role).run();
  }
  for (const [key_cmd, title, body] of [
    ['/hello', 'Auto Welcome', '🔥 Chào mừng bạn đến với Unicorn VIP\n\nBạn đang quan tâm:\n• Futures Signals\n• Copytrade\n• VIP Group\n\nReply:\n1️⃣ Futures\n2️⃣ VIP\n3️⃣ Copytrade'],
    ['/price', 'Báo giá', 'Hiện bên mình có 4 gói: Premium, 3 Month, Lifetime và Ultimate.'],
    ['/pay', 'Thanh toán', 'Bạn có thể thanh toán qua USDT. Sau khi thanh toán, gửi bill tại đây.'],
  ]) {
    await env.DB.prepare('INSERT OR IGNORE INTO quick_replies (key_cmd,title,body,files) VALUES (?,?,?,?)')
      .bind(key_cmd, title, body, '[]').run();
  }
}

// ─── AUTH MIDDLEWARE ──────────────────────────────────────────────────────────
const auth = async (c, next) => {
  const h = c.req.header('Authorization');
  if (!h?.startsWith('Bearer ')) return c.json({ error: 'Unauthorized' }, 401);
  try {
    c.set('user', await jwtVerify(h.slice(7), c.env.JWT_SECRET));
    await next();
  } catch {
    return c.json({ error: 'Token không hợp lệ' }, 401);
  }
};

const adminOnly = async (c, next) => {
  const user = c.get('user');
  if (user?.role !== 'admin') return c.json({ error: 'Chỉ admin mới thực hiện được' }, 403);
  await next();
};

// ─── HELPER: lấy bot token cho contact ───────────────────────────────────────
async function getBotToken(env, contact) {
  const ch = await env.DB.prepare('SELECT bot_token FROM channels WHERE id = ? AND active = 1')
    .bind(contact.channel_id).first();
  return ch?.bot_token || null;
}

// ─── HELPER: gọi Telegram API ─────────────────────────────────────────────────
async function tgCall(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post('/auth/login', async (c) => {
  await seedIfEmpty(c.env);
  const { email, password } = await c.req.json();
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE email = ?')
    .bind((email || '').toLowerCase().trim()).first();
  if (!user || !(await checkPwd(password || '', user.password_hash)))
    return c.json({ error: 'Sai tài khoản hoặc mật khẩu' }, 401);
  const token = await jwtSign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    c.env.JWT_SECRET
  );
  return c.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

// ─── USERS (admin) ────────────────────────────────────────────────────────────
app.get('/users', auth, adminOnly, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY id').all();
  return c.json(results);
});

app.post('/users', auth, adminOnly, async (c) => {
  const { email, name, role, password } = await c.req.json();
  if (!email || !name || !password) return c.json({ error: 'Thiếu thông tin' }, 400);
  const hash = await hashPwd(password);
  try {
    const r = await c.env.DB.prepare('INSERT INTO users (email,password_hash,name,role) VALUES (?,?,?,?)')
      .bind(email.toLowerCase().trim(), hash, name, role || 'sale').run();
    return c.json({ id: r.meta.last_row_id });
  } catch { return c.json({ error: 'Email đã tồn tại' }, 409); }
});

app.delete('/users/:id', auth, adminOnly, async (c) => {
  const user = c.get('user');
  if (String(user.id) === c.req.param('id')) return c.json({ error: 'Không thể xóa chính mình' }, 400);
  await c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

app.patch('/users/:id/password', auth, adminOnly, async (c) => {
  const { password } = await c.req.json();
  if (!password) return c.json({ error: 'Thiếu mật khẩu' }, 400);
  const hash = await hashPwd(password);
  await c.env.DB.prepare('UPDATE users SET password_hash = ? WHERE id = ?')
    .bind(hash, c.req.param('id')).run();
  return c.json({ success: true });
});

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
app.get('/channels', auth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT id,name,icon,bot_username,active FROM channels WHERE active = 1 ORDER BY id'
  ).all();
  return c.json(results);
});

app.post('/channels', auth, async (c) => {
  const { name, icon, bot_token } = await c.req.json();
  if (!name || !bot_token) return c.json({ error: 'Thiếu tên hoặc bot token' }, 400);
  try {
    const meRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const me = await meRes.json();
    if (!me.ok) return c.json({ error: 'Bot token không hợp lệ: ' + me.description }, 400);

    const origin = new URL(c.req.url).origin;
    const webhookUrl = `${origin}/telegram/webhook/${bot_token}`;
    await fetch(`https://api.telegram.org/bot${bot_token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: webhookUrl, allowed_updates: ['message', 'edited_message'] }),
    });

    const r = await c.env.DB.prepare(
      'INSERT OR IGNORE INTO channels (name,icon,bot_token,bot_username) VALUES (?,?,?,?)'
    ).bind(name, icon || '🤖', bot_token, me.result.username).run();

    if (!r.meta.last_row_id) return c.json({ error: 'Bot token đã được dùng rồi' }, 409);
    return c.json({ id: r.meta.last_row_id, name, icon: icon || '🤖', bot_username: me.result.username, active: 1 });
  } catch (err) {
    return c.json({ error: err.message }, 400);
  }
});

app.patch('/channels/:id', auth, async (c) => {
  const { name, icon } = await c.req.json();
  const sets = [], vals = [];
  if (name) { sets.push('name = ?'); vals.push(name); }
  if (icon) { sets.push('icon = ?'); vals.push(icon); }
  if (!sets.length) return c.json({ error: 'Không có gì cập nhật' }, 400);
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return c.json({ success: true });
});

app.delete('/channels/:id', auth, async (c) => {
  const ch = await c.env.DB.prepare('SELECT * FROM channels WHERE id = ?').bind(c.req.param('id')).first();
  if (!ch) return c.json({ error: 'Không tìm thấy' }, 404);
  try { await fetch(`https://api.telegram.org/bot${ch.bot_token}/deleteWebhook`); } catch {}
  await c.env.DB.prepare('UPDATE channels SET active = 0 WHERE id = ?').bind(ch.id).run();
  return c.json({ success: true });
});

// ─── CONVERSATIONS ─────────────────────────────────────────────────────────────
app.get('/conversations', auth, async (c) => {
  const q = c.req.query();
  const params = [];
  let where = 'WHERE 1=1';
  if (q.channel_id) { where += ' AND c.channel_id = ?'; params.push(Number(q.channel_id)); }
  if (q.lifecycle && q.lifecycle !== 'all') { where += ' AND c.lifecycle = ?'; params.push(q.lifecycle); }
  if (q.search) {
    where += ' AND (c.username LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)';
    params.push(`%${q.search}%`, `%${q.search}%`, `%${q.search}%`);
  }
  if (q.unreplied === '1') { where += ' AND c.unread > 0'; }
  params.push((Number(q.page || 1) - 1) * 50);
  const { results } = await c.env.DB.prepare(
    `SELECT c.*, ch.name as channel_name, ch.icon as channel_icon
     FROM contacts c LEFT JOIN channels ch ON c.channel_id = ch.id
     ${where} ORDER BY c.last_message_time DESC LIMIT 50 OFFSET ?`
  ).bind(...params).all();
  return c.json(results);
});

app.get('/conversations/:id/messages', auth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at DESC LIMIT 100'
  ).bind(c.req.param('id')).all();
  return c.json(results);
});

app.patch('/conversations/:id', auth, async (c) => {
  const body = await c.req.json();
  const { lifecycle, package: pkg, notes, sale, tags } = body;
  const sets = [], vals = [];
  if (lifecycle !== undefined) { sets.push('lifecycle = ?'); vals.push(lifecycle); }
  if (pkg !== undefined) { sets.push('package = ?'); vals.push(pkg); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
  if (sale !== undefined) { sets.push('sale = ?'); vals.push(sale); }
  if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags)); }
  if (!sets.length) return c.json({ error: 'Không có gì cập nhật' }, 400);
  vals.push(c.req.param('id'));
  await c.env.DB.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return c.json({ success: true });
});

app.post('/conversations/:id/read', auth, async (c) => {
  await c.env.DB.prepare('UPDATE contacts SET unread = 0 WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

// ─── REPLY TEXT ───────────────────────────────────────────────────────────────
app.post('/reply', auth, async (c) => {
  const { contact_id, text, reply_to_msg_id, button_label, button_url } = await c.req.json();
  if (!contact_id || !text?.trim()) return c.json({ error: 'Thiếu thông tin' }, 400);

  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contact_id).first();
  if (!contact) return c.json({ error: 'Không tìm thấy contact' }, 404);
  const token = await getBotToken(c.env, contact);
  if (!token) return c.json({ error: 'Bot channel này chưa kết nối' }, 503);

  const msgOpts = {};
  if (reply_to_msg_id) {
    const refMsg = await c.env.DB.prepare('SELECT tg_msg_id FROM messages WHERE id = ?').bind(reply_to_msg_id).first();
    if (refMsg?.tg_msg_id) msgOpts.reply_parameters = { message_id: refMsg.tg_msg_id };
  }
  if (button_label && button_url) {
    msgOpts.reply_markup = { inline_keyboard: [[{ text: button_label, url: button_url }]] };
  }

  const tgData = await tgCall(token, 'sendMessage', {
    chat_id: contact.telegram_id, text, ...msgOpts
  });

  if (!tgData.ok) {
    const desc = tgData.description || '';
    if (desc.includes('bot was blocked')) {
      await c.env.DB.prepare("UPDATE contacts SET lifecycle='Blocked' WHERE id=?").bind(contact.id).run();
      return c.json({ error: 'Khách đã chặn bot. Liên hệ kênh khác.', blocked: true }, 403);
    }
    if (desc.includes('chat not found')) {
      return c.json({ error: 'Khách chưa bắt đầu chat với bot này.', chat_not_found: true }, 400);
    }
    return c.json({ error: desc || 'Telegram error' }, 500);
  }

  const user = c.get('user');
  const r = await c.env.DB.prepare(
    "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,direction,sender_name,bot_token) VALUES (?,?,?,?,?,'out',?,?)"
  ).bind(contact.id, contact.channel_id, contact.telegram_id, tgData.result.message_id, text, user.name, token).run();

  await c.env.DB.prepare("UPDATE contacts SET last_message=?,last_message_time=datetime('now') WHERE id=?")
    .bind(text, contact.id).run();

  return c.json({
    success: true,
    message: { id: r.meta.last_row_id, contact_id: contact.id, channel_id: contact.channel_id, text, direction: 'out', sender_name: user.name, tg_msg_id: tgData.result.message_id, created_at: new Date().toISOString() }
  });
});

// ─── REPLY PHOTO (base64) ─────────────────────────────────────────────────────
app.post('/reply-photo', auth, async (c) => {
  const { contact_id, base64, mime_type } = await c.req.json();
  if (!contact_id || !base64) return c.json({ error: 'Thiếu thông tin' }, 400);

  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contact_id).first();
  if (!contact) return c.json({ error: 'Không tìm thấy contact' }, 404);
  const token = await getBotToken(c.env, contact);
  if (!token) return c.json({ error: 'Bot chưa kết nối' }, 503);

  const b64 = base64.replace(/^data:[^;]+;base64,/, '');
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  const isImage = !mime_type || mime_type.startsWith('image/');
  const ext = isImage ? 'photo.jpg' : 'file.bin';
  const ct = mime_type || (isImage ? 'image/jpeg' : 'application/octet-stream');

  const form = new FormData();
  form.append('chat_id', String(contact.telegram_id));
  form.append(isImage ? 'photo' : 'document', new Blob([bytes], { type: ct }), ext);

  const tgRes = await fetch(`https://api.telegram.org/bot${token}/${isImage ? 'sendPhoto' : 'sendDocument'}`, {
    method: 'POST', body: form
  });
  const tgData = await tgRes.json();
  if (!tgData.ok) return c.json({ error: tgData.description }, 500);

  const sentFileId = isImage
    ? (tgData.result.photo?.[tgData.result.photo.length - 1]?.file_id || null)
    : (tgData.result.document?.file_id || null);
  const mType = isImage ? 'photo' : 'document';

  const user = c.get('user');
  const r = await c.env.DB.prepare(
    "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token) VALUES (?,?,?,?,'[photo]',?,?,'out',?,?)"
  ).bind(contact.id, contact.channel_id, contact.telegram_id, tgData.result.message_id, sentFileId, mType, user.name, token).run();

  await c.env.DB.prepare("UPDATE contacts SET last_message='[photo]',last_message_time=datetime('now') WHERE id=?")
    .bind(contact.id).run();

  return c.json({
    success: true,
    message: { id: r.meta.last_row_id, contact_id: contact.id, channel_id: contact.channel_id, text: '[photo]', file_id: sentFileId, media_type: mType, direction: 'out', sender_name: user.name, created_at: new Date().toISOString() }
  });
});

// ─── REPLY PHOTOS (album) ─────────────────────────────────────────────────────
app.post('/reply-photos', auth, async (c) => {
  const { contact_id, images } = await c.req.json();
  if (!contact_id || !Array.isArray(images) || !images.length)
    return c.json({ error: 'Thiếu thông tin' }, 400);

  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contact_id).first();
  if (!contact) return c.json({ error: 'Không tìm thấy contact' }, 404);
  const token = await getBotToken(c.env, contact);
  if (!token) return c.json({ error: 'Bot chưa kết nối' }, 503);

  const user = c.get('user');
  const savedMsgs = [];
  const groupId = images.length > 1 ? `grp_${Date.now()}` : null;

  if (images.length === 1) {
    const b64 = images[0].base64.replace(/^data:[^;]+;base64,/, '');
    const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
    const form = new FormData();
    form.append('chat_id', String(contact.telegram_id));
    form.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'photo.jpg');
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
    const tgData = await tgRes.json();
    if (!tgData.ok) return c.json({ error: tgData.description }, 500);
    const fileId = tgData.result.photo?.[tgData.result.photo.length - 1]?.file_id || null;
    const r = await c.env.DB.prepare(
      "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token) VALUES (?,?,?,?,'[photo]',?,'photo','out',?,?)"
    ).bind(contact.id, contact.channel_id, contact.telegram_id, tgData.result.message_id, fileId, user.name, token).run();
    savedMsgs.push({ id: r.meta.last_row_id, tg_msg_id: tgData.result.message_id, file_id: fileId, media_type: 'photo', channel_id: contact.channel_id, direction: 'out', created_at: new Date().toISOString() });
  } else {
    const form = new FormData();
    form.append('chat_id', String(contact.telegram_id));
    const mediaArr = images.map((img, i) => ({ type: 'photo', media: `attach://photo${i}` }));
    form.append('media', JSON.stringify(mediaArr));
    for (let i = 0; i < images.length; i++) {
      const b64 = images[i].base64.replace(/^data:[^;]+;base64,/, '');
      const bytes = Uint8Array.from(atob(b64), ch => ch.charCodeAt(0));
      form.append(`photo${i}`, new Blob([bytes], { type: 'image/jpeg' }), `photo${i}.jpg`);
    }
    const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: form });
    const tgData = await tgRes.json();
    if (!tgData.ok) return c.json({ error: tgData.description }, 500);
    for (const tgMsg of tgData.result) {
      const fileId = tgMsg.photo?.[tgMsg.photo.length - 1]?.file_id || null;
      const r = await c.env.DB.prepare(
        "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,media_group_id,direction,sender_name,bot_token) VALUES (?,?,?,?,'[photo]',?,'photo',?,'out',?,?)"
      ).bind(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, fileId, groupId, user.name, token).run();
      savedMsgs.push({ id: r.meta.last_row_id, tg_msg_id: tgMsg.message_id, file_id: fileId, media_type: 'photo', media_group_id: groupId, channel_id: contact.channel_id, direction: 'out', created_at: new Date().toISOString() });
    }
  }

  await c.env.DB.prepare("UPDATE contacts SET last_message='[photo]',last_message_time=datetime('now') WHERE id=?")
    .bind(contact.id).run();

  return c.json({ success: true, messages: savedMsgs });
});

// ─── EDIT MESSAGE ─────────────────────────────────────────────────────────────
app.patch('/messages/:id/text', auth, async (c) => {
  const { text } = await c.req.json();
  if (!text?.trim()) return c.json({ error: 'Thiếu nội dung' }, 400);
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(c.req.param('id')).first();
  if (!msg) return c.json({ error: 'Không tìm thấy tin nhắn' }, 404);
  if (msg.direction !== 'out') return c.json({ error: 'Chỉ sửa được tin nhắn đã gửi đi' }, 400);

  let tgError = null;
  if (msg.tg_msg_id) {
    const token = msg.bot_token || (await c.env.DB.prepare('SELECT bot_token FROM channels WHERE id = ? AND active=1').bind(msg.channel_id).first())?.bot_token;
    if (token) {
      const r = await tgCall(token, 'editMessageText', { chat_id: msg.telegram_chat_id, message_id: msg.tg_msg_id, text });
      if (!r.ok) tgError = r.description;
    }
  }
  await c.env.DB.prepare('UPDATE messages SET text = ? WHERE id = ?').bind(text.trim(), msg.id).run();
  return c.json({ success: true, text: text.trim(), tg_error: tgError });
});

// ─── DELETE MESSAGE ───────────────────────────────────────────────────────────
app.delete('/messages/:id', auth, async (c) => {
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(c.req.param('id')).first();
  if (!msg) return c.json({ error: 'Không tìm thấy tin nhắn' }, 404);

  let tgError = null;
  if (msg.tg_msg_id) {
    const token = msg.bot_token || (await c.env.DB.prepare('SELECT bot_token FROM channels WHERE id = ? AND active=1').bind(msg.channel_id).first())?.bot_token;
    if (token) {
      const r = await tgCall(token, 'deleteMessage', { chat_id: msg.telegram_chat_id, message_id: msg.tg_msg_id });
      if (!r.ok) tgError = r.description;
    }
  }

  const user = c.get('user');
  await c.env.DB.prepare(`
    INSERT INTO archived_messages (original_id,contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,reactions,bot_token,media_group_id,deleted_by,original_created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(msg.id, msg.contact_id, msg.channel_id, msg.telegram_chat_id, msg.tg_msg_id,
    msg.text, msg.file_id, msg.media_type, msg.direction, msg.sender_name,
    msg.reactions, msg.bot_token, msg.media_group_id, user.name, msg.created_at).run();

  await c.env.DB.prepare('DELETE FROM messages WHERE id = ?').bind(msg.id).run();
  return c.json({ success: true, tg_error: tgError });
});

// ─── STICKER ──────────────────────────────────────────────────────────────────
app.get('/sticker-set/:name', auth, async (c) => {
  const { results: chs } = await c.env.DB.prepare('SELECT bot_token FROM channels WHERE active=1 LIMIT 1').all();
  if (!chs.length) return c.json({ error: 'Chưa có bot nào' }, 503);
  const r = await fetch(`https://api.telegram.org/bot${chs[0].bot_token}/getStickerSet?name=${c.req.param('name')}`);
  const data = await r.json();
  if (!data.ok) return c.json({ error: data.description }, 400);
  return c.json(data.result);
});

app.post('/reply-sticker', auth, async (c) => {
  const { contact_id, file_id } = await c.req.json();
  if (!contact_id || !file_id) return c.json({ error: 'Thiếu thông tin' }, 400);
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(contact_id).first();
  if (!contact) return c.json({ error: 'Không tìm thấy contact' }, 404);
  const token = await getBotToken(c.env, contact);
  if (!token) return c.json({ error: 'Bot chưa kết nối' }, 503);

  const tgData = await tgCall(token, 'sendSticker', { chat_id: contact.telegram_id, sticker: file_id });
  if (!tgData.ok) return c.json({ error: tgData.description }, 500);

  const user = c.get('user');
  const r = await c.env.DB.prepare(
    "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token) VALUES (?,?,?,?,'[sticker]',?,'sticker','out',?,?)"
  ).bind(contact.id, contact.channel_id, contact.telegram_id, tgData.result.message_id, file_id, user.name, token).run();

  await c.env.DB.prepare("UPDATE contacts SET last_message='[sticker]',last_message_time=datetime('now') WHERE id=?")
    .bind(contact.id).run();

  return c.json({
    success: true,
    message: { id: r.meta.last_row_id, contact_id: contact.id, channel_id: contact.channel_id, text: '[sticker]', file_id, media_type: 'sticker', direction: 'out', sender_name: user.name, created_at: new Date().toISOString() }
  });
});

// ─── QUICK REPLIES ────────────────────────────────────────────────────────────
app.get('/quick-replies', auth, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM quick_replies ORDER BY key_cmd').all();
  return c.json(results.map(r => ({ ...r, text: r.body, files: JSON.parse(r.files || '[]') })));
});

app.post('/quick-replies', auth, async (c) => {
  const { key_cmd, title, text, files } = await c.req.json();
  if (!key_cmd || !title || !text) return c.json({ error: 'Thiếu thông tin' }, 400);
  const key = key_cmd.startsWith('/') ? key_cmd : '/' + key_cmd;
  const r = await c.env.DB.prepare('INSERT OR REPLACE INTO quick_replies (key_cmd,title,body,files) VALUES (?,?,?,?)')
    .bind(key, title, text, JSON.stringify(files || [])).run();
  return c.json({ id: r.meta.last_row_id });
});

app.delete('/quick-replies/:id', auth, async (c) => {
  await c.env.DB.prepare('DELETE FROM quick_replies WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

// ─── TRACK LINKS ──────────────────────────────────────────────────────────────
app.get('/track-links', auth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT t.*, ch.name as channel_name, ch.icon as channel_icon FROM track_links t LEFT JOIN channels ch ON t.channel_id=ch.id ORDER BY t.created_at DESC'
  ).all();
  return c.json(results);
});

app.post('/track-links', auth, async (c) => {
  const { name, ref_code, channel_id } = await c.req.json();
  if (!name || !ref_code) return c.json({ error: 'Thiếu tên hoặc ref_code' }, 400);
  try {
    const r = await c.env.DB.prepare('INSERT INTO track_links (name,ref_code,channel_id) VALUES (?,?,?)')
      .bind(name, ref_code, channel_id || null).run();
    return c.json({ id: r.meta.last_row_id });
  } catch { return c.json({ error: 'ref_code đã tồn tại' }, 409); }
});

app.delete('/track-links/:id', auth, async (c) => {
  await c.env.DB.prepare('DELETE FROM track_links WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

app.get('/track-links/:id/clicks', auth, async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM track_clicks WHERE link_id = ? ORDER BY created_at DESC LIMIT 200'
  ).bind(c.req.param('id')).all();
  return c.json(results);
});

// ─── REPORTS ──────────────────────────────────────────────────────────────────
app.get('/reports', auth, async (c) => {
  const { from = '1900-01-01', to = '2999-12-31', channel_id } = c.req.query();
  const chFilter = channel_id ? 'AND channel_id = ?' : '';
  const chParam = channel_id ? [Number(channel_id)] : [];

  const overview = await c.env.DB.prepare(`
    SELECT COUNT(*) as total_contacts,
      SUM(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as new_leads,
      SUM(CASE WHEN lifecycle='Đã PAID' AND DATE(created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN lifecycle='Đã PAID' THEN 1 ELSE 0 END) as total_paid
    FROM contacts WHERE 1=1 ${chFilter}
  `).bind(from, to, from, to, ...chParam).first();

  const msgStats = await c.env.DB.prepare(`
    SELECT COUNT(*) as total_messages,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) as incoming,
      SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) as outgoing
    FROM messages WHERE DATE(created_at) BETWEEN ? AND ? ${channel_id ? 'AND channel_id=?' : ''}
  `).bind(from, to, ...chParam).first();

  const { results: byDay } = await c.env.DB.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as new_contacts,
      SUM(CASE WHEN lifecycle='Đã PAID' THEN 1 ELSE 0 END) as paid
    FROM contacts WHERE DATE(created_at) BETWEEN ? AND ? ${chFilter}
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).bind(from, to, ...chParam).all();

  const { results: lifecycle } = await c.env.DB.prepare(`
    SELECT lifecycle, COUNT(*) as count FROM contacts WHERE 1=1 ${chFilter}
    GROUP BY lifecycle ORDER BY count DESC
  `).bind(...chParam).all();

  const { results: byLanguage } = await c.env.DB.prepare(`
    SELECT language_code, COUNT(*) as count FROM contacts
    WHERE language_code IS NOT NULL ${chFilter}
    GROUP BY language_code ORDER BY count DESC LIMIT 15
  `).bind(...chParam).all();

  const { results: byChannel } = await c.env.DB.prepare(`
    SELECT ch.id, ch.name, ch.icon, COUNT(c.id) as total,
      SUM(CASE WHEN c.lifecycle='Đã PAID' THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN DATE(c.created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as new_leads
    FROM contacts c JOIN channels ch ON c.channel_id = ch.id GROUP BY ch.id ORDER BY total DESC
  `).bind(from, to).all();

  const { results: msgByDay } = await c.env.DB.prepare(`
    SELECT DATE(created_at) as date,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) as incoming,
      SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) as outgoing
    FROM messages WHERE DATE(created_at) BETWEEN ? AND ? ${channel_id ? 'AND channel_id=?' : ''}
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).bind(from, to, ...chParam).all();

  return c.json({ overview, msgStats, byDay, lifecycle, byLanguage, byChannel, msgByDay });
});

// ─── ARCHIVE (admin only) ─────────────────────────────────────────────────────
app.get('/archive/messages', auth, adminOnly, async (c) => {
  const { contact_id, search, page = 1 } = c.req.query();
  const params = [];
  let where = 'WHERE 1=1';
  if (contact_id) { where += ' AND a.contact_id = ?'; params.push(Number(contact_id)); }
  if (search) {
    where += ' AND (a.text LIKE ? OR a.sender_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  params.push((Number(page) - 1) * 50);
  const { results: rows } = await c.env.DB.prepare(`
    SELECT a.*, co.first_name, co.last_name, co.username as contact_username,
      ch.name as channel_name, ch.icon as channel_icon
    FROM archived_messages a
    LEFT JOIN contacts co ON a.contact_id = co.id
    LEFT JOIN channels ch ON a.channel_id = ch.id
    ${where} ORDER BY a.deleted_at DESC LIMIT 50 OFFSET ?
  `).bind(...params).all();
  const total = (await c.env.DB.prepare(`SELECT COUNT(*) as c FROM archived_messages a ${where}`)
    .bind(...params.slice(0, -1)).first()).c;
  return c.json({ rows, total });
});

app.delete('/archive/messages/:id', auth, adminOnly, async (c) => {
  await c.env.DB.prepare('DELETE FROM archived_messages WHERE id = ?').bind(c.req.param('id')).run();
  return c.json({ success: true });
});

app.delete('/archive/messages', auth, adminOnly, async (c) => {
  await c.env.DB.prepare('DELETE FROM archived_messages').run();
  return c.json({ success: true });
});

// ─── REACT ────────────────────────────────────────────────────────────────────
app.post('/react', auth, async (c) => {
  const { message_id, emoji } = await c.req.json();
  const msg = await c.env.DB.prepare('SELECT * FROM messages WHERE id = ?').bind(message_id).first();
  if (!msg) return c.json({ error: 'Không tìm thấy' }, 404);
  const user = c.get('user');
  let reactions = {};
  try { reactions = JSON.parse(msg.reactions || '{}'); } catch {}
  if (!reactions[emoji]) reactions[emoji] = [];
  const idx = reactions[emoji].indexOf(user.name);
  if (idx >= 0) reactions[emoji].splice(idx, 1);
  else reactions[emoji].push(user.name);
  if (!reactions[emoji].length) delete reactions[emoji];
  await c.env.DB.prepare('UPDATE messages SET reactions = ? WHERE id = ?')
    .bind(JSON.stringify(reactions), msg.id).run();
  return c.json({ success: true, reactions });
});

// ─── MEDIA PROXY ─────────────────────────────────────────────────────────────
app.get('/media/:channelId/:fileId', async (c) => {
  const ch = await c.env.DB.prepare('SELECT bot_token FROM channels WHERE id = ? AND active=1')
    .bind(c.req.param('channelId')).first();
  if (!ch) return new Response('Channel not found', { status: 404 });
  try {
    const info = await fetch(`https://api.telegram.org/bot${ch.bot_token}/getFile?file_id=${c.req.param('fileId')}`);
    const infoData = await info.json();
    if (!infoData.ok) return new Response('File not found', { status: 404 });
    const fileRes = await fetch(`https://api.telegram.org/file/bot${ch.bot_token}/${infoData.result.file_path}`);
    return new Response(fileRes.body, {
      headers: {
        'Content-Type': fileRes.headers.get('content-type') || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
      }
    });
  } catch (err) { return new Response('Error: ' + err.message, { status: 500 }); }
});

// ─── AVATAR PROXY ─────────────────────────────────────────────────────────────
app.get('/avatar/:contactId', async (c) => {
  const contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(c.req.param('contactId')).first();
  if (!contact) return new Response('Not found', { status: 404 });
  const ch = await c.env.DB.prepare('SELECT bot_token FROM channels WHERE id = ? AND active=1')
    .bind(contact.channel_id).first();
  if (!ch) return new Response('No bot', { status: 404 });
  try {
    const photosRes = await fetch(`https://api.telegram.org/bot${ch.bot_token}/getUserProfilePhotos?user_id=${contact.telegram_id}&limit=1`);
    const photos = await photosRes.json();
    if (!photos.ok || !photos.result?.total_count) return new Response('No avatar', { status: 404 });
    const fileId = photos.result.photos[0][photos.result.photos[0].length - 1].file_id;
    const infoRes = await fetch(`https://api.telegram.org/bot${ch.bot_token}/getFile?file_id=${fileId}`);
    const info = await infoRes.json();
    if (!info.ok) return new Response('File error', { status: 404 });
    const imgRes = await fetch(`https://api.telegram.org/file/bot${ch.bot_token}/${info.result.file_path}`);
    return new Response(imgRes.body, {
      headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600' }
    });
  } catch (err) { return new Response('Error', { status: 500 }); }
});

// ─── IMPORT ───────────────────────────────────────────────────────────────────
app.post('/import/contacts', auth, async (c) => {
  const { channel_id, contacts } = await c.req.json();
  if (!channel_id || !Array.isArray(contacts)) return c.json({ error: 'Thiếu thông tin' }, 400);
  let imported = 0;
  for (const ct of contacts) {
    try {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO contacts (channel_id,telegram_id,username,first_name,last_name,lifecycle,notes) VALUES (?,?,?,?,?,?,?)'
      ).bind(channel_id, ct.telegram_id || ct.id, ct.username || '', ct.first_name || '', ct.last_name || '', ct.lifecycle || 'New Lead', ct.notes || '').run();
      imported++;
    } catch {}
  }
  return c.json({ imported });
});

app.post('/import/messages', auth, async (c) => {
  const { messages } = await c.req.json();
  if (!Array.isArray(messages)) return c.json({ error: 'Thiếu thông tin' }, 400);
  let imported = 0;
  for (const m of messages) {
    try {
      await c.env.DB.prepare(
        'INSERT OR IGNORE INTO messages (contact_id,channel_id,telegram_chat_id,text,direction,sender_name,created_at) VALUES (?,?,?,?,?,?,?)'
      ).bind(m.contact_id, m.channel_id, m.telegram_chat_id || 0, m.text || '', m.direction || 'in', m.sender_name || '', m.created_at || new Date().toISOString()).run();
      imported++;
    } catch {}
  }
  return c.json({ imported });
});

// ─── TELEGRAM WEBHOOK ─────────────────────────────────────────────────────────
app.post('/telegram/webhook/:token', async (c) => {
  const token = c.req.param('token');
  const channel = await c.env.DB.prepare('SELECT * FROM channels WHERE bot_token = ? AND active = 1')
    .bind(token).first();
  if (!channel) return c.json({ ok: false }, 404);

  let update;
  try { update = await c.req.json(); } catch { return c.json({ ok: true }); }

  const msg = update.message || update.edited_message;
  if (!msg?.from) return c.json({ ok: true });

  const from = msg.from;
  const text = msg.text || msg.caption || '';
  const isMedia = !msg.text;

  // Upsert contact
  let contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE channel_id = ? AND telegram_id = ?')
    .bind(channel.id, from.id).first();

  if (!contact) {
    const r = await c.env.DB.prepare(
      'INSERT INTO contacts (channel_id,telegram_id,username,first_name,last_name,language_code,is_premium,last_seen_at) VALUES (?,?,?,?,?,?,?,datetime("now"))'
    ).bind(channel.id, from.id, from.username || '', from.first_name || '', from.last_name || '',
      from.language_code || null, from.is_premium ? 1 : 0).run();
    contact = await c.env.DB.prepare('SELECT * FROM contacts WHERE id = ?').bind(r.meta.last_row_id).first();
  } else {
    await c.env.DB.prepare(
      'UPDATE contacts SET language_code=?, is_premium=?, last_seen_at=datetime("now") WHERE id=?'
    ).bind(from.language_code || contact.language_code, from.is_premium ? 1 : 0, contact.id).run();
    contact = { ...contact, language_code: from.language_code || contact.language_code };
  }

  // Xử lý /start với ref_code (tracking)
  if (msg.text?.startsWith('/start')) {
    const parts = msg.text.split(' ');
    const ref = parts[1]?.trim();
    if (ref) {
      const link = await c.env.DB.prepare('SELECT * FROM track_links WHERE ref_code = ?').bind(ref).first();
      if (link) {
        await c.env.DB.prepare('UPDATE track_links SET click_count = click_count + 1 WHERE id = ?').bind(link.id).run();
        await c.env.DB.prepare(
          'INSERT INTO track_clicks (link_id,contact_id,telegram_id,first_name,username,language_code) VALUES (?,?,?,?,?,?)'
        ).bind(link.id, contact.id, from.id, from.first_name || '', from.username || '', from.language_code || '').run();
      }
    }
  }

  // Xác định loại media và file_id
  let msgType = 'text', fileId = null, msgText = text;
  const mediaGroupId = msg.media_group_id || null;

  if (msg.photo) { msgType = 'photo'; fileId = msg.photo[msg.photo.length - 1]?.file_id; msgText = text || '[photo]'; }
  else if (msg.video) { msgType = 'video'; fileId = msg.video?.file_id; msgText = text || '[video]'; }
  else if (msg.document) { msgType = 'document'; fileId = msg.document?.file_id; msgText = text || '[document]'; }
  else if (msg.voice) { msgType = 'voice'; fileId = msg.voice?.file_id; msgText = '[voice]'; }
  else if (msg.sticker) { msgType = 'sticker'; fileId = msg.sticker?.file_id; msgText = '[sticker]'; }
  else if (msg.animation) { msgType = 'gif'; fileId = msg.animation?.file_id; msgText = '[GIF]'; }

  await c.env.DB.prepare(
    "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,type,file_id,media_group_id,direction,sender_name,bot_token) VALUES (?,?,?,?,?,?,?,?,'in',?,?)"
  ).bind(contact.id, channel.id, from.id, msg.message_id, msgText, msgType, fileId, mediaGroupId,
    from.first_name || from.username || '', token).run();

  await c.env.DB.prepare(
    "UPDATE contacts SET last_message=?,last_message_time=datetime('now'),unread=unread+1,last_seen_at=datetime('now') WHERE id=?"
  ).bind(msgText, contact.id).run();

  // Auto-reply nếu là lệnh quick reply
  if (msg.text?.startsWith('/')) {
    const qr = await c.env.DB.prepare('SELECT * FROM quick_replies WHERE key_cmd = ?').bind(msg.text.split(' ')[0]).first();
    if (qr) {
      await tgCall(token, 'sendMessage', {
        chat_id: from.id,
        text: qr.body,
        reply_parameters: { message_id: msg.message_id }
      });
    }
  }

  return c.json({ ok: true });
});

// ─── SERVE FRONTEND ───────────────────────────────────────────────────────────
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
