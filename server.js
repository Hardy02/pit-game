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
const SNAPSHOT_HZ   = 30;      // state broadcasts per second (higher = fresher remote positions)
const TICK_HZ       = 30;      // server logic ticks (physics/bots, respawns, round timer)
const ROUND_TIME    = 180;     // seconds per round (3 minutes) before rotating
const RESPAWN_TIME  = 2000;    // ms dead before respawn
const SPAWN_PROTECT = 1500;    // ms of invulnerability after spawning
const DMG = { melee: 50, ranged: 25, saber: 1000 };
const MELEE_MAX_DIST = 170;    // server-side sanity check for melee claims
const MAX_HP = 100;

/* Game modes. "mini" = the classic single-screen arena. "maxi" = a much larger
   world that scrolls with the player and holds more combatants. Each mode has its
   own map set (below), a hard player cap, and a target headcount that bots top up. */
const MODES = {
  mini: { maxPlayers: 10, botTarget: 6 },
  maxi: { maxPlayers: 18, botTarget: 10 },
};
const PRIVATE_BOT_TARGET = 2;  // private (friends) rooms only add bots up to this headcount

/* Server-side physics — only used to simulate bots. Humans still simulate
   themselves on the client; these numbers mirror the client TUNE so bots feel
   like real players. */
const PHYS = {
  GRAVITY: 2600, MAX_FALL: 1500,
  MOVE_ACCEL: 5200, AIR_ACCEL: 3300, MAX_RUN: 430,
  JUMP_FORCE: 850, DOUBLE_JUMP: 760,
  GROUND_FRICTION: 0.0008, AIR_FRICTION: 0.1,
};
const BOTCFG = {
  BULLET_SPEED: 1050, BULLET_LIFETIME: 1.4,
  RANGED_CD: 0.6, MELEE_CD: 0.3,
  MELEE_RANGE: 82, MELEE_ARC: 1.8,
  FIRE_RANGE: 1500,            // won't bother shooting beyond this
};
const BOT_NAMES = ['Rook','Vex','Nyx','Juno','Kilo','Wraith','Echo','Zane','Ada','Mara','Onyx','Pike','Sable','Cleo','Ravi','Dex','Bishop','Tash'];

/* ============================================================================
   MAPS — all sized to the client viewport (1200x800) so the whole arena is
   always visible (no scrolling); great for readable deathmatch.
   plats: interior platforms [x,y,w,h]. Floor (y>=760), ceiling and side walls
   are implicit on the client. spawns: [x,y] = player top-left start positions.
   ============================================================================ */
