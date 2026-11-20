
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const WIN_KILLS = 10;
const FFA_MAX = 8;
const BOT_NAMES = ['FOX', 'RAVEN', 'VIPER', 'WOLF', 'COBRA', 'HAWK', 'BADGER'];

const rooms = new Map();
const queues = { duel: [], ffa: [] };
const waitingTimers = { duel: null, ffa: null };

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
    bots: true
  }));
});

const wss = new WebSocketServer({ server });

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(room, data) {
  for (const p of room.players.values()) {
    if (!p.isBot) send(p.ws, data);
  }
}

function humanCount(room) {
  return [...room.players.values()].filter(p => !p.isBot).length;
}

function publicPlayers(room) {
  return [...room.players.values()].map(p => ({
    id: p.id,
    name: p.name,
    isBot: !!p.isBot,
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

function spawnFor(mode, i, total) {
  if (mode === 'duel') {
    return { x: i === 0 ? -8 : 8, z: 0 };
  }

  const a = i * Math.PI * 2 / Math.max(1, total);
  return {
    x: Math.cos(a) * 12,
    z: Math.sin(a) * 12
  };
}

function createRoom(mode, clients, botCount = 0) {
  const room = {
    id: crypto.randomUUID().slice(0, 8).toUpperCase(),
    mode,
    players: new Map(),
    ended: false
  };

  rooms.set(room.id, room);

  const total = clients.length + botCount;

  clients.forEach((ws, i) => {
    const id = crypto.randomUUID();
    const pos = spawnFor(mode, i, total);

    const p = {
      id,
      ws,
      name: 'PLAYER',
      isBot: false,
      x: pos.x,
      y: 0,
      z: pos.z,
      yaw: Math.atan2(-pos.x, -pos.z),
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
      x: p.x,
      y: 0,
      z: p.z,
      yaw: p.yaw,
      target: WIN_KILLS,
      maxPlayers: mode === 'ffa' ? FFA_MAX : 2
    });
  });

  for (let i = 0; i < botCount; i++) {
    const pos = spawnFor(mode, clients.length + i, total);
    const id = 'BOT-' + crypto.randomUUID().slice(0, 8);

    room.players.set(id, {
      id,
      ws: null,
      name: BOT_NAMES[i % BOT_NAMES.length],
      isBot: true,
      x: pos.x,
      y: 0,
      z: pos.z,
      yaw: Math.atan2(-pos.x, -pos.z),
      hp: 100,
      kills: 0,
      dead: false,
      lastShot: 0,
      respawnAt: 0,
      thinkAt: 0
    });
  }

  broadcast(room, roomState(room));
}

function startQueue(mode) {
  if (waitingTimers[mode]) {
    clearTimeout(waitingTimers[mode]);
    waitingTimers[mode] = null;
  }

  const q = queues[mode];
  if (!q.length) return;

  if (mode === 'duel') {
    while (q.length >= 2) {
      createRoom('duel', q.splice(0, 2), 0);
    }

    if (q.length === 1) {
      createRoom('duel', q.splice(0, 1), 1);
    }
  } else {
    while (q.length >= FFA_MAX) {
      createRoom('ffa', q.splice(0, FFA_MAX), 0);
    }

    if (q.length) {
      const group = q.splice(0, FFA_MAX);
      createRoom('ffa', group, Math.max(0, FFA_MAX - group.length));
    }
  }
}

function enqueue(ws, mode) {
  if (!['duel', 'ffa'].includes(mode)) {
    return send(ws, {
      type: 'error',
      message: 'Unknown game mode.'
    });
  }

  if (ws.queued || ws.roomId) return;

  ws.queued = true;
  ws.mode = mode;
  queues[mode].push(ws);

  send(ws, {
    type: 'queued',
    mode,
    position: queues[mode].length
  });

  if (mode === 'duel' && queues.duel.length >= 2) {
    return startQueue('duel');
  }

  if (mode === 'ffa' && queues.ffa.length >= FFA_MAX) {
    return startQueue('ffa');
  }

  if (!waitingTimers[mode]) {
    waitingTimers[mode] = setTimeout(
      () => startQueue(mode),
      mode === 'ffa' ? 10000 : 8000
    );
  }
}

function removeFromQueue(ws) {
  for (const mode of ['duel', 'ffa']) {
    const i = queues[mode].indexOf(ws);
    if (i >= 0) queues[mode].splice(i, 1);
  }

  ws.queued = false;
}

function raySphere(origin, dir, centre, radius) {
  const ox = origin.x - centre.x;
  const oy = origin.y - centre.y;
  const oz = origin.z - centre.z;

  const b = ox * dir.x + oy * dir.y + oz * dir.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;

  if (disc < 0) return Infinity;

  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}

function checkWinner(room, shooter) {
  if (shooter.kills >= WIN_KILLS && !room.ended) {
    room.ended = true;

    broadcast(room, {
      type: 'matchOver',
      winner: shooter.id,
      winnerName: shooter.name,
      winnerIsBot: !!shooter.isBot,
      players: publicPlayers(room)
    });

    setTimeout(() => closeRoom(room), 7000);
  }
}

function eliminate(room, shooter, target, now) {
  target.dead = true;
  target.respawnAt = now + 2500;
  shooter.kills++;

  broadcast(room, {
    type: 'elimination',
    killer: shooter.id,
    killerName: shooter.name,
    killerIsBot: !!shooter.isBot,
    victim: target.id,
    victimName: target.name,
    victimIsBot: !!target.isBot,
    kills: shooter.kills,
    players: publicPlayers(room)
  });

  checkWinner(room, shooter);
}

function handleShot(room, shooter, msg) {
  const now = Date.now();

  const cooldown =
    msg.weapon === 'knife' ? 450 :
    msg.weapon === 'sniper' ? 900 : 220;

  if (now - shooter.lastShot < cooldown || shooter.dead) return;

  shooter.lastShot = now;

  const o = msg.origin || {};
  const d = msg.direction || {};

  const len = Math.hypot(
    +d.x || 0,
    +d.y || 0,
    +d.z || 0
  );

  if (!Number.isFinite(len) || len < 0.8 || len > 1.2) return;

  const dir = {
    x: d.x / len,
    y: d.y / len,
    z: d.z / len
  };

  const origin = {
    x: Number(o.x),
    y: Number(o.y),
    z: Number(o.z)
  };

  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return;

  let target = null;
  let closest = Infinity;

  for (const p of room.players.values()) {
    if (p.id === shooter.id || p.dead) continue;

    const distance = raySphere(
      origin,
      dir,
      { x: p.x, y: p.y + 1.0, z: p.z },
      msg.weapon === 'knife' ? 2.2 : 1.05
    );

    if (
      distance < closest &&
      distance <= (
        msg.weapon === 'sniper' ? 140 :
        msg.weapon === 'knife' ? 2.2 : 85
      )
    ) {
      closest = distance;
      target = p;
    }
  }

  if (!target) return;

  target.hp -=
    msg.weapon === 'sniper' ? 100 :
    msg.weapon === 'knife' ? 50 : 34;

  broadcast(room, {
    type: 'hit',
    attacker: shooter.id,
    attackerName: shooter.name,
    target: target.id,
    hp: Math.max(0, target.hp)
  });

  if (target.hp <= 0) {
    eliminate(room, shooter, target, now);
  }
}

function botThink(room, bot, now, dt) {
  if (bot.dead || room.ended || now < bot.thinkAt) return;

  bot.thinkAt = now + 100;

  const candidates = [...room.players.values()]
    .filter(p => p.id !== bot.id && !p.dead);

  if (!candidates.length) return;

  candidates.sort((a, b) =>
    Math.hypot(a.x - bot.x, a.z - bot.z) -
    Math.hypot(b.x - bot.x, b.z - bot.z)
  );

  const target = candidates[0];

  const dx = target.x - bot.x;
  const dz = target.z - bot.z;
  const dist = Math.hypot(dx, dz);

  bot.yaw = Math.atan2(dx, dz);

  if (dist > 11) {
    const step = Math.min(dist - 9, 2.15 * dt);
    bot.x += dx / (dist || 1) * step;
    bot.z += dz / (dist || 1) * step;
  } else if (dist < 6) {
    bot.x -= dx / (dist || 1) * 0.65 * dt;
    bot.z -= dz / (dist || 1) * 0.65 * dt;
  }

  if (dist < 32 && now - bot.lastShot > 1050 + Math.random() * 550) {
    bot.lastShot = now;

    if (Math.random() < (dist < 15 ? 0.48 : 0.30)) {
      target.hp -= 20;

      broadcast(room, {
        type: 'hit',
        attacker: bot.id,
        attackerName: bot.name,
        target: target.id,
        hp: Math.max(0, target.hp)
      });

      if (target.hp <= 0) {
        eliminate(room, bot, target, now);
      }
    }
  }
}

function closeRoom(room) {
  if (!rooms.has(room.id)) return;

  for (const p of room.players.values()) {
    if (!p.isBot) {
      send(p.ws, { type: 'returnToMenu' });
      p.ws.roomId = null;
      p.ws.playerId = null;
    }
  }

  rooms.delete(room.id);
}

wss.on('connection', ws => {
  send(ws, {
    type: 'hello',
    message: 'Connected to STEALTH server.'
  });

  ws.on('message', raw => {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    if (msg.type === 'join') {
      return enqueue(ws, msg.mode);
    }

    if (msg.type === 'leaveQueue') {
      removeFromQueue(ws);
      return;
    }

    const room = rooms.get(ws.roomId);
    if (!room || room.ended) return;

    const player = room.players.get(ws.playerId);
    if (!player || player.isBot) return;

    if (msg.type === 'move') {
      const x = Number(msg.x);
      const y = Number(msg.y);
      const z = Number(msg.z);
      const yaw = Number(msg.yaw);

      if (![x, y, z, yaw].every(Number.isFinite)) return;
      if (Math.hypot(x - player.x, z - player.z) > 3.5) return;

      player.x = x;
      player.y = Math.max(-2, Math.min(8, y));
      player.z = z;
      player.yaw = yaw;
    }

    if (msg.type === 'shoot') {
      handleShot(room, player, msg);
    }
  });

  ws.on('close', () => {
    removeFromQueue(ws);

    const room = rooms.get(ws.roomId);

    if (room) {
      room.players.delete(ws.playerId);

      broadcast(room, {
        type: 'playerLeft',
        id: ws.playerId,
        players: publicPlayers(room)
      });

      if (humanCount(room) === 0) closeRoom(room);
    }
  });
});

setInterval(() => {
  const now = Date.now();

  for (const room of rooms.values()) {
    if (room.ended) continue;

    for (const p of room.players.values()) {
      if (p.dead && p.respawnAt && now >= p.respawnAt) {
        p.dead = false;
        p.hp = 100;
        p.respawnAt = 0;

        const a = Math.random() * Math.PI * 2;
        p.x = Math.cos(a) * 12;
        p.z = Math.sin(a) * 12;
        p.y = 0;

        if (!p.isBot) {
          send(p.ws, {
            type: 'respawn',
            x: p.x,
            y: p.y,
            z: p.z,
            hp: 100
          });
        }
      }

      if (p.isBot) {
        botThink(room, p, now, 0.1);
      }
    }

    broadcast(room, roomState(room));
  }
}, 100);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`STEALTH server listening on ${PORT}`);
});
