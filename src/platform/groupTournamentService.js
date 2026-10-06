'use strict';

// Group rankings are an application feature stored inside the existing
// ProfileStore database. This module never creates a database or changes the
// wallet/ledger. Group and room identity always come from injected server-side
// resolvers; HTTP callers can only select a group to authorize against them.
const crypto = require('node:crypto');
const { getGame } = require('./gameRegistry');

const TABLE = 'group_tournament_records';
const APP_SCHEMA_VERSION = 1;
const MAX_ROUNDS = 20;
const MAX_NAME_LENGTH = 48;

const RULES = Object.freeze({
  competitive: Object.freeze({
    id: 'competitive-3-1-v1',
    title: 'Thi đấu · 3 / 1 / 0 điểm',
    description: 'Thắng được 3 điểm, hòa được 1 điểm, thua được 0 điểm. Không xét tiền cược, chip, lời/lỗ hoặc thời gian ván.',
    win: 3, tie: 1, loss: 0,
  }),
  cooperative: Object.freeze({
    id: 'cooperative-success-2-v1',
    title: 'The Gang · cùng thắng',
    description: 'Khi server ghi nhận cả ván The Gang kết thúc thành công, mỗi thành viên bị khóa trong nhóm được 2 điểm; kết thúc thất bại được 0. Không xếp hạng riêng theo vai hay tiền.',
    win: 2, tie: 0, loss: 0,
  }),
});

const GAME_OPTIONS = Object.freeze({
  'the-gang': { minPlayers: 2, maxPlayers: 6, variants: ['standard'], rankingRule: RULES.cooperative.id },
  uno: { minPlayers: 2, maxPlayers: 6, variants: ['classic-local-v1', 'classic-108-v1'], rankingRule: RULES.competitive.id },
  'tien-len': { minPlayers: 2, maxPlayers: 4, variants: ['standard'], rankingRule: RULES.competitive.id },
  poker: { minPlayers: 2, maxPlayers: 6, variants: ['standard'], rankingRule: RULES.competitive.id },
  'sam-loc': { minPlayers: 2, maxPlayers: 5, variants: ['standard'], rankingRule: RULES.competitive.id },
  phom: { minPlayers: 2, maxPlayers: 4, variants: ['standard'], rankingRule: RULES.competitive.id },
  bang: { minPlayers: 4, maxPlayers: 7, variants: ['standard'], rankingRule: RULES.competitive.id },
});

class TournamentError extends Error {
  constructor(message, code = 'TOURNAMENT_ERROR', status = 400) { super(message); this.name = 'TournamentError'; this.code = code; this.status = status; }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { throw new TournamentError('Dữ liệu giải đấu đã lưu không đọc được.', 'TOURNAMENT_DATA_INVALID', 503); }
}
function uniqueSorted(values) { return [...new Set(values)].sort(); }
function sameSet(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && uniqueSorted(left).every((value, i) => value === uniqueSorted(right)[i]);
}
function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function isId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 160; }
function internalGameId(room) { return room?.gameId || 'the-gang'; }
function roomRulesVersion(room, gameId, variant) {
  return room?.rulesVersion ?? room?.config?.rulesVersion ?? (gameId === 'uno' ? variant : null);
}
function terminalRoomResult(room, gameId) {
  if (gameId === 'the-gang') return room?.gameOver === true || room?.phase === 'GAME_OVER';
  if (gameId === 'uno') return room?.phase === 'RESULT' || room?.uno?.phase === 'RESULT';
  return ['RESULT', 'GAME_OVER', 'CANCELLED'].includes(room?.phase);
}
function publicRules() {
  return {
    schemaVersion: APP_SCHEMA_VERSION,
    maxRounds: MAX_ROUNDS,
    tieBreak: 'Điểm tổng trước, sau đó số ván thắng. Nếu vẫn bằng nhau, cùng hạng; người chơi được hiển thị theo thứ tự thành viên đã khóa lúc bắt đầu.',
    noScore: 'Ván bị hủy hoặc có trạng thái bỏ cuộc được server xác nhận không cho điểm; một ván chưa có bằng chứng kết quả đã commit chưa được tính.',
    membership: 'Khi chủ nhóm bắt đầu giải, danh sách thành viên và thứ tự tham gia được khóa đến khi giải kết thúc hoặc chủ nhóm đóng giải.',
    points: Object.values(RULES).map(rule => ({ id: rule.id, title: rule.title, description: rule.description })),
    games: Object.entries(GAME_OPTIONS).map(([gameId, config]) => ({
      gameId, name: getGame(gameId)?.name || gameId, minPlayers: config.minPlayers, maxPlayers: config.maxPlayers,
      variants: config.variants.map(variant => ({ id: variant, name: gameId === 'the-gang' ? 'The Gang' : variant === 'classic-local-v1' ? 'UNO 112 lá' : variant === 'classic-108-v1' ? 'UNO 108 lá' : 'Chuẩn' })),
      scoringRule: config.rankingRule,
    })),
  };
}

