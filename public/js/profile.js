'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const token = localStorage.getItem(PROFILE_TOKEN_KEY);
const socket = io({ auth: token ? { profileToken: token } : {} });
const $ = id => document.getElementById(id);
let profile = null;

function message(text) { $('notice').textContent = text || ''; }
function request(event, data) { return new Promise(resolve => socket.emit(event, data, resolve)); }
function remember(payload) {
  if (!payload?.profile) return;
  if (payload.profileToken) { localStorage.setItem(PROFILE_TOKEN_KEY, payload.profileToken); socket.auth = { profileToken: payload.profileToken }; }
  if (payload.recoveryCode) localStorage.setItem(PROFILE_RECOVERY_KEY, payload.recoveryCode);
  profile = payload.profile;
  render();
}
function render() {
  $('guest').hidden = !!profile; $('profile').hidden = !profile;
  if (!profile) return;
  $('avatar').textContent = profile.avatar; $('display-name').textContent = profile.displayName;
  $('available').textContent = Number(profile.wallet.available).toLocaleString('vi-VN'); $('reserved').textContent = Number(profile.wallet.reserved).toLocaleString('vi-VN');
  $('edit-name').value = profile.displayName; $('edit-avatar').value = profile.avatar; $('profile-id').textContent = profile.id;
  $('recovery-code').textContent = localStorage.getItem(PROFILE_RECOVERY_KEY) || 'Mở ở thiết bị đã tạo hồ sơ để xem mã này.';
  const missions = $('missions'); missions.replaceChildren();
  (profile.missions || []).forEach(mission => {
    const item = document.createElement('article'); item.className = 'mission';
    const details = document.createElement('div'); const title = document.createElement('strong'); title.textContent = mission.description;
    const progress = document.createElement('progress'); progress.max = mission.threshold; progress.value = Math.min(mission.progress, mission.threshold);
    const text = document.createElement('p'); text.textContent = `${mission.progress}/${mission.threshold} · +${mission.reward} chip`;
    details.append(title, progress, text); item.appendChild(details);
    const action = document.createElement('div');
    if (!mission.enabled) action.textContent = 'Chưa mở';
    else if (mission.claimed) { action.textContent = 'Đã nhận'; action.className = 'done'; }
    else if (!mission.complete) action.textContent = 'Chưa hoàn thành';
    else { const button = document.createElement('button'); button.textContent = `Nhận +${mission.reward}`; button.addEventListener('click', async () => { const result = await request('claim_mission', { missionId: mission.id, version: mission.version }); if (result?.error) return message(result.error); remember(result); message('Đã nhận thưởng vào ví.'); }); action.appendChild(button); }
    item.appendChild(action); missions.appendChild(item); $('period').textContent = mission.period;
  });
  const ledger = $('ledger'); ledger.replaceChildren(); const rows = profile.ledger || [];
  if (!rows.length) { const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = 'Chưa có giao dịch chip.'; ledger.appendChild(empty); }
  rows.forEach(row => { const item = document.createElement('li'); const note = document.createElement('span'); note.textContent = row.note; const amount = document.createElement('span'); const delta = row.availableDelta + row.reservedDelta; amount.textContent = `${delta >= 0 ? '+' : ''}${delta.toLocaleString('vi-VN')}`; item.append(note, amount); ledger.appendChild(item); });
}

$('create').addEventListener('click', async () => { const result = await request('profile_bootstrap', { playerName: $('new-name').value, avatar: $('new-avatar').value }); if (result?.error) return message(result.error); remember(result); message('Hồ sơ đã tạo. Hãy lưu mã khôi phục bên dưới.'); });
$('recover').addEventListener('click', async () => { const result = await request('profile_recover', { profileId: $('recover-id').value.trim(), recoveryCode: $('recover-code').value.trim() }); if (result?.error) return message(result.error); remember(result); message('Đã khôi phục hồ sơ trên thiết bị này.'); });
$('save-profile').addEventListener('click', async () => { const result = await request('profile_update', { playerName: $('edit-name').value, avatar: $('edit-avatar').value }); if (result?.error) return message(result.error); remember(result); message('Đã lưu hồ sơ; ví chip không thay đổi.'); });
socket.on('profile_state', remember);
socket.on('connect', () => socket.emit('profile_status', {}, response => { if (response?.profile) remember(response); else { profile = null; render(); } }));
socket.on('game_error', error => message(error.message));
