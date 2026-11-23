const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const WIN_KILLS = 10;
const FFA_MAX = 8;
const RESPAWN_DELAY = 2500;
const FFA_WAIT = 8000;
const MATCH_MS = 5 * 60 * 1000; // default match length (queued matches)

// Each map has its own boundary (players are clamped inside it) and spawn radius.
const MAPS = {
  woodland: { bound: 120, spawnR: 58 },
  mini:     { bound: 40,  spawnR: 30 }
};
const MAP_IDS = Object.keys(MAPS);

// Custom room options
const CODE_RE = /^[A-Z0-9]{4,8}$/;
const LOADOUTS = ['pistol', 'knife', 'sniper'];
const MINUTES = [3, 5, 10];

// Look limits: clothes colour must be #rrggbb or "camo"; face must be a small JPEG/PNG data URL.
const MAX_FACE_CHARS = 140000; // about 100 KB of base64
const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;
const FACE_PREFIX = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;

function sanitizeMap(m) {
  return MAP_IDS.includes(m) ? m : 'woodland';
}

function sanitizeLook(look) {
  const clean = { clothes: 'camo', face: null };
  if (!look || typeof look !== 'object') return clean;
  if (typeof look.clothes === 'string' && HEX_COLOUR.test(look.clothes)) {
    clean.clothes = look.clothes.toLowerCase();
  }
  if (
    typeof look.face === 'string' &&
    look.face.length <= MAX_FACE_CHARS &&
    FACE_PREFIX.test(look.face)
  ) {
    clean.face = look.face;
  }
  return clean;
}

function sanitizeSettings(raw) {
  const s = raw || {};
  const minutes = MINUTES.includes(Number(s.minutes)) ? Number(s.minutes) : 5;
  const maxPlayers = Math.min(8, Math.max(2, parseInt(s.maxPlayers, 10) || 8));
  const loadout = LOADOUTS.includes(s.loadout) ? s.loadout : 'pistol';
  const map = sanitizeMap(s.map);
  return { minutes, maxPlayers, loadout, map };
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('STEALTH multiplayer server online');
});

const wss = new WebSocket.Server({ server, maxPayload: 256 * 1024 });

const rooms = new Map();          // running matches
const customRooms = new Map();    // custom rooms waiting for the host to start

// Queues are split by mode and map, so players only meet on the map they chose.
const queues = {};
const ffaTimers = {};
for (const mode of ['duel', 'ffa']) {
  for (const map of MAP_IDS) queues[mode + ':' + map] = [];
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const player of room.players) {
    send(player.ws, data);
  }
}

function makeId() {
  return crypto.randomBytes(8).toString('hex');
}

function applyPlayerInfo(ws, msg) {
  if (typeof msg.name === 'string') {
    ws.playerName = msg.name.slice(0, 16) || 'PLAYER';
  }
  ws.look = sanitizeLook(msg.look);
}

function clampToMap(map, v) {
  const b = MAPS[map].bound;
  return Math.max(-b, Math.min(b, v));
}

function getSpawn(mode, map, index, total) {
  const R = MAPS[map].spawnR;

  if (mode === 'duel') {
    const x = index === 0 ? -R : R;

    return {
      x,
      y: 0,
      z: 0,
      yaw: index === 0 ? Math.PI / 2 : -Math.PI / 2
    };
  }

  const angle = (Math.PI * 2 * index / total) - Math.PI / 2;

  const x = Math.cos(angle) * R;
  const z = Math.sin(angle) * R;

  return {
    x,
    y: 0,
    z,
    yaw: Math.atan2(-x, -z)
  };
}

function getRespawn(room, player) {
  const R = MAPS[room.map].spawnR;

  const enemies = room.players.filter(p =>
    p.id !== player.id && !p.dead
  );

  if (room.mode === 'duel') {
    const enemy = enemies[0];

    if (!enemy) {
      return getSpawn('duel', room.map, player.spawnIndex, 2);
    }

    const x = enemy.x >= 0 ? -R : R;

    return {
      x,
      y: 0,
      z: (Math.random() - 0.5) * 8,
      yaw: Math.atan2(-enemy.x + x, -enemy.z)
    };
  }

  let best = null;
  let bestDistance = -1;

  for (let i = 0; i < 48; i++) {
    const angle = Math.random() * Math.PI * 2;
    const x = Math.cos(angle) * R;
    const z = Math.sin(angle) * R;

    let nearest = Infinity;

    for (const enemy of enemies) {
      const distance = Math.hypot(enemy.x - x, enemy.z - z);
      nearest = Math.min(nearest, distance);
    }

    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = { x, y: 0, z };
    }
  }

  if (!best) {
    best = getSpawn('ffa', room.map, player.spawnIndex, room.players.length);
  }

  const enemy = enemies[0];

  best.yaw = enemy
    ? Math.atan2(-enemy.x + best.x, -enemy.z + best.z)
    : 0;

  return best;
}