const MAPS_MINI = [
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

/* MAXI maps — 2400x1500 worlds. The client shows a 1200x800 window that scrolls
   to follow the player, so the whole arena is never visible at once. More
   platforms + spawns to support bigger fights. */
const MAPS_MAXI = [
  {
    name: 'SPRAWL', w: 2400, h: 1500,
    plats: [
      [200,1200,300,30],[700,1100,300,30],[1200,1010,300,30],[1700,1100,300,30],[2080,1200,260,30],
      [400,900,260,30],[1000,820,300,30],[1500,860,300,30],[1950,900,260,30],
      [150,650,260,30],[700,600,260,30],[1140,520,320,30],[1700,600,260,30],[2150,650,210,30],
      [560,300,80,360],[1760,300,80,360],
      [1100,300,260,30],
    ],
    spawns: [[120,1380],[2240,1380],[300,1140],[800,1040],[1300,950],[1800,1040],[500,840],[1080,760],
             [1580,800],[2000,840],[250,590],[800,540],[1250,460],[1800,540],[1180,240],[600,1380]],
  },
  {
    name: 'FOUNDRY', w: 2400, h: 1500,
    plats: [
      [0,1150,400,30],[600,1250,300,30],[1050,1150,300,30],[1500,1250,300,30],[2000,1150,400,30],
      [300,950,300,30],[800,880,300,30],[1300,950,300,30],[1750,880,300,30],
      [100,700,280,30],[650,650,280,30],[1150,600,300,30],[1700,650,280,30],[2150,700,250,30],
      [450,400,300,30],[1050,360,300,30],[1650,400,300,30],
      [1180,150,120,30],
    ],
    spawns: [[150,1080],[2250,1080],[700,1180],[1150,1080],[1600,1180],[400,880],[900,810],[1400,880],
             [1850,810],[200,630],[750,580],[1250,530],[1800,580],[550,330],[1180,290],[1750,330]],
  },
];

function mapsFor(mode) { return mode === 'maxi' ? MAPS_MAXI : MAPS_MINI; }
function mapW(m) { return m.w || 1200; }
function mapH(m) { return m.h || 800; }

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
let nextId = 1;       // player + bot ids
let roomSeq = 1;      // room ids
const rooms = [];

function makeRoom(mode, opts = {}) {
  mode = MODES[mode] ? mode : 'mini';
  const maps = mapsFor(mode);
  const room = {
    id: 'R' + (roomSeq++), mode,
    maps, maxPlayers: MODES[mode].maxPlayers,
    private: !!opts.private, code: opts.code || null,
    players: new Map(),         // id -> player or bot
    bbullets: [],               // server-simulated bot bullets
    mapIndex: Math.floor(Math.random() * maps.length),
    roundEndsAt: Date.now() + ROUND_TIME * 1000,
  };
  computeSolids(room);
  rooms.push(room);
  return room;
}

// cache collision geometry for the room's current map (used by bot physics)
function computeSolids(room) {
  const m = room.maps[room.mapIndex];
  const W = mapW(m), H = mapH(m), floorY = H - 40;
  room.world = { w: W, h: H, floorY };
  room.plats = m.plats.map(p => ({ x: p[0], y: p[1], w: p[2], h: p[3] }));
  room.solids = room.plats.concat([{ x: 0, y: floorY, w: W, h: H - floorY + 200 }]);
}

function humanCount(room) { let n = 0; for (const p of room.players.values()) if (!p.isBot) n++; return n; }

// public matchmaking: a non-private room of the right mode with a free human slot
function findPublicRoom(mode) {
  for (const r of rooms) {
    if (r.private || r.mode !== mode) continue;
    if (humanCount(r) < r.maxPlayers) return r;
  }
  return makeRoom(mode);
}

function roomByCode(code) { for (const r of rooms) if (r.code === code) return r; return null; }
function genCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';   // no ambiguous 0/O/1/I/L
  let c;
  do { c = ''; for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)]; } while (roomByCode(c));
  return c;
}

function spawnAt(room) {
  const m = room.maps[room.mapIndex];
  const s = m.spawns[Math.floor(Math.random() * m.spawns.length)];
  return [s[0], s[1]];
}

function send(conn, obj) {
  if (!conn || conn.dead) return;
  try { conn.socket.write(encodeFrame(JSON.stringify(obj))); } catch (e) {}
}

function broadcast(room, obj, exceptId) {
  const data = JSON.stringify(obj);
  for (const p of room.players.values()) {
    if (p.id === exceptId || !p.conn) continue;   // skip bots (no socket)
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
    // room teardown (incl. its bots) is handled in the tick once no humans remain
  }
  try { conn.socket.destroy(); } catch (e) {}
}

