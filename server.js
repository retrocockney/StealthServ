const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const WIN_KILLS = 10;
const FFA_MAX = 8;
const rooms = new Map();
const queues = { duel: [], ffa: [] };
const waitingTimers = { duel: null, ffa: null };

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify({ name: 'STEALTH multiplayer server', status: 'online', modes: ['duel', 'ffa'], ffaMax: FFA_MAX, winKills: WIN_KILLS }));
});
const wss = new WebSocketServer({ server });

function send(ws, data) { if (ws.readyState === 1) ws.send(JSON.stringify(data)); }
function broadcast(room, data) { for (const p of room.players.values()) send(p.ws, data); }
function publicPlayers(room) {
  return [...room.players.values()].map(p => ({ id: p.id, x: p.x, y: p.y, z: p.z, yaw: p.yaw, hp: p.hp, kills: p.kills, dead: p.dead }));
}
function roomState(room) {
  return { type: 'state', roomId: room.id, mode: room.mode, players: publicPlayers(room), target: WIN_KILLS };
}
function createRoom(mode, clients) {
  const room = { id: crypto.randomUUID().slice(0, 8).toUpperCase(), mode, players: new Map(), ended: false };
  rooms.set(room.id, room);
  clients.forEach((ws, i) => {
    const id = crypto.randomUUID();
    const spawn = mode === 'duel' ? (i === 0 ? -8 : 8) : (Math.cos(i * Math.PI * 2 / clients.length) * 9);
    const p = { id, ws, x: spawn, y: 0, z: mode === 'duel' ? 0 : Math.sin(i * Math.PI * 2 / clients.length) * 9, yaw: i === 0 ? 0 : Math.PI, hp: 100, kills: 0, dead: false, lastShot: 0, respawnAt: 0 };
    room.players.set(id, p);
    ws.playerId = id; ws.roomId = room.id; ws.queued = false;
    const yaw = Math.atan2(-spawn, -(mode === 'duel' ? 0 : Math.sin(i * Math.PI * 2 / clients.length) * 9));
    send(ws, { type: 'matchFound', id, roomId: room.id, mode, x: spawn, y: 0, z: p.z, yaw, target: WIN_KILLS, maxPlayers: mode === 'ffa' ? FFA_MAX : 2 });
  });
  broadcast(room, roomState(room));
}
function startQueue(mode) {
  if (waitingTimers[mode]) { clearTimeout(waitingTimers[mode]); waitingTimers[mode] = null; }
  const q = queues[mode];
  const max = mode === 'duel' ? 2 : FFA_MAX;
  while (q.length >= (mode === 'duel' ? 2 : FFA_MAX)) {
    const group = q.splice(0, max);
    createRoom(mode, group);
  }
  if (mode === 'ffa' && q.length >= 2) createRoom(mode, q.splice(0, q.length));
  if (q.length >= (mode === 'duel' ? 2 : 2) && !waitingTimers[mode]) waitingTimers[mode] = setTimeout(() => startQueue(mode), mode === 'ffa' ? 12000 : 15000);
}
function enqueue(ws, mode) {
  if (!['duel', 'ffa'].includes(mode)) return send(ws, { type: 'error', message: 'Unknown game mode.' });
  if (ws.queued || ws.roomId) return;
  ws.queued = true; ws.mode = mode; queues[mode].push(ws);
  send(ws, { type: 'queued', mode, position: queues[mode].length });
  if (mode === 'duel') {
    if (queues.duel.length >= 2) startQueue('duel');
    else if (!waitingTimers.duel) waitingTimers.duel = setTimeout(() => startQueue('duel'), 15000);
  } else {
    if (queues.ffa.length >= FFA_MAX) startQueue('ffa');
    else if (!waitingTimers.ffa) waitingTimers.ffa = setTimeout(() => startQueue('ffa'), 12000);
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
  const ox = origin.x-centre.x, oy = origin.y-centre.y, oz = origin.z-centre.z;
  const b = ox*dir.x + oy*dir.y + oz*dir.z;
  const c = ox*ox + oy*oy + oz*oz - radius*radius;
  const disc = b*b-c;
  if (disc < 0) return Infinity;
  const t = -b-Math.sqrt(disc);
  return t >= 0 ? t : Infinity;
}
function handleShot(room, shooter, msg) {
  const now = Date.now();
  const cooldown = msg.weapon === 'knife' ? 450 : (msg.weapon === 'sniper' ? 900 : 220);
  if (now - shooter.lastShot < cooldown || shooter.dead) return;
  shooter.lastShot = now;
  const o = msg.origin || {}, d = msg.direction || {};
  const len = Math.hypot(+d.x || 0, +d.y || 0, +d.z || 0);
  if (!Number.isFinite(len) || len < 0.8 || len > 1.2) return;
  const dir = { x: d.x/len, y: d.y/len, z: d.z/len };
  const origin = { x: Number(o.x), y: Number(o.y), z: Number(o.z) };
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) return;
  let target = null, closest = Infinity;
  for (const p of room.players.values()) {
    if (p.id === shooter.id || p.dead) continue;
    const distance = raySphere(origin, dir, { x:p.x, y:p.y+1.0, z:p.z }, msg.weapon === 'knife' ? 2.2 : 1.05);
    if (distance < closest && distance <= (msg.weapon === 'sniper' ? 140 : msg.weapon === 'knife' ? 2.2 : 85)) { closest = distance; target = p; }
  }
  if (!target) return;
  target.hp -= msg.weapon === 'sniper' ? 100 : msg.weapon === 'knife' ? 50 : 34;
  broadcast(room, { type: 'hit', attacker: shooter.id, target: target.id, hp: Math.max(0, target.hp) });
  if (target.hp <= 0) {
    target.dead = true; target.respawnAt = now + 2500; shooter.kills++;
    broadcast(room, { type: 'elimination', killer: shooter.id, victim: target.id, kills: shooter.kills, players: publicPlayers(room) });
    if (shooter.kills >= WIN_KILLS && !room.ended) {
      room.ended = true;
      broadcast(room, { type: 'matchOver', winner: shooter.id, players: publicPlayers(room) });
      setTimeout(() => closeRoom(room), 7000);
    }
  }
}
function closeRoom(room) {
  if (!rooms.has(room.id)) return;
  for (const p of room.players.values()) { send(p.ws, { type: 'returnToMenu' }); p.ws.roomId = null; p.ws.playerId = null; }
  rooms.delete(room.id);
}

