'use strict';

(function groupLobbyPage() {
  const $ = id => document.getElementById(id);
  const names = { 'the-gang': 'The Gang', uno: 'UNO', 'tien-len': 'Tiến lên', poker: 'Poker Texas Hold’em', 'sam-loc': 'Sâm lốc', phom: 'Phỏm', bang: 'BANG!' };
  const limits = {
    'the-gang': { min: 2, max: 6 }, uno: { min: 2, max: 4 }, 'tien-len': { min: 2, max: 4 },
    poker: { min: 2, max: 6 }, 'sam-loc': { min: 2, max: 5 }, phom: { min: 2, max: 4 }, bang: { min: 4, max: 7 },
  };
  const coinGames = new Set(['tien-len', 'sam-loc', 'phom']);
  const ACTIVE_KEY = 'chill-thrill:group-lobby:active';
  const CAP_PREFIX = 'chill-thrill:group-lobby:cap:';
  const INVITE_PREFIX = 'chill-thrill:group-lobby:invite:';
  const state = { groupId: '', capability: '', inviteCapability: '', group: null, timer: null, busy: false };
  let gameSocket = null;
  let socketProfileToken = '';

  function profileToken() {
    try { return localStorage.getItem('chill-thrill:profile-token') || localStorage.getItem('gang.profileToken') || ''; }
    catch { return ''; }
  }
  function connectGameSocket() {
    const token = profileToken();
    if (!token || typeof window.io !== 'function') return null;
    if (gameSocket && socketProfileToken === token) {
      if (!gameSocket.connected) gameSocket.connect();
      return gameSocket;
    }
    gameSocket?.disconnect();
    socketProfileToken = token;
    gameSocket = window.io({ auth: { profileToken: token } });
    gameSocket.on('connect_error', () => setNotice('Kết nối game chưa sẵn sàng. Hãy đợi rồi thử chuyển lại.', true));
    gameSocket.on('connect', () => { if (state.groupId) void refresh(); });
    return gameSocket;
  }
  function waitForGameSocket(timeoutMs = 8000) {
    const socket = connectGameSocket();
    if (!socket) return Promise.reject(new Error('Không tải được kết nối game. Tải lại sảnh nhóm rồi thử lại.'));
    if (socket.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Đang chờ kết nối game. Hãy đợi vài giây rồi thử lại.')), timeoutMs);
      const onConnect = () => finish();
      const onError = () => finish(new Error('Không xác thực được kết nối game của hồ sơ này.'));
      function finish(error) {
        clearTimeout(timer); socket.off('connect', onConnect); socket.off('connect_error', onError);
        if (error) reject(error); else resolve();
      }
      socket.once('connect', onConnect); socket.once('connect_error', onError);
      if (!socket.connected) socket.connect();
    });
  }
  function setNotice(message, error = false) {
    const box = $('notice'); box.textContent = message || ''; box.classList.toggle('error', error);
  }
  function saveMembership(groupId, capability) {
    state.groupId = groupId; state.capability = capability;
    try { sessionStorage.setItem(ACTIVE_KEY, groupId); sessionStorage.setItem(CAP_PREFIX + groupId, capability); } catch {}
    $('entry').classList.add('hidden'); $('lobby').classList.remove('hidden');
    if (!state.timer) state.timer = setInterval(() => { void refresh(); }, 5000);
  }
  function clearMembership() {
    const id = state.groupId;
    try { sessionStorage.removeItem(ACTIVE_KEY); sessionStorage.removeItem(CAP_PREFIX + id); sessionStorage.removeItem(INVITE_PREFIX + id); } catch {}
    if (state.timer) clearInterval(state.timer);
    state.timer = null; state.groupId = ''; state.capability = ''; state.inviteCapability = ''; state.group = null;
    $('entry').classList.remove('hidden'); $('lobby').classList.add('hidden');
  }
  async function api(path, { method = 'GET', body, needsGroup = true } = {}) {
    const token = profileToken();
    if (!token) throw new Error('Hãy tạo hoặc khôi phục hồ sơ ở trang chủ trước.');
    const headers = { 'X-Profile-Token': token };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (needsGroup && state.capability) headers['X-Group-Capability'] = state.capability;
    const response = await fetch(`/api/groups${path}`, { method, headers, cache: 'no-store',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    let result = {};
    try { result = await response.json(); } catch {}
    if (!response.ok) throw new Error(result.error?.message || `Yêu cầu thất bại (${response.status}).`);
    return result;
  }
  function busy(button, value) {
    if (button) { button.disabled = value; button.dataset.busy = value ? 'true' : 'false'; }
  }
  async function run(button, action, successMessage = '') {
    if (state.busy) return;
    state.busy = true; busy(button, true); setNotice('Đang cập nhật sảnh…');
    try {
      const result = await action();
      if (result?.group) { state.group = result.group; render(); }
      if (successMessage) setNotice(successMessage);
      return result;
    } catch (error) { setNotice(error.message || 'Không thể cập nhật sảnh.', true); }
    finally { state.busy = false; busy(button, false); }
  }
  function memberElement(member) {
    const item = document.createElement('li'); item.className = 'member';
    const avatar = document.createElement('span'); avatar.className = 'member-avatar'; avatar.textContent = member.avatar || '🕶️'; item.append(avatar);
    const name = document.createElement('span'); name.className = 'member-name'; name.textContent = member.name || 'Người chơi'; item.append(name);
    const tags = document.createElement('span'); tags.className = 'member-tags';
    if (member.isHost) { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = 'HOST'; tags.append(tag); }
    if (!member.connected) { const tag = document.createElement('span'); tag.className = 'tag offline'; tag.textContent = 'MẤT KẾT NỐI'; tags.append(tag); }
    else if (member.confirmed) { const tag = document.createElement('span'); tag.className = 'tag confirmed'; tag.textContent = 'ĐÃ XÁC NHẬN'; tags.append(tag); }
    item.append(tags); return item;
  }
  function configureForm() {
    const gameId = $('game-select').value;
    const isUno = gameId === 'uno';
    $('variant-wrap').classList.toggle('hidden', !isUno);
    $('stake-wrap').classList.toggle('hidden', !coinGames.has(gameId));
    const bound = { ...limits[gameId] };
    if (isUno && $('variant-select').value === 'classic-108-v1') bound.max = 6;
    const select = $('max-players'); select.replaceChildren();
    for (let n = bound.min; n <= bound.max; n++) {
      const option = document.createElement('option'); option.value = String(n); option.textContent = `${n} người`; select.append(option);
    }
    select.value = String(bound.max);
  }
  function render() {
    const group = state.group;
    if (!group) return;
    $('lobby-title').textContent = `Nhóm ${group.members.length} người`;
    $('tournament-link').href = `/groups/tournament.html?group=${encodeURIComponent(state.groupId)}`;
    $('revision-label').textContent = `REV ${group.revision}`;
    $('expiry-label').textContent = `Sảnh hết hạn ${new Date(group.expiresAt).toLocaleString('vi-VN')}`;
    $('member-count').textContent = `${group.members.length} / 12`;
    const list = $('members'); list.replaceChildren(...group.members.map(memberElement));
    const viewer = group.viewer || {};
    $('host-tools').classList.toggle('hidden', !viewer.isHost);
    $('proposal-form').classList.toggle('hidden', !viewer.isHost || Boolean(group.transition && group.transition.status !== 'complete') || group.proposal?.status === 'pending');
    const hostTarget = $('host-target'); hostTarget.replaceChildren();
    for (const member of group.members.filter(item => item.memberKey !== viewer.memberKey && item.connected)) {
      const option = document.createElement('option'); option.value = member.memberKey; option.textContent = member.name; hostTarget.append(option);
    }
    $('transfer-host').disabled = !hostTarget.options.length;
    $('invite-share').classList.toggle('hidden', !state.inviteCapability || !viewer.isHost);
    $('invite-output').value = state.inviteCapability;
    const proposal = group.proposal;
    $('proposal-status').textContent = proposal ? ({ pending: 'Chờ xác nhận', switching: 'Đang chuyển', complete: 'Đã chuyển', stale: 'Đã đổi trạng thái', expired: 'Đã hết hạn' }[proposal.status] || proposal.status) : 'Chưa đề xuất';
    $('proposal-status').dataset.state = proposal?.status || '';
    const pending = proposal?.status === 'pending';
    $('proposal-summary').classList.toggle('hidden', !proposal);
    if (proposal) {
      const target = proposal.target, config = target.config || {};
      const gameLabel = names[target.gameId] || target.gameId;
      const variant = target.gameId === 'uno' ? (target.variant === 'classic-local-v1' ? '112 lá · classic-local-v1' : '108 lá · classic-108-v1') : target.variant;
      $('proposal-summary').replaceChildren();
      const title = document.createElement('strong'); title.textContent = `${gameLabel} · ${variant}`; $('proposal-summary').append(title);
      const details = document.createElement('p');
      details.textContent = `${group.members.length} thành viên · tối đa ${config.maxPlayers} ghế${config.stake ? ` · cược ${Number(config.stake).toLocaleString('vi-VN')} coin` : ''} · bàn riêng`;
      $('proposal-summary').append(details);
      const status = document.createElement('p'); status.textContent = proposal.status === 'stale' ? 'Thành viên hoặc kết nối đã thay đổi. Host cần tạo đề xuất mới.' : `Xác nhận ${proposal.confirmationCount}/${proposal.requiredConfirmations} · hết hạn ${new Date(proposal.expiresAt).toLocaleTimeString('vi-VN')}`;
      $('proposal-summary').append(status);
    }
    $('proposal-actions').classList.toggle('hidden', !pending);
    $('confirm-proposal').classList.toggle('hidden', !pending || proposal.confirmedByViewer);
    const allConfirmed = pending && proposal.confirmationCount === proposal.requiredConfirmations && group.members.every(item => item.connected);
    $('switch-game').classList.toggle('hidden', !allConfirmed || (!viewer.isHost && group.transition?.status !== 'partial'));
    $('switch-game').disabled = !allConfirmed;
    const transition = group.transition;
    $('transition-summary').classList.toggle('hidden', !transition);
    if (transition) {
      const text = transition.status === 'complete' ? 'Bàn mới đã sẵn sàng. Mỗi thành viên có nút vào bàn riêng.'
        : transition.status === 'partial' ? `Đã chuẩn bị ${transition.prepared}/${transition.total}, đã cấp ${transition.joined}/${transition.total} ghế. Xác nhận lại nếu kết nối hoặc thành viên vừa thay đổi; thử chuyển lại để khôi phục.`
          : transition.status === 'blocked' ? (transition.error?.message || 'Chưa thể rời bàn cũ an toàn.')
            : 'Đang chuyển nhóm và tạo ghế riêng cho từng hồ sơ…';
      $('transition-summary').textContent = text;
    }
    $('enter-new-room').classList.toggle('hidden', transition?.status !== 'complete');
  }
  async function refresh() {
    if (!state.groupId || state.busy) return;
    try { state.group = await api(`/${encodeURIComponent(state.groupId)}`); render(); }
    catch (error) { setNotice(error.message, true); }
  }
  async function createGroup() {
    await run($('create-group'), async () => {
      const result = await api('/', { method: 'POST', body: {}, needsGroup: false });
      state.inviteCapability = result.inviteCapability;
      saveMembership(result.groupId, result.groupCapability);
      try { sessionStorage.setItem(INVITE_PREFIX + result.groupId, state.inviteCapability); } catch {}
      state.group = result.group; render(); return result;
    }, 'Đã tạo sảnh. Gửi mã mời cho cả nhóm.');
  }
  async function joinGroup() {
    const inviteCapability = $('invite-input').value.trim();
    if (inviteCapability.length < 32) { setNotice('Dán đầy đủ mã mời do host gửi.', true); return; }
    await run($('join-group'), async () => {
      const result = await api('/join', { method: 'POST', body: { inviteCapability }, needsGroup: false });
      saveMembership(result.groupId, result.groupCapability); state.group = result.group; render(); return result;
    }, 'Đã tham gia sảnh.');
  }
  async function submitProposal(event) {
    event.preventDefault();
    const gameId = $('game-select').value;
    const target = { gameId, variant: gameId === 'uno' ? $('variant-select').value : 'standard',
      config: { roomName: $('room-name').value.trim(), maxPlayers: Number($('max-players').value),
        ...(coinGames.has(gameId) ? { stake: Number($('stake').value) } : {}) } };
    await run(event.submitter, async () => { state.group = await api(`/${encodeURIComponent(state.groupId)}/proposal`, { method: 'POST', body: target }); render(); return { group: state.group }; }, 'Đề xuất đã gửi cho mọi thành viên.');
  }
  async function confirmProposal() {
    const proposal = state.group?.proposal;
    if (!proposal) return;
    await run($('confirm-proposal'), async () => {
      state.group = await api(`/${encodeURIComponent(state.groupId)}/confirm`, { method: 'POST', body: { proposalId: proposal.id, proposalRevision: proposal.revision } }); render();
      return { group: state.group };
    }, 'Đã ghi nhận xác nhận của bạn.');
  }
  async function switchGroup() {
    await run($('switch-game'), async () => {
      await waitForGameSocket();
      state.group = await api(`/${encodeURIComponent(state.groupId)}/switch`, { method: 'POST', body: {} }); render();
      return { group: state.group };
    }, 'Đã hoàn tất chuyển bàn.');
  }
  async function leaveGroup() {
    const result = await run($('leave-group'), () => api(`/${encodeURIComponent(state.groupId)}/leave`, { method: 'POST', body: {} }), 'Đã rời sảnh nhóm.');
    if (result) clearMembership();
  }
  async function rotateInvite() {
    await run($('rotate-invite'), async () => {
      const result = await api(`/${encodeURIComponent(state.groupId)}/invite`, { method: 'POST', body: {} });
      state.inviteCapability = result.inviteCapability;
      try { sessionStorage.setItem(INVITE_PREFIX + state.groupId, state.inviteCapability); } catch {}
      state.group = result.group; render(); return result;
    }, 'Mã mời cũ đã hết hiệu lực.');
  }
  async function transferHost() {
    const memberKey = $('host-target').value;
    if (!memberKey) return;
    await run($('transfer-host'), async () => {
      state.group = await api(`/${encodeURIComponent(state.groupId)}/host`, { method: 'POST', body: { memberKey } });
      state.inviteCapability = ''; render(); return { group: state.group };
    }, 'Đã chuyển host. Đề xuất trước đó cần xác nhận lại.');
  }
  async function enterNewRoom() {
    await run($('enter-new-room'), async () => {
      const session = await api(`/${encodeURIComponent(state.groupId)}/handoff`);
      const profile = profileToken();
      const record = { ...session, profileToken: profile, handoff: true };
      localStorage.setItem(`chill-thrill:${session.gameId}:${session.roomCode}`, JSON.stringify(record));
      localStorage.setItem('chill-thrill:last-room', JSON.stringify(record));
      if (session.entryPath === '/') sessionStorage.setItem('gang.session', JSON.stringify(record));
      location.assign(`${session.entryPath}?room=${encodeURIComponent(session.roomCode)}`);
      return {};
    });
  }
  async function leaveOnNavigate() {
    if (!state.groupId || !state.capability) return;
    const headers = { 'Content-Type': 'application/json', 'X-Group-Capability': state.capability };
    const token = profileToken(); if (token) headers['X-Profile-Token'] = token;
    try { await fetch(`/api/groups/${encodeURIComponent(state.groupId)}/disconnect`, { method: 'POST', headers, body: '{}', keepalive: true }); } catch {}
  }

  $('create-group').addEventListener('click', createGroup);
  $('join-group').addEventListener('click', joinGroup);
  $('proposal-form').addEventListener('submit', submitProposal);
  $('game-select').addEventListener('change', configureForm);
  $('variant-select').addEventListener('change', configureForm);
  $('confirm-proposal').addEventListener('click', confirmProposal);
  $('switch-game').addEventListener('click', switchGroup);
  $('leave-group').addEventListener('click', leaveGroup);
  $('rotate-invite').addEventListener('click', rotateInvite);
  $('transfer-host').addEventListener('click', transferHost);
  $('enter-new-room').addEventListener('click', enterNewRoom);
  $('copy-invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.inviteCapability); setNotice('Đã sao chép mã mời.'); }
    catch { $('invite-output').select(); document.execCommand('copy'); setNotice('Đã sao chép mã mời.'); }
  });
  window.addEventListener('pagehide', leaveOnNavigate);
  configureForm();
  if (!profileToken()) setNotice('Hãy tạo hoặc khôi phục hồ sơ ở trang chủ trước khi dùng sảnh nhóm.', true);
  else connectGameSocket();
  try {
    const groupId = sessionStorage.getItem(ACTIVE_KEY) || '';
    const capability = groupId && sessionStorage.getItem(CAP_PREFIX + groupId);
    if (groupId && capability) {
      state.groupId = groupId; state.capability = capability;
      state.inviteCapability = sessionStorage.getItem(INVITE_PREFIX + groupId) || '';
      $('entry').classList.add('hidden'); $('lobby').classList.remove('hidden');
      void refresh(); state.timer = setInterval(() => { void refresh(); }, 5000);
    }
  } catch {}
})();
