// Client-side: pointer lock, mouse look, WebSocket networking, simple canvas rendering
const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const socket = new WebSocket(WS_URL);

let isPointerLocked = false;
const sensitivity = 0.0025;
let invertY = false;
let lastSent = 0;
const SEND_INTERVAL_MS = 50; // 20Hz

const PITCH_MIN = -Math.PI / 2 + 0.05;
const PITCH_MAX = Math.PI / 2 - 0.05;

const player = { yaw: 0, pitch: 0 };
let myId = null;

const players = new Map(); // id => { yaw, pitch, ts }

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
  console.log('pointer lock', isPointerLocked);
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

  // update UI
  document.getElementById('yaw').textContent = player.yaw.toFixed(2);
  document.getElementById('pitch').textContent = player.pitch.toFixed(2);

  const now = performance.now();
  if (now - lastSent > SEND_INTERVAL_MS) {
    sendRotationToServer(player.yaw, player.pitch);
    lastSent = now;
  }
});

// keyboard shoot (space)
addEventListener('keydown', (e) => {
  if (e.code === 'Space') { e.preventDefault(); doShoot(); }
});

document.getElementById('shoot').addEventListener('click', doShoot);

function doShoot() {
  // local effect could be added here
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
      if (id === myId) continue; // skip self
      const { yaw, pitch } = dequantizeAngles(p.yaw, p.pitch);
      players.set(id, { yaw, pitch, ts: p.ts });
    }
    renderPlayersList();
  } else if (data.t === 'shootAck') {
    // server acknowledged
    console.log('shootAck', data);
  }
});

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
    d.textContent = id + ' yaw:' + p.yaw.toFixed(2) + ' pitch:' + p.pitch.toFixed(2);
    el.appendChild(d);
  }
}

// very simple canvas loop: draw crosshair and rotate a small indicator for each remote player
function renderLoop() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  // center crosshair
  ctx.fillStyle = '#fff';
  ctx.font = '24px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('+', canvas.width / 2, canvas.height / 2 + 8);

  // draw remote players as small arcs around center based on yaw
  let i = 0;
  for (const [id, p] of players) {
    const radius = 80 + (i * 20);
    const angle = p.yaw; // yaw -> angle
    const x = canvas.width / 2 + Math.cos(angle) * radius;
    const y = canvas.height / 2 + Math.sin(angle) * radius;
    ctx.beginPath(); ctx.fillStyle = '#ff6666'; ctx.arc(x, y, 8, 0, Math.PI*2); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '12px sans-serif'; ctx.fillText(id.slice(0,4), x, y+4);
    i++;
  }

  requestAnimationFrame(renderLoop);
}
requestAnimationFrame(renderLoop);