/* ---------------------------- Damage adjudication ---------------------------- */
// Central kill/score/death logic, shared by player hit-claims and bot attacks.
function applyDamage(room, attacker, victim, weapon, now) {
  if (!attacker || !victim || victim.dead || victim.id === attacker.id) return;
  if (now < victim.invulnUntil) return;
  victim.hp -= (DMG[weapon] || 0);
  if (victim.hp <= 0) {
    victim.dead = true;
    victim.respawnAt = now + RESPAWN_TIME;
    attacker.score += 1;
    broadcast(room, { t: 'kill', killer: attacker.id, killerName: attacker.name, victim: victim.id, victimName: victim.name, weapon });
  }
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
      if (!victim) break;
      if (msg.weapon === 'melee') {
        const dx = victim.x - p.x, dy = victim.y - p.y;
        if (Math.hypot(dx, dy) > MELEE_MAX_DIST) break;  // light validation
      }
      applyDamage(room, p, victim, msg.weapon, now);
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
  const mode = msg.mode === 'maxi' ? 'maxi' : 'mini';
  let room;
  if (msg.create) {
    room = makeRoom(mode, { private: true, code: genCode() });
  } else if (msg.code) {
    room = roomByCode(String(msg.code).toUpperCase().trim());
    if (!room) { send(conn, { t: 'joinError', msg: 'No game found with that code.' }); return; }
    if (humanCount(room) >= room.maxPlayers) { send(conn, { t: 'joinError', msg: 'That game is full.' }); return; }
  } else {
    room = findPublicRoom(mode);
  }

  const [sx, sy] = spawnAt(room);
  const player = {
    id: nextId++, conn, room, isBot: false,
    name: (msg.name || 'Player').toString().slice(0, 14),
    x: sx, y: sy, vx: 0, vy: 0, w: 26, h: 52, facing: 1, aim: 0,
    sl: 0, wr: 0, saber: 0,
    hp: MAX_HP, dead: false, score: 0,
    respawnAt: 0, invulnUntil: Date.now() + SPAWN_PROTECT,
  };
  conn.player = player;
  room.players.set(player.id, player);
  manageBots(room);   // fill/trim bots now that a human is present

  send(conn, {
    t: 'welcome',
    id: player.id, room: room.id, mode: room.mode, code: room.code,
    map: clientMap(room), mapIndex: room.mapIndex, mapName: room.maps[room.mapIndex].name,
    roundEndsAt: room.roundEndsAt,
    spawn: [sx, sy],
    maxHp: MAX_HP,
  });
  broadcast(room, { t: 'join', id: player.id, name: player.name }, player.id);
}

function clientMap(room) {
  const m = room.maps[room.mapIndex];
  return { name: m.name, plats: m.plats, spawns: m.spawns, w: mapW(m), h: mapH(m) };
}

/* ============================================================================
   Bots — server-simulated combatants that fill out a room so you're never alone.
   They run a small physics sim (mirroring the client feel) plus simple but
   capable AI: target the nearest enemy, lead their movement, only shoot with a
   clear line of sight, chase upward by jumping, and melee at point-blank.
   ============================================================================ */
function pickBotName(room) {
  const taken = new Set([...room.players.values()].map(p => p.name));
  const free = BOT_NAMES.filter(n => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)] + (Math.floor(Math.random() * 90) + 10);
}

function addBot(room) {
  const [sx, sy] = spawnAt(room);
  const bot = {
    id: nextId++, conn: null, room, isBot: true,
    name: pickBotName(room),
    x: sx, y: sy, vx: 0, vy: 0, w: 26, h: 52, facing: 1, aim: 0,
    sl: 0, wr: 0, saber: 0,
    hp: MAX_HP, dead: false, score: 0,
    respawnAt: 0, invulnUntil: Date.now() + SPAWN_PROTECT,
    onGround: false, jumpsUsed: 0, meleeCd: 0, rangedCd: 0,
    prefDist: 240 + Math.random() * 180,   // preferred fighting distance
    err: 0.5 + Math.random() * 0.9,        // aim wobble multiplier (lower = sharper)
    aggro: 0.5 + Math.random() * 0.5,      // jumpiness / chase eagerness
    wander: 0,
  };
  room.players.set(bot.id, bot);
  broadcast(room, { t: 'join', id: bot.id, name: bot.name });
  return bot;
}

function removeBot(room, bot) {
  room.players.delete(bot.id);
  broadcast(room, { t: 'leave', id: bot.id });
}

