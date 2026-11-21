
const http = require('http');
const WebSocket = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;

const WIN_KILLS = 10;
const FFA_MAX = 8;
const SPAWN_RADIUS = 58;
const RESPAWN_DELAY = 2500;
const FFA_WAIT = 8000;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('STEALTH multiplayer server online');
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();
const queues = {
  duel: [],
  ffa: []
};

let ffaTimer = null;

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

function getSpawn(mode, index, total) {
  if (mode === 'duel') {
    const x = index === 0 ? -SPAWN_RADIUS : SPAWN_RADIUS;

    return {
      x,
      y: 0,
      z: 0,
      yaw: index === 0 ? Math.PI / 2 : -Math.PI / 2
    };
  }

  const angle = (Math.PI * 2 * index / total) - Math.PI / 2;

  const x = Math.cos(angle) * SPAWN_RADIUS;
  const z = Math.sin(angle) * SPAWN_RADIUS;

  return {
    x,
    y: 0,
    z,
    yaw: Math.atan2(-x, -z)
  };
}

function getRespawn(room, player) {
  const enemies = room.players.filter(p =>
    p.id !== player.id && !p.dead
  );

  if (room.mode === 'duel') {
    const enemy = enemies[0];

    if (!enemy) {
      return getSpawn('duel', player.spawnIndex, 2);
    }

    const x = enemy.x >= 0 ? -SPAWN_RADIUS : SPAWN_RADIUS;

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
    const x = Math.cos(angle) * SPAWN_RADIUS;
    const z = Math.sin(angle) * SPAWN_RADIUS;

    let nearest = Infinity;

    for (const enemy of enemies) {
      const distance = Math.hypot(
        enemy.x - x,
        enemy.z - z
      );

      nearest = Math.min(nearest, distance);
    }

    if (nearest > bestDistance) {
      bestDistance = nearest;
      best = { x, y: 0, z };
    }
  }

  if (!best) {
    best = getSpawn('ffa', player.spawnIndex, room.players.length);
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

function sendState(room) {
  broadcast(room, {
    type: 'state',
    players: room.players.map(playerData)
  });
}

function createRoom(mode, players) {
  const room = {
    id: makeId(),
    mode,
    players: [],
    over: false
  };

  players.forEach((ws, index) => {
    const spawn = getSpawn(mode, index, players.length);

    const player = {
      id: ws.playerId,
      name: ws.playerName || 'PLAYER',
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

  for (const player of room.players) {
    send(player.ws, {
      type: 'matchFound',
      id: player.id,
      roomId: room.id,
      mode,
      x: player.x,
      y: player.y,
      z: player.z,
      yaw: player.yaw
    });
  }

  sendState(room);

  console.log(
    `Room ${room.id} started: ${mode}, ${room.players.length} real players`
  );
}

function startDuelQueue() {
  while (queues.duel.length >= 2) {
    const players = queues.duel.splice(0, 2);
    createRoom('duel', players);
  }
}

function startFFAQueue() {
  if (ffaTimer) {
    clearTimeout(ffaTimer);
    ffaTimer = null;
  }

  if (queues.ffa.length < 2) return;

  const players = queues.ffa.splice(0, FFA_MAX);
  createRoom('ffa', players);

  if (queues.ffa.length >= 2) {
    scheduleFFA();
  }
}

function scheduleFFA() {
  if (ffaTimer || queues.ffa.length < 2) return;

  ffaTimer = setTimeout(() => {
    ffaTimer = null;
    startFFAQueue();
  }, FFA_WAIT);
}

function removeFromQueues(ws) {
  for (const mode of ['duel', 'ffa']) {
    const index = queues[mode].indexOf(ws);

    if (index !== -1) {
      queues[mode].splice(index, 1);
    }
  }

  ws.queued = false;
}

function joinQueue(ws, mode) {
  if (mode !== 'duel' && mode !== 'ffa') {
    send(ws, { type: 'error', message: 'Invalid game mode.' });
    return;
  }

  if (ws.roomId) {
    send(ws, { type: 'error', message: 'You are already in a match.' });
    return;
  }

  removeFromQueues(ws);

  ws.queued = true;
  queues[mode].push(ws);

  send(ws, {
    type: 'queued',
    mode,
    message: 'Waiting for real players.'
  });

  if (mode === 'duel') {
    startDuelQueue();
  } else {
    scheduleFFA();
  }
}

function finishMatch(room, winner) {
  if (room.over) return;

  room.over = true;

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
  ws.roomId = null;
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
      if (typeof msg.name === 'string') {
        ws.playerName = msg.name.slice(0, 16);
      }

      joinQueue(ws, msg.mode);
      return;
    }

    if (msg.type === 'leaveQueue') {
      removeFromQueues(ws);
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

      player.x = Math.max(-72, Math.min(72, x));
      player.y = Math.max(-10, Math.min(20, y));
      player.z = Math.max(-72, Math.min(72, z));
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
    leaveRoom(ws);
  });

  ws.on('error', () => {
    removeFromQueues(ws);
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
