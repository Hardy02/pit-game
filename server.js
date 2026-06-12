/* ============================================================================
   PIT — multiplayer PvP server
   Zero external dependencies. Uses only Node built-ins (http, crypto, fs, path)
   and a hand-rolled WebSocket implementation, so you can run it with just:

       node server.js

   Then open http://localhost:3000 in a browser (open several tabs / other
   machines on your LAN to get multiple players).

   Responsibilities:
     - Serves the client (index.html).
     - Matchmaking: auto-fills "rooms" (servers) up to MAX_PLAYERS, creating
       new rooms as needed.
     - Rotates each room through 5 maps on a round timer.
     - Relays player state between clients at SNAPSHOT_HZ.
     - Authoritatively adjudicates kills, scores, deaths and respawns.

   Netcode model: each client simulates its OWN movement locally (so movement
   stays buttery and responsive) and streams its state here; the server relays
   it and is the source of truth for health, kills and scores. Hit detection is
   client-claimed with light server-side validation — fine for a LAN/casual
   game, not designed to be cheat-proof.
   ============================================================================ */
'use strict';

const http   = require('http');
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

/* ---------------------------- Tunables ---------------------------- */
const PORT          = process.env.PORT || 3000;
const MAX_PLAYERS   = 12;      // hard cap per room ("server"); preferred fill is 4-12
const MIN_PLAYERS   = 2;       // a room stays in "warmup" (clock frozen, no map rotation)
                               // until at least this many players are present
const SNAPSHOT_HZ   = 20;      // state broadcasts per second
const TICK_HZ       = 30;      // server logic ticks (respawns, round timer)
const ROUND_TIME    = 150;     // seconds per map before rotating
const RESPAWN_TIME  = 2000;    // ms dead before respawn
const SPAWN_PROTECT = 1500;    // ms of invulnerability after spawning
const DMG = { melee: 50, ranged: 25, saber: 1000 };
const MELEE_MAX_DIST = 170;    // server-side sanity check for melee claims
const MAX_HP = 100;

/* ============================================================================
   MAPS — all sized to the client viewport (1200x800) so the whole arena is
   always visible (no scrolling); great for readable deathmatch.
   plats: interior platforms [x,y,w,h]. Floor (y>=760), ceiling and side walls
   are implicit on the client. spawns: [x,y] = player top-left start positions.
   ============================================================================ */
const MAPS = [
  {
    name: 'CROSSFIRE',
    plats: [
      [120, 560, 200, 30], [880, 560, 200, 30],
      [470, 430, 260, 30],
      [560, 220, 80, 240],          // central pillar
      [300, 300, 30, 200], [870, 300, 30, 200],
    ],
    spawns: [[80,700],[1090,700],[200,510],[960,510],[540,380],[560,160],[330,250],[840,250]],
  },
  {
    name: 'TOWERS',
    plats: [
      [180, 300, 60, 460], [960, 300, 60, 460],     // tall side towers
      [540, 380, 120, 40],                          // center perch
      [380, 560, 120, 30], [700, 560, 120, 30],
      [540, 600, 120, 30],
    ],
    spawns: [[100,700],[1080,700],[190,250],[970,250],[560,330],[420,510],[720,510],[560,550]],
  },
  {
    name: 'STAIRCASE',
    plats: [
      [120, 660, 200, 30], [320, 560, 200, 30],
      [520, 460, 200, 30], [720, 360, 200, 30],
      [920, 260, 180, 30],
      [120, 300, 160, 30],
    ],
    spawns: [[150,610],[360,510],[560,410],[760,310],[980,210],[160,250],[600,700],[1000,700]],
  },
  {
    name: 'OPEN PIT',
    plats: [
      [250, 520, 180, 30], [770, 520, 180, 30],
      [500, 600, 200, 30],
      [500, 320, 200, 30],
      [120, 400, 30, 200], [1050, 400, 30, 200],
    ],
    spawns: [[300,470],[820,470],[560,550],[560,270],[80,700],[1110,700],[600,150],[300,700]],
  },
  {
    name: 'GANTRY',
    plats: [
      [0, 430, 360, 28], [840, 430, 360, 28],       // side gantries to the walls
      [470, 560, 260, 28],
      [470, 280, 260, 28],
      [560, 380, 80, 28],
    ],
    spawns: [[120,380],[1020,380],[560,510],[560,230],[600,330],[80,700],[1100,700],[600,700]],
  },
];

