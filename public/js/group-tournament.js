(() => {
  'use strict';

  const groupId = new URLSearchParams(location.search).get('group') || '';
  const tokenKey = 'chill-thrill:profile-token';
  const legacyTokenKey = 'gang.profileToken';
  const state = { tournaments: [], rules: null, selectedId: null, canManage: false, loading: false };
  const $ = selector => document.querySelector(selector);
  const el = {
    notice: $('#notice'), groupName: $('#group-name'), createPanel: $('#create-panel'), createForm: $('#create-form'),
    gameSelect: $('#game-select'), variantSelect: $('#variant-select'), refresh: $('#refresh-button'), list: $('#tournament-list'),
    actions: $('#tournament-actions'), selectedName: $('#selected-name'), progress: $('#progress-line'), standings: $('#standings-body'),
    historyCount: $('#history-count'), history: $('#round-history'), tieBreak: $('#tie-break'), noScore: $('#no-score-rule'),
    pointsRules: $('#points-rules'), gameRules: $('#game-rules'),
  };

  const readToken = () => {
    try { return localStorage.getItem(tokenKey) || localStorage.getItem(legacyTokenKey) || ''; } catch { return ''; }
  };
  const api = async (suffix = '', options = {}) => {
    const token = readToken();
    if (!token) throw new Error('Hãy đăng nhập hồ sơ local trên portal rồi mở lại trang giải đấu.');
    const response = await fetch(`/api/groups/${encodeURIComponent(groupId)}/tournaments${suffix}`, {
      ...options, headers: { 'x-profile-token': token, ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
    });
    let payload;
    try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) throw new Error(payload.error || 'Không thể tải giải đấu.');
    return payload;
  };

  function notice(message, kind = 'info') {
    el.notice.textContent = message;
    el.notice.dataset.kind = kind;
    el.notice.hidden = !message;
  }
  function text(tag, value, className) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.textContent = value == null ? '' : String(value);
    return node;
  }
  function statusName(status) {
    return ({ OPEN: 'Chờ bắt đầu', IN_PROGRESS: 'Đang diễn ra', SUSPENDED: 'Tạm dừng', COMPLETED: 'Đã kết thúc', CLOSED: 'Đã đóng' })[status] || status;
  }
  function outcomeName(outcome) {
    return ({ WIN: 'Thắng', TIE: 'Hòa', LOSS: 'Thua' })[outcome] || outcome;
  }
  function gameName(gameId) { return state.rules?.games.find(game => game.gameId === gameId)?.name || gameId; }
  function populateGames() {
    el.gameSelect.replaceChildren();
    for (const game of state.rules?.games || []) {
      const option = document.createElement('option'); option.value = game.gameId; option.textContent = game.name; el.gameSelect.append(option);
    }
    updateVariants();
  }
  function updateVariants() {
    const game = state.rules?.games.find(item => item.gameId === el.gameSelect.value);
    el.variantSelect.replaceChildren();
    for (const variant of game?.variants || []) {
      const option = document.createElement('option'); option.value = variant.id; option.textContent = variant.name; el.variantSelect.append(option);
    }
  }
  function renderRules(rules) {
    state.rules = rules;
    el.tieBreak.textContent = `Xếp hạng: ${rules.tieBreak}`;
    el.noScore.textContent = rules.noScore;
    el.pointsRules.replaceChildren(...rules.points.map(rule => {
      const card = text('article', '', 'rule-card'); card.append(text('h3', rule.title)); card.append(text('p', rule.description)); return card;
    }));
    el.gameRules.replaceChildren(...rules.games.map(game => {
      const item = text('div', '', 'game-rule');
      const variants = game.variants.map(variant => variant.name).join(', ');
      item.append(text('strong', game.name)); item.append(text('span', `${game.minPlayers}–${game.maxPlayers} người · ${variants}`)); return item;
    }));
    populateGames();
  }
  function renderList() {
    if (!state.tournaments.length) {
      el.list.replaceChildren(text('p', 'Chưa có giải trong nhóm.', 'muted'));
      return;
    }
    el.list.replaceChildren(...state.tournaments.map(tournament => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'tournament-item';
      button.setAttribute('aria-current', tournament.tournamentId === state.selectedId ? 'true' : 'false');
      button.append(text('strong', tournament.name));
      button.append(text('span', `${gameName(tournament.gameId)} · ${tournament.completedRounds}/${tournament.plannedRounds} vòng có điểm`));
      button.append(text('span', statusName(tournament.status), 'status-pill'));
      button.addEventListener('click', () => loadDetail(tournament.tournamentId));
      return button;
    }));
  }
  function renderDetail(detail) {
    el.selectedName.textContent = detail.name;
    el.progress.textContent = detail.status === 'IN_PROGRESS'
      ? `Vòng ${detail.currentRound} / ${detail.plannedRounds} · ${detail.currentRoundStatus === 'STARTING' ? 'Đang xác nhận ván từ máy chủ.' : detail.currentRoundStatus === 'PLAYING' ? 'Đang có ván; đợi kết quả server.' : 'Sẵn sàng mở ván trong nhóm.'}`
      : `${gameName(detail.gameId)} · ${detail.completedRounds}/${detail.plannedRounds} vòng có điểm · ${statusName(detail.status)}`;
    el.standings.replaceChildren(...detail.standings.map(row => {
      const tr = document.createElement('tr');
      [row.rank, row.name, row.points, row.wins, row.ties, row.losses].forEach(value => tr.append(text('td', value)));
      return tr;
    }));
    el.historyCount.textContent = detail.rounds.length ? `${detail.rounds.length} vòng đã ghi` : '';
    if (!detail.rounds.length) el.history.replaceChildren(text('p', 'Chưa có vòng nào.', 'muted'));
    else el.history.replaceChildren(...detail.rounds.map(round => {
      const card = text('article', '', 'round-card');
      const head = text('div', '', 'round-title');
      const roundStatus = ({ SCORED: 'Đã tính điểm', READY: 'Sẵn sàng', STARTING: 'Đang xác nhận', PLAYING: 'Đang chơi', NO_SCORE: 'Không tính điểm', CANCELLED: 'Đã hủy', SUSPENDED: 'Tạm dừng' })[round.status] || 'Không tính điểm';
      head.append(text('span', `Vòng ${round.number} · ${roundStatus}`));
      if (round.matchId) head.append(text('span', round.matchId.slice(0, 8)));
      card.append(head);
      if (round.decision) card.append(text('p', round.decision, 'round-decision'));
      if (round.results?.length) {
        const results = text('div', '', 'round-results');
        for (const result of round.results) results.append(text('span', `${result.name}: ${outcomeName(result.outcome)} · +${result.points}`));
        card.append(results);
      }
      return card;
    }));
    renderActions(detail);
  }
  function renderActions(detail) {
    el.actions.replaceChildren();
    el.actions.hidden = !state.canManage || !['OPEN', 'IN_PROGRESS', 'SUSPENDED'].includes(detail.status);
    if (el.actions.hidden) return;
    if (detail.status === 'OPEN') {
      const start = text('button', 'Bắt đầu và khóa thành viên', 'button button-primary'); start.type = 'button';
      start.addEventListener('click', () => mutate(`/` + encodeURIComponent(detail.tournamentId) + '/start', 'Đã bắt đầu giải.'));
      el.actions.append(start);
    }
    const close = text('button', 'Đóng giải', 'button'); close.type = 'button';
    close.addEventListener('click', () => mutate(`/` + encodeURIComponent(detail.tournamentId) + '/close', 'Đã đóng giải.'));
    el.actions.append(close);
  }
  async function loadDetail(id) {
    state.selectedId = id;
    try {
      const detail = await api(`/${encodeURIComponent(id)}`);
      const groupState = await api(); state.canManage = groupState.canManage === true;
      renderDetail(detail); renderList();
      notice('', 'info');
    } catch (error) { notice(error.message, 'error'); }
  }
  async function load() {
    if (!groupId) { notice('Thiếu mã nhóm trong đường dẫn. Hãy mở tính năng từ trang nhóm.', 'error'); return; }
    if (state.loading) return;
    state.loading = true; el.refresh.disabled = true;
    try {
      const [rules, groupState] = await Promise.all([api('/rules'), api()]);
      renderRules(rules); state.tournaments = groupState.tournaments || []; state.canManage = groupState.canManage === true;
      el.groupName.textContent = groupState.group?.name || 'Nhóm';
      const active = state.tournaments.find(item => ['OPEN', 'IN_PROGRESS'].includes(item.status));
      if (!state.selectedId || !state.tournaments.some(item => item.tournamentId === state.selectedId)) state.selectedId = active?.tournamentId || state.tournaments[0]?.tournamentId || null;
      el.createPanel.hidden = Boolean(active) || !state.canManage;
      renderList();
      if (state.selectedId) await loadDetail(state.selectedId);
      else { el.selectedName.textContent = 'Bảng xếp hạng'; el.actions.hidden = true; }
      notice('', 'info');
    } catch (error) { notice(error.message, 'error'); }
    finally { state.loading = false; el.refresh.disabled = false; }
  }
  async function mutate(path, successMessage) {
    try {
      const result = await api(path, { method: 'POST', body: '{}' });
      if (result?.tournamentId) state.selectedId = result.tournamentId;
      notice(successMessage, 'success');
      await load();
    } catch (error) { notice(error.message, 'error'); }
  }

  el.createForm.addEventListener('submit', async event => {
    event.preventDefault();
    const data = new FormData(el.createForm);
    const payload = { name: data.get('name'), gameId: data.get('gameId'), variant: data.get('variant'), rounds: Number(data.get('rounds')) };
    try {
      const created = await api('', { method: 'POST', body: JSON.stringify(payload) });
      state.selectedId = created.tournamentId;
      notice('Đã tạo giải. Chủ nhóm có thể bắt đầu và khóa danh sách thành viên.', 'success');
      await load();
    } catch (error) { notice(error.message, 'error'); }
  });
  el.gameSelect.addEventListener('change', updateVariants);
  el.refresh.addEventListener('click', load);
  load();
})();
