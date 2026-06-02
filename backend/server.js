require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { exec } = require('child_process');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Telegraf } = require('telegraf');
const Database = require('better-sqlite3');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json({ limit: '20mb' }));

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const db = new Database('crm.db');
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'sale',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '🤖',
    bot_token TEXT UNIQUE NOT NULL,
    bot_username TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS channel_bots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    bot_token TEXT UNIQUE NOT NULL,
    bot_username TEXT,
    active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(channel_id) REFERENCES channels(id)
  );
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    lifecycle TEXT DEFAULT 'New Lead',
    package TEXT,
    tags TEXT DEFAULT '[]',
    notes TEXT,
    sale TEXT,
    unread INTEGER DEFAULT 0,
    last_message TEXT,
    last_message_time DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(channel_id, telegram_id)
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    channel_id INTEGER NOT NULL,
    telegram_chat_id INTEGER NOT NULL,
    tg_msg_id INTEGER,
    text TEXT,
    direction TEXT NOT NULL,
    sender_name TEXT,
    reactions TEXT DEFAULT '{}',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS quick_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    key_cmd TEXT UNIQUE NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    files TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Archive table
db.exec(`
  CREATE TABLE IF NOT EXISTS archived_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_id INTEGER,
    contact_id INTEGER,
    channel_id INTEGER,
    telegram_chat_id INTEGER,
    tg_msg_id INTEGER,
    text TEXT,
    file_id TEXT,
    media_type TEXT,
    direction TEXT,
    sender_name TEXT,
    reactions TEXT DEFAULT '{}',
    bot_token TEXT,
    media_group_id TEXT,
    deleted_by TEXT,
    deleted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    original_created_at DATETIME
  );
`);

// Tracking tables
db.exec(`
  CREATE TABLE IF NOT EXISTS track_links (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER,
    ref_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS track_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    link_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    language_code TEXT,
    is_premium INTEGER DEFAULT 0,
    first_name TEXT,
    username TEXT,
    is_new_contact INTEGER DEFAULT 1,
    clicked_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// Seed default users
if (db.prepare('SELECT COUNT(*) as c FROM users').get().c === 0) {
  const hash = bcrypt.hashSync('123456', 10);
  for (const [email, name, role] of [
    ['admin@unicorn.com', 'Admin', 'admin'],
    ['sale@unicorn.com', 'Sale', 'sale'],
    ['support@unicorn.com', 'Support', 'support'],
    ['mkt@unicorn.com', 'Marketing', 'mkt'],
  ]) {
    db.prepare('INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, ?)').run(email, hash, name, role);
  }
  console.log('✅ Seeded default users (password: 123456)');
}

// Seed default quick replies
if (db.prepare('SELECT COUNT(*) as c FROM quick_replies').get().c === 0) {
  for (const [key_cmd, title, body, files] of [
    ['/hello', 'Auto Welcome',
      '🔥 Chào mừng bạn đến với Unicorn VIP\n\nBạn đang quan tâm:\n• Futures Signals\n• Copytrade\n• VIP Group\n• AI Trading\n\nReply:\n1️⃣ Futures\n2️⃣ VIP\n3️⃣ Copytrade',
      '["bang-gia-vip.png"]'],
    ['/price', 'Báo giá',
      'Hiện bên mình có 4 gói: Premium, 3 Month, Lifetime và Ultimate. Bạn muốn mình gửi chi tiết gói nào trước?',
      '["bang-gia-vip.png"]'],
    ['/pay', 'Thanh toán',
      'Bạn có thể thanh toán qua USDT hoặc chuyển khoản. Sau khi thanh toán, gửi bill tại đây để mình kích hoạt gói cho bạn.',
      '[]'],
    ['/feedback', 'Feedback khách hàng',
      'Mình gửi bạn một vài feedback khách đã tham gia nhóm để bạn tham khảo trước nhé.',
      '["feedback-01.jpg","feedback-02.jpg"]'],
  ]) {
    db.prepare('INSERT INTO quick_replies (key_cmd, title, body, files) VALUES (?, ?, ?, ?)').run(key_cmd, title, body, files);
  }
}

// ─── AUTH ──────────────────────────────────────────────────────────────────────
const JWT_SECRET = process.env.JWT_SECRET || 'unicorn_crm_secret_2026_change_this';

function verifyToken(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn' });
  }
}

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get((email || '').toLowerCase().trim());
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Sai tài khoản hoặc mật khẩu' });
  }
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '30d' }
  );
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, name: user.name } });
});

// ─── CHANNELS ──────────────────────────────────────────────────────────────────
// Trả về channels kèm danh sách bots
app.get('/channels', verifyToken, (_req, res) => {
  const chs = db.prepare('SELECT id, name, icon, active FROM channels WHERE active = 1 ORDER BY id').all();
  const bots = db.prepare('SELECT * FROM channel_bots WHERE active = 1').all();
  res.json(chs.map(ch => ({
    ...ch,
    bots: bots.filter(b => b.channel_id === ch.id),
    // backward compat: bot_username = tên bot đầu tiên
    bot_username: bots.find(b => b.channel_id === ch.id)?.bot_username || ''
  })));
});

// Tạo channel mới + bot đầu tiên
app.post('/channels', verifyToken, async (req, res) => {
  const { name, icon, bot_token } = req.body;
  if (!name || !bot_token) return res.status(400).json({ error: 'Thiếu tên hoặc bot token' });
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const tgData = await tgRes.json();
    if (!tgData.ok) return res.status(400).json({ error: 'Bot token không hợp lệ: ' + (tgData.description || 'Unauthorized') });
    const username = tgData.result.username;
    // Kiểm tra token chưa dùng
    const existing = db.prepare('SELECT id FROM channel_bots WHERE bot_token = ?').get(bot_token);
    if (existing) return res.status(409).json({ error: 'Bot token này đã được dùng' });
    // Tạo channel
    const r = db.prepare('INSERT INTO channels (name, icon, bot_token, bot_username) VALUES (?, ?, ?, ?)').run(name, icon || '🤖', bot_token, username);
    // Thêm vào channel_bots
    db.prepare('INSERT INTO channel_bots (channel_id, bot_token, bot_username) VALUES (?, ?, ?)').run(r.lastInsertRowid, bot_token, username);
    launchBotToken(r.lastInsertRowid, bot_token, username);
    res.json({ id: r.lastInsertRowid, name, icon: icon || '🤖', bot_username: username, active: 1,
      bots: [{ id: 1, channel_id: r.lastInsertRowid, bot_token, bot_username: username, active: 1 }] });
  } catch (err) {
    res.status(400).json({ error: 'Không thể kết nối Telegram API: ' + err.message });
  }
});

// Cập nhật tên/icon channel
app.patch('/channels/:id', verifyToken, (req, res) => {
  const { name, icon } = req.body;
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND active = 1').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Không tìm thấy channel' });
  const sets = [], vals = [];
  if (name) { sets.push('name = ?'); vals.push(name); }
  if (icon) { sets.push('icon = ?'); vals.push(icon); }
  if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  vals.push(ch.id);
  db.prepare(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ success: true, id: ch.id, name: name || ch.name, icon: icon || ch.icon });
});

// Thêm bot vào channel đã có
app.post('/channels/:id/bots', verifyToken, async (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ? AND active = 1').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Không tìm thấy channel' });
  const { bot_token } = req.body;
  if (!bot_token) return res.status(400).json({ error: 'Thiếu bot_token' });
  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${bot_token}/getMe`);
    const tgData = await tgRes.json();
    if (!tgData.ok) return res.status(400).json({ error: 'Bot token không hợp lệ: ' + tgData.description });
    const username = tgData.result.username;
    const existing = db.prepare('SELECT id, channel_id FROM channel_bots WHERE bot_token = ?').get(bot_token);
    if (existing) return res.status(409).json({ error: 'Bot token này đã được dùng ở channel #' + existing.channel_id });
    const r = db.prepare('INSERT INTO channel_bots (channel_id, bot_token, bot_username) VALUES (?, ?, ?)').run(ch.id, bot_token, username);
    launchBotToken(ch.id, bot_token, username);
    res.json({ id: r.lastInsertRowid, channel_id: ch.id, bot_token, bot_username: username, active: 1 });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Xóa bot khỏi channel
