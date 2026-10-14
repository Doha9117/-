/**
 * 버튼 누르기 실험 - Google Apps Script 저장소
 *
 * 이 스크립트를 결과를 모을 Google 스프레드시트에 붙여 넣고 웹 앱으로 배포하면
 * 참가자 웹사이트(docs/index.html)와 연구자 페이지(docs/admin.html)가 여기에 기록합니다.
 * 설치 방법은 저장소 README의 "웹사이트로 실험하기"를 보세요.
 */

// 연구자 페이지 비밀번호. 반드시 바꾸세요. 참가자에게 알려주면 안 됩니다.
const ADMIN_KEY = 'change-me';

const DEFAULT_CONFIG = {
  p0: 0.95, pStep: 0.05, pMin: 0.05,
  r0: 100, rStep: 100, cost: 0,
  failMode: 'lose', cap: 10, safety: 200,
  showProb: true, showReward: true, showRemain: true,
  allowRepeat: false, open: true,
  title: '버튼 누르기 과제',
  consentText: '이 과제는 연구 목적으로 진행됩니다. 수집되는 정보는 입력한 참가자 ID와 과제 중 버튼을 누른 기록뿐이며, 연구 목적으로만 사용됩니다. 언제든 창을 닫아 참여를 중단할 수 있습니다.'
};

const RUN_COLS = ['run_id', 'participant_id', 'group', 'assignment', 'limit', 'status', 'presses', 'earned',
  'end_reason', 'started_at', 'ended_at', 'instruction_ms', 'total_ms', 'user_agent', 'config_json'];
const PRESS_COLS = ['run_id', 'participant_id', 'group', 'press_no', 'prob', 'reward', 'draw', 'success',
  'pot_before', 'pot_after', 'ms_since_start'];

function doGet(e) {
  return handle_(e && e.parameter ? e.parameter : {});
}

function doPost(e) {
  let body = {};
  try { body = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'bad_request' }); }
  return handle_(body);
}

function handle_(req) {
  try {
    switch (req.action) {
      case 'config': return json_({ ok: true, config: getConfig_() });
      case 'start': return json_(start_(req));
      case 'finish': return json_(finish_(req));
      case 'adminData': requireAdmin_(req); return json_(adminData_());
      case 'saveConfig': requireAdmin_(req); return json_(saveConfig_(req.config));
      case 'deleteRun': requireAdmin_(req); return json_(deleteRun_(req.runId));
      case 'ping': requireAdmin_(req); return json_({ ok: true });
      default: return json_({ ok: false, error: 'unknown_action' });
    }
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function requireAdmin_(req) {
  if (!ADMIN_KEY || ADMIN_KEY === 'change-me') throw new Error('admin_key_not_set');
  if (req.key !== ADMIN_KEY) throw new Error('wrong_key');
}

// ---------- 시트 ----------
function sheet_(name, cols) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    if (cols) {
      sh.appendRow(cols); sh.setFrozenRows(1);
      // 참가자 ID가 숫자로 바뀌지 않도록(예: 001 -> 1) 텍스트 서식으로 고정
      sh.getRange('A:B').setNumberFormat('@');
    }
  }
  return sh;
}

function rows_(sh) {
  const values = sh.getDataRange().getValues();
  const head = values.shift() || [];
  return values.map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => o[h] = v[j]);
    return o;
  });
}

function getConfig_() {
  const sh = sheet_('settings');
  const raw = sh.getRange('A1').getValue();
  let saved = {};
  if (raw) { try { saved = JSON.parse(raw); } catch (err) { saved = {}; } }
  return Object.assign({}, DEFAULT_CONFIG, saved);
}

function saveConfig_(config) {
  const c = Object.assign({}, DEFAULT_CONFIG, config || {});
  sheet_('settings').getRange('A1').setValue(JSON.stringify(c));
  return { ok: true, config: c };
}

