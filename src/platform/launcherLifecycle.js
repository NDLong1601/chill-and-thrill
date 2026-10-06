'use strict';

const { fork } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');
const crypto = require('node:crypto');

function launcherError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

class ServerSupervisor extends EventEmitter {
  constructor(options = {}) {
    super();
    this.childScript = path.resolve(options.childScript || path.resolve(__dirname, '../../scripts/launcher-game-child.js'));
    this.projectRoot = path.resolve(options.projectRoot || path.resolve(__dirname, '../..'));
    this.env = { ...(options.env || {}) };
    this.startTimeoutMs = options.startTimeoutMs ?? 30000;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 15000;
    this.spawnChild = options.spawnChild || ((script, env) => fork(script, [], {
      cwd: this.projectRoot,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      windowsHide: true,
    }));
    this.state = 'idle';
    this.child = null;
    this.startAttempt = null;
    this.stopAttempts = new Map();
    this.server = null;
    this.lastError = null;
    this.exitInfo = null;
  }

  getStatus() {
    return {
      state: this.state,
      managedProcess: Boolean(this.child),
      port: this.server?.port ?? null,
      urls: this.server?.urls || [],
      lastError: this.lastError,
      exitInfo: this.exitInfo,
    };
  }

  start() {
    if (this.startAttempt) return Promise.reject(launcherError('Đang khởi động máy chủ. Vui lòng đợi trạng thái hiện tại.', 'START_IN_PROGRESS'));
    if (this.child) {
      if (this.state === 'running') return Promise.resolve({ ...this.getStatus(), alreadyRunning: true });
      return Promise.reject(launcherError('Tiến trình máy chủ trước chưa thoát; hãy đợi hoặc thử dừng lại.', 'SERVER_PROCESS_ACTIVE'));
    }

    this.state = 'starting';
    this.lastError = null;
    this.exitInfo = null;
    let child;
    try { child = this.spawnChild(this.childScript, this.env); }
    catch (error) {
      this.state = 'failed';
      this.lastError = { code: error.code || 'CHILD_SPAWN_FAILED', message: `Không mở được tiến trình máy chủ: ${error.message}` };
      this.emit('change', this.getStatus());
      return Promise.reject(launcherError(this.lastError.message, this.lastError.code));
    }
    this.child = child;
    const attempt = { settled: false, timer: null, resolve: null, reject: null, child };
    const result = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject; });
    this.startAttempt = attempt;
    attempt.timer = setTimeout(() => {
      if (attempt.settled) return;
      attempt.settled = true;
      if (this.startAttempt === attempt) this.startAttempt = null;
      this.state = 'start-timeout';
      this.lastError = { code: 'START_TIMEOUT', message: 'Chưa nhận được xác nhận khởi động. Tiến trình vẫn còn chạy; hãy xem trạng thái hoặc thử Dừng.' };
      this.emit('change', this.getStatus());
      attempt.reject(launcherError(this.lastError.message, this.lastError.code));
    }, this.startTimeoutMs);

    child.on('message', message => this._onMessage(child, message));
    child.on('error', error => this._onChildError(child, error));
    child.on('exit', (code, signal) => this._onExit(child, code, signal));
    child.on('disconnect', () => this.emit('change', this.getStatus()));
    this.emit('change', this.getStatus());
    return result;
  }

  stop() {
    if (this.state === 'stopped' && !this.child) return Promise.resolve({ ...this.getStatus(), alreadyStopped: true });
    if (this.state === 'starting') return Promise.reject(launcherError('Máy chủ đang khởi động. Đợi kết quả rồi thử Dừng lại.', 'START_IN_PROGRESS'));
    if (!this.child) {
      const message = this.state === 'idle'
        ? 'Chưa xác nhận trạng thái máy chủ. Hãy khởi động và dừng bằng launcher trước khi sao lưu.'
        : 'Không xác nhận được máy chủ đã dừng an toàn. Không thể sao lưu; hãy xem trạng thái và xử lý tiến trình máy chủ bên ngoài launcher.';
      return Promise.reject(launcherError(message, this.state === 'idle' ? 'SERVER_STATE_UNVERIFIED' : 'STOP_NOT_CONFIRMED'));
    }
    if (this.state === 'stopping') return Promise.reject(launcherError('Đang chờ máy chủ dừng. Vui lòng đợi.', 'STOP_IN_PROGRESS'));

    const child = this.child;
    const requestId = crypto.randomBytes(12).toString('hex');
    const attempt = { requestId, child, ack: false, exited: false, settled: false, timer: null, resolve: null, reject: null };
    const result = new Promise((resolve, reject) => { attempt.resolve = resolve; attempt.reject = reject; });
    this.stopAttempts.set(requestId, attempt);
    this.state = 'stopping';
    this.lastError = null;
    attempt.timer = setTimeout(() => {
      if (attempt.settled) return;
      attempt.settled = true;
      this.state = 'stop-failed';
      this.lastError = { code: 'STOP_TIMEOUT', message: 'Máy chủ chưa xác nhận đóng hoặc tiến trình chưa thoát. Không bị buộc tắt; hãy thử Dừng lại.' };
      this.emit('change', this.getStatus());
      attempt.reject(launcherError(this.lastError.message, this.lastError.code));
    }, this.stopTimeoutMs);
    attempt.timer.unref?.();
    this.emit('change', this.getStatus());
    try {
      child.send({ type: 'stop', requestId }, error => {
        if (error && !attempt.settled) {
          this._failStop(attempt, error.code || 'STOP_IPC_FAILED', `Không gửi được yêu cầu dừng: ${error.message}`);
        }
      });
    } catch (error) {
      this._failStop(attempt, error.code || 'STOP_IPC_FAILED', `Không gửi được yêu cầu dừng: ${error.message}`);
    }
    return result;
  }

  _onMessage(child, message) {
    if (child !== this.child || !message || typeof message !== 'object') return;
    if (message.type === 'ready') {
      const attempt = this.startAttempt;
      this.server = { port: Number(message.port), urls: Array.isArray(message.urls) ? message.urls : [] };
      const stopAlreadyRequested = this.state === 'stopping' || this.state === 'stop-failed';
      this.state = stopAlreadyRequested ? this.state : 'running';
      if (!stopAlreadyRequested) this.lastError = null;
      this.emit('change', this.getStatus());
      if (attempt && !attempt.settled) {
        attempt.settled = true;
        clearTimeout(attempt.timer);
        this.startAttempt = null;
        attempt.resolve({ ...this.getStatus(), alreadyRunning: false });
      }
      return;
    }
    if (message.type === 'startup-error') {
      const error = { code: message.error?.code || 'SERVER_START_FAILED', message: message.error?.message || 'Không khởi động được máy chủ.' };
      this.state = 'failed';
      this.lastError = error;
      this.emit('change', this.getStatus());
      const attempt = this.startAttempt;
      if (attempt && !attempt.settled) {
        attempt.settled = true;
        clearTimeout(attempt.timer);
        this.startAttempt = null;
        attempt.reject(launcherError(error.message, error.code));
      }
      return;
    }
    if (message.type === 'runtime-error') {
      this.state = 'failed';
      this.lastError = { code: message.error?.code || 'SERVER_RUNTIME_FAILED', message: message.error?.message || 'Máy chủ báo lỗi khi đang chạy.' };
      this.emit('change', this.getStatus());
      return;
    }
    if (message.type === 'stopped') {
      const attempt = this.stopAttempts.get(message.requestId);
      if (!attempt || attempt.child !== child) return;
      attempt.ack = true;
      attempt.closeError = message.error || null;
      if (attempt.closeError) this._failStop(attempt, attempt.closeError.code || 'SERVER_CLOSE_FAILED', attempt.closeError.message || 'Máy chủ không đóng sạch.');
      this._settleStopIfComplete(attempt);
    }
  }

  _onChildError(child, error) {
    if (child !== this.child) return;
    this.state = 'failed';
    this.lastError = { code: error.code || 'CHILD_PROCESS_ERROR', message: `Lỗi tiến trình máy chủ: ${error.message}` };
    this.emit('change', this.getStatus());
    const attempt = this.startAttempt;
    if (attempt && !attempt.settled) {
      attempt.settled = true;
      clearTimeout(attempt.timer);
      this.startAttempt = null;
      attempt.reject(launcherError(this.lastError.message, this.lastError.code));
    }
  }

  _onExit(child, code, signal) {
    if (child !== this.child) return;
    this.exitInfo = { code, signal };
    this.child = null;
    this.server = null;
    const start = this.startAttempt;
    if (start && !start.settled) {
      start.settled = true;
      clearTimeout(start.timer);
      this.startAttempt = null;
      const error = launcherError('Tiến trình máy chủ thoát trước khi xác nhận đã khởi động.', 'CHILD_EXITED_DURING_START');
      start.reject(error);
      this.lastError = { code: error.code, message: error.message };
    }

    const attempts = [...this.stopAttempts.values()].filter(attempt => attempt.child === child);
    const acknowledged = attempts.some(attempt => attempt.ack && !attempt.closeError);
    const cleanExit = code === 0 && acknowledged;
    if (cleanExit) {
      this.state = 'stopped';
      this.lastError = null;
      for (const attempt of attempts) {
        attempt.exited = true;
        this._settleStopIfComplete(attempt);
      }
    } else {
      this.state = this.state === 'stop-failed' ? 'stop-failed' : 'failed';
      if (!this.lastError || this.state !== 'stop-failed') {
        const missingAck = code === 0 ? 'Không nhận được xác nhận dừng sạch từ tiến trình.' : `Tiến trình máy chủ thoát bất thường (mã ${code ?? 'không rõ'}${signal ? `, ${signal}` : ''}).`;
        this.lastError = { code: code === 0 ? 'STOP_ACK_MISSING' : 'SERVER_EXITED_UNEXPECTEDLY', message: missingAck };
      }
      for (const attempt of attempts) {
        attempt.exited = true;
        if (!attempt.settled) this._failStop(attempt, this.lastError.code, this.lastError.message);
      }
    }
    this.emit('change', this.getStatus());
  }

  _settleStopIfComplete(attempt) {
    if (attempt.settled || !attempt.ack || !attempt.exited) return;
    if (attempt.closeError) return;
    attempt.settled = true;
    clearTimeout(attempt.timer);
    if (this.state !== 'stop-failed') this.state = 'stopped';
    this.lastError = null;
    this.stopAttempts.delete(attempt.requestId);
    this.emit('change', this.getStatus());
    attempt.resolve({ ...this.getStatus(), alreadyStopped: false });
  }

  _failStop(attempt, code, message) {
    if (attempt.settled) return;
    attempt.settled = true;
    clearTimeout(attempt.timer);
    this.state = 'stop-failed';
    this.lastError = { code, message };
    this.emit('change', this.getStatus());
    attempt.reject(launcherError(message, code));
  }
}

module.exports = { ServerSupervisor, launcherError };
