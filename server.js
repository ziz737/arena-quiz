const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });
app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

function generateCode() {
  let code;
  do { code = String(Math.floor(100 + Math.random() * 900)); } while (rooms[code]);
  return code;
}
function getPlayers(room) {
  return Object.values(room.players).sort((a, b) => b.score - a.score);
}

io.on('connection', (socket) => {

  // HOST: Create Room (host is also a player)
  socket.on('host:create', ({ name }, cb) => {
    const code = generateCode();
    rooms[code] = { code, hostId: socket.id, players: {}, status: 'waiting', question: null, fastestAnswer: null, questionIndex: 0 };
    rooms[code].players[socket.id] = { id: socket.id, name, score: 0, answered: false, isHost: true };
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = true;
    socket.playerName = name;
    io.to(code).emit('room:players', getPlayers(rooms[code]));
    cb({ code });
  });

  // GUEST: Join
  socket.on('guest:join', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'الغرفة غير موجودة!' });
    if (room.status === 'ended') return cb({ error: 'المسابقة انتهت!' });
    const names = Object.values(room.players).map(p => p.name);
    if (names.includes(name)) return cb({ error: 'الاسم مستخدم، اختر اسماً آخر!' });
    room.players[socket.id] = { id: socket.id, name, score: 0, answered: false, isHost: false };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;
    io.to(code).emit('room:players', getPlayers(room));
    cb({ success: true });
  });

  // HOST: Start
  socket.on('host:start', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.status = 'playing';
    socket.to(socket.roomCode).emit('game:started');
  });

  // HOST: Question
  socket.on('host:question', ({ question, options, category, answer, index }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    Object.keys(room.players).forEach(id => { room.players[id].answered = false; room.players[id].pendingAnswer = null; });
    room.fastestAnswer = null;
    room.question = { question, options, category, answer, index, startTime: Date.now() };
    room.questionIndex = index;
    io.to(socket.roomCode).emit('question:new', { question, options, category, index, startTime: Date.now() });
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  // PLAYER: Answer
  socket.on('player:answer', ({ optIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    if (player.answered) return;
    player.answered = true;
    player.pendingAnswer = optIndex;
    const answerTime = Date.now() - (room.question?.startTime || Date.now());
    const correctAnswer = room.question?.answer;
    const isCorrect = optIndex === correctAnswer;
    if (isCorrect && !room.fastestAnswer) {
      room.fastestAnswer = { name: player.name, id: socket.id, time: answerTime };
      player.score += 1;
      io.to(room.hostId).emit('host:fastest', { name: player.name, time: answerTime });
      socket.emit('player:point', { score: player.score });
    }
    socket.emit('player:answer:confirm', { isCorrect, optIndex, correctAnswer: isCorrect ? correctAnswer : -1 });
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  // HOST: Reveal
  socket.on('host:reveal', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    const answer = room.question?.answer;
    Object.keys(room.players).forEach(id => {
      const p = room.players[id];
      if (p.pendingAnswer === answer && !room.fastestAnswer) {
        p.score += 1;
        io.to(id).emit('player:point', { score: p.score });
      }
    });
    io.to(socket.roomCode).emit('question:reveal', { correctAnswer: answer });
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  // HOST: Kick Player
  socket.on('host:kick', ({ playerId }, cb) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId || !room.players[playerId] || playerId === socket.id) return;
    const name = room.players[playerId].name;
    delete room.players[playerId];
    io.to(playerId).emit('player:kicked');
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
    if (cb) cb({ success: true, name });
  });

  // HOST: End
  socket.on('host:end', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.status = 'ended';
    io.to(socket.roomCode).emit('game:ended', { players: getPlayers(room) });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    if (socket.isHost) {
      io.to(code).emit('game:host_left');
      delete rooms[code];
    } else if (room.players[socket.id]) {
      delete room.players[socket.id];
      io.to(code).emit('room:players', getPlayers(room));
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ArenaQuiz on port ${PORT}`));
