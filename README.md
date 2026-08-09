# MG Control Server

Simple Render receiver for the Android `com.wepie.debug` floating menu.

## Endpoints used by the menu

- `GET /api/data`
- `POST /api/heartbeat`
- `POST /api/chat/batch`

Compatibility aliases are also included:

- `POST /api/v1/device/heartbeat`
- `POST /api/v1/chat/batch`

## Render

Use this repo on Render as a Node web service.

Build command:

```bash
npm install
```

Start command:

```bash
npm start
```

Open the Render URL to see the dashboard.
