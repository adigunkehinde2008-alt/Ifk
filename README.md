# Ifk - Minimal Online Shooter Starter

This repository contains a minimal starter for an online shooter with:

- Pointer Lock + mouse look (yaw/pitch)
- Throttled, quantized rotation messages over WebSocket
- Simple Node.js server that broadcasts player state

Get started:

1. Install dependencies

   npm install

2. Start the server

   npm start

3. Open http://localhost:8080 in multiple browser windows and click the page to lock the pointer.

Files of interest:

- server.js — HTTP + WebSocket server and simple player state broadcast
- public/index.html — basic UI and canvas
- public/client.js — pointer lock, mouse look, networking, simple rendering

Next steps (suggested): integrate with Three.js or your rendering engine, implement server-side hit detection and lag compensation.