// Keep the room topped up with bots. Public rooms fill to the mode's target;
// private (friends) rooms only add a single sparring bot until friends arrive.
function manageBots(room) {
  const humans = humanCount(room);
  const bots = [...room.players.values()].filter(p => p.isBot);
  let target;
  if (humans === 0) target = 0;
  else if (room.private) target = Math.max(0, PRIVATE_BOT_TARGET - humans);
  else target = Math.max(0, MODES[room.mode].botTarget - humans);
  target = Math.min(target, room.maxPlayers - humans);

  let n = bots.length;
  while (n < target) { addBot(room); n++; }
  while (n > target) { removeBot(room, bots[--n]); }
}

/* --- server physics helpers (entities use center-x, top-y like the client) --- */
function aabb(a, b) { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

function collideEntity(e, room, dt) {
  const solids = room.solids, Wd = room.world.w;
  const halfW = e.w / 2;
  e.onGround = false;
  // horizontal
  let nx = (e.x - halfW) + e.vx * dt;
  let rect = { x: nx, y: e.y, w: e.w, h: e.h };
  for (const s of solids) {
    if (aabb(rect, s)) {
      if (e.vx > 0) nx = s.x - e.w; else if (e.vx < 0) nx = s.x + s.w;
      e.vx = 0; rect.x = nx;
    }
  }
  if (nx < 0) { nx = 0; e.vx = 0; }
  if (nx + e.w > Wd) { nx = Wd - e.w; e.vx = 0; }
  e.x = nx + halfW;
  // vertical
  const rx = e.x - halfW;
  let ny = e.y + e.vy * dt;
  let rect2 = { x: rx, y: ny, w: e.w, h: e.h };
  for (const s of solids) {
    if (aabb(rect2, s)) {
      if (e.vy > 0) { ny = s.y - e.h; e.onGround = true; e.vy = 0; }
      else if (e.vy < 0) { ny = s.y + s.h; e.vy = 0; }
      rect2.y = ny;
    }
  }
  if (ny < 0) { ny = 0; e.vy = 0; }
  e.y = ny;
}

function angDiff(a, b) { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; }

// segment vs axis-aligned rect (Liang–Barsky); used for bot line-of-sight
function segHitsRect(x1, y1, x2, y2, r) {
  let t0 = 0, t1 = 1; const dx = x2 - x1, dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, (r.x + r.w) - x1, y1 - r.y, (r.y + r.h) - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) { if (q[i] < 0) return false; }
    else { const t = q[i] / p[i]; if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; } else { if (t < t0) return false; if (t < t1) t1 = t; } }
  }
  return true;
}
function lineClear(x1, y1, x2, y2, rects) { for (const r of rects) if (segHitsRect(x1, y1, x2, y2, r)) return false; return true; }

function botFire(bot, room, ang, now) {
  const ox = bot.x, oy = bot.y + bot.h / 2;
  room.bbullets.push({ x: ox, y: oy, vx: Math.cos(ang) * BOTCFG.BULLET_SPEED, vy: Math.sin(ang) * BOTCFG.BULLET_SPEED, life: BOTCFG.BULLET_LIFETIME, owner: bot.id });
  broadcast(room, { t: 'fx', id: bot.id, kind: 'fire', x: ox, y: oy, ang });
}

function botMelee(bot, room, now) {
  const ox = bot.x, oy = bot.y + bot.h / 2, ang = bot.aim;
  broadcast(room, { t: 'fx', id: bot.id, kind: 'swing', x: ox, y: oy, ang });
  for (const p of room.players.values()) {
    if (p.id === bot.id || p.dead) continue;
    const dx = p.x - ox, dy = (p.y + p.h / 2) - oy;
    if (Math.hypot(dx, dy) > BOTCFG.MELEE_RANGE + 18) continue;
    if (Math.abs(angDiff(Math.atan2(dy, dx), ang)) <= BOTCFG.MELEE_ARC / 2) applyDamage(room, bot, p, 'melee', now);
  }
}

