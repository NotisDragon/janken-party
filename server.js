const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

const rooms = {};

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

// 通常じゃんけん判定 (2人用)
function evaluateStandardJanken(hands) {
  const p1 = hands[0];
  const p2 = hands[1];
  if (p1.hand === p2.hand) return { winners: [], isDraw: true };

  const rules = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  if (rules[p1.hand] === p2.hand) {
    return { winners: [p1.id], isDraw: false };
  } else {
    return { winners: [p2.id], isDraw: false };
  }
}

// 多数派勝ち（勝ち残り）判定
function evaluateMajorityJanken(hands) {
  const counts = { rock: 0, scissors: 0, paper: 0 };
  hands.forEach(h => counts[h.hand]++);

  let maxCount = -1;
  let winningHands = [];
  for (const [hand, count] of Object.entries(counts)) {
    if (count > maxCount && count > 0) {
      maxCount = count;
      winningHands = [hand];
    } else if (count === maxCount && count > 0) {
      winningHands.push(hand);
    }
  }

  // 全員同じまたは最大手が複数の場合は引き分け
  if (winningHands.length !== 1 || maxCount === hands.length) {
    return { winners: [], isDraw: true };
  }

  const winningHand = winningHands[0];
  const winners = hands.filter(h => h.hand === winningHand).map(h => h.id);
  return { winners, isDraw: false };
}

// チャット自動送信用関数
function sendSystemChat(roomCode, message) {
  io.to(roomCode).emit('receiveChatMessage', {
    sender: '📢 システム',
    message: message,
    isSystem: true
  });
}