function playerData(player) {
  return {
    id: player.id,
    name: player.name,
    x: player.x,
    y: player.y,
    z: player.z,
    yaw: player.yaw,
    hp: player.hp,
    kills: player.kills,
    dead: player.dead,
    isBot: false
  };
}

// Looks are sent once per match (not in every state tick) to keep traffic small.
function sendLooks(room) {
  broadcast(room, {
    type: 'looks',
    players: room.players.map(p => ({
      id: p.id,
      look: p.look
    }))
  });
}

function sendState(room) {
  broadcast(room, {
    type: 'state',
    players: room.players.map(playerData)
  });
}

function createRoom(mode, players, opts = {}) {
  const map = sanitizeMap(opts.map);

  const room = {
    id: makeId(),
    mode,
    map,
    players: [],
    over: false,
    matchMs: opts.matchMs || MATCH_MS,
    loadout: opts.loadout || null
  };

  players.forEach((ws, index) => {
    const spawn = getSpawn(mode, map, index, players.length);

    const player = {
      id: ws.playerId,
      name: ws.playerName || 'PLAYER',
      look: ws.look || sanitizeLook(null),
      ws,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      yaw: spawn.yaw,
      hp: 100,
      kills: 0,
      dead: false,
      spawnIndex: index,
      lastShot: 0
    };

    player.roomId = room.id;
    ws.roomId = room.id;
    ws.queued = false;

    room.players.push(player);
  });

  rooms.set(room.id, room);

  // When time runs out, the player with the most kills wins (a tie is a draw).
  room.timer = setTimeout(() => {
    if (room.over) return;
    const ranked = [...room.players].sort((a, b) => b.kills - a.kills);
    const tie = ranked.length > 1 && ranked[0].kills === ranked[1].kills;
    finishMatch(room, tie ? null : ranked[0]);
  }, room.matchMs);

  for (const player of room.players) {
    send(player.ws, {
      type: 'matchFound',
      id: player.id,
      roomId: room.id,
      mode,
      map,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw,
      matchMs: room.matchMs,
      loadout: room.loadout
    });
  }

  sendLooks(room);
  sendState(room);

  console.log(
    `Room ${room.id} started: ${mode} on ${map}, ${room.players.length} real players`
  );
}

function startDuelQueue(map) {
  const q = queues['duel:' + map];
  while (q.length >= 2) {
    const players = q.splice(0, 2);
    createRoom('duel', players, { map });
  }
}

function startFFAQueue(map) {
  if (ffaTimers[map]) {
    clearTimeout(ffaTimers[map]);
    ffaTimers[map] = null;
  }

  const q = queues['ffa:' + map];
  if (q.length < 2) return;

  const players = q.splice(0, FFA_MAX);
  createRoom('ffa', players, { map });

  if (q.length >= 2) {
    scheduleFFA(map);
  }
}

function scheduleFFA(map) {
  const q = queues['ffa:' + map];
  if (ffaTimers[map] || q.length < 2) return;

  ffaTimers[map] = setTimeout(() => {
    ffaTimers[map] = null;
    startFFAQueue(map);
  }, FFA_WAIT);
}

function removeFromQueues(ws) {
  for (const key of Object.keys(queues)) {
    const index = queues[key].indexOf(ws);

    if (index !== -1) {
      queues[key].splice(index, 1);
    }
  }

  ws.queued = false;
}

function joinQueue(ws, mode, map) {
  if (mode !== 'duel' && mode !== 'ffa') {
    send(ws, { type: 'error', message: 'Invalid game mode.' });
    return;
  }

  if (ws.roomId || ws.customCode) {
    send(ws, { type: 'error', message: 'You are already in a match or room.' });
    return;
  }

  const useMap = sanitizeMap(map);

  removeFromQueues(ws);

  ws.queued = true;
  queues[mode + ':' + useMap].push(ws);

  send(ws, {
    type: 'queued',
    mode,
    map: useMap,
    message: 'Waiting for real players.'
  });

  if (mode === 'duel') {
    startDuelQueue(useMap);
  } else {
    scheduleFFA(useMap);
  }
}

// ---- Custom rooms ----