app.delete('/channels/:id/bots/:botId', verifyToken, (req, res) => {
  const bot = db.prepare('SELECT * FROM channel_bots WHERE id = ? AND channel_id = ?').get(req.params.botId, req.params.id);
  if (!bot) return res.status(404).json({ error: 'Không tìm thấy bot' });
  const remaining = db.prepare('SELECT COUNT(*) as c FROM channel_bots WHERE channel_id = ? AND active = 1').get(req.params.id).c;
  if (remaining <= 1) return res.status(400).json({ error: 'Channel phải có ít nhất 1 bot' });
  if (activeBots[bot.bot_token]) { activeBots[bot.bot_token].stop('remove'); delete activeBots[bot.bot_token]; }
  db.prepare('UPDATE channel_bots SET active = 0 WHERE id = ?').run(bot.id);
  res.json({ success: true });
});

// Xóa toàn bộ channel
app.delete('/channels/:id', verifyToken, (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id = ?').get(req.params.id);
  if (!ch) return res.status(404).json({ error: 'Không tìm thấy channel' });
  // Stop tất cả bots của channel này
  db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1').all(ch.id).forEach(b => {
    if (activeBots[b.bot_token]) { activeBots[b.bot_token].stop('delete'); delete activeBots[b.bot_token]; }
  });
  db.prepare('UPDATE channel_bots SET active = 0 WHERE channel_id = ?').run(ch.id);
  db.prepare('UPDATE channels SET active = 0 WHERE id = ?').run(ch.id);
  res.json({ success: true });
});

