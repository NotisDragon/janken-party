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

// 通常じゃんけん判定（2人〜何人でも対応）
function evaluateStandardJanken(hands) {
  const uniqueHands = [...new Set(hands.map(h => h.hand))];

  // 全員同じ手（1種類）または グー・チョキ・パー全種揃い（3種類）はあいこ
  if (uniqueHands.length !== 2) {
    return { winners: [], isDraw: true };
  }

  const rules = { rock: 'scissors', scissors: 'paper', paper: 'rock' };
  const [h1, h2] = uniqueHands;
  const winningHand = (rules[h1] === h2) ? h1 : h2;

  const winners = hands.filter(h => h.hand === winningHand).map(h => h.id);
  return { winners, isDraw: false };
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

  // 全員同じ手、または最大人数が同率で複数ある場合は引き分け
  if (winningHands.length !== 1 || maxCount === hands.length) {
    return { winners: [], isDraw: true };
  }

  const winningHand = winningHands[0];
  const winners = hands.filter(h => h.hand === winningHand).map(h => h.id);
  return { winners, isDraw: false };
}

function sendSystemChat(roomCode, message) {
  io.to(roomCode).emit('receiveChatMessage', {
    sender: '📢 システム',
    message,
    isSystem: true
  });
}

// ラウンド判定と結果配信の共通処理（全員提出時・途中退出時の両方で呼ばれる）
function checkAndResolveRound(roomCode) {
  const room = rooms[roomCode];
  if (!room || room.status !== 'playing') return;

  // 現在手を出せる生存プレイヤー（退出済みを除外）
  const activeIds = (room.gameMode === 'majority')
    ? room.survivingPlayers.filter(id => room.players[id])
    : Object.keys(room.players);

  // もしゲーム中に残りが1人以下になってしまった場合の安全処理
  if (activeIds.length === 0) return;
  if (Object.keys(room.players).length < 2) {
    room.status = 'lobby';
    Object.values(room.players).forEach(p => {
      p.status = 'lobby';
      p.isEliminated = false;
    });
    sendSystemChat(roomCode, 'プレイヤーが2人未満になったためロビーに戻りました。');
    io.to(roomCode).emit('forceReturnToLobby');
    broadcastRoomState(roomCode);
    return;
  }

  const submittedCount = activeIds.filter(id => room.currentHands[id]).length;
  io.to(roomCode).emit('handSubmittedCount', { submitted: submittedCount, total: activeIds.length });

  // 生存者全員の手が揃っていなければ待機
  if (submittedCount < activeIds.length) return;

  const handsList = activeIds.map(id => room.currentHands[id]);
  // 勝ち残りモードで残り2人になった場合は通常じゃんけんルールで決着をつける
  const effectiveMode = (room.gameMode === 'majority' && activeIds.length > 2) ? 'majority' : 'standard';

  const result = (effectiveMode === 'majority')
    ? evaluateMajorityJanken(handsList)
    : evaluateStandardJanken(handsList);

  let gameOver = false;
  let matchWinner = null;
  let setReset = false;
  let chatMsg = '';

  if (result.isDraw) {
    chatMsg = `【判定】あいこです！ (対象人数: ${activeIds.length}人)`;
  } else {
    const winners = result.winners;
    const winnerNames = handsList.filter(h => winners.includes(h.id)).map(h => h.name).join(', ');

    if (room.gameMode === 'majority') {
      // 勝ち残りモード：敗者を脱落（観戦状態）にする
      activeIds.forEach(id => {
        if (!winners.includes(id) && room.players[id]) {
          room.players[id].isEliminated = true;
        }
      });
      room.survivingPlayers = winners;

      if (room.survivingPlayers.length === 1) {
        // 最後の1人になった場合：勝ちポイント+1＆観戦者を全員試合に復帰
        const championId = room.survivingPlayers[0];
        const champion = room.players[championId];
        champion.wins += 1;
        chatMsg = `【勝ち残り制覇】${champion.name} が最後の1人となり勝ちポイント+1！`;

        if (champion.wins >= room.targetWins) {
          gameOver = true;
          matchWinner = champion;
        } else {
          // 次のセットに向けて全員復帰
          setReset = true;
          Object.values(room.players).forEach(p => {
            p.isEliminated = false;
          });
          room.survivingPlayers = Object.keys(room.players);
          chatMsg += ' 観戦していたプレイヤーが試合に復帰します！';
        }
      } else {
        chatMsg = `【勝ち残り】${winnerNames} が生き残りました！（残り${room.survivingPlayers.length}人）`;
      }
    } else {
      // 通常じゃんけんモード（2人〜何人でも勝者全員に+1勝）
      winners.forEach(winnerId => {
        if (room.players[winnerId]) {
          room.players[winnerId].wins += 1;
          if (room.players[winnerId].wins >= room.targetWins && !matchWinner) {
            gameOver = true;
            matchWinner = room.players[winnerId];
          }
        }
      });
      // 複数人同時に目標勝利数に達した場合の勝者名表示
      const topWinners = Object.values(room.players).filter(p => p.wins >= room.targetWins);
      if (topWinners.length > 0) {
        gameOver = true;
        matchWinner = { name: topWinners.map(p => p.name).join(', ') };
      }
      chatMsg = `【ラウンド勝者】${winnerNames} の勝ち！`;
    }
  }

  sendSystemChat(roomCode, chatMsg);

  if (gameOver && matchWinner) {
    sendSystemChat(roomCode, `🏆【試合終了】最終勝者: ${matchWinner.name}！！`);
    room.status = 'result';
    Object.values(room.players).forEach(p => {
      p.status = 'result';
      p.isEliminated = false;
    });
  }

  io.to(roomCode).emit('roundResult', {
    hands: handsList,
    result,
    players: Object.values(room.players),
    roomGameMode: room.gameMode,
    effectiveMode,
    gameOver,
    matchWinner,
    setReset,
    survivingPlayers: room.survivingPlayers
  });

  room.currentHands = {};
  broadcastRoomState(roomCode);
}