wss.on('connection', ws => {
  send(ws, { type: 'hello', message: 'Connected to STEALTH server.' });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'join') return enqueue(ws, msg.mode);
    if (msg.type === 'leaveQueue') { removeFromQueue(ws); return; }
    const room = rooms.get(ws.roomId);
    if (!room || room.ended) return;
    const player = room.players.get(ws.playerId);
    if (!player) return;
    if (msg.type === 'move') {
      const x = Number(msg.x), y = Number(msg.y), z = Number(msg.z), yaw = Number(msg.yaw);
      if (![x,y,z,yaw].every(Number.isFinite)) return;
      if (Math.hypot(x-player.x, z-player.z) > 3.5) return;
      player.x = x; player.y = Math.max(-2, Math.min(8, y)); player.z = z; player.yaw = yaw;
    }
    if (msg.type === 'shoot') handleShot(room, player, msg);
  });
  ws.on('close', () => {
    removeFromQueue(ws);
    const room = rooms.get(ws.roomId);
    if (room) {
      room.players.delete(ws.playerId);
      broadcast(room, { type: 'playerLeft', id: ws.playerId, players: publicPlayers(room) });
      if (room.players.size < 2) closeRoom(room);
    }
  });
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.dead && p.respawnAt && now >= p.respawnAt && !room.ended) {
        p.dead = false; p.hp = 100; p.respawnAt = 0;
        const a = Math.random() * Math.PI * 2;
        p.x = Math.cos(a) * 12; p.z = Math.sin(a) * 12; p.y = 0;
        send(p.ws, { type: 'respawn', x: p.x, y: p.y, z: p.z, hp: 100 });
      }
    }
    broadcast(room, roomState(room));
  }
}, 50);

server.listen(PORT, '0.0.0.0', () => console.log(`STEALTH server listening on ${PORT}`));