// ---------- 참가자 ----------
function start_(req) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cfg = getConfig_();
    if (!cfg.open) return { ok: false, error: 'closed' };
    const pid = String(req.participantId || '').trim().slice(0, 60);
    if (!pid) return { ok: false, error: 'no_participant_id' };
    const sh = sheet_('runs', RUN_COLS);
    const all = rows_(sh);
    if (!cfg.allowRepeat && all.some(r => String(r.participant_id) === pid && r.status === 'finished')) {
      return { ok: false, error: 'duplicate' };
    }
    let group = req.group === 'control' || req.group === 'experimental' ? req.group : null;
    const assignment = group ? 'link' : 'balanced';
    if (!group) {
      // 시작한 인원(완료 + 진행 중) 기준으로 적은 집단에 배정, 같으면 무작위
      const n = { control: 0, experimental: 0 };
      all.forEach(r => { if (n[r.group] !== undefined) n[r.group]++; });
      group = n.control === n.experimental ? (Math.random() < 0.5 ? 'control' : 'experimental')
        : (n.control < n.experimental ? 'control' : 'experimental');
    }
    const runId = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
    const limit = group === 'experimental' ? cfg.cap : cfg.safety;
    const now = new Date().toISOString();
    sh.appendRow([runId, pid, group, assignment, limit, 'started', 0, 0, '', now, '', '', '',
      String(req.userAgent || '').slice(0, 300), JSON.stringify(cfg)]);
    return { ok: true, runId: runId, group: group, limit: limit, config: cfg, startedAt: now };
  } finally {
    lock.releaseLock();
  }
}

function finish_(req) {
  const run = req.run || {};
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = sheet_('runs', RUN_COLS);
    const found = rows_(sh).filter(r => String(r.run_id) === String(run.runId))[0];
    if (!found) return { ok: false, error: 'unknown_run' };
    if (found.status === 'finished') return { ok: true, already: true };
    const presses = Array.isArray(run.presses) ? run.presses.slice(0, 5000) : [];
    const last = presses.length ? presses[presses.length - 1].potAfter : 0;
    const values = [
      'finished', presses.length, Number(last) || 0, String(run.endReason || ''),
      new Date().toISOString(), Number(run.instructionMs) || '', Number(run.totalMs) || ''
    ];
    // status ~ total_ms 열(6~13번째)을 갱신. started_at(10번째)은 유지
    sh.getRange(found._row, 6, 1, 3).setValues([values.slice(0, 3)]);
    sh.getRange(found._row, 9, 1, 1).setValues([[values[3]]]);
    sh.getRange(found._row, 11, 1, 3).setValues([values.slice(4)]);
    if (presses.length) {
      const ps = sheet_('presses', PRESS_COLS);
      const rows = presses.map(p => [found.run_id, found.participant_id, found.group, p.n, p.prob, p.reward,
        p.draw, p.success ? 1 : 0, p.potBefore, p.potAfter, p.ms]);
      ps.getRange(ps.getLastRow() + 1, 1, rows.length, PRESS_COLS.length).setValues(rows);
    }
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

// ---------- 연구자 ----------
function adminData_() {
  const runs = rows_(sheet_('runs', RUN_COLS)).map(strip_);
  const presses = rows_(sheet_('presses', PRESS_COLS)).map(strip_);
  return { ok: true, runs: runs, presses: presses, config: getConfig_() };
}

function strip_(o) {
  const c = Object.assign({}, o);
  delete c._row;
  Object.keys(c).forEach(k => { if (c[k] instanceof Date) c[k] = c[k].toISOString(); });
  return c;
}

function deleteRun_(runId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    [['runs', RUN_COLS], ['presses', PRESS_COLS]].forEach(([name, cols]) => {
      const sh = sheet_(name, cols);
      const hit = rows_(sh).filter(r => String(r.run_id) === String(runId)).map(r => r._row).reverse();
      hit.forEach(row => sh.deleteRow(row));
    });
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}
