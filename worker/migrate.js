// migrate.js — Xuất dữ liệu từ local crm.db sang D1
// Chạy: node migrate.js
// Sau đó: npx wrangler d1 execute unicorn-crm-db --remote --file=migrate_data.sql

const Database = require('../backend/node_modules/better-sqlite3');
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, '../backend/crm.db');
if (!fs.existsSync(dbPath)) {
  console.error('Không tìm thấy file:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath, { readonly: true });
const lines = [];

function esc(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  return "'" + String(v).replace(/'/g, "''") + "'";
}

function exportTable(table, columns) {
  let rows;
  try {
    rows = db.prepare(`SELECT ${columns.join(',')} FROM ${table}`).all();
  } catch (e) {
    console.log(`  Bỏ qua ${table}: ${e.message}`);
    return 0;
  }
  if (!rows.length) return 0;

  lines.push(`-- ${table} (${rows.length} rows)`);
  for (const row of rows) {
    const vals = columns.map(c => esc(row[c])).join(',');
    lines.push(`INSERT OR IGNORE INTO ${table} (${columns.join(',')}) VALUES (${vals});`);
  }
  lines.push('');
  return rows.length;
}

lines.push('-- Unicorn CRM — Migration từ local SQLite sang D1');
lines.push('-- Tạo bởi migrate.js');
lines.push('');

// Channels
const chCount = exportTable('channels', [
  'id','name','icon','bot_token','bot_username','active','created_at'
]);
console.log(`channels: ${chCount} rows`);

// Contacts
const ctCount = exportTable('contacts', [
  'id','channel_id','telegram_id','username','first_name','last_name',
  'lifecycle','package','tags','notes','sale','unread',
  'last_message','last_message_time','last_seen_at','language_code',
  'is_premium','phone','avatar_updated_at','created_at'
]);
console.log(`contacts: ${ctCount} rows`);

// Messages (giới hạn 5000 tin mới nhất để tránh timeout)
let msgRows;
try {
  msgRows = db.prepare(`
    SELECT id,contact_id,channel_id,telegram_chat_id,text,type,file_id,
           media_type,tg_msg_id,bot_token,media_group_id,direction,
           sender_name,reactions,created_at
    FROM messages
    ORDER BY id DESC LIMIT 5000
  `).all();
} catch (e) {
  // Thử với ít cột hơn nếu schema cũ hơn
  try {
    msgRows = db.prepare(`
      SELECT id,contact_id,channel_id,telegram_chat_id,text,
             tg_msg_id,bot_token,media_group_id,direction,sender_name,created_at
      FROM messages ORDER BY id DESC LIMIT 5000
    `).all();
  } catch (e2) {
    msgRows = [];
  }
}

if (msgRows.length) {
  lines.push(`-- messages (${msgRows.length} rows - 5000 mới nhất)`);
  for (const row of msgRows) {
    const cols = Object.keys(row);
    const vals = cols.map(c => esc(row[c])).join(',');
    lines.push(`INSERT OR IGNORE INTO messages (${cols.join(',')}) VALUES (${vals});`);
  }
  lines.push('');
}
console.log(`messages: ${msgRows.length} rows`);

// Quick Replies
const qrCount = exportTable('quick_replies', [
  'id','key_cmd','title','body','files','created_at'
]);
console.log(`quick_replies: ${qrCount} rows`);

// Track Links
const tlCount = exportTable('track_links', [
  'id','name','ref_code','channel_id','click_count','created_at'
]);
console.log(`track_links: ${tlCount} rows`);

// Track Clicks
const tcCount = exportTable('track_clicks', [
  'id','link_id','contact_id','telegram_id','first_name','username','language_code','created_at'
]);
console.log(`track_clicks: ${tcCount} rows`);

db.close();

const outFile = path.join(__dirname, 'migrate_data.sql');
fs.writeFileSync(outFile, lines.join('\n'), 'utf8');
console.log(`\nXong! Đã xuất ra: migrate_data.sql`);
console.log(`\nBước tiếp theo — chạy lệnh này:`);
console.log(`  npx wrangler d1 execute unicorn-crm-db --remote --file=migrate_data.sql`);
