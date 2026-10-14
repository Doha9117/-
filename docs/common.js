// 참가자 페이지와 연구자 페이지가 함께 쓰는 규칙·저장소·통계
(() => {
"use strict";

const DEFAULTS = {
  p0: 0.95, pStep: 0.05, pMin: 0.05,
  r0: 100, rStep: 100, cost: 0,
  failMode: "lose", cap: 10, safety: 200,
  showProb: true, showReward: true, showRemain: true,
  allowRepeat: false, open: true,
  title: "버튼 누르기 과제",
  consentText: "이 과제는 연구 목적으로 진행됩니다. 수집되는 정보는 입력한 참가자 ID와 과제 중 버튼을 누른 기록뿐이며, 연구 목적으로만 사용됩니다. 언제든 창을 닫아 참여를 중단할 수 있습니다."
};

// n번째 누름(1부터)의 성공 확률과 성공 보상
const probAt = (n, c) => Math.max(c.pMin, c.p0 - c.pStep * (n - 1));
const rewardAt = (n, c) => c.r0 + c.rStep * (n - 1);

function rand() { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] / 4294967296; }
const won = x => (x < 0 ? "−" : "") + Math.abs(Math.round(x)).toLocaleString("ko-KR") + "원";
const pct = x => { const v = Math.round(x * 1000) / 10; return (Number.isInteger(v) ? v : v.toFixed(1)) + "%"; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const ERRORS = {
  closed: "지금은 참여를 받고 있지 않습니다.",
  duplicate: "이 참가자 ID는 이미 참여를 마쳤습니다.",
  no_participant_id: "참가자 ID를 입력해 주세요.",
  wrong_key: "연구자 비밀번호가 맞지 않습니다.",
  admin_key_not_set: "Apps Script의 ADMIN_KEY를 아직 바꾸지 않았습니다. Code.gs 맨 위의 값을 바꾸고 다시 배포하세요.",
  unknown_run: "진행 기록을 찾지 못했습니다.",
  network: "서버에 연결하지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요."
};
const errorText = code => ERRORS[code] || `오류가 발생했습니다 (${code}).`;

// ---------- 저장소 ----------
const URL_ = (window.EXPERIMENT_API_URL || "").trim();
const demo = !URL_;

async function remote(body) {
  let res;
  try {
    // text/plain 이면 CORS 사전 요청 없이 Apps Script로 보낼 수 있다
    res = await fetch(URL_, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow" });
  } catch (e) { return { ok: false, error: "network" }; }
  try { return await res.json(); } catch (e) { return { ok: false, error: "network" }; }
}

// 데모 모드: Code.gs와 같은 규칙을 이 브라우저의 localStorage로 흉내 낸다
const LS = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};
async function local(req) {
  const cfg = { ...DEFAULTS, ...LS.get("bx.demo.config", {}) };
  const runs = LS.get("bx.demo.runs", []), presses = LS.get("bx.demo.presses", []);
  switch (req.action) {
    case "config": return { ok: true, config: cfg };
    case "start": {
      if (!cfg.open) return { ok: false, error: "closed" };
      const pid = String(req.participantId || "").trim();
      if (!pid) return { ok: false, error: "no_participant_id" };
      if (!cfg.allowRepeat && runs.some(r => r.participant_id === pid && r.status === "finished")) return { ok: false, error: "duplicate" };
      let group = ["control", "experimental"].includes(req.group) ? req.group : null;
      const assignment = group ? "link" : "balanced";
      if (!group) {
        const n = { control: 0, experimental: 0 }; runs.forEach(r => n[r.group]++);
        group = n.control === n.experimental ? (rand() < 0.5 ? "control" : "experimental") : n.control < n.experimental ? "control" : "experimental";
      }
      const runId = Math.floor(rand() * 2 ** 48).toString(16).padStart(12, "0");
      const limit = group === "experimental" ? cfg.cap : cfg.safety, now = new Date().toISOString();
      runs.push({ run_id: runId, participant_id: pid, group, assignment, limit, status: "started", presses: 0, earned: 0, end_reason: "", started_at: now, ended_at: "", instruction_ms: "", total_ms: "", user_agent: req.userAgent || "", config_json: JSON.stringify(cfg) });
      LS.set("bx.demo.runs", runs);
      return { ok: true, runId, group, limit, config: cfg, startedAt: now };
    }
    case "finish": {
      const run = req.run, r = runs.find(x => x.run_id === run.runId);
      if (!r) return { ok: false, error: "unknown_run" };
      if (r.status === "finished") return { ok: true, already: true };
      const ps = run.presses || [];
      Object.assign(r, { status: "finished", presses: ps.length, earned: ps.length ? ps[ps.length - 1].potAfter : 0, end_reason: run.endReason, ended_at: new Date().toISOString(), instruction_ms: run.instructionMs, total_ms: run.totalMs });
      ps.forEach(p => presses.push({ run_id: r.run_id, participant_id: r.participant_id, group: r.group, press_no: p.n, prob: p.prob, reward: p.reward, draw: p.draw, success: p.success ? 1 : 0, pot_before: p.potBefore, pot_after: p.potAfter, ms_since_start: p.ms }));
      LS.set("bx.demo.runs", runs); LS.set("bx.demo.presses", presses);
      return { ok: true };
    }
    case "ping": return { ok: true };
    case "adminData": return { ok: true, runs, presses, config: cfg };
    case "saveConfig": { const c = { ...DEFAULTS, ...req.config }; LS.set("bx.demo.config", c); return { ok: true, config: c }; }
    case "deleteRun":
      LS.set("bx.demo.runs", runs.filter(r => r.run_id !== req.runId));
      LS.set("bx.demo.presses", presses.filter(p => p.run_id !== req.runId));
      return { ok: true };
  }
  return { ok: false, error: "unknown_action" };
}

const api = req => demo ? local(req) : remote(req);

// ---------- 통계 ----------
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const sd = a => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };

function lgamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = 0.99999999999980993; g.forEach((v, i) => x += v / (z + i + 1));
  const t = z + g.length - 0.5; return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}
