
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const WIN_KILLS = 10;
const FFA_MAX = 8;

const rooms = new Map();
const queues = { duel: [], ffa: [] };

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*'
  });

  res.end(JSON.stringify({
    name: 'STEALTH multiplayer server',
    status: 'online',
    modes: ['duel', 'ffa'],
    ffaMax: FFA_MAX,
    winKills: WIN_KILLS,
    bots: false
  }));
});

const wss = new WebSocketServer({ server });

function send(ws, data) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

function broadcast(room, data) {
  for (const p of room.players.values()) {
    send(p.ws, data);
  }
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    x: p.x,
    y: p.y,
    z: p.z,
    yaw: p.yaw,
    hp: p.hp,
    kills: p.kills,
    dead: p.dead
  }));
}

function roomState(room) {
  return {
    type: 'state',
    roomId: room.id,
    mode: room.mode,
    players: publicPlayers(room),
    target: WIN_KILLS
  };
}

function createRoom(mode, clients) {
  const room = {
    id: crypto.randomUUID().slice(0, 8).toUpperCase(),
    mode,
    players: new Map(),
    ended: false
  };

  rooms.set(room.id, room);

  clients.forEach((ws, i) => {
    const id = crypto.randomUUID();

    const x = mode === 'duel'
      ? (i === 0 ? -8 : 8)
      : Math.cos(i * Math.PI * 2 / clients.length) * 12;

    const z = mode === 'duel'
      ? 0
      : Math.sin(i * Math.PI * 2 / clients.length) * 12;

    const p = {
      id,
      ws,
      x,
      y: 0,
      z,
      yaw: Math.atan2(-x, -z),
      hp: 100,
      kills: 0,
      dead: false,
      lastShot: 0,
      respawnAt: 0
    };

    room.players.set(id, p);

    ws.playerId = id;
    ws.roomId = room.id;
    ws.queued = false;

    send(ws, {
      type: 'matchFound',
      id,
      roomId: room.id,
      mode,
      x,
      y: 0,
      z,
      yaw: p.yaw,
      target: WIN_KILLS,
      maxPlayers: mode === 'ffa' ? FFA_MAX : 2
    });
  });

  broadcast(room, roomState(room));
}

function startQueue(mode) {
  const q = queues[mode];
  const max = mode === 'duel' ? 2 : FFA_MAX;

  while (q.length >= max) {
    createRoom(mode, q.splice(0, max));
  }

  if (mode === 'ffa' && q.length >= 2) {
    createRoom(mode, q.splice(0, max));
  }
}

function removeFromQueue(ws) {
  for (const mode of ['duel', 'ffa']) {
    queues[mode] = queues[mode].filter(player => player !== ws);
  }
  ws.queued = false;
}

function removePlayer(ws) {
  removeFromQueue(ws);

  if (!ws.roomId) return;

  const room = rooms.get(ws.roomId);
  if (!room) return;

  room.players.delete(ws.playerId);

  broadcast(room, {
    type: 'playerLeft',
    id: ws.playerId
  });

  if (room.players.size === 0) {
    rooms.delete(room.id);
  }

  ws.roomId = null;
  ws.playerId = null;
}

function respawn(room, player) {
  if (room.ended) return;

  player.hp = 100;
  player.dead = false;
  player.x = Math.random() > 0.5 ? -10 : 10;
  player.y = 0;
  player.z = Math.random() * 10 - 5;

  broadcast(room, {
    type: 'respawn',
    id: player.id,
    x: player.x,
    y: player.y,
    z: player.z,
    hp: player.hp
  });
}

function eliminate(room, victim, attacker, weapon) {
  if (victim.dead || room.ended) return;

  victim.hp = 0;
  victim.dead = true;

  if (attacker) {
    attacker.kills++;

    if (attacker.kills >= WIN_KILLS) {
      room.ended = true;

      broadcast(room, {
        type: 'matchOver',
        winner: attacker.id,
        kills: attacker.kills
      });
      return;
    }
  }

  broadcast(room, {
    type: 'elimination',
    victim: victim.id,
    killer: attacker ? attacker.id : null,
    weapon,
    scores: publicPlayers(room).map(p => ({
      id: p.id,
      kills: p.kills
    }))
  });

  setTimeout(() => {
    if (rooms.has(room.id)) {
      respawn(room, victim);
    }
  }, 2500);
}

function damage(room, victim, attacker, weapon) {
  if (victim.dead || room.ended) return;

  const amount = weapon === 'sniper'
    ? 100
    : weapon === 'knife'
      ? 50
      : 34;

  victim.hp = Math.max(0, victim.hp - amount);

  broadcast(room, {
    type: 'hit',
    victim: victim.id,
    attacker: attacker.id,
    hp: victim.hp
  });

  if (victim.hp <= 0) {
    eliminate(room, victim, attacker, weapon);
  }
}

wss.on('connection', ws => {
  send(ws, { type: 'hello', status: 'connected' });

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      const mode = msg.mode === 'ffa' ? 'ffa' : 'duel';

      removePlayer(ws);

      if (mode === 'duel' && queues.duel.includes(ws)) return;
      if (mode === 'ffa' && queues.ffa.includes(ws)) return;

      ws.queued = true;
      ws.mode = mode;

      queues[mode].push(ws);

      send(ws, {
        type: 'queued',
        mode,
        playersWaiting: queues[mode].length,
        bots: false
      });

      startQueue(mode);
    }

    if (msg.type === 'leaveQueue') {
      removeFromQueue(ws);
      send(ws, { type: 'returnToMenu' });
    }

    if (msg.type === 'move' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      const player = room?.players.get(ws.playerId);

      if (!player || player.dead || room.ended) return;

      player.x = Number(msg.x) || 0;
      player.y = Number(msg.y) || 0;
      player.z = Number(msg.z) || 0;
      player.yaw = Number(msg.yaw) || 0;

      broadcast(room, {
        type: 'playerMoved',
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw
      });
    }

    if (msg.type === 'shoot' && ws.roomId) {
      const room = rooms.get(ws.roomId);
      const attacker = room?.players.get(ws.playerId);

      if (!attacker || attacker.dead || room.ended) return;

      const now = Date.now();
      if (now - attacker.lastShot < 200) return;
      attacker.lastShot = now;

      const victim = room.players.get(msg.target);

      if (!victim || victim.id === attacker.id || victim.dead) return;

      const weapon = ['sniper', 'knife', 'pistol'].includes(msg.weapon)
        ? msg.weapon
        : 'pistol';

      damage(room, victim, attacker, weapon);
    }
  });

  ws.on('close', () => {
    removePlayer(ws);
  });

  ws.on('error', () => {
    removePlayer(ws);
  });
});

server.listen(PORT, () => {
  console.log(`STEALTH server running on port ${PORT}`);
});