// ─── CONVERSATIONS ─────────────────────────────────────────────────────────────
app.get('/conversations', verifyToken, (req, res) => {
  const { channel_id, lifecycle, search, unreplied, page = 1 } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (channel_id) { where += ' AND c.channel_id = ?'; params.push(Number(channel_id)); }
  if (lifecycle && lifecycle !== 'all') { where += ' AND c.lifecycle = ?'; params.push(lifecycle); }
  if (search) {
    where += ' AND (c.username LIKE ? OR c.first_name LIKE ? OR c.last_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (unreplied === '1') { where += ' AND c.unread > 0'; }
  params.push((Number(page) - 1) * 50);
  const rows = db.prepare(
    `SELECT c.*, ch.name as channel_name, ch.icon as channel_icon
     FROM contacts c
     LEFT JOIN channels ch ON c.channel_id = ch.id
     ${where}
     ORDER BY c.last_message_time DESC LIMIT 50 OFFSET ?`
  ).all(...params);
  res.json(rows);
});

app.get('/conversations/:id/messages', verifyToken, (req, res) => {
  res.json(db.prepare('SELECT * FROM messages WHERE contact_id = ? ORDER BY created_at ASC LIMIT 200').all(req.params.id));
});

app.patch('/conversations/:id', verifyToken, (req, res) => {
  const { lifecycle, package: pkg, notes, sale, tags } = req.body;
  const sets = [], vals = [];
  if (lifecycle !== undefined) { sets.push('lifecycle = ?'); vals.push(lifecycle); }
  if (pkg !== undefined) { sets.push('package = ?'); vals.push(pkg); }
  if (notes !== undefined) { sets.push('notes = ?'); vals.push(notes); }
  if (sale !== undefined) { sets.push('sale = ?'); vals.push(sale); }
  if (tags !== undefined) { sets.push('tags = ?'); vals.push(JSON.stringify(tags)); }
  if (!sets.length) return res.status(400).json({ error: 'Không có gì để cập nhật' });
  vals.push(req.params.id);
  db.prepare(`UPDATE contacts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  res.json({ success: true });
});

app.post('/conversations/:id/read', verifyToken, (req, res) => {
  db.prepare('UPDATE contacts SET unread = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ─── HELPER: lấy bot instance để reply cho một contact ────────────────────────
function getBotForContact(contact) {
  // Ưu tiên bot mà contact đã nhắn vào
  if (contact.bot_token && activeBots[contact.bot_token])
    return { bot: activeBots[contact.bot_token], token: contact.bot_token };
  // Fallback: bất kỳ bot nào của channel
  const anyBot = db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(contact.channel_id);
  if (anyBot && activeBots[anyBot.bot_token])
    return { bot: activeBots[anyBot.bot_token], token: anyBot.bot_token };
  return null;
}

// ─── REPLY ─────────────────────────────────────────────────────────────────────
app.post('/reply', verifyToken, async (req, res) => {
  const { contact_id, text, reply_to_msg_id, button_label, button_url } = req.body;
  if (!contact_id || !text?.trim()) return res.status(400).json({ error: 'Thiếu contact_id hoặc nội dung' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Không tìm thấy contact' });
  const botInfo = getBotForContact(contact);
  if (!botInfo) return res.status(503).json({ error: 'Bot channel này chưa được kết nối' });
  const { bot, token: usedToken } = botInfo;
  try {
    // Nếu có reply_to_msg_id (DB id), tìm tg_msg_id tương ứng
    let replyOptions = {};
    if (reply_to_msg_id) {
      const refMsg = db.prepare('SELECT tg_msg_id FROM messages WHERE id = ?').get(reply_to_msg_id);
      if (refMsg?.tg_msg_id) replyOptions = { reply_parameters: { message_id: refMsg.tg_msg_id } };
    }
    if (button_label && button_url) {
      replyOptions.reply_markup = { inline_keyboard: [[{ text: button_label, url: button_url }]] };
    }
    const tgMsg = await bot.telegram.sendMessage(contact.telegram_id, text, replyOptions);
    const r = db.prepare(
      "INSERT INTO messages (contact_id, channel_id, telegram_chat_id, tg_msg_id, text, direction, sender_name, bot_token) VALUES (?, ?, ?, ?, ?, 'out', ?, ?)"
    ).run(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, text, req.user.name, usedToken);
    db.prepare('UPDATE contacts SET last_message = ?, last_message_time = CURRENT_TIMESTAMP WHERE id = ?').run(text, contact.id);
    const msg = {
      id: r.lastInsertRowid, contact_id: contact.id, channel_id: contact.channel_id,
      text, direction: 'out', sender_name: req.user.name, created_at: new Date().toISOString()
    };
    io.emit('new_message', { contactId: contact.id, channelId: contact.channel_id, message: msg });
    res.json({ success: true, message: msg });
  } catch (err) {
    if (err.message?.includes('bot was blocked by the user')) {
      db.prepare("UPDATE contacts SET lifecycle = 'Blocked', notes = COALESCE(NULLIF(notes,''), '') || '\n[Bot bị chặn]' WHERE id = ?").run(contact.id);
      return res.status(403).json({ error: 'Khách hàng đã chặn bot. Liên hệ qua kênh khác.', blocked: true });
    }
    if (err.message?.includes('chat not found')) {
      return res.status(400).json({ error: 'Khách hàng chưa bắt đầu chat với bot này. Họ cần nhắn tin vào bot trước.', chat_not_found: true });
    }
    res.status(500).json({ error: err.message });
  }
});

// ─── MEDIA PROXY (không cần auth để hiện ảnh trong <img src>) ─────────────────
app.get('/media/:channelId/:fileId', async (req, res) => {
  const botRow = db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(req.params.channelId);
  if (!botRow) return res.status(404).send('Channel not found');
  const token = botRow.bot_token;
  try {
    const infoRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${req.params.fileId}`);
    const info = await infoRes.json();
    if (!info.ok) return res.status(404).send('File not found');
    const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${info.result.file_path}`);
    const ct = fileRes.headers.get('content-type') || 'image/jpeg';
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    const buf = await fileRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch (err) { res.status(500).send('Error: ' + err.message); }
});

// ─── REPLY WITH PHOTO ──────────────────────────────────────────────────────────
app.post('/reply-photo', verifyToken, async (req, res) => {
  const { contact_id, base64, mime_type } = req.body;
  if (!contact_id || !base64) return res.status(400).json({ error: 'Thiếu thông tin' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Không tìm thấy contact' });
  const botInfo = getBotForContact(contact);
  if (!botInfo) return res.status(503).json({ error: 'Bot chưa kết nối' });
  const { bot, token: usedToken } = botInfo;
  try {
    const buffer = Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
    const isImage = !mime_type || mime_type.startsWith('image/');
    let tgMsg;
    if (isImage) {
      tgMsg = await bot.telegram.sendPhoto(contact.telegram_id, { source: buffer });
    } else {
      tgMsg = await bot.telegram.sendDocument(contact.telegram_id, { source: buffer });
    }
    const sentFileId = isImage
      ? (tgMsg.photo?.[tgMsg.photo.length - 1]?.file_id || null)
      : (tgMsg.document?.file_id || null);
    const mType = isImage ? 'photo' : 'document';
    const r = db.prepare(
      "INSERT INTO messages (contact_id, channel_id, telegram_chat_id, tg_msg_id, text, file_id, media_type, direction, sender_name, bot_token) VALUES (?, ?, ?, ?, '[photo]', ?, ?, 'out', ?, ?)"
    ).run(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, sentFileId, mType, req.user.name, usedToken);
    db.prepare('UPDATE contacts SET last_message = ?, last_message_time = CURRENT_TIMESTAMP WHERE id = ?').run('[photo]', contact.id);
    const msg = {
      id: r.lastInsertRowid, contact_id: contact.id, channel_id: contact.channel_id,
      text: '[photo]', file_id: sentFileId, media_type: mType,
      direction: 'out', sender_name: req.user.name, created_at: new Date().toISOString()
    };
    io.emit('new_message', { contactId: contact.id, channelId: contact.channel_id, message: msg });
    res.json({ success: true, message: msg });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EDIT MESSAGE ──────────────────────────────────────────────────────────────
app.patch('/messages/:id/text', verifyToken, async (req, res) => {
  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Thiếu nội dung' });
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
  if (msg.direction !== 'out') return res.status(400).json({ error: 'Chỉ sửa được tin nhắn đã gửi đi' });

  let tgError = null;
  if (msg.tg_msg_id) {
    const botToken = msg.bot_token
      || db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(msg.channel_id)?.bot_token;
    if (botToken) {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: msg.telegram_chat_id, message_id: msg.tg_msg_id, text })
        });
        const data = await tgRes.json();
        if (!data.ok) tgError = data.description;
      } catch (err) { tgError = err.message; }
    }
  }

  db.prepare('UPDATE messages SET text = ? WHERE id = ?').run(text.trim(), msg.id);
  res.json({ success: true, text: text.trim(), tg_error: tgError });
});

// ─── DELETE MESSAGE ────────────────────────────────────────────────────────────
app.delete('/messages/:id', verifyToken, async (req, res) => {
  const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });

  console.log(`[DELETE] msg#${msg.id} tg_msg_id=${msg.tg_msg_id} chat=${msg.telegram_chat_id} bot=${msg.bot_token}`);

  let tgError = null;
  if (msg.tg_msg_id) {
    const botToken = msg.bot_token
      || db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(msg.channel_id)?.bot_token;
    if (botToken) {
      try {
        const tgRes = await fetch(`https://api.telegram.org/bot${botToken}/deleteMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: msg.telegram_chat_id, message_id: msg.tg_msg_id })
        });
        const data = await tgRes.json();
        console.log(`[DELETE] Telegram response:`, JSON.stringify(data));
        if (!data.ok) tgError = data.description;
      } catch (err) {
        tgError = err.message;
        console.log(`[DELETE] Telegram fetch error:`, err.message);
      }
    } else {
      console.log(`[DELETE] Không tìm được bot token`);
    }
  } else {
    console.log(`[DELETE] Bỏ qua Telegram vì tg_msg_id = null`);
  }

  // Lưu vào archive trước khi xóa
  db.prepare(`INSERT INTO archived_messages
    (original_id,contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,reactions,bot_token,media_group_id,deleted_by,original_created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(msg.id, msg.contact_id, msg.channel_id, msg.telegram_chat_id, msg.tg_msg_id,
    msg.text, msg.file_id, msg.media_type, msg.direction, msg.sender_name,
    msg.reactions, msg.bot_token, msg.media_group_id, req.user.name, msg.created_at);

  db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  res.json({ success: true, tg_error: tgError });
});

// ─── REPLY PHOTOS (album / single) ────────────────────────────────────────────
app.post('/reply-photos', verifyToken, async (req, res) => {
  const { contact_id, images } = req.body;
  if (!contact_id || !Array.isArray(images) || !images.length)
    return res.status(400).json({ error: 'Thiếu thông tin' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Không tìm thấy contact' });
  const botInfo = getBotForContact(contact);
  if (!botInfo) return res.status(503).json({ error: 'Bot chưa kết nối' });
  const { bot, token: usedToken } = botInfo;

  try {
    const savedMsgs = [];
    const groupId = images.length > 1 ? `grp_${Date.now()}` : null;

    if (images.length === 1) {
      const buf = Buffer.from(images[0].base64.replace(/^data:[^;]+;base64,/, ''), 'base64');
      const tgMsg = await bot.telegram.sendPhoto(contact.telegram_id, { source: buf });
      const fileId = tgMsg.photo?.[tgMsg.photo.length - 1]?.file_id || null;
      const r = db.prepare(
        "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token) VALUES (?,?,?,?,'[photo]',?,'photo','out',?,?)"
      ).run(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, fileId, req.user.name, usedToken);
      savedMsgs.push({ id: r.lastInsertRowid, tg_msg_id: tgMsg.message_id, file_id: fileId, media_type: 'photo', channel_id: contact.channel_id });
    } else {
      const mediaItems = images.map(img => ({
        type: 'photo',
        media: { source: Buffer.from(img.base64.replace(/^data:[^;]+;base64,/, ''), 'base64') }
      }));
      const tgMsgs = await bot.telegram.sendMediaGroup(contact.telegram_id, mediaItems);
      for (const tgMsg of tgMsgs) {
        const fileId = tgMsg.photo?.[tgMsg.photo.length - 1]?.file_id || null;
        const r = db.prepare(
          "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token,media_group_id) VALUES (?,?,?,?,'[photo]',?,'photo','out',?,?,?)"
        ).run(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, fileId, req.user.name, usedToken, groupId);
        savedMsgs.push({ id: r.lastInsertRowid, tg_msg_id: tgMsg.message_id, file_id: fileId, media_type: 'photo', channel_id: contact.channel_id, media_group_id: groupId });
      }
    }

    db.prepare('UPDATE contacts SET last_message=?,last_message_time=CURRENT_TIMESTAMP WHERE id=?').run('[photo]', contact.id);
    const baseMsg = { contact_id: contact.id, channel_id: contact.channel_id, direction: 'out', sender_name: req.user.name, created_at: new Date().toISOString() };
    savedMsgs.forEach(m => io.emit('new_message', { contactId: contact.id, channelId: contact.channel_id, message: { ...baseMsg, ...m } }));
    res.json({ success: true, messages: savedMsgs, media_group_id: groupId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REPORTS ───────────────────────────────────────────────────────────────────
app.get('/reports', verifyToken, (req, res) => {
  const { from = '1900-01-01', to = '2999-12-31', channel_id } = req.query;
  const chFilter = channel_id ? 'AND channel_id = ?' : '';
  const params = channel_id ? [from, to, Number(channel_id)] : [from, to];

  // Tổng quan
  const overview = db.prepare(`
    SELECT
      COUNT(*) as total_contacts,
      SUM(CASE WHEN DATE(created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as new_leads,
      SUM(CASE WHEN lifecycle='Đã PAID' AND DATE(created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN lifecycle='Đã PAID' THEN 1 ELSE 0 END) as total_paid
    FROM contacts WHERE 1=1 ${chFilter}
  `).get(from, to, from, to, ...(channel_id ? [Number(channel_id)] : []));

  // Tin nhắn trong kỳ
  const msgStats = db.prepare(`
    SELECT
      COUNT(*) as total_messages,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) as incoming,
      SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) as outgoing
    FROM messages WHERE DATE(created_at) BETWEEN ? AND ? ${channel_id ? 'AND channel_id=?' : ''}
  `).get(from, to, ...(channel_id ? [Number(channel_id)] : []));

  // Contacts theo ngày
  const byDay = db.prepare(`
    SELECT DATE(created_at) as date, COUNT(*) as new_contacts,
      SUM(CASE WHEN lifecycle='Đã PAID' THEN 1 ELSE 0 END) as paid
    FROM contacts WHERE DATE(created_at) BETWEEN ? AND ? ${chFilter}
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).all(...params);

  // Lifecycle funnel
  const lifecycle = db.prepare(`
    SELECT lifecycle, COUNT(*) as count FROM contacts
    WHERE 1=1 ${chFilter} GROUP BY lifecycle ORDER BY count DESC
  `).all(...(channel_id ? [Number(channel_id)] : []));

  // Phân bổ theo ngôn ngữ → quốc gia
  const byLanguage = db.prepare(`
    SELECT language_code, COUNT(*) as count
    FROM contacts WHERE language_code IS NOT NULL ${chFilter}
    GROUP BY language_code ORDER BY count DESC LIMIT 15
  `).all(...(channel_id ? [Number(channel_id)] : []));

  // Top channel
  const byChannel = db.prepare(`
    SELECT ch.id, ch.name, ch.icon,
      COUNT(c.id) as total,
      SUM(CASE WHEN c.lifecycle='Đã PAID' THEN 1 ELSE 0 END) as paid,
      SUM(CASE WHEN DATE(c.created_at) BETWEEN ? AND ? THEN 1 ELSE 0 END) as new_leads
    FROM contacts c JOIN channels ch ON c.channel_id = ch.id
    GROUP BY ch.id ORDER BY total DESC
  `).all(from, to);

  // Tin nhắn theo ngày
  const msgByDay = db.prepare(`
    SELECT DATE(created_at) as date,
      SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) as incoming,
      SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) as outgoing
    FROM messages WHERE DATE(created_at) BETWEEN ? AND ? ${channel_id ? 'AND channel_id=?' : ''}
    GROUP BY DATE(created_at) ORDER BY date ASC
  `).all(from, to, ...(channel_id ? [Number(channel_id)] : []));

  res.json({ overview, msgStats, byDay, lifecycle, byLanguage, byChannel, msgByDay });
});

// ─── ARCHIVED MESSAGES (admin only) ───────────────────────────────────────────
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin mới xem được' });
  next();
}

app.get('/archive/messages', verifyToken, adminOnly, (req, res) => {
  const { contact_id, search, page = 1 } = req.query;
  const params = [];
  let where = 'WHERE 1=1';
  if (contact_id) { where += ' AND a.contact_id = ?'; params.push(Number(contact_id)); }
  if (search) {
    where += ' AND (a.text LIKE ? OR a.sender_name LIKE ?)';
    params.push(`%${search}%`, `%${search}%`);
  }
  params.push((Number(page) - 1) * 50);
  const rows = db.prepare(`
    SELECT a.*,
      co.first_name, co.last_name, co.username as contact_username,
      ch.name as channel_name, ch.icon as channel_icon
    FROM archived_messages a
    LEFT JOIN contacts co ON a.contact_id = co.id
    LEFT JOIN channels ch ON a.channel_id = ch.id
    ${where}
    ORDER BY a.deleted_at DESC LIMIT 50 OFFSET ?
  `).all(...params);
  const total = db.prepare(`SELECT COUNT(*) as c FROM archived_messages a ${where.replace(/LIMIT.*$/,'')}`)
    .get(...params.slice(0, -1)).c;
  res.json({ rows, total });
});

app.delete('/archive/messages/:id', verifyToken, adminOnly, (req, res) => {
  db.prepare('DELETE FROM archived_messages WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/archive/messages', verifyToken, adminOnly, (req, res) => {
  db.prepare('DELETE FROM archived_messages').run();
  res.json({ success: true });
});

// ─── TRACKING ──────────────────────────────────────────────────────────────────
app.get('/track-links', verifyToken, (_req, res) => {
  const links = db.prepare(`
    SELECT tl.*,
      COUNT(tc.id) as total_clicks,
      COUNT(DISTINCT tc.telegram_id) as unique_clicks,
      SUM(tc.is_new_contact) as new_contacts
    FROM track_links tl
    LEFT JOIN track_clicks tc ON tc.link_id = tl.id
    GROUP BY tl.id ORDER BY tl.created_at DESC
  `).all();
  res.json(links);
});

app.post('/track-links', verifyToken, (req, res) => {
  const { name, channel_id, ref_code } = req.body;
  if (!name || !ref_code) return res.status(400).json({ error: 'Thiếu tên hoặc ref code' });
  const clean = ref_code.replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return res.status(400).json({ error: 'Ref code chỉ dùng chữ, số, gạch dưới' });
  try {
    const r = db.prepare('INSERT INTO track_links (name, channel_id, ref_code) VALUES (?,?,?)').run(name, channel_id || null, clean);
    res.json({ id: r.lastInsertRowid, name, channel_id, ref_code: clean, total_clicks: 0, unique_clicks: 0, new_contacts: 0 });
  } catch { res.status(409).json({ error: 'Ref code đã tồn tại' }); }
});

app.delete('/track-links/:id', verifyToken, (req, res) => {
  db.prepare('DELETE FROM track_clicks WHERE link_id = ?').run(req.params.id);
  db.prepare('DELETE FROM track_links WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.get('/track-links/:id/clicks', verifyToken, (req, res) => {
  const clicks = db.prepare(`
    SELECT language_code, COUNT(*) as count,
      SUM(is_new_contact) as new_contacts,
      SUM(is_premium) as premium_count
    FROM track_clicks WHERE link_id = ?
    GROUP BY language_code ORDER BY count DESC
  `).all(req.params.id);
  const recent = db.prepare('SELECT * FROM track_clicks WHERE link_id = ? ORDER BY clicked_at DESC LIMIT 20').all(req.params.id);
  res.json({ by_language: clicks, recent });
});

// ─── STICKERS ──────────────────────────────────────────────────────────────────
app.get('/sticker-set/:name', verifyToken, async (req, res) => {
  const contact = db.prepare('SELECT channel_id FROM contacts LIMIT 1').get();
  const botRow = db.prepare('SELECT bot_token FROM channel_bots WHERE active = 1 LIMIT 1').get();
  if (!botRow) return res.status(503).json({ error: 'Chưa có bot nào' });
  try {
    const r = await fetch(`https://api.telegram.org/bot${botRow.bot_token}/getStickerSet?name=${encodeURIComponent(req.params.name)}`);
    const d = await r.json();
    if (!d.ok) return res.status(404).json({ error: d.description || 'Không tìm thấy bộ sticker' });
    res.json({
      name: d.result.name,
      title: d.result.title,
      stickers: d.result.stickers.map(s => ({
        file_id: s.file_id,
        thumb_file_id: s.thumbnail?.file_id || s.file_id,
        emoji: s.emoji
      }))
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/reply-sticker', verifyToken, async (req, res) => {
  const { contact_id, file_id } = req.body;
  if (!contact_id || !file_id) return res.status(400).json({ error: 'Thiếu thông tin' });
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(contact_id);
  if (!contact) return res.status(404).json({ error: 'Không tìm thấy contact' });
  const botInfo = getBotForContact(contact);
  if (!botInfo) return res.status(503).json({ error: 'Bot chưa kết nối' });
  const { bot, token: usedToken } = botInfo;
  try {
    const tgMsg = await bot.telegram.sendSticker(contact.telegram_id, file_id);
    const r = db.prepare(
      "INSERT INTO messages (contact_id,channel_id,telegram_chat_id,tg_msg_id,text,file_id,media_type,direction,sender_name,bot_token) VALUES (?,?,?,?,'[sticker]',?,'sticker','out',?,?)"
    ).run(contact.id, contact.channel_id, contact.telegram_id, tgMsg.message_id, file_id, req.user.name, usedToken);
    db.prepare('UPDATE contacts SET last_message=?,last_message_time=CURRENT_TIMESTAMP WHERE id=?').run('[sticker]', contact.id);
    const msg = { id: r.lastInsertRowid, contact_id: contact.id, channel_id: contact.channel_id, text: '[sticker]', file_id, media_type: 'sticker', direction: 'out', sender_name: req.user.name, created_at: new Date().toISOString() };
    io.emit('new_message', { contactId: contact.id, channelId: contact.channel_id, message: msg });
    res.json({ success: true, message: msg });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── QUICK REPLIES ─────────────────────────────────────────────────────────────
app.get('/quick-replies', verifyToken, (_req, res) => {
  const rows = db.prepare('SELECT * FROM quick_replies ORDER BY key_cmd').all();
  res.json(rows.map(r => ({ ...r, text: r.body, files: JSON.parse(r.files || '[]') })));
});

app.post('/quick-replies', verifyToken, (req, res) => {
  const { key_cmd, title, text, files } = req.body;
  if (!key_cmd || !title || !text) return res.status(400).json({ error: 'Thiếu thông tin' });
  const key = key_cmd.startsWith('/') ? key_cmd : '/' + key_cmd;
  const r = db.prepare('INSERT OR REPLACE INTO quick_replies (key_cmd, title, body, files) VALUES (?, ?, ?, ?)').run(key, title, text, JSON.stringify(files || []));
  res.json({ id: r.lastInsertRowid });
});

app.delete('/quick-replies/:id', verifyToken, (req, res) => {
  db.prepare('DELETE FROM quick_replies WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Migrate: thêm cột mới vào bảng cũ nếu chưa có
try { db.exec('ALTER TABLE messages ADD COLUMN tg_msg_id INTEGER'); } catch {}
try { db.exec("ALTER TABLE messages ADD COLUMN reactions TEXT DEFAULT '{}'"); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN file_id TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_type TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN bot_token TEXT'); } catch {}
try { db.exec('ALTER TABLE messages ADD COLUMN media_group_id TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN last_seen_at DATETIME'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN language_code TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN is_premium INTEGER DEFAULT 0'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN phone TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN avatar_updated_at DATETIME'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN bot_token TEXT'); } catch {}
try { db.exec('ALTER TABLE contacts ADD COLUMN avatar_file_id TEXT'); } catch {}

// Migrate: copy bot tokens từ channels sang channel_bots nếu chưa có
db.prepare('SELECT * FROM channels WHERE active=1').all().forEach(ch => {
  try {
    db.prepare('INSERT OR IGNORE INTO channel_bots (channel_id, bot_token, bot_username) VALUES (?,?,?)')
      .run(ch.id, ch.bot_token, ch.bot_username);
  } catch {}
});

// ─── REACT ─────────────────────────────────────────────────────────────────────
app.post('/react', verifyToken, async (req, res) => {
  const { message_id, emoji } = req.body;
  if (!message_id || !emoji) return res.status(400).json({ error: 'Thiếu thông tin' });

  const row = db.prepare(`
    SELECT m.*, ch.bot_token
    FROM messages m
    JOIN contacts co ON m.contact_id = co.id
    JOIN channels ch ON m.channel_id = ch.id
    WHERE m.id = ?
  `).get(message_id);

  if (!row) return res.status(404).json({ error: 'Không tìm thấy tin nhắn' });
  if (!row.tg_msg_id) return res.status(400).json({ error: 'Tin nhắn này không có Telegram ID (tin cũ trước khi cập nhật)' });

  try {
    const reactions = JSON.parse(row.reactions || '{}');

    // Kiểm tra Bot đã react emoji này chưa (để toggle)
    const alreadyReacted = reactions[emoji]?.includes('Bot');

    // Xóa 'Bot' khỏi TẤT CẢ emoji cũ (Telegram chỉ cho 1 reaction/người)
    Object.keys(reactions).forEach(e => {
      reactions[e] = reactions[e].filter(n => n !== 'Bot');
      if (!reactions[e].length) delete reactions[e];
    });

    // Toggle: nếu chưa react thì thêm, đã react rồi thì bỏ
    const newReaction = alreadyReacted ? [] : [{ type: 'emoji', emoji }];
    if (!alreadyReacted) {
      if (!reactions[emoji]) reactions[emoji] = [];
      reactions[emoji].push('Bot');
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${row.bot_token}/setMessageReaction`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: row.telegram_chat_id, message_id: row.tg_msg_id, reaction: newReaction })
    });
    const data = await tgRes.json();
    if (!tgRes.ok) return res.status(400).json({ error: data.description || 'Telegram error' });

    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), row.id);
    io.emit('msg_reaction', { contactId: row.contact_id, messageId: row.id, reactions });
    res.json({ success: true, reactions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BOTS ──────────────────────────────────────────────────────────────────────
const activeBots = {}; // key = bot_token

function launchBotToken(channelId, token, username) {
  if (activeBots[token]) return;
  const bot = new Telegraf(token);

  // Xử lý /start với ref code để tracking
  bot.command('start', (ctx) => {
    const from = ctx.from;
    const payload = ctx.message.text?.split(' ')[1] || '';
    if (payload) {
      const link = db.prepare('SELECT * FROM track_links WHERE ref_code = ?').get(payload);
      if (link) {
        const isNew = !db.prepare('SELECT id FROM contacts WHERE channel_id=? AND telegram_id=?').get(channelId, from.id);
        db.prepare('INSERT INTO track_clicks (link_id, telegram_id, language_code, is_premium, first_name, username, is_new_contact) VALUES (?,?,?,?,?,?,?)')
          .run(link.id, from.id, from.language_code || null, from.is_premium ? 1 : 0, from.first_name || '', from.username || '', isNew ? 1 : 0);
        console.log(`[TRACK] @${username} ref="${payload}" from ${from.first_name} (${from.language_code})`);
      }
    }
  });

  bot.on('message', (ctx) => {
    const from = ctx.from;

    // Extract text / media
    let text = '[media]';
    let fileId = null;
    let mediaType = null;
    if (ctx.message.text) {
      text = ctx.message.text;
    } else if (ctx.message.photo) {
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      fileId = photo.file_id;
      mediaType = 'photo';
      text = ctx.message.caption || '[photo]';
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
      mediaType = 'document';
      text = '[file:' + (ctx.message.document.file_name || 'document') + ']';
    } else if (ctx.message.video) {
      fileId = ctx.message.video.file_id;
      mediaType = 'video';
      text = ctx.message.caption || '[video]';
    } else if (ctx.message.sticker) {
      fileId = ctx.message.sticker.file_id;
      mediaType = 'sticker';
      text = '[sticker]';
    } else if (ctx.message.voice) {
      fileId = ctx.message.voice.file_id;
      mediaType = 'voice';
      text = '[voice]';
    } else if (ctx.message.animation) {
      fileId = ctx.message.animation.file_id;
      mediaType = 'gif';
      text = '[gif]';
    }

    let contact = db.prepare('SELECT * FROM contacts WHERE channel_id = ? AND telegram_id = ?').get(channelId, from.id);
    if (!contact) {
      const r = db.prepare(
        'INSERT INTO contacts (channel_id, telegram_id, username, first_name, last_name, bot_token, language_code, is_premium) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(channelId, from.id, from.username, from.first_name, from.last_name, token,
        from.language_code || null, from.is_premium ? 1 : 0);
      contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(r.lastInsertRowid);
    } else {
      // Cập nhật thông tin mới nhất mỗi lần khách nhắn
      db.prepare(`UPDATE contacts SET
        bot_token   = COALESCE(bot_token, ?),
        username    = COALESCE(NULLIF(?, ''), username),
        first_name  = COALESCE(NULLIF(?, ''), first_name),
        last_name   = COALESCE(NULLIF(?, ''), last_name),
        language_code = COALESCE(NULLIF(?, ''), language_code),
        is_premium  = ?
        WHERE id = ?`
      ).run(token, from.username, from.first_name, from.last_name,
        from.language_code || null, from.is_premium ? 1 : 0, contact.id);
      contact.bot_token = contact.bot_token || token;
    }

    // Fetch avatar nếu chưa có (non-blocking)
    if (!contact.avatar_file_id) {
      bot.telegram.getUserProfilePhotos(from.id, { limit: 1 }).then(res => {
        if (res?.total_count > 0) {
          const fid = res.photos[0][0].file_id;
          db.prepare('UPDATE contacts SET avatar_file_id = ?, avatar_updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(fid, contact.id);
        }
      }).catch(() => {});
    }

    const msgR = db.prepare(
      "INSERT INTO messages (contact_id, channel_id, telegram_chat_id, tg_msg_id, text, file_id, media_type, direction, sender_name) VALUES (?, ?, ?, ?, ?, ?, ?, 'in', ?)"
    ).run(contact.id, channelId, from.id, ctx.message.message_id, text, fileId, mediaType, from.first_name || from.username || '');

    db.prepare('UPDATE contacts SET last_message = ?, last_message_time = CURRENT_TIMESTAMP, unread = unread + 1, last_seen_at = CURRENT_TIMESTAMP WHERE id = ?').run(text, contact.id);

    contact = db.prepare(
      'SELECT c.*, ch.name as channel_name, ch.icon as channel_icon FROM contacts c LEFT JOIN channels ch ON c.channel_id = ch.id WHERE c.id = ?'
    ).get(contact.id);

    const message = {
      id: msgR.lastInsertRowid, contact_id: contact.id, channel_id: channelId,
      text, file_id: fileId, media_type: mediaType, direction: 'in',
      sender_name: from.first_name || from.username || '',
      created_at: new Date().toISOString()
    };

    io.emit('new_message', { contactId: contact.id, channelId, message, contact });
    console.log(`[@${username}] ${from.first_name || from.username}: ${text}`);
  });

  // Nhận reaction từ khách
  bot.on('message_reaction', (ctx) => {
    try {
      const r = ctx.update.message_reaction;
      if (!r) return;
      const tgMsgId = r.message_id;
      const userName = r.user?.first_name || r.user?.username || 'User';
      const newReacts = r.new_reaction || [];
      const oldReacts = r.old_reaction || [];

      const msg = db.prepare('SELECT * FROM messages WHERE channel_id = ? AND tg_msg_id = ?').get(channelId, tgMsgId);
      if (!msg) return;

      const reactions = JSON.parse(msg.reactions || '{}');
      oldReacts.forEach(x => {
        if (x.type === 'emoji' && reactions[x.emoji]) {
          reactions[x.emoji] = reactions[x.emoji].filter(n => n !== userName);
          if (!reactions[x.emoji].length) delete reactions[x.emoji];
        }
      });
      newReacts.forEach(x => {
        if (x.type === 'emoji') {
          if (!reactions[x.emoji]) reactions[x.emoji] = [];
          if (!reactions[x.emoji].includes(userName)) reactions[x.emoji].push(userName);
        }
      });

      db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), msg.id);
      io.emit('msg_reaction', { contactId: msg.contact_id, messageId: msg.id, reactions });
      console.log(`[@${username}] Reaction từ ${userName}: ${newReacts.map(x=>x.emoji).join('')}`);
    } catch {}
  });

  bot.launch({ allowedUpdates: ['message', 'message_reaction', 'callback_query'] }).catch(err => console.error(`Bot @${username} error:`, err.message));
  activeBots[token] = bot;
  console.log(`✅ Bot started: @${username} → channel #${channelId}`);
}

// Launch tất cả bots từ channel_bots khi khởi động
db.prepare('SELECT * FROM channel_bots WHERE active = 1').all().forEach(b => launchBotToken(b.channel_id, b.bot_token, b.bot_username));

// ─── SOCKET.IO ─────────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log('🔌 Client connected:', socket.id);
  socket.on('disconnect', () => console.log('❌ Disconnected:', socket.id));
});

// ─── AVATAR PROXY ──────────────────────────────────────────────────────────────
app.get('/avatar/:contactId', async (req, res) => {
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.contactId);
  if (!contact) return res.status(404).end();

  // Lấy file_id: từ DB hoặc fetch mới
  let fid = contact.avatar_file_id;
  if (!fid) {
    const botRow = db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(contact.channel_id);
    if (!botRow) return res.status(404).end();
    try {
      const r = await fetch(`https://api.telegram.org/bot${botRow.bot_token}/getUserProfilePhotos?user_id=${contact.telegram_id}&limit=1`);
      const d = await r.json();
      if (!d.ok || !d.result.total_count) return res.status(404).end();
      fid = d.result.photos[0][0].file_id;
      db.prepare('UPDATE contacts SET avatar_file_id = ? WHERE id = ?').run(fid, contact.id);
    } catch { return res.status(404).end(); }
  }

  // Proxy ảnh từ Telegram
  const botRow = db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(contact.channel_id);
  if (!botRow) return res.status(404).end();
  try {
    const infoRes = await fetch(`https://api.telegram.org/bot${botRow.bot_token}/getFile?file_id=${fid}`);
    const info = await infoRes.json();
    if (!info.ok) { db.prepare('UPDATE contacts SET avatar_file_id = NULL WHERE id = ?').run(contact.id); return res.status(404).end(); }
    const imgRes = await fetch(`https://api.telegram.org/file/bot${botRow.bot_token}/${info.result.file_path}`);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = await imgRes.arrayBuffer();
    res.send(Buffer.from(buf));
  } catch { res.status(500).end(); }
});

// Refresh avatar hàng loạt cho 1 channel
app.post('/contacts/refresh-avatars/:channelId', verifyToken, async (req, res) => {
  const contacts = db.prepare('SELECT id, telegram_id, channel_id FROM contacts WHERE channel_id = ? AND avatar_file_id IS NULL LIMIT 50').all(req.params.channelId);
  const botRow = db.prepare('SELECT bot_token FROM channel_bots WHERE channel_id = ? AND active = 1 LIMIT 1').get(req.params.channelId);
  if (!botRow) return res.json({ refreshed: 0 });
  let refreshed = 0;
  for (const c of contacts) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${botRow.bot_token}/getUserProfilePhotos?user_id=${c.telegram_id}&limit=1`);
      const d = await r.json();
      if (d.ok && d.result.total_count > 0) {
        db.prepare('UPDATE contacts SET avatar_file_id = ? WHERE id = ?').run(d.result.photos[0][0].file_id, c.id);
        refreshed++;
      }
      await new Promise(r => setTimeout(r, 50)); // rate limit
    } catch {}
  }
  res.json({ refreshed, remaining: contacts.length - refreshed });
});

// ─── IMPORT: CONTACTS (bulk) ───────────────────────────────────────────────────
app.post('/import/contacts', verifyToken, (req, res) => {
  const { rows, channel_id } = req.body;
  if (!Array.isArray(rows) || !channel_id) return res.status(400).json({ error: 'Thiếu rows hoặc channel_id' });
  let imported = 0, updated = 0, skipped = 0;
  const upsert = db.prepare(`
    INSERT INTO contacts (channel_id, telegram_id, username, first_name, last_name, lifecycle, tags, notes, sale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id, telegram_id) DO UPDATE SET
      first_name = COALESCE(NULLIF(excluded.first_name,''), first_name),
      last_name  = COALESCE(NULLIF(excluded.last_name,''),  last_name),
      username   = COALESCE(NULLIF(excluded.username,''),   username),
      lifecycle  = COALESCE(NULLIF(excluded.lifecycle,''),  lifecycle),
      tags       = COALESCE(NULLIF(excluded.tags,'[]'),     tags),
      notes      = COALESCE(NULLIF(excluded.notes,''),      notes),
      sale       = COALESCE(NULLIF(excluded.sale,''),       sale)
  `);
  const tx = db.transaction((rows) => {
    for (const r of rows) {
      const tid = Number(r.telegram_id);
      if (!tid) { skipped++; continue; }
      const exists = db.prepare('SELECT id FROM contacts WHERE channel_id=? AND telegram_id=?').get(channel_id, tid);
      upsert.run(channel_id, tid, r.username||'', r.first_name||'', r.last_name||'', r.lifecycle||'New Lead', JSON.stringify(r.tags||[]), r.notes||'', r.sale||'');
      if (exists) updated++; else imported++;
    }
  });
  try { tx(rows); res.json({ imported, updated, skipped }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── IMPORT: MESSAGES (bulk history) ──────────────────────────────────────────
app.post('/import/messages', verifyToken, (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'messages phải là array' });
  let imported = 0, skipped = 0;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO messages (contact_id, channel_id, telegram_chat_id, text, direction, sender_name, created_at)
    VALUES (?,?,?,?,?,?,?)
  `);
  const updContact = db.prepare(`
    UPDATE contacts SET last_message=?, last_message_time=?
    WHERE id=? AND (last_message_time IS NULL OR last_message_time < ?)
  `);
  const tx = db.transaction((msgs) => {
    for (const m of msgs) {
      const tid = Number(m.telegram_id);
      if (!tid || !m.text) { skipped++; continue; }
      const contact = db.prepare('SELECT id, channel_id FROM contacts WHERE telegram_id=?').get(tid);
      if (!contact) { skipped++; continue; }
      const ts = m.created_at || new Date().toISOString();
      const r = ins.run(contact.id, contact.channel_id, tid, m.text, m.direction||'in', m.sender_name||'', ts);
      if (r.changes) { imported++; updContact.run(m.text, ts, contact.id, ts); }
      else skipped++;
    }
  });
  try { tx(messages); res.json({ imported, skipped }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── IMPORT: FLUSH getUpdates (lấy tin nhắn pending từ Telegram) ──────────────
app.post('/import/flush/:channelId', verifyToken, async (req, res) => {
  const ch = db.prepare('SELECT * FROM channels WHERE id=? AND active=1').get(req.params.channelId);
  if (!ch) return res.status(404).json({ error: 'Channel không tồn tại' });
  let offset = 0, total = 0, contacts = 0;
  const ins = db.prepare(`
    INSERT OR IGNORE INTO messages (contact_id, channel_id, telegram_chat_id, tg_msg_id, text, direction, sender_name, created_at)
    VALUES (?,?,?,?,?,?,?,?)
  `);
  try {
    while (true) {
      const r = await fetch(`https://api.telegram.org/bot${ch.bot_token}/getUpdates?offset=${offset}&limit=100&timeout=0`);
      const data = await r.json();
      if (!data.ok || !data.result.length) break;
      for (const upd of data.result) {
        offset = upd.update_id + 1;
        const msg = upd.message;
        if (!msg?.from) continue;
        const from = msg.from;
        const text = msg.text || '[media]';
        let contact = db.prepare('SELECT * FROM contacts WHERE channel_id=? AND telegram_id=?').get(ch.id, from.id);
        if (!contact) {
          const r2 = db.prepare('INSERT INTO contacts (channel_id,telegram_id,username,first_name,last_name) VALUES (?,?,?,?,?)').run(ch.id, from.id, from.username||'', from.first_name||'', from.last_name||'');
          contact = db.prepare('SELECT * FROM contacts WHERE id=?').get(r2.lastInsertRowid);
          contacts++;
        }
        const ts = new Date(msg.date * 1000).toISOString();
        const ri = ins.run(contact.id, ch.id, from.id, msg.message_id, text, 'in', from.first_name||from.username||'', ts);
        if (ri.changes) {
          total++;
          db.prepare('UPDATE contacts SET last_message=?,last_message_time=?,unread=unread+1 WHERE id=?').run(text, ts, contact.id);
        }
      }
      if (data.result.length < 100) break;
    }
    res.json({ messages: total, new_contacts: contacts });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── SERVE FRONTEND ────────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'telegram_sales_crm_demo (2).html'));
});

// ─── START ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

let retried = false;
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !retried) {
    retried = true;
    console.log(`⚠️  Port ${PORT} đang bị chiếm — đang tự kill process cũ...`);
    exec(
      `for /f "tokens=5" %a in ('netstat -aon ^| findstr ":${PORT} "') do taskkill /F /PID %a`,
      { shell: 'cmd.exe' },
      () => {
        setTimeout(() => server.listen(PORT), 1500);
      }
    );
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Unicorn CRM Server running on http://localhost:${PORT}`);
  console.log(`   Bots active: ${db.prepare('SELECT COUNT(*) as c FROM channels WHERE active=1').get().c}`);
  console.log(`   Users: ${db.prepare('SELECT COUNT(*) as c FROM users').get().c}\n`);
});

process.once('SIGINT', () => { Object.values(activeBots).forEach(b => b.stop('SIGINT')); });
process.once('SIGTERM', () => { Object.values(activeBots).forEach(b => b.stop('SIGTERM')); });
