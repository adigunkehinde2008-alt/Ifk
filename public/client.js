// public/client.js
// Client-side: pointer lock, mouse look, WebSocket networking, Three.js rendering, WASD input -> send to server

const WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host + '/ws';
const socket = new WebSocket(WS_URL);

let isPointerLocked = false;
const sensitivity = 0.0025;
let invertY = false;
let lastSentRot = 0;
const ROT_SEND_INTERVAL_MS = 50; // 20Hz
const INPUT_SEND_INTERVAL_MS = 50; // 20Hz

const PITCH_MIN = -Math.PI / 2 + 0.05;
const PITCH_MAX = Math.PI / 2 - 0.05;

const player = { yaw: 0, pitch: 0, pos: { x: 0, y: 0, z: 0 } };
let myId = null;
const players = new Map(); // remote players

// Input state and local prediction
const keys = { w: false, a: false, s: false, d: false };
function inputMaskFromKeys() {
  let mask = 0;
  if (keys.w) mask |= 1; // forward
  if (keys.s) mask |= 2; // back
  if (keys.a) mask |= 4; // left
  if (keys.d) mask |= 8; // right
  return mask;
}

// --- Three.js setup (same as earlier branch) ---
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio || 1);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x202124);
const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
camera.position.set(0, 1.6, 5);
const ambient = new THREE.AmbientLight(0xffffff, 0.5); scene.add(ambient);
const dirLight = new THREE.DirectionalLight(0xffffff, 0.6); dirLight.position.set(5, 10, 7.5); scene.add(dirLight);
const groundGeo = new THREE.PlaneGeometry(200, 200); const groundMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a }); const ground = new THREE.Mesh(groundGeo, groundMat); ground.rotation.x = -Math.PI / 2; ground.position.y = 0; scene.add(ground);
const localHelperGeo = new THREE.ConeGeometry(0.15, 0.4, 8); const localHelperMat = new THREE.MeshStandardMaterial({ color: 0x66ccff }); const localHelper = new THREE.Mesh(localHelperGeo, localHelperMat); localHelper.rotation.x = Math.PI; localHelper.position.set(0, 0.2, 0); scene.add(localHelper);
const remoteContainer = new THREE.Group(); scene.add(remoteContainer);
const remoteMeshes = new Map();

window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });

// Input handlers
document.body.addEventListener('click', () => { if (!isPointerLocked) document.body.requestPointerLock(); });
document.addEventListener('pointerlockchange', () => { isPointerLocked = (document.pointerLockElement === document.body); });
document.addEventListener('mousemove', (e) => {
  if (!isPointerLocked) return;
  const movementX = e.movementX || e.mozMovementX || 0; const movementY = e.movementY || e.mozMovementY || 0;
  player.yaw -= movementX * sensitivity; player.pitch -= (invertY ? -1 : 1) * movementY * sensitivity;
  if (player.pitch < PITCH_MIN) player.pitch = PITCH_MIN; if (player.pitch > PITCH_MAX) player.pitch = PITCH_MAX;
  document.getElementById('yaw').textContent = player.yaw.toFixed(2); document.getElementById('pitch').textContent = player.pitch.toFixed(2);
  const now = performance.now(); if (now - lastSentRot > ROT_SEND_INTERVAL_MS) { sendRotationToServer(player.yaw, player.pitch); lastSentRot = now; }
});

addEventListener('keydown', (e) => { if (e.code === 'Space') { e.preventDefault(); doShoot(); } if (e.key === 'w' || e.key === 'W') keys.w = true; if (e.key === 'a' || e.key === 'A') keys.a = true; if (e.key === 's' || e.key === 'S') keys.s = true; if (e.key === 'd' || e.key === 'D') keys.d = true; });
addEventListener('keyup', (e) => { if (e.key === 'w' || e.key === 'W') keys.w = false; if (e.key === 'a' || e.key === 'A') keys.a = false; if (e.key === 's' || e.key === 'S') keys.s = false; if (e.key === 'd' || e.key === 'D') keys.d = false; });