function updateCustomRoom(room) {
  for (const m of room.members) {
    send(m, {
      type: 'roomUpdate',
      code: room.code,
      count: room.members.length,
      max: room.settings.maxPlayers
    });
  }
}

function createCustom(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();

  if (!CODE_RE.test(code)) {
    send(ws, { type: 'error', message: 'Room code must be 4 to 8 letters or numbers.' });
    return;
  }
  if (customRooms.has(code)) {
    send(ws, { type: 'error', message: 'That room code is already in use.' });
    return;
  }
  if (ws.roomId || ws.customCode) {
    send(ws, { type: 'error', message: 'Leave your current match or room first.' });
    return;
  }

  removeFromQueues(ws);
  applyPlayerInfo(ws, msg);

  const settings = sanitizeSettings(msg.settings);
  const room = { code, settings, host: ws, members: [ws] };

  customRooms.set(code, room);
  ws.customCode = code;

  send(ws, {
    type: 'roomJoined',
    code,
    isHost: true,
    settings,
    count: 1,
    max: settings.maxPlayers
  });
}

function joinCustom(ws, msg) {
  const code = String(msg.code || '').toUpperCase().trim();
  const room = customRooms.get(code);

  if (!room) {
    send(ws, { type: 'error', message: 'No room with that code.' });
    return;
  }
  if (ws.roomId || ws.customCode) {
    send(ws, { type: 'error', message: 'Leave your current match or room first.' });
    return;
  }
  if (room.members.length >= room.settings.maxPlayers) {
    send(ws, { type: 'error', message: 'That room is full.' });
    return;
  }

  removeFromQueues(ws);
  applyPlayerInfo(ws, msg);

  room.members.push(ws);
  ws.customCode = code;

  send(ws, {
    type: 'roomJoined',
    code,
    isHost: false,
    settings: room.settings,
    count: room.members.length,
    max: room.settings.maxPlayers
  });

  updateCustomRoom(room);
}

function startCustom(ws) {
  const room = customRooms.get(ws.customCode);

  if (!room || room.host !== ws) {
    send(ws, { type: 'error', message: 'Only the host can start the match.' });
    return;
  }
  if (room.members.length < 2) {
    send(ws, { type: 'error', message: 'You need at least 2 players to start.' });
    return;
  }

  customRooms.delete(room.code);

  const members = room.members;
  for (const m of members) m.customCode = null;

  createRoom('custom', members, {
    matchMs: room.settings.minutes * 60 * 1000,
    loadout: room.settings.loadout,
    map: room.settings.map
  });
}

function leaveCustom(ws) {
  const code = ws.customCode;
  if (!code) return;

  ws.customCode = null;

  const room = customRooms.get(code);
  if (!room) return;

  if (room.host === ws) {
    // Host left: close the room and send everyone back to the menu.
    for (const m of room.members) {
      if (m === ws) continue;
      m.customCode = null;
      send(m, { type: 'error', message: 'The host left the room.' });
      send(m, { type: 'returnToMenu' });
    }
    customRooms.delete(code);
  } else {
    room.members = room.members.filter(m => m !== ws);
    updateCustomRoom(room);
  }
}

function finishMatch(room, winner) {
  if (room.over) return;

  room.over = true;
  clearTimeout(room.timer);

  broadcast(room, {
    type: 'matchOver',
    winner: winner ? winner.id : null
  });

  console.log(`Room ${room.id} finished`);

  setTimeout(() => {
    broadcast(room, { type: 'returnToMenu' });

    for (const player of room.players) {
      player.ws.roomId = null;
    }

    rooms.delete(room.id);
  }, 6000);
}

function eliminate(room, attacker, victim) {
  if (victim.dead || room.over) return;

  victim.hp = 0;
  victim.dead = true;
  attacker.kills++;

  broadcast(room, {
    type: 'hit',
    attacker: attacker.id,
    target: victim.id,
    hp: victim.hp
  });

  broadcast(room, {
    type: 'elimination',
    killer: attacker.id,
    victim: victim.id,
    killerIsBot: false,
    victimIsBot: false,
    killerName: attacker.name,
    victimName: victim.name
  });

  sendState(room);

  if (attacker.kills >= WIN_KILLS) {
    finishMatch(room, attacker);
    return;
  }

  setTimeout(() => {
    if (room.over || !room.players.includes(victim)) return;

    const spawn = getRespawn(room, victim);

    victim.x = spawn.x;
    victim.y = spawn.y;
    victim.z = spawn.z;
    victim.yaw = spawn.yaw;
    victim.hp = 100;
    victim.dead = false;

    send(victim.ws, {
      type: 'respawn',
      x: victim.x,
      y: victim.y,
      z: victim.z,
      yaw: victim.yaw,
      hp: victim.hp
    });

    sendState(room);
  }, RESPAWN_DELAY);
}

