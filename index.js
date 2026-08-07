const express = require("express");
const bodyParser = require("body-parser");
const app = express();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

let currentData = {
  title: "MG Menu",
  text: "Waiting for command...",
  action: "none",
  activity: ""
};

let clearTimer = null;

app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>MG Control Panel</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #0f0f13;
          color: white;
          padding: 20px;
          max-width: 500px;
          margin: 0 auto;
        }
        h1 {
          text-align: center;
          color: #a78bfa;
        }
        label {
          display: block;
          margin-top: 15px;
          margin-bottom: 5px;
          color: #ccc;
        }
        input, textarea {
          width: 100%;
          padding: 12px;
          border-radius: 8px;
          border: none;
          background: #1e1e27;
          color: white;
          font-size: 16px;
          box-sizing: border-box;
        }
        button {
          width: 100%;
          padding: 14px;
          margin-top: 20px;
          border: none;
          border-radius: 8px;
          background: linear-gradient(135deg, #7c3aed, #4f46e5);
          color: white;
          font-size: 16px;
          font-weight: bold;
          cursor: pointer;
        }
        .status {
          margin-top: 20px;
          padding: 12px;
          background: #1e1e27;
          border-radius: 8px;
          font-size: 14px;
          color: #a3e635;
        }
      </style>
    </head>
    <body>
      <h1>MG Control Panel</h1>

      <form method="POST" action="/update">
        <label>Menu Text</label>
        <textarea name="text" rows="3" placeholder="Type text to show in menu...">${currentData.text}</textarea>

        <label>Activity Class Name (optional)</label>
        <input type="text" name="activity" placeholder="com.wepie.module.teenmode.TeenModeOpeningActivity" value="">

        <button type="submit">Send to App</button>
      </form>

      <div class="status">
        <b>Current Status:</b><br>
        Text: ${currentData.text}<br>
        Action: ${currentData.action}<br>
        Activity: ${currentData.activity || "None"}
      </div>
    </body>
    </html>
  `);
});

app.post("/update", (req, res) => {
  // Purana timer cancel karo
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }

  currentData.text = req.body.text || "No text";
  currentData.activity = req.body.activity || "";
  currentData.action = currentData.activity ? "launch" : "none";
  currentData.title = "MG Menu";

  // Agar activity bheji hai to 3 second baad automatically clear kar do
  if (currentData.action === "launch") {
    clearTimer = setTimeout(() => {
      currentData.action = "none";
      currentData.activity = "";
      console.log("Auto cleared launch command");
    }, 3000);
  }

  res.redirect("/");
});

app.get("/api/data", (req, res) => {
  res.json(currentData);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("MG Control Server running on port " + PORT);
});