// Local prediction movement (same as simulation model)
let lastFrame = performance.now();
function updateLocal(dt) {
  const speed = 3.0; const f = (keys.w ? 1 : 0) - (keys.s ? 1 : 0); const r = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
  if (f !== 0 || r !== 0) {
    const fx = Math.sin(player.yaw); const fz = Math.cos(player.yaw); const rx = Math.sin(player.yaw + Math.PI / 2); const rz = Math.cos(player.yaw + Math.PI / 2);
    player.pos.x += (fx * f + rx * r) * speed * dt; player.pos.z += (fz * f + rz * r) * speed * dt; player.pos.y = 0;
  }
}

function gameLoop() {
  const now = performance.now(); const dt = Math.min((now - lastFrame) / 1000, 0.05); lastFrame = now;
  updateLocal(dt);
  requestAnimationFrame(gameLoop);
}
requestAnimationFrame(gameLoop);

// send input packets at fixed interval (authoritative movement)
setInterval(() => {
  if (socket.readyState !== WebSocket.OPEN) return;
  const mask = inputMaskFromKeys();
  const msg = { t: 'input', ts: Date.now(), mask };
  socket.send(JSON.stringify(msg));
}, INPUT_SEND_INTERVAL_MS);

// shooting
document.getElementById('shoot').addEventListener('click', doShoot);
function doShoot() { if (socket.readyState !== WebSocket.OPEN) return; const msg = { t: 'shoot', ts: Date.now(), ...quantizeAngles(player.yaw, player.pitch) }; socket.send(JSON.stringify(msg)); showLocalShot(); }

function quantizeAngles(yaw, pitch) { const qYaw = Math.floor(((yaw + Math.PI) / (2 * Math.PI)) * 65535) & 0xFFFF; const pitchRange = PITCH_MAX - PITCH_MIN; const qPitch = Math.floor(((pitch - PITCH_MIN) / pitchRange) * 65535) & 0xFFFF; return { yaw: qYaw, pitch: qPitch }; }
function dequantizeAngles(qYaw, qPitch) { const yaw = (qYaw / 65535) * 2 * Math.PI - Math.PI; const pitch = (qPitch / 65535) * (PITCH_MAX - PITCH_MIN) + PITCH_MIN; return { yaw, pitch }; }
function sendRotationToServer(yaw, pitch) { if (socket.readyState !== WebSocket.OPEN) return; const { yaw: qYaw, pitch: qPitch } = quantizeAngles(yaw, pitch); const msg = { t: 'rot', seq: Date.now(), yaw: qYaw, pitch: qPitch, ts: Date.now() }; socket.send(JSON.stringify(msg)); }

socket.addEventListener('message', (ev) => {
  let data; try { data = JSON.parse(ev.data); } catch (e) { return; }
  if (data.t === 'welcome') { myId = data.id; }
  else if (data.t === 'state') {
    for (const p of data.players) {
      const id = p.id; const { yaw, pitch } = dequantizeAngles(p.yaw, p.pitch);
      if (id === myId) {
        // server authoritative position for me: reconcile
        const srvPos = p.pos;
        const dx = srvPos.x - player.pos.x; const dy = srvPos.y - player.pos.y; const dz = srvPos.z - player.pos.z;
        const dist2 = dx*dx + dy*dy + dz*dz;
        if (dist2 > 0.04) { // threshold (0.2m)^2
          // correct smoothly
          player.pos.x = lerp(player.pos.x, srvPos.x, 0.5);
          player.pos.y = lerp(player.pos.y, srvPos.y, 0.5);
          player.pos.z = lerp(player.pos.z, srvPos.z, 0.5);
          console.log('reconciled position by server');
        }
      } else {
        players.set(id, { yaw, pitch, pos: p.pos, ts: p.ts, health: p.health });
      }
    }
    syncRemoteMeshes(); renderPlayersList();
  } else if (data.t === 'hit') { highlightHit(data.target); }
  else if (data.t === 'shootAck') { if (data.hit) showTemporaryMessage('Hit!'); else showTemporaryMessage('Miss'); }
  else if (data.t === 'death') { showTemporaryMessage(`Player ${data.id} killed by ${data.by}`); }
});

