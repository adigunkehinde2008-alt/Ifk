const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8080;
const HISTORY_MS = 1000; // keep ~1s of position history
const BROADCAST_INTERVAL_MS = 100; // 10Hz
const SHOOT_DAMAGE = 34;

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

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

const players = new Map(); // id => { ws, id, yaw, pitch, pos, posHistory:[], lastTs, health }

function generatePlayerId() {
  return Math.random().toString(36).slice(2, 9);
}

wss.on('connection', (ws) => {
  const id = generatePlayerId();
  players.set(id, {
    ws,
    id,
    yaw: 0,
    pitch: 0,
    pos: { x: 0, y: 0, z: 0 },
    posHistory: [], // each { ts, pos }
    lastTs: Date.now(),
    health: 100,
    hitRadius: 0.5
  });
  ws.send(JSON.stringify({ t: 'welcome', id }));
  console.log('connect', id);

  ws.on('message', (msg) => {
    let data;
    try { data = JSON.parse(msg); } catch (e) { return; }
    const player = players.get(id);
    if (!player) return;

    if (data.t === 'rot') {
      player.yaw = (data.yaw / 65535) * 2 * Math.PI - Math.PI;
      const PITCH_MIN = -Math.PI / 2 + 0.05;
      const PITCH_MAX = Math.PI / 2 - 0.05;
      player.pitch = (data.pitch / 65535) * (PITCH_MAX - PITCH_MIN) + PITCH_MIN;
      player.lastTs = data.ts || Date.now();
    } else if (data.t === 'pos') {
      // data.pos { x, y, z }, data.ts
      const ts = data.ts || Date.now();
      player.pos = { x: data.pos.x, y: data.pos.y, z: data.pos.z };
      player.posHistory.push({ ts, pos: { ...player.pos } });
      // prune history
      const cutoff = Date.now() - HISTORY_MS;
      while (player.posHistory.length > 0 && player.posHistory[0].ts < cutoff) {
        player.posHistory.shift();
      }
    } else if (data.t === 'shoot') {
      // data has quantized yaw/pitch from client, and ts
      const yaw = (data.yaw / 65535) * 2 * Math.PI - Math.PI;
      const PITCH_MIN = -Math.PI / 2 + 0.05;
      const PITCH_MAX = Math.PI / 2 - 0.05;
      const pitch = (data.pitch / 65535) * (PITCH_MAX - PITCH_MIN) + PITCH_MIN;
      const shotTs = data.ts || Date.now();

      const hitResult = performServerHitscan(id, yaw, pitch, shotTs);
      if (hitResult) {
        // apply damage
        const target = players.get(hitResult.id);
        if (target) {
          target.health = Math.max(0, (target.health || 100) - SHOOT_DAMAGE);
          // notify everybody about hit/damage
          broadcast({ t: 'hit', shooter: id, target: hitResult.id, distance: hitResult.distance, targetHealth: target.health });
          // send ack to shooter specifically
          ws.send(JSON.stringify({ t: 'shootAck', hit: true, target: hitResult.id }));
          // handle death
          if (target.health <= 0) {
            broadcast({ t: 'death', id: hitResult.id, by: id });
            // reset target after a short delay
            setTimeout(() => {
              const tp = players.get(hitResult.id);
              if (!tp) return;
              tp.health = 100;
              tp.pos = { x: 0, y: 0, z: 0 };
              tp.posHistory = [];
            }, 1000);
          }
        } else {
          ws.send(JSON.stringify({ t: 'shootAck', hit: false }));
        }
      } else {
        ws.send(JSON.stringify({ t: 'shootAck', hit: false }));
      }
    }
  });

  ws.on('close', () => {
    players.delete(id);
    console.log('disconnect', id);
    broadcast({ t: 'leave', id });
  });
});

// Helpers

function broadcast(obj) {
  const s = JSON.stringify(obj);
  for (const p of players.values()) {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(s);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

function interpolatePositionAt(history, targetTs) {
  if (!history || history.length === 0) return null;
  if (targetTs <= history[0].ts) return history[0].pos;
  if (targetTs >= history[history.length - 1].ts) return history[history.length - 1].pos;
  for (let i = 0; i < history.length - 1; i++) {
    const a = history[i];
    const b = history[i + 1];
    if (targetTs >= a.ts && targetTs <= b.ts) {
      const dt = (targetTs - a.ts) / (b.ts - a.ts || 1);
      return { x: lerp(a.pos.x, b.pos.x, dt), y: lerp(a.pos.y, b.pos.y, dt), z: lerp(a.pos.z, b.pos.z, dt) };
    }
  }
  return history[history.length - 1].pos;
}

function yawPitchToDir(yaw, pitch) {
  const x = Math.cos(pitch) * Math.sin(yaw);
  const y = Math.sin(pitch);
  const z = Math.cos(pitch) * Math.cos(yaw);
  const len = Math.hypot(x, y, z) || 1;
  return { x: x / len, y: y / len, z: z / len };
}

function raySphereIntersect(origin, dir, center, radius) {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const a = dir.x * dir.x + dir.y * dir.y + dir.z * dir.z;
  const b = 2 * (ox * dir.x + oy * dir.y + oz * dir.z);
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return null;
  const sqrtD = Math.sqrt(disc);
  const t1 = (-b - sqrtD) / (2 * a);
  const t2 = (-b + sqrtD) / (2 * a);
  const t = Math.min(t1 > 0 ? t1 : Infinity, t2 > 0 ? t2 : Infinity);
  return isFinite(t) ? t : null;
}

function performServerHitscan(shooterId, yaw, pitch, shotTs) {
  const shooter = players.get(shooterId);
  if (!shooter) return null;
  const dir = yawPitchToDir(yaw, pitch);

  // Determine shooter origin at shotTs. Use posHistory if available, otherwise current pos.
  const shooterPos = shooter.posHistory && shooter.posHistory.length ? interpolatePositionAt(shooter.posHistory, shotTs) : shooter.pos || { x: 0, y: 0, z: 0 };
  // eye offset; adjust to your character height
  const eyeOffset = { x: 0, y: 1.6, z: 0 };
  const origin = { x: shooterPos.x + eyeOffset.x, y: shooterPos.y + eyeOffset.y, z: shooterPos.z + eyeOffset.z };

  let closest = { id: null, t: Infinity };
  for (const [id, p] of players) {
    if (id === shooterId) continue;
    const targetPos = p.posHistory && p.posHistory.length ? interpolatePositionAt(p.posHistory, shotTs) : p.pos || null;
    if (!targetPos) continue;
    const radius = p.hitRadius || 0.5;
    const t = raySphereIntersect(origin, dir, targetPos, radius);
    if (t !== null && t < closest.t) {
      closest = { id, t };
    }
  }

  if (closest.id) return { id: closest.id, distance: closest.t };
  return null;
}

// Broadcast loop: send players' positions/yaw/pitch/health at 10Hz
setInterval(() => {
  const payload = { t: 'state', players: [] };
  for (const [id, p] of players) {
    payload.players.push({
      id,
      pos: p.pos,
      yaw: quantize(p.yaw),
      pitch: quantizePitch(p.pitch),
      ts: p.lastTs,
      health: p.health || 100
    });
  }
  broadcast(payload);
}, BROADCAST_INTERVAL_MS);

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
