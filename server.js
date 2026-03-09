const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

app.use(express.static(path.join(__dirname, 'public')));

// ========== GAME STATE ==========
const rooms = {}; // { code: { host, players, status, question, fastestAnswer } }

function generateCode() {
  let code;
  do { code = String(Math.floor(100 + Math.random() * 900)); }
  while (rooms[code]);
  return code;
}

// ========== SOCKET EVENTS ==========
io.on('connection', (socket) => {
  console.log('🔌 Connected:', socket.id);

  // HOST: Create Room
  socket.on('host:create', (cb) => {
    const code = generateCode();
    rooms[code] = {
      code,
      hostId: socket.id,
      players: {},
      status: 'waiting',
      question: null,
      fastestAnswer: null,
      questionIndex: 0
    };
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = true;
    console.log(`🏠 Room created: ${code}`);
    cb({ code });
  });

  // GUEST: Join Room
  socket.on('guest:join', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'الغرفة غير موجودة!' });
    if (room.status === 'ended') return cb({ error: 'المسابقة انتهت!' });

    // Check duplicate name
    const names = Object.values(room.players).map(p => p.name);
    if (names.includes(name)) return cb({ error: 'الاسم مستخدم، اختر اسماً آخر!' });

    room.players[socket.id] = { id: socket.id, name, score: 0, answered: false };
    socket.join(code);
    socket.roomCode = code;
    socket.playerName = name;

    // Notify host & all players
    io.to(code).emit('room:players', getPlayers(room));
    cb({ success: true });
    console.log(`👤 ${name} joined room ${code}`);
  });

  // HOST: Start Game
  socket.on('host:start', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.status = 'playing';
    io.to(socket.roomCode).emit('game:started');
  });

  // HOST: Send Question
  socket.on('host:question', ({ question, options, category, answer, index }) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;

    // Reset player states
    Object.keys(room.players).forEach(id => {
      room.players[id].answered = false;
      room.players[id].pendingAnswer = null;
    });
    room.fastestAnswer = null;
    room.question = { question, options, category, answer, index, startTime: Date.now() };
    room.questionIndex = index;

    // Send to players WITHOUT the answer
    io.to(socket.roomCode).emit('question:new', {
      question, options, category, index, startTime: Date.now()
    });

    // Send full data to host
    socket.emit('host:question:confirm', { question, options, category, answer, index });

    // Update host with player list
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  // PLAYER: Submit Answer
  socket.on('player:answer', ({ optIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.players[socket.id]) return;
    const player = room.players[socket.id];
    if (player.answered) return;

    player.answered = true;
    player.pendingAnswer = optIndex;
    const answerTime = Date.now() - (room.question?.startTime || Date.now());

    // Is it correct?
    const correctAnswer = room.question?.answer;
    const isCorrect = optIndex === correctAnswer;

    // Check if fastest correct answer
    if (isCorrect && !room.fastestAnswer) {
      room.fastestAnswer = { name: player.name, id: socket.id, time: answerTime };
      player.score += 1;

      // Notify host
      io.to(room.hostId).emit('host:fastest', { name: player.name, time: answerTime });

      // Notify the winner
      socket.emit('player:point', { score: player.score });
    }

    // Update answer status
    socket.emit('player:answer:confirm', { isCorrect, optIndex, correctAnswer: isCorrect ? correctAnswer : -1 });

    // Update all with player list (scores + answered count)
    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  // HOST: Reveal Answer
  socket.on('host:reveal', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    const answer = room.question?.answer;

    // Award points to pending correct answers if no one was fastest
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

  // HOST: End Game
  socket.on('host:end', () => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    room.status = 'ended';
    const finalPlayers = getPlayers(room);
    io.to(socket.roomCode).emit('game:ended', { players: finalPlayers });
  });

  // DISCONNECT
  socket.on('disconnect', () => {
    const code = socket.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];

    if (socket.isHost) {
      // Host left - end game
      io.to(code).emit('game:host_left');
      delete rooms[code];
      console.log(`🏠 Room ${code} closed (host left)`);
    } else if (room.players[socket.id]) {
      const name = room.players[socket.id].name;
      delete room.players[socket.id];
      io.to(code).emit('room:players', getPlayers(room));
      console.log(`👤 ${name} left room ${code}`);
    }
  });
});

function getPlayers(room) {
  return Object.values(room.players).sort((a, b) => b.score - a.score);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ArenaQuiz running on port ${PORT}`));