function showTemporaryMessage(text) { const el = document.createElement('div'); el.style.position = 'absolute'; el.style.left = '50%'; el.style.top = '20%'; el.style.transform = 'translateX(-50%)'; el.style.padding = '8px 12px'; el.style.background = 'rgba(0,0,0,0.6)'; el.style.color = '#fff'; el.style.borderRadius = '6px'; el.textContent = text; document.body.appendChild(el); setTimeout(() => el.remove(), 800); }
function lerp(a,b,t){return a+(b-a)*t}

function renderPlayersList() { const el = document.getElementById('playersList'); el.innerHTML = ''; for (const [id, p] of players) { const d = document.createElement('div'); d.textContent = `${id} yaw:${p.yaw.toFixed(2)} pitch:${p.pitch.toFixed(2)} health:${(p.health||100)}`; el.appendChild(d); } }

// Three.js helpers: makeRemoteMesh, syncRemoteMeshes, highlightHit, showLocalShot (same as previous)
function makeRemoteMesh(id) { const g = new THREE.BoxGeometry(0.6, 1.8, 0.4); const m = new THREE.MeshStandardMaterial({ color: 0xff6666 }); const mesh = new THREE.Mesh(g, m); mesh.position.y = 0.9; mesh.userData.id = id; remoteContainer.add(mesh); remoteMeshes.set(id, mesh); return mesh; }
function syncRemoteMeshes() { for (const [id, p] of players) { let mesh = remoteMeshes.get(id); if (!mesh) mesh = makeRemoteMesh(id); mesh.position.lerp(new THREE.Vector3(p.pos.x, p.pos.y + 0.9, p.pos.z), 0.2); mesh.rotation.y = -p.yaw; const health = p.health != null ? p.health : 100; mesh.material.color.setHex(health > 66 ? 0x66ff66 : health > 33 ? 0xffcc33 : 0xff6666); } for (const [id, mesh] of remoteMeshes) { if (!players.has(id)) { remoteContainer.remove(mesh); remoteMeshes.delete(id); } } }
function highlightHit(targetId) { const mesh = remoteMeshes.get(targetId); if (!mesh) return; mesh.material.emissive = new THREE.Color(0xff0000); setTimeout(() => { if (mesh) mesh.material.emissive = new THREE.Color(0x000000); }, 200); }
let shotLine = null; function showLocalShot() { if (shotLine) { scene.remove(shotLine); shotLine.geometry.dispose(); shotLine.material.dispose(); shotLine = null; } const origin = new THREE.Vector3(player.pos.x, player.pos.y + 1.6, player.pos.z); const dir = yawPitchToDir(player.yaw, player.pitch); const end = new THREE.Vector3(origin.x + dir.x * 50, origin.y + dir.y * 50, origin.z + dir.z * 50); const geo = new THREE.BufferGeometry().setFromPoints([origin, end]); const mat = new THREE.LineBasicMaterial({ color: 0xffff00 }); shotLine = new THREE.Line(geo, mat); scene.add(shotLine); setTimeout(() => { if (shotLine) { scene.remove(shotLine); shotLine.geometry.dispose(); shotLine.material.dispose(); shotLine = null; } }, 120); }
function yawPitchToDir(yaw, pitch) { const x = Math.cos(pitch) * Math.sin(yaw); const y = Math.sin(pitch); const z = Math.cos(pitch) * Math.cos(yaw); const len = Math.hypot(x, y, z) || 1; return { x: x / len, y: y / len, z: z / len }; }

// animate/render loop
function animate() { requestAnimationFrame(animate); const now = performance.now(); const dt = Math.min((now - lastFrame) / 1000, 0.05); lastFrame = now; // set camera
  camera.position.set(player.pos.x, player.pos.y + 1.6, player.pos.z); const euler = new THREE.Euler(player.pitch, player.yaw, 0, 'YXZ'); camera.quaternion.setFromEuler(euler); localHelper.position.set(player.pos.x, 0.2, player.pos.z); localHelper.rotation.y = -player.yaw; renderer.render(scene, camera); }
animate();
