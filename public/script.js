const socket = io();
let currentRoomCode = '';
let isHost = false;
let myHandSelected = false;
let isMyEliminated = false;

function switchTab(tab) {
  document.getElementById('tabCreate').classList.toggle('active', tab === 'create');
  document.getElementById('tabJoin').classList.toggle('active', tab === 'join');
  document.getElementById('createArea').style.display = tab === 'create' ? 'block' : 'none';
  document.getElementById('joinArea').style.display = tab === 'join' ? 'block' : 'none';
}

function createRoom() {
  const name = document.getElementById('playerName').value.trim() || 'ホスト';
  socket.emit('createRoom', { name });
}

function joinRoom() {
  const name = document.getElementById('playerName').value.trim() || 'ゲスト';
  const roomCode = document.getElementById('roomCodeInput').value.trim();
  if (!roomCode) return alert('部屋コードを入力してください。');
  socket.emit('joinRoom', { roomCode, name });
}

socket.on('joinedSuccess', (data) => {
  currentRoomCode = data.roomCode;
  isHost = data.isHost;
  document.getElementById('chatBox').innerHTML = '';
  document.getElementById('entranceScreen').classList.remove('active');
  document.getElementById('roomScreen').classList.add('active');
});

// 部屋から退出して最初の画面へ戻る
function leaveRoom() {
  socket.emit('leaveRoom');
}

socket.on('leftRoomSuccess', () => {
  currentRoomCode = '';
  isHost = false;
  myHandSelected = false;
  isMyEliminated = false;
  document.getElementById('roomScreen').classList.remove('active');
  document.getElementById('entranceScreen').classList.add('active');
});

function updateSettings() {
  if (!isHost) return;
  const targetWins = document.getElementById('targetWinsInput').value;
  const gameMode = document.getElementById('gameModeSelect').value;
  socket.emit('updateSettings', { roomCode: currentRoomCode, targetWins, gameMode });
}

function startGame() {
  if (!isHost) return;
  socket.emit('startGame', { roomCode: currentRoomCode });
}

// 部屋ステータスの同期処理
socket.on('roomUpdated', (data) => {
  currentRoomCode = data.roomCode;
  isHost = (socket.id === data.hostId);

  document.getElementById('roomCodeDisplay').innerText = data.roomCode;
  document.getElementById('targetWinsDisplay').innerText = data.targetWins;
  
  const modeText = (data.gameMode === 'majority') ? '多数派勝ち（勝ち残り）' : '通常じゃんけん';
  document.getElementById('modeDisplay').innerText = modeText;

  if (isHost) {
    document.getElementById('targetWinsInput').value = data.targetWins;
    document.getElementById('gameModeSelect').value = data.gameMode;
  }

  const me = data.players.find(p => p.id === socket.id);
  const myStatus = me ? me.status : 'lobby';
  isMyEliminated = me ? me.isEliminated : false;

  document.getElementById('hostSettingsPanel').style.display = (isHost && data.status === 'lobby') ? 'block' : 'none';
  document.getElementById('waitingHostMsg').style.display = (!isHost && data.status === 'lobby') ? 'block' : 'none';

  if (myStatus === 'lobby') {
    document.getElementById('gamePlayArea').style.display = 'none';
    document.getElementById('resultArea').style.display = 'none';
  }

  // 参加者カードリスト描画
  const grid = document.getElementById('playersList');
  grid.innerHTML = data.players.map(p => {
    let statusBadge = '';
    if (p.status === 'lobby') statusBadge = '<span class="player-status-badge lobby">ロビー待機</span>';
    else if (p.isEliminated) statusBadge = '<span class="player-status-badge eliminated">観戦中（脱落）</span>';
    else statusBadge = '<span class="player-status-badge playing">対戦中</span>';

    return `
      <div class="player-card ${p.id === data.hostId ? 'is-host' : ''}">
        <div class="player-name">${p.name}</div>
        <div class="player-wins">${p.wins} 勝</div>
        <div>${statusBadge}</div>
      </div>
    `;
  }).join('');
});

socket.on('gameStarted', () => {
  preparePlayScreen();
});

socket.on('forceNextRound', () => {
  preparePlayScreen();
});

socket.on('forceReturnToLobby', () => {
  document.getElementById('gamePlayArea').style.display = 'none';
  document.getElementById('resultArea').style.display = 'none';
});

function preparePlayScreen() {
  myHandSelected = false;
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('gamePlayArea').style.display = 'block';

  if (isMyEliminated) {
    // 観戦モード表示（ロビーには戻さない）
    document.getElementById('eliminatedMsg').style.display = 'block';
    document.getElementById('handSelectionBox').style.display = 'none';
    document.getElementById('statusMsg').innerText = '生き残っているプレイヤーの選択を待っています...';
  } else {
    document.getElementById('eliminatedMsg').style.display = 'none';
    document.getElementById('handSelectionBox').style.display = 'block';
    disableHandButtons(false);
    document.getElementById('statusMsg').innerText = '手を選択してください';
  }
}

