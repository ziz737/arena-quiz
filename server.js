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
  // إنشاء الغرفة (المضيف هو لاعب أيضاً)
  socket.on('host:create', ({ name }, cb) => {
    const code = generateCode();
    rooms[code] = { 
      code, hostId: socket.id, players: {}, status: 'waiting', 
      question: null, questionIndex: 0, startTime: null 
    };
    rooms[code].players[socket.id] = { id: socket.id, name, score: 0, answered: false, isHost: true };
    socket.join(code);
    socket.roomCode = code;
    socket.isHost = true;
    io.to(code).emit('room:players', getPlayers(rooms[code]));
    cb({ code });
  });

  // انضمام لاعب
  socket.on('guest:join', ({ code, name }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ error: 'الغرفة غير موجودة!' });
    if (room.status === 'ended') return cb({ error: 'المسابقة انتهت!' });
    
    room.players[socket.id] = { id: socket.id, name, score: 0, answered: false, isHost: false };
    socket.join(code);
    socket.roomCode = code;
    io.to(code).emit('room:players', getPlayers(room));
    cb({ success: true });
  });

  // إرسال سؤال جديد
  socket.on('host:question', (data) => {
    const room = rooms[socket.roomCode];
    if (!room || socket.id !== room.hostId) return;
    
    room.question = data;
    room.startTime = Date.now();
    // إعادة ضبط حالة الإجابة للجميع
    Object.keys(room.players).forEach(id => room.players[id].answered = false);
    
    io.to(socket.roomCode).emit('question:new', { ...data, startTime: room.startTime });
  });

  // استقبال الإجابة وحساب النقاط
  socket.on('player:answer', ({ optIndex }) => {
    const room = rooms[socket.roomCode];
    if (!room || !room.players[socket.id]) return;

    const player = room.players[socket.id];
    if (player.answered) return;

    player.answered = true;
    const isCorrect = optIndex === room.question.answer;
    
    if (isCorrect) {
      const timeTaken = (Date.now() - room.startTime) / 1000;
      const points = Math.max(1, Math.ceil(10 - timeTaken));
      player.score += points;
      socket.emit('player:point', { score: player.score, earned: points });
    }

    io.to(socket.roomCode).emit('room:players', getPlayers(room));
  });

  socket.on('host:reveal', () => {
    const room = rooms[socket.roomCode];
    if (room) io.to(socket.roomCode).emit('question:reveal', { correctAnswer: room.question.answer });
  });

  socket.on('disconnect', () => {
    if (socket.isHost) {
      io.to(socket.roomCode).emit('game:host_left');
      delete rooms[socket.roomCode];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ArenaQuiz running on port ${PORT}`));
