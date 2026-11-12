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
  document.getElementById('entranceScreen').classList.remove('active');
  document.getElementById('roomScreen').classList.add('active');
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

// 部屋ステータスの同期処理 (勝敗・〇勝のスコア更新)
socket.on('roomUpdated', (data) => {
  currentRoomCode = data.roomCode;
  isHost = (socket.id === data.hostId);

  document.getElementById('roomCodeDisplay').innerText = data.roomCode;
  document.getElementById('targetWinsDisplay').innerText = data.targetWins;
  
  const modeText = (data.gameMode === 'majority') ? '多数派勝ち（勝ち残り）' : '通常対戦';
  document.getElementById('modeDisplay').innerText = modeText;

  // 自分自身のプレイヤー情報
  const me = data.players.find(p => p.id === socket.id);
  const myStatus = me ? me.status : 'lobby';

  // ホストコントロール表示
  document.getElementById('hostSettingsPanel').style.display = (isHost && data.status === 'lobby') ? 'block' : 'none';
  document.getElementById('waitingHostMsg').style.display = (!isHost && data.status === 'lobby') ? 'block' : 'none';

  // 画面の表示切替（自分がロビーなら他画面は非表示）
  if (myStatus === 'lobby') {
    document.getElementById('gamePlayArea').style.display = 'none';
    document.getElementById('resultArea').style.display = 'none';
  }

  // 参加者カードリストと「〇勝」スコアのリアルタイム再描写
  const grid = document.getElementById('playersList');
  grid.innerHTML = data.players.map(p => {
    let statusBadge = '';
    if (p.status === 'lobby') statusBadge = '<span class="player-status-badge lobby">ロビー待機</span>';
    else if (p.isEliminated) statusBadge = '<span class="player-status-badge eliminated">脱落</span>';
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
  myHandSelected = false;
  isMyEliminated = false;
  disableHandButtons(false);
  document.getElementById('gamePlayArea').style.display = 'block';
  document.getElementById('handSelectionBox').style.display = 'block';
  document.getElementById('eliminatedMsg').style.display = 'none';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('statusMsg').innerText = '手を選択してください';
});

function selectHand(hand) {
  if (myHandSelected || isMyEliminated) return;
  myHandSelected = true;
  disableHandButtons(true);
  document.getElementById('statusMsg').innerText = '相手の選択を待っています...';
  socket.emit('submitHand', { roomCode: currentRoomCode, hand });
}

function disableHandButtons(disabled) {
  document.querySelectorAll('.circle-btn').forEach(btn => btn.disabled = disabled);
}

socket.on('handSubmittedCount', ({ submitted, total }) => {
  if (myHandSelected && !isMyEliminated) {
    document.getElementById('statusMsg').innerText = `全員の選択を待っています (${submitted}/${total})`;
  }
});

// ラウンド結果表示
socket.on('roundResult', ({ hands, result, players, effectiveMode, gameOver, matchWinner, survivingPlayers }) => {
  document.getElementById('gamePlayArea').style.display = 'none';
  document.getElementById('resultArea').style.display = 'block';

  const details = document.getElementById('resultDetails');
  const handMap = { rock: '✊グー', scissors: '✌️チョキ', paper: '🖐️パー' };

  let html = `<p style="font-size:14px; color:#666;">（ルール: ${effectiveMode === 'majority' ? '多数派勝ち残り' : '通常対戦'}）</p><br>`;
  hands.forEach(h => {
    html += `<p><strong>${h.name}</strong>: ${handMap[h.hand]}</p>`;
  });

  html += '<br>';
  if (result.isDraw) {
    html += `<p style="color:#f59e0b; font-weight:bold;">引き分け！</p>`;
  } else {
    const winnerNames = hands.filter(h => result.winners.includes(h.id)).map(h => h.name).join(', ');
    html += `<p style="color:#10b981; font-weight:bold;">勝ち残り勝者: ${winnerNames}！</p>`;
  }

  // 自分が脱落したか確認
  if (effectiveMode === 'majority' && !survivingPlayers.includes(socket.id)) {
    isMyEliminated = true;
  }

  if (gameOver) {
    html += `<br><h2 style="color:#e74c3c;">🏆 最終勝利者: ${matchWinner.name} 🏆</h2>`;
    document.getElementById('nextRoundBtn').style.display = 'none';
  } else {
    if (isMyEliminated) {
      html += `<p style="color:#e74c3c; margin-top:10px;">あなたは脱落しました。「ロビーに戻る」を押して待機できます。</p>`;
      document.getElementById('nextRoundBtn').style.display = 'none';
    } else {
      document.getElementById('nextRoundBtn').style.display = 'block';
    }
  }

  document.getElementById('returnLobbyBtn').style.display = 'block';
  details.innerHTML = html;
});

function nextRound() {
  myHandSelected = false;
  disableHandButtons(false);
  document.getElementById('gamePlayArea').style.display = 'block';
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('statusMsg').innerText = '手を選択してください';
}

// 個人ごとのロビー復帰
function returnToLobbyIndividual() {
  socket.emit('returnToLobbyIndividual', { roomCode: currentRoomCode });
}

socket.on('individualReturnedToLobby', () => {
  document.getElementById('resultArea').style.display = 'none';
  document.getElementById('gamePlayArea').style.display = 'none';
});

// チャット受信
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