function shoot(room, attacker, msg) {
  if (room.over || attacker.dead) return;

  const now = Date.now();

  const weapon = msg.weapon || 'pistol';
  const isKnife = weapon === 'knife';

  const cooldown = isKnife ? 650 : 250;

  if (now - attacker.lastShot < cooldown) return;
  attacker.lastShot = now;

  const origin = msg.origin;
  const direction = msg.direction;

  if (!origin || !direction) return;

  let dx = Number(direction.x);
  let dy = Number(direction.y);
  let dz = Number(direction.z);

  const length = Math.hypot(dx, dy, dz);

  if (!Number.isFinite(length) || length < 0.001) return;

  dx /= length;
  dy /= length;
  dz /= length;

  const ox = Number(origin.x);
  const oy = Number(origin.y);
  const oz = Number(origin.z);

  if (![ox, oy, oz].every(Number.isFinite)) return;

  const range = isKnife ? 3.5 : 120;
  const hitRadius = isKnife ? 1.4 : 0.75;

  let closest = null;
  let closestDistance = range;

  for (const target of room.players) {
    if (
      target.id === attacker.id ||
      target.dead
    ) continue;

    const tx = target.x - ox;
    const ty = (target.y + 1.1) - oy;
    const tz = target.z - oz;

    const along = tx * dx + ty * dy + tz * dz;

    if (along < 0 || along > range) continue;

    const cx = ox + dx * along;
    const cy = oy + dy * along;
    const cz = oz + dz * along;

    const distance = Math.hypot(
      target.x - cx,
      (target.y + 1.1) - cy,
      target.z - cz
    );

    if (
      distance <= hitRadius &&
      along < closestDistance
    ) {
      closest = target;
      closestDistance = along;
    }
  }

  if (!closest) return;

  const damage = isKnife ? 100 : weapon === 'sniper' ? 100 : 34;

  closest.hp = Math.max(0, closest.hp - damage);

  broadcast(room, {
    type: 'hit',
    attacker: attacker.id,
    target: closest.id,
    hp: closest.hp
  });

  if (closest.hp <= 0) {
    eliminate(room, attacker, closest);
  } else {
    sendState(room);
  }
}

function leaveRoom(ws) {
  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  ws.roomId = null;

  if (!room) return;

  room.players = room.players.filter(p => p.ws !== ws);

  if (room.players.length === 0) {
    rooms.delete(room.id);
  } else if (room.players.length === 1 && !room.over) {
    const remaining = room.players[0];

    finishMatch(room, remaining);
  } else {
    sendState(room);
  }
}

wss.on('connection', ws => {
  ws.playerId = makeId();
  ws.playerName = 'PLAYER';
  ws.look = sanitizeLook(null);
  ws.roomId = null;
  ws.customCode = null;
  ws.queued = false;

  send(ws, {
    type: 'hello',
    id: ws.playerId
  });

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    if (msg.type === 'join') {
      applyPlayerInfo(ws, msg);
      joinQueue(ws, msg.mode, msg.map);
      return;
    }

    if (msg.type === 'createRoom') {
      createCustom(ws, msg);
      return;
    }

    if (msg.type === 'joinRoom') {
      joinCustom(ws, msg);
      return;
    }

    if (msg.type === 'startRoom') {
      startCustom(ws);
      return;
    }

    if (msg.type === 'leaveQueue') {
      removeFromQueues(ws);
      leaveCustom(ws);
      send(ws, { type: 'returnToMenu' });
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || room.over) return;

    const player = room.players.find(p => p.ws === ws);
    if (!player) return;

    if (msg.type === 'move') {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const yaw = Number(msg.yaw);

      if (![x, y, z, yaw].every(Number.isFinite)) return;

      player.x = clampToMap(room.map, x);
      player.y = Math.max(-10, Math.min(20, y));
      player.z = clampToMap(room.map, z);
      player.yaw = yaw;

      return;
    }

    if (msg.type === 'shoot') {
      shoot(room, player, msg);
      return;
    }
  });

  ws.on('close', () => {
    removeFromQueues(ws);
    leaveCustom(ws);
    leaveRoom(ws);
  });

  ws.on('error', () => {
    removeFromQueues(ws);
    leaveCustom(ws);
    leaveRoom(ws);
  });
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (!room.over) sendState(room);
  }
}, 100);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`STEALTH server running on port ${PORT}`);
});
