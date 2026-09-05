const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;

// Simple static file server for files under ./public
const server = http.createServer((req, res) => {
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(__dirname, 'public', reqPath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    const mime = {
      '.html': 'text/html',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.json': 'application/json'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

const wss = new WebSocket.Server({ noServer: true });

// Upgrade HTTP to WebSocket for /ws
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const players = new Map(); // id => { ws, id, yaw, pitch, lastTs }

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 9);
}

wss.on('connection', (ws) => {
  const id = generatePlayerId();
  players.set(id, { ws, id, yaw: 0, pitch: 0, lastTs: Date.now() });
  ws.send(JSON.stringify({ t: 'welcome', id }));
  console.log('connect', id);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }
    const player = players.get(id);
    if (!player) return;

    if (data.t === 'rot') {
      // dequantize
      player.yaw = (data.yaw / 65535) * 2 * Math.PI - Math.PI;
      // pitch mapping matches client (PITCH_MIN/PITCH_MAX)
      const PITCH_MIN = -Math.PI / 2 + 0.05;
      const PITCH_MAX = Math.PI / 2 - 0.05;
      player.pitch = (data.pitch / 65535) * (PITCH_MAX - PITCH_MIN) + PITCH_MIN;
      player.lastTs = data.ts || Date.now();
    } else if (data.t === 'shoot') {
      // stub: just acknowledge shot
      ws.send(JSON.stringify({ t: 'shootAck', hit: false }));
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log('disconnect', id);
  });
});

// Broadcast loop: send players' yaw/pitch at 10Hz
setInterval(() => {
  const payload = { t: 'state', players: [] };
  for (const [id, p] of players) {
    payload.players.push({ id, yaw: quantize(p.yaw), pitch: quantizePitch(p.pitch), ts: p.lastTs });
  }
  const s = JSON.stringify(payload);
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}, 100);

function quantize(angle) {
  return Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 65535) & 0xFFFF;
}
function quantizePitch(pitch) {
  const PITCH_MIN = -Math.PI / 2 + 0.05;
  const PITCH_MAX = Math.PI / 2 - 0.05;
  return Math.floor(((pitch - PITCH_MIN) / (PITCH_MAX - PITCH_MIN)) * 65535) & 0xFFFF;
}

server.listen(PORT, () => {
  console.log('Server listening on http://localhost:' + PORT);
});