function ibeta(x, a, b) {   // 정규화 불완전 베타 함수 (연분수)
  if (x <= 0) return 0; if (x >= 1) return 1;
  if (x > (a + 1) / (a + b + 2)) return 1 - ibeta(1 - x, b, a);
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b + lgamma(a + b) - lgamma(a) - lgamma(b)) / a;
  let f = 1, c = 1, d = 0;
  for (let i = 0; i <= 300; i++) {
    const m = i >> 1;
    const num = i === 0 ? 1 : i % 2 === 0 ? (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m)) : -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 + num * d; d = Math.abs(d) < 1e-30 ? 1e-30 : d; d = 1 / d;
    c = 1 + num / c; c = Math.abs(c) < 1e-30 ? 1e-30 : c;
    const cd = c * d; f *= cd; if (Math.abs(1 - cd) < 1e-12) break;
  }
  return front * (f - 1);
}
// Welch t 검정 (양측)
function welch(a, b) {
  if (a.length < 2 || b.length < 2) return null;
  const va = sd(a) ** 2 / a.length, vb = sd(b) ** 2 / b.length, se = Math.sqrt(va + vb);
  if (!se) return null;
  const t = (mean(a) - mean(b)) / se, df = (va + vb) ** 2 / (va ** 2 / (a.length - 1) + vb ** 2 / (b.length - 1));
  return { t, df, p: ibeta(df / (df + t * t), df / 2, 0.5) };
}

// ---------- CSV ----------
const csvCell = v => { const s = v === null || v === undefined ? "" : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
function toCsv(rows, cols) { return "﻿" + [cols, ...rows.map(r => cols.map(c => r[c]))].map(r => r.map(csvCell).join(",")).join("\n"); }
function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  a.download = name; document.body.appendChild(a); a.click(); a.remove();
}

window.BX = { DEFAULTS, probAt, rewardAt, rand, won, pct, esc, errorText, api, demo, LS, mean, median, sd, welch, toCsv, download };
})();