/* ============================================================================
   WebSocket (hand-rolled, just enough for our small JSON messages)
   ============================================================================ */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function decodeFrame(buf) {
  if (buf.length < 2) return null;
  const b1 = buf[1];
  const opcode = buf[0] & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let len = b1 & 0x7f;
  let offset = 2;
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); offset = 4; }
  else if (len === 127) { if (buf.length < 10) return null; len = Number(buf.readBigUInt64BE(2)); offset = 10; }
  let mask;
  if (masked) { if (buf.length < offset + 4) return null; mask = buf.slice(offset, offset + 4); offset += 4; }
  if (buf.length < offset + len) return null;
  let payload = buf.slice(offset, offset + len);
  if (masked) {
    const out = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
    payload = out;
  }
  return { opcode, payload, total: offset + len };
}

function encodeFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.from([0x80 | opcode, len]); }
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  return Buffer.concat([header, payload]);
}

/* ============================================================================
   HTTP server (serves the client) + WS upgrade
   ============================================================================ */
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0];
  if (p === '/') p = '/index.html';
  const file = path.join(__dirname, path.normalize(p));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  if (!key) { socket.destroy(); return; }
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
  );
  socket.setNoDelay(true);
  handleConnection(socket);
});

/* ============================================================================
   Connection / player / room model
   ============================================================================ */
let nextId = 1;
const rooms = [];

function makeRoom() {
  const room = {
    id: 'R' + (rooms.length + 1),
    players: new Map(),         // id -> player
    mapIndex: Math.floor(Math.random() * MAPS.length),
    roundEndsAt: Date.now() + ROUND_TIME * 1000,
  };
  rooms.push(room);
  return room;
}

function findRoom() {
  for (const r of rooms) if (r.players.size < MAX_PLAYERS) return r;
  return makeRoom();
}

function spawnPoint(room) {
  const m = MAPS[room.mapIndex];
  return m.spawns[Math.floor(Math.random() * m.spawns.length)];
}

function send(conn, obj) {
  if (conn.dead) return;
  try { conn.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id === exceptId) continue;
    try { p.conn.socket.write(encodeFrame(data)); } catch (e) {}
  }
}

function handleConnection(socket) {
  const conn = { socket, dead: false, player: null };
  let buf = Buffer.alloc(0);

  socket.on('data', (d) => {
    buf = Buffer.concat([buf, d]);
    let frame;
    while ((frame = decodeFrame(buf))) {
      buf = buf.slice(frame.total);
      if (frame.opcode === 0x8) { closeConn(conn); return; }       // close
      else if (frame.opcode === 0x9) { socket.write(encodeFrame(frame.payload, 0xA)); } // ping->pong
      else if (frame.opcode === 0x1) {                              // text
        let msg; try { msg = JSON.parse(frame.payload.toString('utf8')); } catch (e) { continue; }
        onMessage(conn, msg);
      }
    }
  });
  socket.on('close', () => closeConn(conn));
  socket.on('error', () => closeConn(conn));
}

function closeConn(conn) {
  if (conn.dead) return;
  conn.dead = true;
  const p = conn.player;
  if (p && p.room) {
    p.room.players.delete(p.id);
    broadcast(p.room, { t: 'leave', id: p.id });
    if (p.room.players.size === 0) {
      const i = rooms.indexOf(p.room);
      if (i >= 0) rooms.splice(i, 1);
    }
  }
  try { conn.socket.destroy(); } catch (e) {}
}

/* ---------------------------- Message handling ---------------------------- */
function onMessage(conn, msg) {
  if (msg.t === 'join') return doJoin(conn, msg);
  const p = conn.player;
  if (!p || !p.room) return;
  const room = p.room;
  const now = Date.now();

  switch (msg.t) {
    case 'state': {
      // trust client for its own position/visual flags
      p.x = msg.x; p.y = msg.y; p.vx = msg.vx; p.vy = msg.vy;
      p.facing = msg.facing; p.aim = msg.aim;
      p.sl = msg.sl ? 1 : 0; p.wr = msg.wr ? 1 : 0; p.saber = msg.saber ? 1 : 0;
      break;
    }
    case 'hit': {
      const victim = room.players.get(msg.target);
      if (!victim || victim.dead || victim.id === p.id) break;
      if (now < victim.invulnUntil) break;
      const dmg = DMG[msg.weapon] || 0;
      if (msg.weapon === 'melee') {
        const dx = victim.x - p.x, dy = victim.y - p.y;
        if (Math.hypot(dx, dy) > MELEE_MAX_DIST) break;  // light validation
      }
      victim.hp -= dmg;
      if (victim.hp <= 0) {
        victim.dead = true;
        victim.respawnAt = now + RESPAWN_TIME;
        p.score += 1;
        broadcast(room, { t: 'kill', killer: p.id, killerName: p.name, victim: victim.id, victimName: victim.name, weapon: msg.weapon });
      }
      break;
    }
    // visual-only effects forwarded to other players so they can see attacks
    case 'fx': {
      broadcast(room, { t: 'fx', id: p.id, kind: msg.kind, x: msg.x, y: msg.y, ang: msg.ang }, p.id);
      break;
    }
  }
}

