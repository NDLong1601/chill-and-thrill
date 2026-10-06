'use strict';

const PROFILE_TOKEN_KEY = 'chill-thrill:profile-token';
const LEGACY_PROFILE_TOKEN_KEY = 'gang.profileToken';
const PROFILE_RECOVERY_KEY = 'chill-thrill:profile-recovery';
const memoryStorage = new Map();
function storageGet(key) {
  try { const value = globalThis.localStorage?.getItem(key); if (value !== null && value !== undefined) return value; } catch {}
  return memoryStorage.get(key) || null;
}
function storageSet(key, value) {
  memoryStorage.set(key, String(value));
  try { globalThis.localStorage?.setItem(key, String(value)); } catch {}
}
const token = storageGet(PROFILE_TOKEN_KEY) || storageGet(LEGACY_PROFILE_TOKEN_KEY);
const socket = io({ auth: token ? { profileToken: token } : {} });
const $ = id => document.getElementById(id);
let profile = null;

function message(text) { $('notice').textContent = text || ''; }
function request(event, data) { return new Promise(resolve => socket.emit(event, data, resolve)); }
function remember(payload) {
  if (!payload?.profile) return;
  if (payload.profileToken) {
    storageSet(PROFILE_TOKEN_KEY, payload.profileToken); storageSet(LEGACY_PROFILE_TOKEN_KEY, payload.profileToken);
    socket.auth = { profileToken: payload.profileToken };
  }
  if (payload.recoveryCode) storageSet(PROFILE_RECOVERY_KEY, payload.recoveryCode);
  profile = payload.profile;
  render();
}
function render() {
  $('guest').hidden = !!profile; $('profile').hidden = !profile;
  if (!profile) return;
  window.CurrencyWallet?.render(profile);
  $('avatar').textContent = profile.avatar; $('display-name').textContent = profile.displayName;
  $('available').textContent = Number(profile.wallet.available).toLocaleString('vi-VN'); $('reserved').textContent = Number(profile.wallet.reserved).toLocaleString('vi-VN');
  $('edit-name').value = profile.displayName; $('edit-avatar').value = profile.avatar; $('profile-id').textContent = profile.id;
  $('recovery-code').textContent = storageGet(PROFILE_RECOVERY_KEY) || 'Mở ở thiết bị đã tạo hồ sơ để xem mã này.';
  const missions = $('missions'); missions.replaceChildren();
  (profile.missions || []).forEach(mission => {
    const item = document.createElement('article'); item.className = 'mission';
    const details = document.createElement('div'); const title = document.createElement('strong'); title.textContent = mission.description;
    const progress = document.createElement('progress'); progress.max = mission.threshold; progress.value = Math.min(mission.progress, mission.threshold);
    const text = document.createElement('p'); text.textContent = `${mission.progress}/${mission.threshold} · +${mission.reward} ${mission.currency || 'coin'}`;
    details.append(title, progress, text); item.appendChild(details);
    const action = document.createElement('div');
    if (!mission.enabled) action.textContent = 'Chưa mở';
    else if (mission.claimed) { action.textContent = 'Đã nhận'; action.className = 'done'; }
    else if (!mission.complete && mission.kind === 'tutorial') { const link = document.createElement('a'); link.href = '/tutorial'; link.className = 'button-link'; link.textContent = 'Học hướng dẫn'; action.appendChild(link); }
    else if (!mission.complete) action.textContent = 'Chưa hoàn thành';
    else { const button = document.createElement('button'); button.textContent = `Nhận +${mission.reward}`; button.addEventListener('click', async () => { const result = await request('claim_mission', { missionId: mission.id, version: mission.version }); if (result?.error) return message(result.error); remember(result); message('Đã nhận thưởng vào ví.'); }); action.appendChild(button); }
    item.appendChild(action); missions.appendChild(item); if (mission.kind !== 'tutorial') $('period').textContent = mission.period;
  });
  const ledger = $('ledger'); ledger.replaceChildren(); const rows = profile.ledger || [];
  if (!rows.length) { const empty = document.createElement('li'); empty.className = 'empty'; empty.textContent = 'Chưa có biến động ví.'; ledger.appendChild(empty); }
  const signed = value => `${value > 0 ? '+' : ''}${value.toLocaleString('vi-VN')}`;
  rows.forEach(row => {
    const item = document.createElement('li'); item.className = 'ledger-entry';
    const note = document.createElement('strong'); note.textContent = row.note || row.reason || 'Biến động ví';
    const amount = document.createElement('span');
    if (Number.isSafeInteger(row.availableDelta) && Number.isSafeInteger(row.reservedDelta)) {
      const currency = ['chip', 'coin', 'gem'].includes(row.currency) ? row.currency : `tiền (${String(row.currency || 'không rõ')})`;
      const total = row.availableDelta + row.reservedDelta;
      amount.textContent = `Khả dụng ${signed(row.availableDelta)} · Đang giữ ${signed(row.reservedDelta)} · Tổng tài sản ${signed(total)} ${currency}`;
    } else amount.textContent = 'Máy chủ chưa gửi đủ chi tiết biến động.';
    item.append(note, amount); ledger.appendChild(item);
  });
}
document.addEventListener('currency-wallet:updated', event => {
  const data = event.detail;
  profile = { ...profile, ...data.profile, ledger: data.history, missions: data.missions };
  render();
});

$('create').addEventListener('click', async () => { const result = await request('profile_bootstrap', { playerName: $('new-name').value, avatar: $('new-avatar').value }); if (result?.error) return message(result.error); remember(result); message('Hồ sơ đã tạo. Hãy lưu mã khôi phục bên dưới.'); });
$('recover').addEventListener('click', async () => { const result = await request('profile_recover', { profileId: $('recover-id').value.trim(), recoveryCode: $('recover-code').value.trim() }); if (result?.error) return message(result.error); remember(result); message('Đã khôi phục hồ sơ trên thiết bị này.'); });
$('save-profile').addEventListener('click', async () => { const result = await request('profile_update', { playerName: $('edit-name').value, avatar: $('edit-avatar').value }); if (result?.error) return message(result.error); remember(result); message('Đã lưu hồ sơ; ví chip không thay đổi.'); });
socket.on('profile_state', remember);
socket.on('connect', () => socket.emit('profile_status', {}, response => { if (response?.profile) remember(response); else { profile = null; render(); } }));
socket.on('game_error', error => message(error.message));

const storageBanner = $('storage-status');
const refreshStorageStatus = () => window.StorageStatus?.refresh(storageBanner);
refreshStorageStatus();
window.addEventListener('focus', refreshStorageStatus);
setInterval(() => { if (document.visibilityState === 'visible') refreshStorageStatus(); }, 60000);