function selectHand(hand) {
  if (myHandSelected || isMyEliminated) return;
  myHandSelected = true;
  disableHandButtons(true);
  document.getElementById('statusMsg').innerText = '他のプレイヤーの選択を待っています...';
  socket.emit('submitHand', { roomCode: currentRoomCode, hand });
}

function disableHandButtons(disabled) {
  document.querySelectorAll('.circle-btn').forEach(btn => btn.disabled = disabled);
}

socket.on('handSubmittedCount', ({ submitted, total }) => {
  if (myHandSelected || isMyEliminated) {
    document.getElementById('statusMsg').innerText = `対戦者の選択を待っています (${submitted}/${total})`;
  }
});

// ラウンド結果表示
socket.on('roundResult', ({ hands, result, roomGameMode, effectiveMode, gameOver, matchWinner, setReset, survivingPlayers }) => {
  document.getElementById('gamePlayArea').style.display = 'none';
  document.getElementById('resultArea').style.display = 'block';

  const details = document.getElementById('resultDetails');
  const handMap = { rock: '✊グー', scissors: '✌️チョキ', paper: '🖐️パー' };

  let html = `<p style="font-size:14px; color:#666;">（判定ルール: ${effectiveMode === 'majority' ? '多数派勝ち残り' : '通常じゃんけん'}）</p><br>`;
  hands.forEach(h => {
    html += `<p><strong>${h.name}</strong>: ${handMap[h.hand]}</p>`;
  });

  html += '<br>';
  if (result.isDraw) {
    html += `<p style="color:#f59e0b; font-weight:bold;">あいこ！もう一度勝負！</p>`;
  } else {
    const winnerNames = hands.filter(h => result.winners.includes(h.id)).map(h => h.name).join(', ');
    if (roomGameMode === 'majority') {
      html += `<p style="color:#10b981; font-weight:bold;">勝ち残り: ${winnerNames}！</p>`;
    } else {
      html += `<p style="color:#10b981; font-weight:bold;">勝者: ${winnerNames}！</p>`;
    }
  }

  // 自分が勝ち残り戦で脱落したか判定
  if (roomGameMode === 'majority' && !setReset && !gameOver) {
    isMyEliminated = !survivingPlayers.includes(socket.id);
  } else {
    isMyEliminated = false;
  }

  if (gameOver) {
    html += `<br><h2 style="color:#e74c3c;">🏆 最終勝利者: ${matchWinner.name} 🏆</h2>`;
    document.getElementById('nextRoundBtn').style.display = 'none';
    document.getElementById('returnLobbyBtn').style.display = 'block';
  } else {
    document.getElementById('returnLobbyBtn').style.display = 'none';
    document.getElementById('nextRoundBtn').style.display = 'block';

    if (setReset) {
      html += `<p style="color:#4f46e5; font-weight:bold; margin-top:10px;">🎉 1人が勝ち残りました！観戦していた全員が試合に復帰します！</p>`;
      document.getElementById('nextRoundBtn').innerText = '全員復帰して次のラウンドへ';
    } else if (isMyEliminated) {
      html += `<p style="color:#d97706; font-weight:bold; margin-top:10px;">👀 あなたは脱落しました。次の画面で決着まで観戦できます。</p>`;
      document.getElementById('nextRoundBtn').innerText = '観戦画面へ進む';
    } else {
      document.getElementById('nextRoundBtn').innerText = '次のラウンドへ';
    }
  }

  details.innerHTML = html;
});

function nextRound() {
  preparePlayScreen();
}

// 個人ごとのロビー復帰（試合完全終了時のみ表示）
function returnToLobbyIndividual() {
  socket.emit('returnToLobbyIndividual', { roomCode: currentRoomCode });
}

socket.on('individualReturnedToLobby', () => {
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('gamePlayArea').style.display = 'none';
});

// チャット処理
function sendChatMessage() {
  const input = document.getElementById('chatInput');
  const message = input.value.trim();
  if (message) {
    socket.emit('sendChatMessage', { roomCode: currentRoomCode, message });
    input.value = '';
  }
}

function handleChatKeyPress(e) {
  if (e.key === 'Enter') sendChatMessage();
}

socket.on('receiveChatMessage', ({ sender, message, isSystem }) => {
  const chatBox = document.getElementById('chatBox');
  const item = document.createElement('div');
  item.className = isSystem ? 'chat-item system' : 'chat-item';
  item.innerHTML = isSystem ? message : `<strong>${sender}:</strong> ${message}`;
  chatBox.appendChild(item);
  chatBox.scrollTop = chatBox.scrollHeight;
});

socket.on('errorMsg', (msg) => alert(msg));