// プレイヤーの部屋退出処理（手動退出・切断共通）
function handlePlayerLeave(socket) {
  for (const code in rooms) {
    const room = rooms[code];
    if (room.players[socket.id]) {
      const name = room.players[socket.id].name;
      delete room.players[socket.id];
      delete room.currentHands[socket.id];
      room.survivingPlayers = room.survivingPlayers.filter(id => id !== socket.id);

      socket.leave(code);
      sendSystemChat(code, `${name} が部屋から退出しました。`);

      const remainingIds = Object.keys(room.players);
      if (remainingIds.length === 0) {
        delete rooms[code];
        break;
      }

      // ホストが抜けたら次の人に権限委譲
      if (room.hostId === socket.id) {
        room.hostId = remainingIds[0];
        sendSystemChat(code, `${room.players[room.hostId].name} が新しいホストになりました。`);
      }

      // 試合中だった場合、残りのメンバーでラウンド進行・決着判定を行う
      if (room.status === 'playing') {
        // 勝ち残りモードで退出により生存者が1人になった場合の処理
        if (room.gameMode === 'majority' && room.survivingPlayers.length === 1 && remainingIds.length >= 2) {
          const champion = room.players[room.survivingPlayers[0]];
          champion.wins += 1;
          sendSystemChat(code, `相手の退出により ${champion.name} が勝ち残り制覇（勝ちポイント+1）！`);
          if (champion.wins >= room.targetWins) {
            room.status = 'result';
            Object.values(room.players).forEach(p => { p.status = 'result'; p.isEliminated = false; });
            io.to(code).emit('roundResult', {
              hands: [],
              result: { isDraw: false, winners: [champion.id] },
              players: Object.values(room.players),
              roomGameMode: room.gameMode,
              effectiveMode: 'majority',
              gameOver: true,
              matchWinner: champion,
              setReset: false,
              survivingPlayers: room.survivingPlayers
            });
          } else {
            Object.values(room.players).forEach(p => p.isEliminated = false);
            room.survivingPlayers = Object.keys(room.players);
            room.currentHands = {};
            sendSystemChat(code, '観戦していたプレイヤーが試合に復帰し、次のラウンドへ進みます！');
            io.to(code).emit('forceNextRound');
          }
        } else {
          checkAndResolveRound(code);
        }
      } else {
        // 全員がロビー状態になっていれば部屋もロビーへ
        if (Object.values(room.players).every(p => p.status === 'lobby')) {
          room.status = 'lobby';
        }
      }

      broadcastRoomState(code);
      break;
    }
  }
}

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
      survivingPlayers: []
    };

    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: name || 'ホスト',
      wins: 0,
      status: 'lobby',
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

  // 部屋から退出（スタート画面に戻る）
  socket.on('leaveRoom', () => {
    handlePlayerLeave(socket);
    socket.emit('leftRoomSuccess');
  });

  // ホストによる設定更新
  socket.on('updateSettings', ({ roomCode, targetWins, gameMode }) => {
    const room = rooms[roomCode];
    if (room && room.hostId === socket.id && room.status === 'lobby') {
      room.targetWins = Math.min(100, Math.max(1, parseInt(targetWins) || 3));
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

    const notInLobby = playersArr.filter(p => p.status !== 'lobby');
    if (notInLobby.length > 0) {
      const names = notInLobby.map(p => p.name).join(', ');
      return socket.emit('errorMsg', `まだロビーに戻っていないプレイヤーがいます: (${names})`);
    }

    room.status = 'playing';
    room.currentHands = {};

    playersArr.forEach(p => {
      p.wins = 0;
      p.status = 'playing';
      p.isEliminated = false;
    });

    room.survivingPlayers = playersArr.map(p => p.id);

    sendSystemChat(roomCode, '🎮 ゲームが開始されました！');
    io.to(roomCode).emit('gameStarted');
    broadcastRoomState(roomCode);
  });

  // じゃんけんの手提出
  socket.on('submitHand', ({ roomCode, hand }) => {
    const room = rooms[roomCode];
    if (!room || room.status !== 'playing') return;
    const player = room.players[socket.id];
    if (!player || player.isEliminated) return;

    room.currentHands[socket.id] = {
      id: socket.id,
      name: player.name,
      hand
    };

    checkAndResolveRound(roomCode);
  });

  // 個人ごとにロビーへ戻る
  socket.on('returnToLobbyIndividual', ({ roomCode }) => {
    const room = rooms[roomCode];
    if (room && room.players[socket.id]) {
      room.players[socket.id].status = 'lobby';
      room.players[socket.id].isEliminated = false;

      if (Object.values(room.players).every(p => p.status === 'lobby')) {
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
        message,
        isSystem: false
      });
    }
  });

  // 切断処理
  socket.on('disconnect', () => {
    handlePlayerLeave(socket);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`ポート ${PORT} で起動中`));