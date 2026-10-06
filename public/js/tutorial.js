(function () {
  'use strict';
  const content = window.ChillTutorialContent;
  const $ = id => document.getElementById(id);
  const select = $('game-select'), guide = $('guide-body'), variant = $('guide-variant'), status = $('exercise-status');
  const exercise = $('exercise-content'), startButton = $('start-button'), submitButton = $('submit-button'), claimButton = $('claim-button');
  const token = () => { try { return localStorage.getItem('chill-thrill:profile-token') || localStorage.getItem('gang.profileToken') || ''; } catch { return ''; } };
  const rules = { 'the-gang': null, uno: null, 'tien-len': '/docs/rules/tien-len.md', poker: '/docs/rules/poker.md', 'sam-loc': '/docs/rules/sam-loc.md', phom: '/docs/rules/phom.md', bang: '/docs/rules/bang.md' };
  const labels = { 'the-gang':'The Gang', uno:'UNO', 'tien-len':'Tiến lên', poker:'Poker', 'sam-loc':'Sâm lốc', phom:'Phỏm', bang:'BANG!' };
  let guides = content ? content.listGuides() : [], session = null, currentChallenge = null, selectedColor = null;
  let version = content?.VERSION || '2026-10-06.v1';
  const setStatus = (message, kind = '') => { status.textContent = message; status.className = `status ${kind}`.trim(); };
  const noStoreFetch = (url, options = {}) => fetch(url, { cache: 'no-store', ...options, headers: { 'Cache-Control': 'no-store', ...(options.headers || {}) } });
  const authHeaders = () => token() ? { 'X-Profile-Token': token() } : {};
  const errorMessage = (payload, fallback) => typeof payload.error === 'string' ? payload.error : payload.error?.message || fallback;
  const actionId = () => typeof globalThis.crypto?.randomUUID === 'function' ? crypto.randomUUID() : `lesson-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cardLabel = card => card.label || `${card.rank || ''}${({ H:'♥', D:'♦', C:'♣', S:'♠' })[card.suit] || card.suit || ''}${card.color ? ` · ${({ red:'đỏ', blue:'xanh dương', green:'xanh lá', yellow:'vàng' })[card.color] || card.color}` : ''}${card.value !== null && card.value !== undefined ? ` ${card.value}` : ''}${card.type === 'wild' ? 'Wild' : ''}`;
  function renderGuide() {
    const item = guides[Number(select.value)]; if (!item) return;
    variant.textContent = item.rules;
    guide.replaceChildren();
    const ol = document.createElement('ol');
    item.steps.forEach(step => { const li = document.createElement('li'); li.textContent = step; ol.append(li); }); guide.append(ol);
    const rulePath = item.gameId === 'uno' ? (item.variant === 'classic-local-v1' ? '/docs/rules/uno-classic.md' : '/docs/rules/uno.md') : rules[item.gameId];
    const rulesLink = $('rules-link'); rulesLink.hidden = !rulePath; if (rulePath) rulesLink.href = rulePath;
  }
  function fillGuides() {
    select.replaceChildren();
    guides.forEach((item, index) => { const option = document.createElement('option'); option.value = String(index); option.textContent = item.title; select.append(option); });
    const query=new URLSearchParams(location.search),requested=guides.findIndex(item=>item.gameId===query.get('game') && (!query.get('variant') || item.variant===query.get('variant')));
    if(requested>=0) select.value=String(requested);
    renderGuide();
  }
  function drawChallenge(challenge) {
    currentChallenge = challenge; selectedColor = null; exercise.hidden = !challenge; submitButton.hidden = !challenge; startButton.hidden = !!challenge; claimButton.hidden = true;
    if (!challenge) { exercise.replaceChildren(); return; }
    exercise.replaceChildren();
    const meta = document.createElement('div'); meta.className = 'exercise-meta';
    [labels[challenge.gameId] || 'Bài luyện', challenge.gameId === 'uno' ? 'Bộ 112 lá' : 'Luật của bàn', `Bài ${challenge.sequence + 1}`].forEach(value => { const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = value; meta.append(tag); });
    const prompt = document.createElement('p'); prompt.className = 'exercise-prompt'; prompt.textContent = challenge.prompt;
    exercise.append(meta, prompt);
    const cards = challenge.state?.myHand;
    if (Array.isArray(cards)) { const row = document.createElement('div'); row.className = 'card-row'; cards.forEach(card => { const chip = document.createElement('span'); chip.className = 'lesson-card'; chip.textContent = cardLabel(card); row.append(chip); }); exercise.append(row); }
    if (challenge.id === 'uno-wild-color') {
      const colors = document.createElement('div'); colors.className = 'color-choices';
      [['red','Đỏ'],['blue','Xanh dương'],['green','Xanh lá'],['yellow','Vàng']].forEach(([id, name]) => { const button = document.createElement('button'); button.type = 'button'; button.className = 'color-choice'; button.dataset.color = id; button.textContent = name; button.setAttribute('aria-pressed','false'); button.addEventListener('click', () => { selectedColor = id; colors.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button))); }); colors.append(button); }); exercise.append(colors);
    } else if (challenge.id === 'poker-check') {
      const options = document.createElement('div'); options.className = 'choice-list';
      [['check','Check'],['call','Call'],['fold','Fold']].forEach(([id,name]) => { const label = document.createElement('label'); label.className = 'choice'; const input = document.createElement('input'); input.type='radio'; input.name='poker-action'; input.value=id; label.append(input, document.createTextNode(name)); options.append(label); }); exercise.append(options);
    } else if (challenge.id === 'phom-laydown') {
      const options = document.createElement('div'); options.className='choice-list';
      (cards || []).forEach(card => { const label = document.createElement('label'); label.className='choice'; const input=document.createElement('input'); input.type='checkbox'; input.value=card.id; label.append(input,document.createTextNode(cardLabel(card))); options.append(label); }); exercise.append(options);
    }
    setStatus(`Bài ${challenge.sequence + 1} / ${session?.total || 3}. Thử thao tác; phản hồi máy chủ sẽ cho biết vì sao một lựa chọn chưa hợp lệ.`, '');
  }
  function actionForChallenge() {
    if (currentChallenge?.id === 'uno-wild-color') return selectedColor ? { type:'choose-color', color:selectedColor } : null;
    if (currentChallenge?.id === 'poker-check') return { type:exercise.querySelector('input[name="poker-action"]:checked')?.value || '' };
    if (currentChallenge?.id === 'phom-laydown') return { melds:[Array.from(exercise.querySelectorAll('input[type="checkbox"]:checked'), item => item.value)] };
    return null;
  }
  async function loadServerContent() {
    try {
      const response = await noStoreFetch('/api/tutorial/guides');
      if (response.ok) { const payload = await response.json(); if (Array.isArray(payload.guides) && payload.guides.length) guides = payload.guides; version = payload.version || version; }
    } catch { /* local guide content remains available */ }
    $('curriculum-version').textContent = version;
    fillGuides();
    setStatus(token() ? 'Hướng dẫn đã sẵn sàng. Bắt đầu để mở một bài luyện được máy chủ xác minh.' : 'Bạn có thể xem hướng dẫn. Hãy khôi phục/tạo hồ sơ để chạy bài luyện và lưu xác minh.', '');
    try {
      const response = await noStoreFetch('/api/missions', { headers: authHeaders() });
      if (response.ok) { const payload = await response.json(); const mission = (payload.missions || []).find(item => item.id === 'tutorial_verified'); if (mission?.verified) { setStatus(mission.claimed ? 'Bạn đã hoàn thành hướng dẫn và nhận thưởng phiên bản này.' : 'Bạn đã hoàn thành hướng dẫn. Thưởng đang chờ nhận.', 'success'); startButton.hidden=true; claimButton.hidden=!!mission.claimed; } }
    } catch { /* guide lookup does not depend on profile progress */ }
  }
  startButton.addEventListener('click', async () => {
    if (!token()) { setStatus('Cần hồ sơ đã xác thực. Mở trang hồ sơ hoặc quay về sảnh để tạo/khôi phục hồ sơ.', 'error'); return; }
    startButton.disabled = true;
    try {
      const response = await noStoreFetch('/api/tutorial/start', { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body:JSON.stringify({ version }) });
      const payload = await response.json(); if (!response.ok || !payload.ok) throw new Error(errorMessage(payload, 'Không thể bắt đầu chương trình.'));
      if (payload.alreadyVerified) { setStatus('Phiên bản hướng dẫn này đã được xác minh cho hồ sơ của bạn.', 'success'); claimButton.hidden=false; startButton.hidden=true; return; }
      session = payload; if (!session.challenge) throw new Error('Máy chủ chưa trả thử thách hiện tại.'); drawChallenge(session.challenge);
    } catch (error) { setStatus(error.message.includes('Failed to fetch') ? 'Chưa kết nối được với máy chủ. Hãy thử lại khi kết nối ổn định.' : error.message, 'error'); }
    finally { startButton.disabled = false; }
  });
  submitButton.addEventListener('click', async () => {
    const action = actionForChallenge(); if (!action || (currentChallenge?.id === 'poker-check' && !action.type) || (currentChallenge?.id === 'phom-laydown' && !action.melds[0].length)) { setStatus('Chọn một thao tác trước khi gửi.', 'error'); return; }
    submitButton.disabled = true;
    try {
      const response = await noStoreFetch('/api/tutorial/submit', { method:'POST', headers:{ 'Content-Type':'application/json', ...authHeaders() }, body:JSON.stringify({ version:session.version, sessionId:session.sessionId, nonce:session.nonce, sequence:session.sequence, revision:session.revision, challengeId:currentChallenge.id, actionId:actionId(), action }) });
      const payload = await response.json(); if (!response.ok || !payload.ok) { if (['SESSION_EXPIRED','CHALLENGE_STALE','TUTORIAL_VERSION'].includes(payload.code || payload.error?.code)) { session=null; drawChallenge(null); } throw new Error(errorMessage(payload, 'Máy chủ chưa xác minh được thao tác.')); }
      setStatus(payload.feedback || 'Máy chủ đã xử lý thao tác.', payload.accepted ? 'success' : 'error');
      if (!payload.accepted) return;
      session.sequence = payload.sequence ?? session.sequence + 1; session.revision = payload.revision ?? session.revision + 1;
      if (payload.completed) { session.completed=true; drawChallenge(null); startButton.hidden=true; claimButton.hidden=false; setStatus('Đã hoàn thành chương trình hướng dẫn. Kết quả đã được lưu; bạn có thể nhận thưởng một lần.', 'success'); return; }
      drawChallenge(payload.challenge);
    } catch (error) { setStatus(error.message, 'error'); }
    finally { submitButton.disabled=false; }
  });
  claimButton.addEventListener('click', async () => {
    claimButton.disabled=true;
    try { const response=await noStoreFetch('/api/tutorial/claim',{method:'POST',headers:{'Content-Type':'application/json',...authHeaders()},body:JSON.stringify({version})}); const payload=await response.json(); if(!response.ok||!payload.ok) throw new Error(errorMessage(payload,'Không thể nhận thưởng.')); setStatus(payload.alreadyClaimed?'Thưởng phiên bản này đã được nhận trước đó.':'Đã nhận 200 coin vào hồ sơ.', 'success'); claimButton.hidden=true; }
    catch(error){setStatus(error.message,'error');} finally{claimButton.disabled=false;}
  });
  select.addEventListener('change', renderGuide);
  loadServerContent();
}());
