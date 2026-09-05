// public/client.js
// Client-side: pointer lock, mouse look, WebSocket networking, simple rendering, WASD movement, pos updates

const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const socket = new WebSocket(WS_URL);

let isPointerLocked = false;
const sensitivity = 0.0025;
let invertY = false;
let lastSentRot = 0;
const ROT_SEND_INTERVAL_MS = 50; // 20Hz
const POS_SEND_INTERVAL_MS = 50; // 20Hz

const PITCH_MIN = -Math.PI / 2 + 0.05;
const PITCH_MAX = Math.PI / 2 - 0.05;

const player = { yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
let myId = null;
const players = new Map();

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
addEventListener('resize', resize); resize();

// pointer lock
document.body.addEventListener('click', () => {
  if (!isPointerLocked) document.body.requestPointerLock();
});
document.addEventListener('pointerlockchange', () => {
  isPointerLocked = (document.pointerLockElement === document.body);
});

// mouse move
document.addEventListener('mousemove', (e) => {
  if (!isPointerLocked) return;
  const movementX = e.movementX || e.mozMovementX || 0;
  const movementY = e.movementY || e.mozMovementY || 0;
  player.yaw -= movementX * sensitivity;
  player.pitch -= (invertY ? -1 : 1) * movementY * sensitivity;
  if (player.pitch < PITCH_MIN) player.pitch = PITCH_MIN;
  if (player.pitch > PITCH_MAX) player.pitch = PITCH_MAX;
  document.getElementById('yaw').textContent = player.yaw.toFixed(2);
  document.getElementById('pitch').textContent = player.pitch.toFixed(2);

  const now = performance.now();
  if (now - lastSentRot > ROT_SEND_INTERVAL_MS) {
    sendRotationToServer(player.yaw, player.pitch);
    lastSentRot = now;
  }
});

// WASD movement (very simple)
const keys = { w: false, a: false, s: false, d: false };
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); doShoot(); }
  if (e.key === 'w' || e.key === 'W') keys.w = true;
  if (e.key === 'a' || e.key === 'A') keys.a = true;
  if (e.key === 's' || e.key === 'S') keys.s = true;
  if (e.key === 'd' || e.key === 'D') keys.d = true;
});
addEventListener('keyup', (e) => {
  if (e.key === 'w' || e.key === 'W') keys.w = false;
  if (e.key === 'a' || e.key === 'A') keys.a = false;
  if (e.key === 's' || e.key === 'S') keys.s = false;
  if (e.key === 'd' || e.key === 'D') keys.d = false;
});

let lastFrame = performance.now();
function gameLoop() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.05);
  lastFrame = now;

  // movement relative to yaw
  const speed = 3.0; // m/s
  const forward = (keys.w ? 1 : 0) - (keys.s ? 1 : 0);
  const right = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  if (forward !== 0 || right !== 0) {
    // convert yaw to forward vector on XZ plane
    const fx = Math.sin(player.yaw);
    const fz = Math.cos(player.yaw);
    // right vector
    const rx = Math.sin(player.yaw + Math.PI / 2);
    const rz = Math.cos(player.yaw + Math.PI / 2);
    player.pos.x += (fx * forward + rx * right) * speed * dt;
    player.pos.z += (fz * forward + rz * right) * speed * dt;
    // keep y constant for now (flat ground)
    player.pos.y = 0;
  }

  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

// send pos updates at interval
setInterval(() => {
  if (socket.readyState !== WebSocket.OPEN) return;
  const msg = { t: 'pos', ts: Date.now(), pos: { x: player.pos.x, y: player.pos.y, z: player.pos.z } };
  socket.send(JSON.stringify(msg));
}, POS_SEND_INTERVAL_MS);

document.getElementById('shoot').addEventListener('click', doShoot);

function doShoot() {
  if (socket.readyState !== WebSocket.OPEN) return;
  const msg = { t: 'shoot', ts: Date.now(), ...quantizeAngles(player.yaw, player.pitch) };
  socket.send(JSON.stringify(msg));
}

socket.addEventListener('message', (ev) => {
  let data;
  try { data = JSON.parse(ev.data); } catch (e) { return; }
  if (data.t === 'welcome') { myId = data.id; }
  else if (data.t === 'state') {
    for (const p of data.players) {
      const id = p.id;
      if (id === myId) continue;
      const { yaw, pitch } = dequantizeAngles(p.yaw, p.pitch);
      players.set(id, { yaw, pitch, pos: p.pos, ts: p.ts, health: p.health });
    }
    renderPlayersList();
  } else if (data.t === 'hit') {
    // hit event broadcast by server - visual feedback
    console.log('hit', data);
  } else if (data.t === 'shootAck') {
    // shooter-specific ack
    if (data.hit) {
      // show hit marker
      showTemporaryMessage('Hit!');
    } else {
      showTemporaryMessage('Miss');
    }
  } else if (data.t === 'death') {
    showTemporaryMessage(`Player ${data.id} killed by ${data.by}`);
  }
});

function showTemporaryMessage(text) {
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.left = '50%';
  el.style.top = '20%';
  el.style.transform = 'translateX(-50%)';
  el.style.padding = '8px 12px';
  el.style.background = 'rgba(0,0,0,0.6)';
  el.style.color = '#fff';
  el.style.borderRadius = '6px';
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 800);
}

function quantizeAngles(yaw, pitch) {
  const qYaw = Math.floor(((yaw + Math.PI) / (2 * Math.PI)) * 65535) & 0xFFFF;
  const pitchRange = PITCH_MAX - PITCH_MIN;
  const qPitch = Math.floor(((pitch - PITCH_MIN) / pitchRange) * 65535) & 0xFFFF;
  return { yaw: qYaw, pitch: qPitch };
}
function dequantizeAngles(qYaw, qPitch) {
  const yaw = (qYaw / 65535) * 2 * Math.PI - Math.PI;
  const pitch = (qPitch / 65535) * (PITCH_MAX - PITCH_MIN) + PITCH_MIN;
  return { yaw, pitch };
}
function sendRotationToServer(yaw, pitch) {
  if (socket.readyState !== WebSocket.OPEN) return;
  const { yaw: qYaw, pitch: qPitch } = quantizeAngles(yaw, pitch);
  const msg = { t: 'rot', seq: Date.now(), yaw: qYaw, pitch: qPitch, ts: Date.now() };
  socket.send(JSON.stringify(msg));
}

function renderPlayersList() {
  const el = document.getElementById('playersList');
  el.innerHTML = '';
  for (const [id, p] of players) {
    const d = document.createElement('div');
    d.textContent = `${id} yaw:${p.yaw.toFixed(2)} pitch:${p.pitch.toFixed(2)} health:${(p.health||100)}`;
    el.appendChild(d);
  }
}

// very simple canvas loop
function renderLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#fff';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('+', canvas.width / 2, canvas.height / 2 + 8);

  let i = 0;
  for (const [id, p] of players) {
    const radius = 80 + (i * 20);
    const angle = p.yaw;
    const x = canvas.width / 2 + Math.cos(angle) * radius;
    const y = canvas.height / 2 + Math.sin(angle) * radius;
    ctx.beginPath(); ctx.fillStyle = '#ff6666'; ctx.arc(x, y, 8, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText(id.slice(0,4), x, y+4);
    i++;
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