function doJoin(conn, msg) {
  const room = findRoom();
  const [sx, sy] = spawnPoint(room);
  const player = {
    id: nextId++, conn, room,
    name: (msg.name || 'Player').toString().slice(0, 14),
    x: sx, y: sy, vx: 0, vy: 0, facing: 1, aim: 0,
    sl: 0, wr: 0, saber: 0,
    hp: MAX_HP, dead: false, score: 0,
    respawnAt: 0, invulnUntil: Date.now() + SPAWN_PROTECT,
  };
  conn.player = player;
  room.players.set(player.id, player);

  send(conn, {
    t: 'welcome',
    id: player.id, room: room.id,
    map: clientMap(room), mapIndex: room.mapIndex, mapName: MAPS[room.mapIndex].name,
    roundEndsAt: room.roundEndsAt,
    spawn: [sx, sy],
    maxHp: MAX_HP,
  });
  broadcast(room, { t: 'join', id: player.id, name: player.name }, player.id);
}

function clientMap(room) {
  const m = MAPS[room.mapIndex];
  return { name: m.name, plats: m.plats, spawns: m.spawns };
}

/* ============================================================================
   Server loops
   ============================================================================ */
// Logic tick: respawns + map rotation
setInterval(() => {
  const now = Date.now();
  for (const room of rooms) {
    // respawns
    for (const p of room.players.values()) {
      if (p.dead && now >= p.respawnAt) {
        const [sx, sy] = spawnPoint(room);
        p.dead = false; p.hp = MAX_HP; p.x = sx; p.y = sy; p.vx = 0; p.vy = 0;
        p.invulnUntil = now + SPAWN_PROTECT;
        send(p.conn, { t: 'respawn', x: sx, y: sy });
      }
    }
    // warmup: with fewer than MIN_PLAYERS, freeze the round clock and don't
    // rotate maps — the match effectively waits for a 2nd player.
    room.warmup = room.players.size < MIN_PLAYERS;
    if (room.warmup) { room.roundEndsAt = now + ROUND_TIME * 1000; continue; }

    // map rotation
    if (now >= room.roundEndsAt) {
      room.mapIndex = (room.mapIndex + 1) % MAPS.length;
      room.roundEndsAt = now + ROUND_TIME * 1000;
      for (const p of room.players.values()) {
        const [sx, sy] = spawnPoint(room);
        p.score = 0; p.hp = MAX_HP; p.dead = false; p.x = sx; p.y = sy; p.vx = 0; p.vy = 0;
        p.invulnUntil = now + SPAWN_PROTECT;
      }
      broadcast(room, {
        t: 'mapChange',
        map: clientMap(room), mapIndex: room.mapIndex, mapName: MAPS[room.mapIndex].name,
        roundEndsAt: room.roundEndsAt,
      });
      // tell each client where it now spawns
      for (const p of room.players.values()) send(p.conn, { t: 'respawn', x: p.x, y: p.y });
    }
  }
}, 1000 / TICK_HZ);

// Snapshot broadcast
setInterval(() => {
  const now = Date.now();
  for (const room of rooms) {
    const players = [];
    for (const p of room.players.values()) {
      players.push({
        id: p.id, n: p.name,
        x: Math.round(p.x), y: Math.round(p.y),
        vx: Math.round(p.vx), vy: Math.round(p.vy),
        f: p.facing, a: +p.aim.toFixed(2),
        hp: p.hp, d: p.dead ? 1 : 0, s: p.score,
        sl: p.sl, wr: p.wr, sb: p.saber,
        iv: now < p.invulnUntil ? 1 : 0,
      });
    }
    const snap = { t: 'snap', players, roundEndsAt: room.roundEndsAt, warmup: !!room.warmup, need: MIN_PLAYERS };
    const data = JSON.stringify(snap);
    for (const p of room.players.values()) {
      try { p.conn.socket.write(encodeFrame(data)); } catch (e) {}
    }
  }
}, 1000 / SNAPSHOT_HZ);

// Bind to 0.0.0.0 so it works both locally and inside cloud containers (Railway etc.)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  PIT multiplayer server running on port ${PORT}`);
  console.log(`  → locally: http://localhost:${PORT}`);
  console.log(`  → on your LAN: http://<your-ip>:${PORT}`);
  console.log(`  → when deployed, use the public URL your host gives you\n`);
});