class GroupTournamentService {
  constructor({ profileStore, getTrustedGroupSnapshot, now = () => new Date().toISOString(), idFactory = () => crypto.randomUUID() } = {}) {
    if (!profileStore?.db || typeof profileStore.transaction !== 'function') throw new TypeError('GroupTournamentService requires the existing ProfileStore.');
    if (profileStore.readOnly) throw new TypeError('GroupTournamentService requires a writable ProfileStore.');
    if (typeof getTrustedGroupSnapshot !== 'function') {
      throw new TypeError('GroupTournamentService requires C01 getTrustedGroupSnapshot(groupId).');
    }
    this.store = profileStore;
    this.getTrustedGroupSnapshot = getTrustedGroupSnapshot;
    this.now = now;
    this.idFactory = idFactory;
    this.startingGroups = new Set();
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS ${TABLE} (
        record_id TEXT PRIMARY KEY,
        record_type TEXT NOT NULL CHECK(record_type IN ('tournament', 'match')),
        group_id TEXT NOT NULL,
        tournament_id TEXT,
        game_id TEXT,
        variant TEXT,
        match_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        UNIQUE(group_id, game_id, variant, match_id)
      );
      CREATE INDEX IF NOT EXISTS group_tournament_group_idx ON ${TABLE}(group_id, record_type, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS group_tournament_active_idx ON ${TABLE}(group_id)
        WHERE record_type = 'tournament' AND status IN ('OPEN', 'IN_PROGRESS');
    `);
  }

  rules() { return publicRules(); }

  async getTrustedContext(groupId) {
    if (!isId(groupId)) throw new TournamentError('Yêu cầu nhóm không hợp lệ.', 'GROUP_REQUEST_INVALID');
    const snapshot = await this.getTrustedGroupSnapshot(groupId);
    if (!snapshot) return null;
    if (!Array.isArray(snapshot.participantProfileIds)) throw new TournamentError('Snapshot thành viên nhóm chưa hợp lệ.', 'GROUP_MEMBERS_INVALID', 503);
    const canonicalId = snapshot.groupId || snapshot.id || groupId;
    const memberIds = snapshot.participantProfileIds;
    if (!isId(canonicalId) || memberIds.some(id => !isId(id)) || new Set(memberIds).size !== memberIds.length || !isId(snapshot.hostProfileId)) {
      throw new TournamentError('Snapshot thành viên nhóm chưa hợp lệ.', 'GROUP_MEMBERS_INVALID', 503);
    }
    const snapshotMembers = Array.isArray(snapshot.members) ? snapshot.members : memberIds.map((profileId, joinOrder) => ({ profileId, joinOrder }));
    if (!sameSet(snapshotMembers.map(member => member?.profileId), memberIds)) throw new TournamentError('Thành viên trong snapshot không khớp danh sách hồ sơ.', 'GROUP_MEMBERS_INVALID', 503);
    const members = snapshotMembers.map((member, order) => {
      const profileId = member.profileId;
      const profile = this.store.db.prepare('SELECT display_name AS displayName FROM profiles WHERE id = ?').get(profileId);
      if (!profile) throw new TournamentError('Thành viên nhóm chưa có hồ sơ local.', 'GROUP_MEMBERS_INVALID', 503);
      return { profileId, displayName: String(member.displayName || profile.displayName || 'Người chơi').slice(0, 48),
        joinOrder: Number.isSafeInteger(member.joinOrder) ? member.joinOrder : order };
    });
    return { groupId: canonicalId, name: String(snapshot.name || snapshot.groupName || 'Nhóm').slice(0, 48),
      hostProfileId: snapshot.hostProfileId, currentTargetRoomCode: snapshot.currentTargetRoomCode || null,
      revision: snapshot.revision ?? snapshot.updatedAt ?? null, roomBinding: snapshot.roomBinding || null,
      transitionStatus: snapshot.transitionStatus || null, members };
  }

  async getLiveMemberContext(groupId, actorProfileId) {
    if (!isId(groupId) || !isId(actorProfileId)) throw new TournamentError('Yêu cầu nhóm không hợp lệ.', 'GROUP_REQUEST_INVALID');
    const context = await this.getTrustedContext(groupId);
    if (!context) throw new TournamentError('Nhóm không còn trong snapshot hoạt động của server.', 'GROUP_NOT_FOUND', 404);
    if (context.groupId !== groupId) throw new TournamentError('Mã nhóm không khớp snapshot server.', 'GROUP_NOT_FOUND', 404);
    this.requireMember(context, actorProfileId);
    return context;
  }

  stateFromRow(row) { return safeJson(row.payload_json); }

  async suspendForMissingGroup(state) {
    if (!['OPEN', 'IN_PROGRESS'].includes(state.status)) return state;
    if (state.pendingStartIntentId) {
      const intentRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match' AND status = 'STARTING'`).get(state.pendingStartIntentId);
      if (intentRow) {
        const intent = safeJson(intentRow.payload_json);
        const recovered = await this.recoverStartIntent({ startIntentId: intentRow.record_id, room: null });
        if (recovered.recovered || ['REGISTERED', 'RECONCILED'].includes(recovered.status)) {
          state = this.stateFromRow(this.rowByTournament(state.groupId, state.tournamentId));
        } else {
          const at = this.now();
          this.store.transaction(() => {
            const freshRow = this.rowByTournament(state.groupId, state.tournamentId);
            if (!freshRow) return;
            const fresh = safeJson(freshRow.payload_json);
            if (fresh.pendingStartIntentId !== intentRow.record_id || fresh.status !== 'IN_PROGRESS') return;
            const round = fresh.rounds[fresh.currentRound - 1];
            round.status = 'NO_SCORE'; round.appliedAt = at; round.decision = 'Server đã khởi động lại trước khi có thể liên kết kết quả đã commit; vòng không có điểm.'; round.results = [];
            fresh.resolvedRounds += 1; fresh.pendingStartIntentId = null;
            this.store.db.prepare(`UPDATE ${TABLE} SET status = 'NO_SCORE', updated_at = ?, payload_json = ? WHERE record_id = ? AND status = 'STARTING'`)
              .run(at, JSON.stringify({ ...intent, kind: 'start_intent', resolution: { status: 'NO_SCORE', appliedAt: at } }), intentRow.record_id);
            this.advance(fresh, at);
            fresh.status = 'SUSPENDED'; fresh.membershipLocked = false; fresh.currentRoundStatus = 'SUSPENDED';
            fresh.suspensionReason = 'Nhóm không có snapshot hoạt động sau khi server khởi động lại.'; fresh.suspendedAt = at; fresh.updatedAt = at;
            this.writeTournament(fresh);
          });
          state = this.stateFromRow(this.rowByTournament(state.groupId, state.tournamentId));
        }
      }
    }
    if (state.pendingMatchId) {
      const association = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_type = 'match' AND group_id = ? AND match_id = ? AND status = 'REGISTERED'`).get(state.groupId, state.pendingMatchId);
      const committed = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(state.pendingMatchId);
      if (association && committed) {
        const match = safeJson(association.payload_json);
        try {
          await this.reconcileCommittedMatch({ groupId: match.groupId, gameId: match.gameId, variant: match.variant, matchId: match.matchId });
          state = this.stateFromRow(this.rowByTournament(state.groupId, state.tournamentId));
        } catch (error) {
          if (!(error instanceof TournamentError)) throw error;
          this.applyNoScore(association, 'NO_SCORE', 'Server đã khởi động lại nhưng kết quả không vượt qua kiểm tra proof; không có điểm.');
          state = this.stateFromRow(this.rowByTournament(state.groupId, state.tournamentId));
        }
      } else if (association) {
        this.applyNoScore(association, 'NO_SCORE', 'Server đã khởi động lại trước khi kết quả được commit; không có điểm.');
        state = this.stateFromRow(this.rowByTournament(state.groupId, state.tournamentId));
      }
    }
    if (state.status === 'COMPLETED') return state;
    if (!['OPEN', 'IN_PROGRESS'].includes(state.status)) return state;
    const at = this.now();
    state.status = 'SUSPENDED'; state.membershipLocked = false; state.currentRoundStatus = 'SUSPENDED';
    state.suspensionReason = 'Nhóm không có snapshot hoạt động sau khi server khởi động lại.';
    state.suspendedAt = at; state.updatedAt = at;
    this.store.transaction(() => this.writeTournament(state));
    return state;
  }

  async readContext(groupId, actorProfileId) {
    if (!isId(groupId) || !isId(actorProfileId)) throw new TournamentError('Yêu cầu nhóm không hợp lệ.', 'GROUP_REQUEST_INVALID');
    const live = await this.getTrustedContext(groupId);
    if (live) {
      if (live.groupId !== groupId) throw new TournamentError('Mã nhóm không khớp snapshot server.', 'GROUP_NOT_FOUND', 404);
      this.requireMember(live, actorProfileId);
      const saved = this.rowsForGroup(groupId).map(row => this.stateFromRow(row));
      const states = saved
        .filter(state => state.roster.some(member => member.profileId === actorProfileId) || state.createdByProfileId === actorProfileId);
      if (saved.length && !states.length) throw new TournamentError('Bạn không thuộc đội hình đã khóa của giải này.', 'GROUP_FORBIDDEN', 403);
      return { live, states };
    }
    // C01 groups are currently in memory. After a process restart the saved
    // roster is the only safe authorization boundary for historical records.
    // Active records become suspended; they never accept more results against
    // an absent group snapshot.
    const saved = this.rowsForGroup(groupId).map(row => this.stateFromRow(row));
    const visible = saved.filter(state => state.roster.some(member => member.profileId === actorProfileId) || state.createdByProfileId === actorProfileId);
    if (!visible.length) throw new TournamentError('Bạn không có quyền xem lịch sử nhóm này.', 'GROUP_FORBIDDEN', 403);
    const suspended = [];
    for (const state of visible) suspended.push(await this.suspendForMissingGroup(state));
    return { live: null, states: suspended };
  }

  requireMember(context, actorProfileId) {
    if (!context.members.some(member => member.profileId === actorProfileId)) throw new TournamentError('Bạn không thuộc nhóm này.', 'GROUP_FORBIDDEN', 403);
  }

  requireHost(context, actorProfileId) {
    this.requireMember(context, actorProfileId);
    if (context.hostProfileId !== actorProfileId) throw new TournamentError('Chỉ chủ nhóm được thực hiện thao tác này.', 'GROUP_HOST_REQUIRED', 403);
  }

  rowsForGroup(groupId) {
    return this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE group_id = ? AND record_type = 'tournament' ORDER BY created_at DESC, record_id DESC`).all(groupId);
  }

  rowByTournament(groupId, tournamentId) {
    return this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE group_id = ? AND record_type = 'tournament' AND record_id = ?`).get(groupId, tournamentId);
  }

  publicSummary(state) {
    const standings = this.standings(state);
    return {
      tournamentId: state.tournamentId, name: state.name, status: state.status,
      gameId: state.gameId, variant: state.variant, scoringRule: state.scoringRule,
      plannedRounds: state.plannedRounds, completedRounds: state.completedRounds,
      resolvedRounds: state.resolvedRounds,
      currentRound: state.currentRound, currentRoundStatus: state.currentRoundStatus,
      membershipLocked: state.membershipLocked === true, createdAt: state.createdAt, updatedAt: state.updatedAt,
      standings,
    };
  }

  async list({ groupId, actorProfileId }) {
    const access = await this.readContext(groupId, actorProfileId);
    const tournaments = access.states.map(state => this.publicSummary(state));
    return { group: { name: String(access.live?.name || access.states[0]?.groupName || 'Nhóm').slice(0, 48) }, rules: this.rules(), tournaments,
      canManage: access.live ? access.live.hostProfileId === actorProfileId : access.states.some(state => state.createdByProfileId === actorProfileId && state.status === 'SUSPENDED'),
      activeTournamentId: tournaments.find(item => ['OPEN', 'IN_PROGRESS'].includes(item.status))?.tournamentId || null };
  }

  async detail({ groupId, tournamentId, actorProfileId }) {
    const access = await this.readContext(groupId, actorProfileId);
    const row = this.rowByTournament(groupId, tournamentId);
    if (!row) throw new TournamentError('Không tìm thấy giải đấu.', 'TOURNAMENT_NOT_FOUND', 404);
    const state = safeJson(row.payload_json);
    const isSavedMember = state.roster.some(member => member.profileId === actorProfileId) || state.createdByProfileId === actorProfileId;
    if (!isSavedMember) throw new TournamentError('Bạn không có quyền xem giải đấu này.', 'GROUP_FORBIDDEN', 403);
    return { ...this.publicSummary(state), canManage: access.live ? access.live.hostProfileId === actorProfileId : state.createdByProfileId === actorProfileId && state.status === 'SUSPENDED', rounds: state.rounds.map(round => ({
      number: round.number, status: round.status, matchId: round.matchId || null, gameId: state.gameId, variant: state.variant,
      appliedAt: round.appliedAt || null, decision: round.decision || null,
      results: (round.results || []).map(result => ({ name: this.displayName(state, result.profileId), outcome: result.outcome, points: result.points })),
    })), rules: this.rules() };
  }

  async create({ groupId, actorProfileId, name, gameId, variant, rounds }) {
    const context = await this.getLiveMemberContext(groupId, actorProfileId);
    this.requireHost(context, actorProfileId);
    const options = GAME_OPTIONS[gameId];
    if (!options || !getGame(gameId) || !options.variants.includes(variant)) throw new TournamentError('Chọn một game và biến thể đang được hỗ trợ.', 'TOURNAMENT_GAME_INVALID');
    if (context.members.length < options.minPlayers || context.members.length > options.maxPlayers) throw new TournamentError(`Game này cần nhóm có từ ${options.minPlayers} đến ${options.maxPlayers} thành viên.`, 'TOURNAMENT_GROUP_SIZE');
    if (!Number.isInteger(rounds) || rounds < 1 || rounds > MAX_ROUNDS) throw new TournamentError(`Số vòng phải từ 1 đến ${MAX_ROUNDS}.`, 'TOURNAMENT_ROUNDS_INVALID');
    const cleanName = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ').slice(0, MAX_NAME_LENGTH) : '';
    if (!cleanName) throw new TournamentError('Nhập tên giải đấu.', 'TOURNAMENT_NAME_INVALID');
    const at = this.now(), tournamentId = this.idFactory();
    const state = {
      schemaVersion: APP_SCHEMA_VERSION, tournamentId, groupId: context.groupId, groupName: context.name, name: cleanName,
      gameId, variant, scoringRule: options.rankingRule, rulesVersion: options.rankingRule,
      plannedRounds: rounds, completedRounds: 0, resolvedRounds: 0, currentRound: 0, currentRoundStatus: 'NOT_STARTED',
      status: 'OPEN', membershipLocked: false, createdByProfileId: actorProfileId,
      roster: context.members.map(member => ({ ...member })), totals: Object.fromEntries(context.members.map(member => [member.profileId,
        { points: 0, wins: 0, ties: 0, losses: 0, scoredMatches: 0 }])),
      rounds: [], pendingMatchId: null, createdAt: at, updatedAt: at, closedAt: null,
    };
    try {
      this.store.transaction(() => this.store.db.prepare(`INSERT INTO ${TABLE}
        (record_id, record_type, group_id, status, created_at, updated_at, payload_json)
        VALUES (?, 'tournament', ?, ?, ?, ?, ?)`)
        .run(tournamentId, context.groupId, state.status, at, at, JSON.stringify(state)));
    } catch (error) {
      if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT') || /UNIQUE constraint failed/.test(String(error?.message || ''))) throw new TournamentError('Nhóm đã có một giải đang mở.', 'TOURNAMENT_ALREADY_ACTIVE', 409);
      throw error;
    }
    return this.publicSummary(state);
  }

  async start({ groupId, tournamentId, actorProfileId }) {
    if (!isId(groupId) || !isId(actorProfileId)) throw new TournamentError('Yêu cầu nhóm không hợp lệ.', 'GROUP_REQUEST_INVALID');
    if (this.startingGroups.has(groupId)) throw new TournamentError('Một thao tác đang khóa roster nhóm.', 'TOURNAMENT_START_PENDING', 409);
    // Set before the first await: C01 membership and target hooks can observe
    // this reservation while the trusted group snapshot is being acquired.
    this.startingGroups.add(groupId);
    try {
      const context = await this.getLiveMemberContext(groupId, actorProfileId);
      this.requireHost(context, actorProfileId);
      return this.store.transaction(() => {
        const row = this.rowByTournament(context.groupId, tournamentId);
        if (!row) throw new TournamentError('Không tìm thấy giải đấu.', 'TOURNAMENT_NOT_FOUND', 404);
        const state = safeJson(row.payload_json);
        if (state.status !== 'OPEN') throw new TournamentError('Giải này không còn ở trạng thái chờ bắt đầu.', 'TOURNAMENT_STATE_INVALID', 409);
        if (!sameSet(context.members.map(item => item.profileId), state.roster.map(item => item.profileId))) throw new TournamentError('Danh sách thành viên đã đổi sau khi tạo giải.', 'TOURNAMENT_ROSTER_CHANGED', 409);
        state.status = 'IN_PROGRESS'; state.membershipLocked = true; state.currentRound = 1; state.currentRoundStatus = 'READY'; state.updatedAt = this.now();
        state.rounds.push({ number: 1, status: 'READY', matchId: null, results: [] });
        this.writeTournament(state);
        return this.publicSummary(state);
      });
    } finally {
      this.startingGroups.delete(groupId);
    }
  }

  async close({ groupId, tournamentId, actorProfileId }) {
    const context = await this.getTrustedContext(groupId);
    if (context) {
      if (context.groupId !== groupId) throw new TournamentError('Mã nhóm không khớp snapshot server.', 'GROUP_NOT_FOUND', 404);
      this.requireHost(context, actorProfileId);
    }
    return this.store.transaction(() => {
      const row = this.rowByTournament(groupId, tournamentId);
      if (!row) throw new TournamentError('Không tìm thấy giải đấu.', 'TOURNAMENT_NOT_FOUND', 404);
      const state = safeJson(row.payload_json);
      if (!context && (state.status !== 'SUSPENDED' || state.createdByProfileId !== actorProfileId)) throw new TournamentError('Chỉ chủ giải đã lưu mới có thể đóng giải bị treo.', 'GROUP_HOST_REQUIRED', 403);
      if (!['OPEN', 'IN_PROGRESS', 'SUSPENDED'].includes(state.status) || ['STARTING', 'PLAYING'].includes(state.currentRoundStatus)) throw new TournamentError('Đợi ván hiện tại được chốt trước khi đóng giải.', 'TOURNAMENT_MATCH_ACTIVE', 409);
      state.status = 'CLOSED'; state.membershipLocked = false; state.currentRoundStatus = 'CLOSED'; state.closedAt = this.now(); state.updatedAt = state.closedAt;
      this.writeTournament(state);
      return this.publicSummary(state);
    });
  }

  membershipLocked(groupId) {
    if (this.startingGroups.has(groupId)) return true;
    const row = this.store.db.prepare(`SELECT 1 FROM ${TABLE} WHERE group_id = ? AND record_type = 'tournament' AND status = 'IN_PROGRESS' LIMIT 1`).get(groupId);
    return Boolean(row);
  }

  authorizeTarget({ groupId, target } = {}) {
    if (!isId(groupId)) return { ok: false, code: 'GROUP_ID_INVALID', message: 'Thiếu mã nhóm đáng tin cậy.' };
    if (this.startingGroups.has(groupId)) return { ok: false, code: 'TOURNAMENT_START_PENDING', message: 'Đang khóa roster để bắt đầu giải.' };
    const row = this.store.db.prepare(`SELECT payload_json FROM ${TABLE}
      WHERE group_id = ? AND record_type = 'tournament' AND status IN ('OPEN', 'IN_PROGRESS')
      ORDER BY created_at DESC LIMIT 1`).get(groupId);
    if (!row) return { ok: true };
    const state = safeJson(row.payload_json);
    if (state.status === 'IN_PROGRESS') {
      const roundCanMove = state.currentRoundStatus === 'READY' && !state.pendingMatchId && !state.pendingStartIntentId;
      if (roundCanMove && target?.gameId === state.gameId && target?.variant === state.variant) return { ok: true };
      return { ok: false, code: 'TOURNAMENT_ACTIVE', message: 'Đợi ván hiện tại được chốt trước khi đổi bàn nhóm.' };
    }
    if (target?.gameId !== state.gameId || target?.variant !== state.variant) {
      return { ok: false, code: 'TOURNAMENT_TARGET_LOCKED', message: 'Giải đang mở đã chọn game và biến thể khác.' };
    }
    return { ok: true };
  }

  async prepareStartIntent({ groupId, room, gameId = internalGameId(room), variant } = {}) {
    if (!isId(groupId) || !room || !isId(room.code)) return { tracked: false };
    const context = await this.getTrustedContext(groupId);
    if (!context || context.groupId !== groupId) return { tracked: false };
    const binding = context.roomBinding;
    const roomCode = String(room.code).trim().toUpperCase();
    const canonicalVariant = variant || binding?.variant;
    const profileSeats = Array.isArray(room.players) ? room.players.map(player => ({ seatId: player?.id, profileId: player?.profileId })) : [];
    const participantProfileIds = profileSeats.map(seat => seat.profileId);
    const seatIds = profileSeats.map(seat => seat.seatId);
    const liveMembers = context.members.map(member => member.profileId);
    const waitingMatchId = isId(room.matchId) ? room.matchId : null;
    const waitingRoom = room.phase === 'WAITING';
    const replayRoom = terminalRoomResult(room, gameId) && Boolean(waitingMatchId)
      && Boolean(this.store.db.prepare(`SELECT 1 FROM matches m JOIN rooms r ON r.id = m.room_id
        WHERE m.match_id = ? AND m.game_id = ? AND m.status = 'COMPLETED' AND r.room_code = ?`).get(waitingMatchId, gameId, roomCode));
    if (!binding || context.currentTargetRoomCode !== roomCode || binding.roomCode !== roomCode || binding.gameId !== gameId
      || binding.variant !== canonicalVariant || binding.phase !== room.phase || (!waitingRoom && !replayRoom)
      || (binding.matchId && binding.matchId !== waitingMatchId)
      || !sameSet(binding.participants, liveMembers) || !sameSet(participantProfileIds, liveMembers)
      || participantProfileIds.some(id => !isId(id)) || seatIds.some(id => !isId(id))
      || new Set(seatIds).size !== seatIds.length || new Set(participantProfileIds).size !== participantProfileIds.length) {
      throw new TournamentError('Phòng chờ và đội hình nhóm chưa khớp với snapshot server.', 'MATCH_GROUP_BINDING_INVALID', 409);
    }
    const options = GAME_OPTIONS[gameId];
    if (!options || !options.variants.includes(canonicalVariant)) throw new TournamentError('Game hoặc biến thể không được hỗ trợ cho giải.', 'TOURNAMENT_GAME_INVALID', 409);
    return this.store.transaction(() => {
      const tournamentRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE group_id = ? AND record_type = 'tournament' AND status = 'IN_PROGRESS'`).get(groupId);
      if (!tournamentRow) return { tracked: false };
      const state = safeJson(tournamentRow.payload_json);
      if (state.gameId !== gameId || state.variant !== canonicalVariant) throw new TournamentError('Game và biến thể không khớp giải đang chạy.', 'TOURNAMENT_ROUND_NOT_READY', 409);
      if (!sameSet(participantProfileIds, state.roster.map(member => member.profileId)) || !sameSet(liveMembers, state.roster.map(member => member.profileId))) {
        throw new TournamentError('Đội hình phòng không khớp roster đã khóa.', 'TOURNAMENT_ROSTER_CHANGED', 409);
      }
      if (state.currentRoundStatus === 'STARTING' && state.pendingStartIntentId) {
        const existingRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match' AND status = 'STARTING'`).get(state.pendingStartIntentId);
        const existing = existingRow && safeJson(existingRow.payload_json);
        if (existing && existing.roomCode === roomCode && existing.gameId === gameId && existing.variant === canonicalVariant
          && existing.waitingMatchId === waitingMatchId && existing.startPhase === room.phase && sameSet(existing.participantProfileIds, participantProfileIds)) {
          return { tracked: true, duplicate: true, startIntentId: existingRow.record_id, tournamentId: state.tournamentId, round: state.currentRound, waitingMatchId, startPhase: room.phase };
        }
        throw new TournamentError('Đang có một lượt bắt đầu cần được khôi phục trước.', 'TOURNAMENT_START_PENDING', 409);
      }
      if (state.currentRoundStatus !== 'READY' || state.pendingMatchId || state.pendingStartIntentId) {
        throw new TournamentError('Vòng giải hiện chưa sẵn sàng bắt đầu ván mới.', 'TOURNAMENT_ROUND_NOT_READY', 409);
      }
      const at = this.now(), startIntentId = this.idFactory();
      const sentinelMatchId = `intent:${startIntentId}`;
      const intent = { kind: 'start_intent', schemaVersion: APP_SCHEMA_VERSION, startIntentId,
        tournamentId: state.tournamentId, groupId, gameId, variant: canonicalVariant, roomCode,
        roundNumber: state.currentRound, rulesVersion: state.rulesVersion,
        roomRulesVersion: roomRulesVersion(room, gameId, canonicalVariant),
        participantProfileIds: uniqueSorted(participantProfileIds), participantSeats: profileSeats,
        waitingMatchId, startPhase: room.phase, groupRevision: context.revision, preparedAt: at };
      this.store.db.prepare(`INSERT INTO ${TABLE}
        (record_id, record_type, group_id, tournament_id, game_id, variant, match_id, status, created_at, updated_at, payload_json)
        VALUES (?, 'match', ?, ?, ?, ?, ?, 'STARTING', ?, ?, ?)`)
        .run(startIntentId, groupId, state.tournamentId, gameId, canonicalVariant, sentinelMatchId, at, at, JSON.stringify(intent));
      state.currentRoundStatus = 'STARTING'; state.pendingStartIntentId = startIntentId;
      state.rounds[state.currentRound - 1].status = 'STARTING'; state.updatedAt = at;
      this.writeTournament(state);
      return { tracked: true, startIntentId, tournamentId: state.tournamentId, round: state.currentRound, waitingMatchId, startPhase: room.phase };
    });
  }

  async bindStartIntent({ startIntentId, room, recovery = false } = {}) {
    if (!isId(startIntentId)) throw new TournamentError('Thiếu mã lượt bắt đầu đã lưu.', 'START_INTENT_INVALID');
    const intentRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match'`).get(startIntentId);
    if (!intentRow) throw new TournamentError('Không tìm thấy lượt bắt đầu đã lưu.', 'START_INTENT_NOT_FOUND', 404);
    const intent = safeJson(intentRow.payload_json);
    if (intent.kind !== 'start_intent') {
      if (intent.startIntentId === startIntentId && intent.matchId === room?.matchId && intent.roomCode === room?.code
        && intent.gameId === internalGameId(room) && ['REGISTERED', 'SCORED', 'CANCELLED', 'NO_SCORE'].includes(intentRow.status)) {
        return { registered: true, duplicate: true, status: intentRow.status, matchId: intent.matchId, tournamentId: intent.tournamentId, round: intent.roundNumber };
      }
      throw new TournamentError('Dữ liệu lượt bắt đầu đã bị thay đổi.', 'START_INTENT_INVALID', 409);
    }
    if (!room || room.code !== intent.roomCode || internalGameId(room) !== intent.gameId || !isId(room.matchId)
      || room.matchId === intent.waitingMatchId
      || stableJson(roomRulesVersion(room, intent.gameId, intent.variant)) !== stableJson(intent.roomRulesVersion)) {
      throw new TournamentError('Manager chưa xác nhận một match mới trong đúng phòng.', 'MATCH_START_UNVERIFIED', 409);
    }
    const roomSeats = Array.isArray(room.players) ? room.players.map(player => ({ seatId: player?.id, profileId: player?.profileId })) : [];
    if (!sameSet(roomSeats.map(item => item.profileId), intent.participantProfileIds)
      || roomSeats.some(item => !isId(item.seatId) || !isId(item.profileId))
      || new Set(roomSeats.map(item => item.seatId)).size !== roomSeats.length) {
      throw new TournamentError('Ghế và hồ sơ trong manager đã đổi sau khi chuẩn bị bắt đầu.', 'MATCH_PARTICIPANTS_MISMATCH', 409);
    }
    const context = await this.getTrustedContext(intent.groupId);
    if (context) {
      const binding = context.roomBinding;
      const sameLockedRoster = context.groupId === intent.groupId
        && sameSet(context.members.map(item => item.profileId), intent.participantProfileIds);
      const exactCurrentBinding = context.currentTargetRoomCode === intent.roomCode && binding
        && binding.roomCode === intent.roomCode && binding.gameId === intent.gameId && binding.variant === intent.variant
        && binding.matchId === room.matchId && binding.phase === room.phase
        && sameSet(binding.participants, intent.participantProfileIds);
      if (!sameLockedRoster || (!exactCurrentBinding && !recovery)) {
        throw new TournamentError('Snapshot lifecycle sau khi bắt đầu chưa khớp matchId, phòng và roster đã khóa.', 'MATCH_GROUP_BINDING_INVALID', 409);
      }
    } else if (!recovery) {
      throw new TournamentError('Không thể xác minh snapshot nhóm sau khi bắt đầu.', 'GROUP_NOT_FOUND', 409);
    }
    return this.store.transaction(() => {
      const currentIntentRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match'`).get(startIntentId);
      if (!currentIntentRow) throw new TournamentError('Lượt bắt đầu đã biến mất.', 'START_INTENT_NOT_FOUND', 409);
      const currentIntent = safeJson(currentIntentRow.payload_json);
      if (currentIntent.kind !== 'start_intent') {
        if (currentIntent.startIntentId === startIntentId && currentIntent.matchId === room.matchId && currentIntent.roomCode === room.code
          && currentIntent.gameId === internalGameId(room) && ['REGISTERED', 'SCORED', 'CANCELLED', 'NO_SCORE'].includes(currentIntentRow.status)) {
          return { registered: true, duplicate: true, status: currentIntentRow.status, matchId: room.matchId,
            tournamentId: currentIntent.tournamentId, round: currentIntent.roundNumber };
        }
        throw new TournamentError('Lượt bắt đầu đã được liên kết với match khác.', 'MATCH_ASSOCIATION_CONFLICT', 409);
      }
      const stateRow = this.rowByTournament(currentIntent.groupId, currentIntent.tournamentId);
      if (!stateRow) throw new TournamentError('Giải liên kết với lượt bắt đầu không còn tồn tại.', 'TOURNAMENT_NOT_FOUND', 503);
      const state = safeJson(stateRow.payload_json);
      if (state.status !== 'IN_PROGRESS' || state.pendingStartIntentId !== startIntentId || state.currentRound !== currentIntent.roundNumber
        || state.currentRoundStatus !== 'STARTING' || state.gameId !== currentIntent.gameId || state.variant !== currentIntent.variant) {
        throw new TournamentError('Lượt bắt đầu không còn là vòng hiện tại của giải.', 'TOURNAMENT_MATCH_STALE', 409);
      }
      const conflict = this.store.db.prepare(`SELECT record_id, payload_json FROM ${TABLE}
        WHERE record_type = 'match' AND status = 'REGISTERED' AND group_id = ? AND game_id = ? AND variant = ? AND match_id = ?`)
        .get(currentIntent.groupId, currentIntent.gameId, currentIntent.variant, room.matchId);
      if (conflict && conflict.record_id !== startIntentId) throw new TournamentError('Mã match đã được liên kết với một giải khác.', 'MATCH_ASSOCIATION_CONFLICT', 409);
      const at = this.now();
      const match = { schemaVersion: APP_SCHEMA_VERSION, startIntentId,
        tournamentId: currentIntent.tournamentId, groupId: currentIntent.groupId,
        gameId: currentIntent.gameId, variant: currentIntent.variant, matchId: room.matchId, roomCode: currentIntent.roomCode,
        roundNumber: currentIntent.roundNumber, rulesVersion: currentIntent.rulesVersion,
        roomRulesVersion: currentIntent.roomRulesVersion,
        participantProfileIds: currentIntent.participantProfileIds,
        participantSeats: roomSeats, groupRevision: currentIntent.groupRevision,
        registeredAt: at, appliedAt: null, resolution: null };
      this.store.db.prepare(`UPDATE ${TABLE} SET match_id = ?, status = 'REGISTERED', updated_at = ?, payload_json = ?
        WHERE record_id = ? AND status = 'STARTING'`).run(room.matchId, at, JSON.stringify(match), startIntentId);
      state.pendingStartIntentId = null; state.pendingMatchId = room.matchId;
      state.currentRoundStatus = 'PLAYING'; state.rounds[state.currentRound - 1].status = 'PLAYING';
      state.rounds[state.currentRound - 1].matchId = room.matchId; state.updatedAt = at;
      this.writeTournament(state);
      return { registered: true, tournamentId: state.tournamentId, round: state.currentRound, matchId: room.matchId };
    });
  }

  failStartIntent({ startIntentId, room, message } = {}) {
    if (!isId(startIntentId)) return { failed: false, status: 'MISSING' };
    return this.store.transaction(() => {
      const row = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match' AND status = 'STARTING'`).get(startIntentId);
      if (!row) return { failed: false, status: 'NOT_STARTING' };
      const intent = safeJson(row.payload_json);
      if (intent.kind !== 'start_intent' || !room || room.code !== intent.roomCode || internalGameId(room) !== intent.gameId
        || room.phase !== intent.startPhase || (isId(room.matchId) ? room.matchId : null) !== intent.waitingMatchId) {
        return { failed: false, pending: true, status: 'START_STATE_UNCERTAIN' };
      }
      const tournamentRow = this.rowByTournament(intent.groupId, intent.tournamentId);
      if (!tournamentRow) return { failed: false, status: 'TOURNAMENT_MISSING' };
      const state = safeJson(tournamentRow.payload_json), at = this.now();
      this.store.db.prepare(`UPDATE ${TABLE} SET status = 'FAILED', updated_at = ?, payload_json = ? WHERE record_id = ? AND status = 'STARTING'`)
        .run(at, JSON.stringify({ ...intent, kind: 'start_intent', failedAt: at, failure: String(message || 'Manager declined the start').slice(0, 240) }), startIntentId);
      if (state.status === 'IN_PROGRESS' && state.pendingStartIntentId === startIntentId && state.currentRoundStatus === 'STARTING') {
        state.pendingStartIntentId = null; state.currentRoundStatus = 'READY';
        state.rounds[state.currentRound - 1].status = 'READY'; state.updatedAt = at; this.writeTournament(state);
      }
      return { failed: true, status: 'FAILED' };
    });
  }

  recoverStartIntent({ startIntentId, room } = {}) {
    const row = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ? AND record_type = 'match'`).get(startIntentId);
    if (!row) return Promise.resolve({ recovered: false, status: 'MISSING' });
    const intent = safeJson(row.payload_json);
    if (intent.kind !== 'start_intent') {
      if (row.status === 'REGISTERED') {
        const complete = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(intent.matchId);
        return complete ? this.reconcileCommittedMatch({ groupId: intent.groupId, gameId: intent.gameId, variant: intent.variant, matchId: intent.matchId })
          : Promise.resolve({ recovered: true, status: 'REGISTERED' });
      }
      return Promise.resolve({ recovered: false, status: row.status });
    }
    if (room && room.code === intent.roomCode && internalGameId(room) === intent.gameId
      && isId(room.matchId) && room.matchId !== intent.waitingMatchId
      && stableJson(roomRulesVersion(room, intent.gameId, intent.variant)) === stableJson(intent.roomRulesVersion)
      && sameSet((room.players || []).map(player => player.profileId), intent.participantProfileIds)) {
      return this.bindStartIntent({ startIntentId, room, recovery: true }).then(async linked => {
        const result = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(linked.matchId);
        if (result) await this.reconcileCommittedMatch({ groupId: intent.groupId, gameId: intent.gameId, variant: intent.variant, matchId: linked.matchId });
        return { recovered: true, status: result ? 'RECONCILED' : 'REGISTERED', matchId: linked.matchId };
      });
    }
    const candidates = this.completedIntentCandidates(intent);
    if (candidates.length === 1) {
      const candidate = candidates[0];
      const syntheticRoom = { code: intent.roomCode, gameId: intent.gameId, phase: 'RESULT', matchId: candidate.matchId,
        rulesVersion: intent.roomRulesVersion, players: intent.participantSeats };
      return this.bindStartIntent({ startIntentId, room: syntheticRoom, recovery: true }).then(async linked => {
        const result = await this.reconcileCommittedMatch({ groupId: intent.groupId, gameId: intent.gameId, variant: intent.variant, matchId: linked.matchId });
        return { recovered: true, status: result.status, matchId: linked.matchId };
      });
    }
    return Promise.resolve({ recovered: false, status: candidates.length ? 'AMBIGUOUS' : 'UNRESOLVED' });
  }

  completedIntentCandidates(intent) {
    const rows = this.store.db.prepare(`SELECT m.match_id AS matchId, m.completed_at AS completedAt
      FROM matches m JOIN rooms r ON r.id = m.room_id
      WHERE m.status = 'COMPLETED' AND m.game_id = ? AND r.room_code = ? AND m.completed_at >= ?
      ORDER BY m.completed_at, m.match_id`).all(intent.gameId, intent.roomCode, intent.preparedAt);
    return rows.filter(row => {
      const players = this.store.db.prepare('SELECT profile_id AS profileId FROM match_players WHERE match_id = ?').all(row.matchId);
      if (!sameSet(players.map(player => player.profileId), intent.participantProfileIds)) return false;
      const snapshots = this.store.db.prepare('SELECT snapshot_json AS snapshotJson FROM match_snapshots WHERE match_id = ?').all(row.matchId);
      return snapshots.some(item => {
        try {
          const snapshot = JSON.parse(item.snapshotJson);
          return snapshot?.matchId === row.matchId && snapshot?.gameId === intent.gameId && snapshot?.roomCode === intent.roomCode
            && (intent.gameId !== 'uno' || snapshot?.variant === intent.variant);
        } catch { return false; }
      });
    });
  }

  async registerRoomMatch({ groupId, roomCode, gameId, variant, matchId }) {
    if (!isId(groupId) || !isId(roomCode) || !isId(matchId)) {
      throw new TournamentError('Thông tin ván từ server chưa hợp lệ.', 'MATCH_CONTEXT_INVALID');
    }
    const context = await this.getTrustedContext(groupId);
    const binding = context?.roomBinding;
    const participants = context?.members.map(member => member.profileId) || [];
    if (!context || context.groupId !== groupId || context.currentTargetRoomCode !== roomCode || !binding
      || binding.roomCode !== roomCode || binding.gameId !== gameId || binding.variant !== variant || binding.matchId !== matchId || binding.phase !== 'WAITING') {
      throw new TournamentError('Phòng chưa khớp current-room binding server hoặc chưa sẵn sàng bắt đầu.', 'MATCH_GROUP_BINDING_INVALID', 409);
    }
    if (!Array.isArray(binding.participants) || !sameSet(participants, binding.participants)) throw new TournamentError('Ghế ván không khớp thành viên nhóm hiện tại.', 'MATCH_GROUP_MEMBERS_CHANGED', 409);
    const canonicalParticipants = uniqueSorted(binding.participants);
    if (canonicalParticipants.length !== binding.participants.length) throw new TournamentError('Danh sách ghế ván bị trùng.', 'MATCH_CONTEXT_INVALID');
    return this.store.transaction(() => {
      const tournamentRow = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE group_id = ? AND record_type = 'tournament' AND status = 'IN_PROGRESS'`).get(context.groupId);
      if (!tournamentRow) throw new TournamentError('Nhóm chưa có giải đang chạy.', 'TOURNAMENT_NOT_ACTIVE', 409);
      const state = safeJson(tournamentRow.payload_json);
      const previous = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_type = 'match' AND group_id = ? AND game_id = ? AND variant = ? AND match_id = ?`).get(groupId, gameId, variant, matchId);
      if (previous) {
        const priorMatch = safeJson(previous.payload_json);
        if (priorMatch.roomCode !== roomCode || !sameSet(priorMatch.participantProfileIds, canonicalParticipants)) throw new TournamentError('Mã ván đã liên kết với một snapshot khác.', 'MATCH_ASSOCIATION_CONFLICT', 409);
        return { registered: previous.status === 'REGISTERED', duplicate: true, status: previous.status,
          tournamentId: priorMatch.tournamentId, round: priorMatch.roundNumber, matchId };
      }
      if (state.currentRoundStatus !== 'READY' || state.pendingMatchId || state.gameId !== gameId || state.variant !== variant) {
        throw new TournamentError('Ván này không khớp vòng giải đang chờ.', 'TOURNAMENT_ROUND_NOT_READY', 409);
      }
      if (!sameSet(canonicalParticipants, state.roster.map(member => member.profileId)) || !sameSet(context.members.map(member => member.profileId), state.roster.map(member => member.profileId))) {
        throw new TournamentError('Danh sách thành viên đã khóa không khớp ván.', 'TOURNAMENT_ROSTER_CHANGED', 409);
      }
      const at = this.now(), associationId = this.idFactory();
      const match = { schemaVersion: APP_SCHEMA_VERSION, tournamentId: state.tournamentId, groupId: state.groupId,
        gameId, variant, matchId, roomCode, roundNumber: state.currentRound, rulesVersion: state.rulesVersion,
        participantProfileIds: canonicalParticipants, groupRevision: context.revision, registeredAt: at, appliedAt: null, resolution: null };
      this.store.db.prepare(`INSERT INTO ${TABLE}
        (record_id, record_type, group_id, tournament_id, game_id, variant, match_id, status, created_at, updated_at, payload_json)
        VALUES (?, 'match', ?, ?, ?, ?, ?, 'REGISTERED', ?, ?, ?)`)
        .run(associationId, state.groupId, state.tournamentId, gameId, variant, matchId, at, at, JSON.stringify(match));
      state.pendingMatchId = matchId; state.currentRoundStatus = 'PLAYING'; state.rounds[state.currentRound - 1].status = 'PLAYING';
      state.rounds[state.currentRound - 1].matchId = matchId; state.updatedAt = at;
      this.writeTournament(state);
      return { registered: true, tournamentId: state.tournamentId, round: state.currentRound, matchId };
    });
  }

  async cancelCurrentRound({ groupId, roomCode, gameId, variant, matchId }) {
    const context = await this.getTrustedContext(groupId);
    const binding = context?.roomBinding;
    if (!context || context.groupId !== groupId || context.currentTargetRoomCode !== roomCode || !binding
      || binding.roomCode !== roomCode || binding.gameId !== gameId || binding.variant !== variant || binding.matchId !== matchId
      || binding.phase !== 'CANCELLED' || binding.terminalStatus !== 'CANCELLED') {
      throw new TournamentError('Chỉ snapshot lifecycle server đã xác nhận hủy mới được bỏ điểm vòng này.', 'MATCH_CANCELLATION_UNVERIFIED', 409);
    }
    const association = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_type = 'match' AND game_id = ? AND variant = ? AND match_id = ? AND status = 'REGISTERED'`).get(gameId, variant, matchId);
    if (!association) throw new TournamentError('Không tìm thấy ván đang chờ xác minh.', 'MATCH_ASSOCIATION_NOT_FOUND', 404);
    const record = safeJson(association.payload_json);
    if (record.groupId !== groupId || record.roomCode !== roomCode || record.gameId !== gameId || record.variant !== variant
      || !sameSet(binding.participants, record.participantProfileIds)) throw new TournamentError('Ván hủy không khớp snapshot nhóm đã khóa.', 'MATCH_GROUP_BINDING_INVALID', 409);
    return this.applyNoScore(association, 'CANCELLED', 'Ván bị server hủy; không có điểm.');
  }

  resolveCapturedCancellation({ groupId, roomCode, gameId, variant, matchId, participantProfileIds } = {}) {
    const association = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_type = 'match' AND group_id = ?
      AND game_id = ? AND variant = ? AND match_id = ? AND status = 'REGISTERED'`).get(groupId, gameId, variant, matchId);
    if (!association) return { applied: false, status: 'NO_ASSOCIATION', matchId };
    const match = safeJson(association.payload_json);
    if (match.roomCode !== roomCode || !sameSet(match.participantProfileIds, participantProfileIds || [])) {
      throw new TournamentError('Thông tin hủy không khớp liên kết match đã lưu.', 'MATCH_GROUP_BINDING_INVALID', 409);
    }
    const committed = this.store.db.prepare("SELECT 1 FROM matches WHERE match_id = ? AND status = 'COMPLETED'").get(matchId);
    if (committed) return this.reconcileCommittedMatch({ groupId, gameId, variant, matchId });
    return this.applyNoScore(association, 'CANCELLED', 'Manager server đã hủy hoặc đưa match về sảnh; không có điểm.');
  }

  recoverCommittedCoinCancellation(match) {
    // The coin engines commit their refund operation and WAITING snapshot
    // together. This durable proof also repairs cancellations made before the
    // lifecycle hook existed, or a crash before the tournament update.
    if (!['tien-len', 'sam-loc', 'phom'].includes(match?.gameId)) return { applied: false };
    const operationKey = `${match.gameId}:cancel:${match.matchId}`;
    const operation = this.store.db.prepare("SELECT result_json FROM wallet_operations WHERE idempotency_key = ? AND kind = 'release_reservations'").get(operationKey);
    const snapshot = this.store.db.prepare('SELECT state_json, closed_at FROM game_snapshots WHERE game_id = ? AND room_code = ?').get(match.gameId, match.roomCode);
    if (!operation || !snapshot) return { applied: false };
    const room = safeJson(snapshot.state_json);
    if (!snapshot.closed_at && (room.code !== match.roomCode || room.phase !== 'WAITING' || room.matchId)) return { applied: false };
    const released = safeJson(operation.result_json).released;
    const reservations = this.store.db.prepare('SELECT id, profile_id, amount, currency, status FROM reservations WHERE room_code = ? AND match_id = ?').all(match.roomCode, match.matchId);
    const ledger = this.store.db.prepare('SELECT profile_id, available_delta, reserved_delta, currency, source, room_code, match_id FROM wallet_ledger WHERE operation_key = ?').all(operationKey);
    if (!Array.isArray(released) || released.length !== reservations.length || ledger.length !== reservations.length
      || !sameSet(reservations.map(row => row.profile_id), match.participantProfileIds)
      || reservations.some(row => row.status !== 'RELEASED' || row.currency !== 'coin'
        || !released.some(item => item.reservationId === row.id && item.profileId === row.profile_id)
        || !ledger.some(item => item.profile_id === row.profile_id && item.currency === 'coin' && item.source === 'release'
          && item.room_code === match.roomCode && item.match_id === match.matchId
          && item.available_delta === row.amount && item.reserved_delta === -row.amount))) return { applied: false };
    return this.resolveCapturedCancellation(match);
  }

  async reconcileCommittedMatch({ groupId, gameId, variant, matchId } = {}) {
    if (![groupId, gameId, variant, matchId].every(isId)) throw new TournamentError('Danh tính ván server chưa đầy đủ.', 'MATCH_ID_INVALID');
    return this.store.transaction(() => {
      const association = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_type = 'match' AND group_id = ? AND game_id = ? AND variant = ? AND match_id = ?`).get(groupId, gameId, variant, matchId);
      if (!association) throw new TournamentError('Ván chưa được liên kết với một nhóm giải.', 'MATCH_ASSOCIATION_NOT_FOUND', 404);
      if (association.status !== 'REGISTERED') return { applied: false, status: association.status, matchId };
      const match = safeJson(association.payload_json);
      const tournamentRow = this.rowByTournament(match.groupId, match.tournamentId);
      if (!tournamentRow) throw new TournamentError('Giải liên kết với ván không còn tồn tại.', 'TOURNAMENT_NOT_FOUND', 503);
      const state = safeJson(tournamentRow.payload_json);
      if (state.pendingMatchId !== matchId || state.currentRound !== match.roundNumber || state.status !== 'IN_PROGRESS') {
        throw new TournamentError('Ván không còn là vòng hiện tại của giải.', 'TOURNAMENT_MATCH_STALE', 409);
      }
      const proof = this.completedProof(match);
      const resolution = this.scoreProof(match, proof);
      const at = this.now();
      const round = state.rounds[match.roundNumber - 1];
      round.status = resolution.status; round.appliedAt = at; round.decision = resolution.decision;
      round.results = resolution.results;
      if (resolution.status === 'SCORED') {
        for (const item of resolution.results) {
          const total = state.totals[item.profileId];
          total.points += item.points; total.scoredMatches += 1;
          if (item.outcome === 'WIN') total.wins += 1;
          else if (item.outcome === 'TIE') total.ties += 1;
          else if (item.outcome === 'LOSS') total.losses += 1;
        }
        state.completedRounds += 1;
      }
      state.resolvedRounds += 1;
      match.appliedAt = at; match.resolution = { status: resolution.status, decision: resolution.decision };
      this.store.db.prepare(`UPDATE ${TABLE} SET status = ?, updated_at = ?, payload_json = ? WHERE record_id = ? AND status = 'REGISTERED'`)
        .run(resolution.status, at, JSON.stringify(match), association.record_id);
      this.advance(state, at);
      this.writeTournament(state);
      return { applied: true, status: resolution.status, decision: resolution.decision, matchId, tournament: this.publicSummary(state) };
    });
  }

  completedProof(association) {
    const row = this.store.db.prepare(`SELECT match_id AS matchId, game_id AS gameId, room_id AS roomId, status,
      result_json AS resultJson, completed_at AS completedAt FROM matches WHERE match_id = ?`).get(association.matchId);
    if (!row || row.status !== 'COMPLETED') throw new TournamentError('Chưa có kết quả đã commit trong ProfileStore.', 'MATCH_NOT_COMPLETED', 409);
    if (row.gameId !== association.gameId) throw new TournamentError('Game của kết quả không khớp với ván đã đăng ký.', 'MATCH_PROOF_MISMATCH', 409);
    const room = row.roomId ? this.store.db.prepare('SELECT room_code AS roomCode, game_id AS gameId FROM rooms WHERE id = ?').get(row.roomId) : null;
    if (!room || room.roomCode !== association.roomCode || room.gameId !== association.gameId) throw new TournamentError('Kết quả không còn liên kết với đúng phòng server.', 'MATCH_PROOF_MISMATCH', 409);
    const snapshots = this.store.db.prepare(`SELECT snapshot_json AS snapshotJson FROM match_snapshots WHERE match_id = ? ORDER BY committed_at DESC, id DESC`).all(association.matchId);
    const snapshot = snapshots.map(item => safeJson(item.snapshotJson)).find(item => item?.matchId === association.matchId && item?.gameId === association.gameId && item?.roomCode === association.roomCode);
    if (!snapshot || (snapshot.variant && snapshot.variant !== association.variant) || (association.gameId === 'uno' && snapshot.variant !== association.variant)) {
      throw new TournamentError('Thiếu snapshot kết quả server khớp game, biến thể, phòng và mã ván.', 'MATCH_PROOF_MISMATCH', 409);
    }
    const players = this.store.db.prepare(`SELECT profile_id AS profileId, outcome FROM match_players WHERE match_id = ? ORDER BY profile_id`).all(association.matchId);
    if (!sameSet(players.map(item => item.profileId), association.participantProfileIds)) throw new TournamentError('Danh sách người chơi trong kết quả đã commit không khớp ván đăng ký.', 'MATCH_PARTICIPANTS_MISMATCH', 409);
    const result = safeJson(row.resultJson);
    if (stableJson(snapshot.result) !== stableJson(result)) throw new TournamentError('Snapshot kết quả và bản ghi match không khớp.', 'MATCH_PROOF_MISMATCH', 409);
    return { result, snapshot, players, completedAt: row.completedAt };
  }

  scoreProof(match, proof) {
    const result = proof.result || {};
    const players = proof.players;
    const noScoreKind = this.noScoreKind(result, players);
    if (noScoreKind) return { status: noScoreKind, decision: noScoreKind === 'CANCELLED' ? 'Ván bị hủy; không có điểm.' : 'Ván bỏ cuộc theo bằng chứng server; không ai nhận điểm.', results: [] };
    const scoreRows = new Map();
    if (match.gameId === 'the-gang') {
      if (typeof result.won !== 'boolean') throw new TournamentError('Snapshot The Gang không có kết quả thắng/thua đã xác nhận.', 'MATCH_RESULT_UNSCORABLE', 409);
      for (const row of players) scoreRows.set(row.profileId, { outcome: result.won ? 'WIN' : 'LOSS', points: result.won ? RULES.cooperative.win : RULES.cooperative.loss });
    } else {
      const known = new Set(['WIN', 'TIE', 'LOSS']);
      if (players.every(row => known.has(String(row.outcome || '').toUpperCase()))) {
        for (const row of players) {
          const outcome = String(row.outcome).toUpperCase();
          scoreRows.set(row.profileId, { outcome, points: outcome === 'WIN' ? RULES.competitive.win : outcome === 'TIE' ? RULES.competitive.tie : RULES.competitive.loss });
        }
      } else {
        const winners = this.winnerProfiles(match, proof);
        if (!winners.length || winners.some(id => !match.participantProfileIds.includes(id))) throw new TournamentError('Snapshot kết quả không xác định được người thắng từ dữ liệu server.', 'MATCH_RESULT_UNSCORABLE', 409);
        for (const player of players) scoreRows.set(player.profileId, { outcome: winners.includes(player.profileId) ? (winners.length > 1 ? 'TIE' : 'WIN') : 'LOSS',
          points: winners.includes(player.profileId) ? (winners.length > 1 ? RULES.competitive.tie : RULES.competitive.win) : RULES.competitive.loss });
      }
    }
    const appliedRule = match.gameId === 'the-gang' ? RULES.cooperative.title : RULES.competitive.title;
    return { status: 'SCORED', decision: `Đã tính theo luật ${appliedRule}.`, results: players.map(row => ({
      profileId: row.profileId, outcome: scoreRows.get(row.profileId).outcome, points: scoreRows.get(row.profileId).points,
    })) };
  }

  winnerProfiles(match, proof) {
    const result = proof.result || {};
    if (Array.isArray(result.winnerProfileIds)) return result.winnerProfileIds.filter(isId);
    if (isId(result.winnerProfileId)) return [result.winnerProfileId];
    if (match.gameId === 'uno' && isId(result.winnerId)) {
      // ProfileStore captures this immutable seat mapping in the completion
      // snapshot. A room row can already describe the next hand by the time a
      // queued completion event is reconciled.
      const seats = proof.snapshot?.participants;
      if (Array.isArray(seats)) {
        const matching = seats.filter(seat => seat?.seatId === result.winnerId && isId(seat?.profileId));
        if (matching.length === 1 && match.participantProfileIds.includes(matching[0].profileId)) return [matching[0].profileId];
      }
    }
    return [];
  }

  noScoreKind(result, players) {
    const kind = String(result.kind || result.status || '').toUpperCase();
    if (result.cancelled === true || result.canceled === true || ['CANCELLED', 'CANCELED'].includes(kind) || players.some(item => String(item.outcome || '').toUpperCase() === 'CANCELLED')) return 'CANCELLED';
    if (result.forfeit === true || result.forfeited === true || result.forfeitProfileId || (Array.isArray(result.forfeitedProfileIds) && result.forfeitedProfileIds.length)
      || ['FORFEIT', 'FORFEITED'].includes(kind) || players.some(item => String(item.outcome || '').toUpperCase() === 'FORFEIT')) return 'NO_SCORE';
    return null;
  }

  applyNoScore(association, status, decision) {
    return this.store.transaction(() => {
      const fresh = this.store.db.prepare(`SELECT * FROM ${TABLE} WHERE record_id = ?`).get(association.record_id);
      if (!fresh || fresh.status !== 'REGISTERED') return { applied: false, status: fresh?.status || 'MISSING' };
      const match = safeJson(fresh.payload_json), row = this.rowByTournament(match.groupId, match.tournamentId);
      const state = safeJson(row.payload_json), at = this.now(), round = state.rounds[match.roundNumber - 1];
      round.status = status; round.decision = decision; round.appliedAt = at; round.results = [];
      state.resolvedRounds += 1;
      match.appliedAt = at; match.resolution = { status, decision };
      this.store.db.prepare(`UPDATE ${TABLE} SET status = ?, updated_at = ?, payload_json = ? WHERE record_id = ? AND status = 'REGISTERED'`).run(status, at, JSON.stringify(match), fresh.record_id);
      this.advance(state, at); this.writeTournament(state);
      return { applied: true, status, decision, matchId: match.matchId, tournament: this.publicSummary(state) };
    });
  }

  advance(state, at) {
    state.pendingMatchId = null;
    if (state.resolvedRounds >= state.plannedRounds) {
      state.status = 'COMPLETED'; state.membershipLocked = false; state.currentRoundStatus = 'COMPLETED'; state.completedAt = at;
    } else {
      state.currentRound += 1; state.currentRoundStatus = 'READY';
      state.rounds.push({ number: state.currentRound, status: 'READY', matchId: null, results: [] });
    }
    state.updatedAt = at;
  }

  writeTournament(state) {
    this.store.db.prepare(`UPDATE ${TABLE} SET status = ?, updated_at = ?, payload_json = ? WHERE record_id = ? AND record_type = 'tournament'`)
      .run(state.status, state.updatedAt, JSON.stringify(state), state.tournamentId);
  }

  standings(state) {
    const entries = state.roster.map(member => ({ profileId: member.profileId, name: member.displayName, joinOrder: member.joinOrder,
      ...(state.totals[member.profileId] || { points: 0, wins: 0, ties: 0, losses: 0, scoredMatches: 0 }) }));
    entries.sort((a, b) => b.points - a.points || b.wins - a.wins || a.joinOrder - b.joinOrder || a.profileId.localeCompare(b.profileId));
    let rank = 0, previous = null;
    const publicRows = entries.map((entry, index) => {
      if (!previous || entry.points !== previous.points || entry.wins !== previous.wins) rank = index + 1;
      previous = entry;
      return { rank, name: entry.name, points: entry.points, wins: entry.wins, ties: entry.ties, losses: entry.losses, scoredMatches: entry.scoredMatches };
    });
    return publicRows;
  }

  displayName(state, profileId) { return state.roster.find(member => member.profileId === profileId)?.displayName || 'Người chơi'; }
}

module.exports = { GroupTournamentService, TournamentError, publicTournamentRules: publicRules, MAX_ROUNDS };