function updateBot(bot, room, dt, now) {
  bot.meleeCd = Math.max(0, bot.meleeCd - dt);
  bot.rangedCd = Math.max(0, bot.rangedCd - dt);
  if (bot.onGround) bot.jumpsUsed = 0;

  const cx = bot.x, cy = bot.y + bot.h / 2;
  // nearest living enemy
  let tgt = null, bd = Infinity;
  for (const p of room.players.values()) {
    if (p.id === bot.id || p.dead) continue;
    const dx = p.x - bot.x, dy = p.y - bot.y, d = dx * dx + dy * dy;
    if (d < bd) { bd = d; tgt = p; }
  }

  let inputX = 0, wantJump = false;
  if (tgt) {
    const tcx = tgt.x, tcy = tgt.y + tgt.h / 2;
    const dist = Math.hypot(tcx - cx, tcy - cy);
    const lead = Math.min(dist / BOTCFG.BULLET_SPEED, 0.22);
    const ax = tgt.x + (tgt.vx || 0) * lead, ay = tcy + (tgt.vy || 0) * lead;
    let aim = Math.atan2(ay - cy, ax - cx);
    aim += (Math.random() - 0.5) * 0.05 * bot.err;
    bot.aim = aim; bot.facing = (ax >= cx) ? 1 : -1;

    const pref = bot.prefDist, hdx = tcx - cx;
    if (Math.abs(hdx) > pref + 60) inputX = Math.sign(hdx);
    else if (Math.abs(hdx) < pref - 60) inputX = -Math.sign(hdx || 1);
    else inputX = (Math.random() < 0.4 ? Math.sign(hdx || 1) : 0);

    if (bot.onGround && tcy < cy - 60 && Math.random() < 0.2 + 0.6 * bot.aggro) wantJump = true;
    if (bot.onGround && inputX !== 0 && Math.abs(bot.vx) < 25 && Math.random() < 0.5) wantJump = true;  // blocked → hop
    if (bot.onGround && Math.random() < 0.015) wantJump = true;                                          // random evasion
    if (!bot.onGround && tcy < cy - 130 && bot.vy > -40 && bot.jumpsUsed < 2 && Math.random() < 0.1) { bot.vy = -PHYS.DOUBLE_JUMP; bot.jumpsUsed = 2; }

    if (dist < BOTCFG.MELEE_RANGE + 10 && bot.meleeCd <= 0) { botMelee(bot, room, now); bot.meleeCd = BOTCFG.MELEE_CD; }
    else if (bot.rangedCd <= 0 && dist < BOTCFG.FIRE_RANGE) {
      const direct = Math.atan2(tcy - cy, tcx - cx);
      if (Math.abs(angDiff(bot.aim, direct)) < 0.2 && lineClear(cx, cy, tcx, tcy, room.plats)) {
        botFire(bot, room, bot.aim, now); bot.rangedCd = BOTCFG.RANGED_CD;
      }
    }
  } else {
    if (Math.random() < 0.01) bot.wander = (Math.random() < 0.5 ? -1 : 1);
    inputX = bot.wander || 0;
  }

  // integrate physics
  const accel = bot.onGround ? PHYS.MOVE_ACCEL : PHYS.AIR_ACCEL;
  if (inputX !== 0) { bot.vx += inputX * accel * dt; bot.vx = Math.max(-PHYS.MAX_RUN, Math.min(PHYS.MAX_RUN, bot.vx)); }
  else if (bot.onGround) bot.vx *= Math.pow(PHYS.GROUND_FRICTION, dt);
  else bot.vx *= Math.pow(PHYS.AIR_FRICTION, dt);
  bot.vy += PHYS.GRAVITY * dt; if (bot.vy > PHYS.MAX_FALL) bot.vy = PHYS.MAX_FALL;
  if (wantJump && bot.onGround) { bot.vy = -PHYS.JUMP_FORCE; bot.jumpsUsed = 1; bot.onGround = false; }
  collideEntity(bot, room, dt);
}