io.on('connection', (socket) => {
  // 部屋作成
  socket.on('createRoom', ({ name }) => {
    const roomCode = generateRoomCode();
    rooms[roomCode] = {
      hostId: socket.id,
      players: {},
      targetWins: 3,
      gameMode: 'standard',
      status: 'lobby',
      currentHands: {},
      survivingPlayers: [] // 勝ち残りモード用の生存プレイヤーリスト
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: name || 'ホスト',
      wins: 0,
      status: 'lobby', // 'lobby' | 'playing' | 'result'
      isEliminated: false
    };

    socket.join(roomCode);
    socket.emit('joinedSuccess', { roomCode, isHost: true });
    broadcastRoomState(roomCode);
  });

  // 部屋参加
  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) return socket.emit('errorMsg', '部屋が存在しません。');
    if (room.status !== 'lobby') return socket.emit('errorMsg', 'ゲーム中のため参加できません。');

    room.players[socket.id] = {
      id: socket.id,
      name: name || `プレイヤー${Object.keys(room.players).length + 1}`,
      wins: 0,
      status: 'lobby',
      isEliminated: false
    };

    socket.join(roomCode);
    socket.emit('joinedSuccess', { roomCode, isHost: false });
    sendSystemChat(roomCode, `${room.players[socket.id].name} が部屋に参加しました。`);
    broadcastRoomState(roomCode);
  });

  // ホストによる設定更新
  socket.on('updateSettings', ({ roomCode, targetWins, gameMode }) => {
    const room = rooms[roomCode];
    if (room && room.hostId === socket.id && room.status === 'lobby') {
      room.targetWins = parseInt(targetWins) || 3;
      room.gameMode = gameMode;
      broadcastRoomState(roomCode);
    }
  });

  // ゲーム開始（全員がロビーにいる場合のみ実行）
  socket.on('startGame', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (!room || room.hostId !== socket.id) return;

    const playersArr = Object.values(room.players);
    if (playersArr.length < 2) {
      return socket.emit('errorMsg', '対戦を開始するには2名以上必要です。');
    }

    // 全員がロビー状態か確認
    const notInLobby = playersArr.filter(p => p.status !== 'lobby');
    if (notInLobby.length > 0) {
      const names = notInLobby.map(p => p.name).join(', ');
      return socket.emit('errorMsg', `まだロビーに戻っていないプレイヤーがいます: (${names})`);
    }

    // ゲーム準備
    room.status = 'playing';
    room.currentHands = {};
    
    playersArr.forEach(p => {
      p.status = 'playing';
      p.isEliminated = false;
    });

    // 勝ち残り用の生存リスト初期化
    room.survivingPlayers = playersArr.map(p => p.id);

    sendSystemChat(roomCode, '🎮 ゲームが開始されました！');
    io.to(roomCode).emit('gameStarted');
    broadcastRoomState(roomCode);
  });

  // じゃんけんの手提出
  socket.on('submitHand', ({ roomCode, hand }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;

    // 脱落しているプレイヤーは無効
    if (room.players[socket.id].isEliminated) return;

    room.currentHands[socket.id] = {
      id: socket.id,
      name: room.players[socket.id].name,
      hand
    };

    // 今回の手を出すべき生存人数
    const activeIds = (room.gameMode === 'majority') ? room.survivingPlayers : Object.keys(room.players);
    const submittedCount = Object.keys(room.currentHands).length;

    io.to(roomCode).emit('handSubmittedCount', { submitted: submittedCount, total: activeIds.length });

    // 生存者全員が手を出し終えたら判定
    if (submittedCount === activeIds.length) {
      const handsList = Object.values(room.currentHands);
      const effectiveMode = (activeIds.length <= 2) ? 'standard' : room.gameMode;

      const result = (effectiveMode === 'majority') 
        ? evaluateMajorityJanken(handsList) 
        : evaluateStandardJanken(handsList);

      let gameOver = false;
      let matchWinner = null;
      let chatMsg = '';

      if (result.isDraw) {
        chatMsg = `【判定】引き分けです！ (手を出した人数: ${activeIds.length}人)`;
      } else {
        const winners = result.winners;
        const winnerNames = handsList.filter(h => winners.includes(h.id)).map(h => h.name).join(', ');

        if (effectiveMode === 'majority') {
          // 多数派勝ち判定（敗者を脱落させる）
          activeIds.forEach(id => {
            if (!winners.includes(id)) {
              room.players[id].isEliminated = true;
            }
          });
          room.survivingPlayers = winners;
          chatMsg = `【多数派勝利】${winnerNames} が生き残りました！`;

          // 残り1人になったらゲーム終了
          if (room.survivingPlayers.length === 1) {
            const winnerId = room.survivingPlayers[0];
            room.players[winnerId].wins += 1;
            gameOver = true;
            matchWinner = room.players[winnerId];
          }
        } else {
          // 通常じゃんけん判定
          winners.forEach(winnerId => {
            if (room.players[winnerId]) {
              room.players[winnerId].wins += 1;
              if (room.players[winnerId].wins >= room.targetWins) {
                gameOver = true;
                matchWinner = room.players[winnerId];
              }
            }
          });
          chatMsg = `【ラウンド勝者】${winnerNames} の勝ち！`;
        }
      }

      // システムチャット通知
      sendSystemChat(roomCode, chatMsg);

      if (gameOver && matchWinner) {
        sendSystemChat(roomCode, `🏆【ゲーム終了】勝者: ${matchWinner.name}！！`);
        room.status = 'result';
        Object.values(room.players).forEach(p => p.status = 'result');
      }

      io.to(roomCode).emit('roundResult', {
        hands: handsList,
        result,
        players: Object.values(room.players),
        effectiveMode,
        gameOver,
        matchWinner,
        survivingPlayers: room.survivingPlayers
      });

      room.currentHands = {};
      broadcastRoomState(roomCode);
    }
  });

  // 個人ごとにロビーへ戻る
  socket.on('returnToLobbyIndividual', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id].status = 'lobby';
      room.players[socket.id].isEliminated = false;

      // 全員がロビーに戻っていたら全体ステータスもロビーに変更
      const allInLobby = Object.values(room.players).every(p => p.status === 'lobby');
      if (allInLobby) {
        room.status = 'lobby';
      }

      socket.emit('individualReturnedToLobby');
      sendSystemChat(roomCode, `${room.players[socket.id].name} がロビーに戻りました。`);
      broadcastRoomState(roomCode);
    }
  });

  // チャット送信
  socket.on('sendChatMessage', ({ roomCode, message }) => {
    const room = rooms[roomCode];
    if (room && room.players[socket.id]) {
      io.to(roomCode).emit('receiveChatMessage', {
        sender: room.players[socket.id].name,
        message: message,
        isSystem: false
      });
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    for (const code in rooms) {
      const room = rooms[code];
      if (room.players[socket.id]) {
        const name = room.players[socket.id].name;
        delete room.players[socket.id];
        sendSystemChat(code, `${name} が切断しました。`);

        if (room.hostId === socket.id) {
          const remaining = Object.keys(room.players);
          if (remaining.length > 0) {
            room.hostId = remaining[0];
          } else {
            delete rooms[code];
            break;
          }
        }
        broadcastRoomState(code);
        break;
      }
    }
  });

  function broadcastRoomState(roomCode) {
    const room = rooms[roomCode];
    if (!room) return;
    io.to(roomCode).emit('roomUpdated', {
      roomCode,
      players: Object.values(room.players),
      targetWins: room.targetWins,
      gameMode: room.gameMode,
      hostId: room.hostId,
      status: room.status
    });
  }
});

// 修正後（クラウドが指定するポートを優先し、なければ3000を使う）:
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ポート ${PORT} で起動中`));