// advance bot bullets (sub-stepped so fast shots don't tunnel thin pillars)
function stepBullets(room, dt, now) {
  for (const b of room.bbullets) {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.vx, b.vy) * dt / 12));
    const sdt = dt / steps;
    for (let i = 0; i < steps && !b.dead; i++) {
      b.x += b.vx * sdt; b.y += b.vy * sdt;
      if (b.x < 0 || b.x > room.world.w || b.y < 0 || b.y > room.world.floorY) { b.dead = true; break; }
      for (const s of room.plats) if (b.x > s.x && b.x < s.x + s.w && b.y > s.y && b.y < s.y + s.h) { b.dead = true; break; }
      if (b.dead) break;
      for (const p of room.players.values()) {
        if (p.id === b.owner || p.dead || now < p.invulnUntil) continue;
        const dx = p.x - b.x, dy = (p.y + p.h / 2) - b.y;
        if (dx * dx + dy * dy < 26 * 26) {
          const owner = room.players.get(b.owner);
          applyDamage(room, owner, p, 'ranged', now);
          b.dead = true; break;
        }
      }
    }
    b.life -= dt; if (b.life <= 0) b.dead = true;
  }
  room.bbullets = room.bbullets.filter(b => !b.dead);
}

/* ============================================================================
   Server loops
   ============================================================================ */
// Logic tick: bot population, respawns, physics/bots, bot bullets, map rotation
let lastTick = Date.now();
setInterval(() => {
  const now = Date.now();
  let dt = (now - lastTick) / 1000; lastTick = now;
  if (dt > 0.1) dt = 0.1;

  for (let ri = rooms.length - 1; ri >= 0; ri--) {
    const room = rooms[ri];
    const humans = humanCount(room);
    manageBots(room);
    // tear down rooms that have neither humans nor bots
    if (room.players.size === 0) { rooms.splice(ri, 1); continue; }

    // no humans → freeze (warmup). bots were just removed, so this is rare.
    room.warmup = humans === 0;
    if (room.warmup) { room.roundEndsAt = now + ROUND_TIME * 1000; continue; }

    // respawns
    for (const p of room.players.values()) {
      if (p.dead && now >= p.respawnAt) {
        const [sx, sy] = spawnAt(room);
        p.dead = false; p.hp = MAX_HP; p.x = sx; p.y = sy; p.vx = 0; p.vy = 0;
        p.invulnUntil = now + SPAWN_PROTECT;
        if (p.isBot) { p.onGround = false; p.jumpsUsed = 0; }
        if (p.conn) send(p.conn, { t: 'respawn', x: sx, y: sy });
      }
    }

    // simulate bots + their bullets
    for (const p of room.players.values()) if (p.isBot && !p.dead) { try { updateBot(p, room, dt, now); } catch (e) {} }
    stepBullets(room, dt, now);

    // round / map rotation
    if (now >= room.roundEndsAt) {
      let winner = null, best = -1;
      for (const p of room.players.values()) if (p.score > best) { best = p.score; winner = p; }
      room.mapIndex = (room.mapIndex + 1) % room.maps.length;
      room.roundEndsAt = now + ROUND_TIME * 1000;
      computeSolids(room);
      room.bbullets.length = 0;
      for (const p of room.players.values()) {
        const [sx, sy] = spawnAt(room);
        p.score = 0; p.hp = MAX_HP; p.dead = false; p.x = sx; p.y = sy; p.vx = 0; p.vy = 0;
        p.invulnUntil = now + SPAWN_PROTECT;
        if (p.isBot) { p.onGround = false; p.jumpsUsed = 0; }
      }
      broadcast(room, {
        t: 'mapChange',
        map: clientMap(room), mapIndex: room.mapIndex, mapName: room.maps[room.mapIndex].name,
        roundEndsAt: room.roundEndsAt,
        winnerName: best > 0 && winner ? winner.name : null,
        winnerScore: best > 0 ? best : 0,
      });
      for (const p of room.players.values()) if (p.conn) send(p.conn, { t: 'respawn', x: p.x, y: p.y });
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
    const snap = { t: 'snap', players, roundEndsAt: room.roundEndsAt, warmup: !!room.warmup, need: 1 };
    const data = JSON.stringify(snap);
    for (const p of room.players.values()) {
      if (!p.conn) continue;
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
