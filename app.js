'use strict';

const STORE = 'alcpt-practice-v1';   // 考試紀錄與每題統計
const CURRENT = 'alcpt-current-v1';  // 進行中的測驗（可中斷後繼續）
const PICK = 'alcpt-pick-v1';        // 上次選的題庫

const CATS = {
  question: '聽力・問答',
  statement: '聽力・敘述',
  dialogue: '聽力・對話',
  grammar: '文法',
  vocab: '字彙',
  usage: '文法・字彙', // PDF 未標註文法/字彙的回數
  reading: '閱讀理解',
};
const SPEAKER = { M: '男', W: '女', M2: '男2', W2: '女2', Q: '問' };
const COUNTS = [0, 50, 20]; // 0 = 全部

const $ = (s) => document.querySelector(s);
const app = $('#app');
const tabs = $('#tabs');

let banks = [];
const bankData = {};   // bank -> questions[]
const Q = {};          // question id -> question
let db = loadDB();
let session = loadJSON(CURRENT);
let pick = { banks: [], count: 0, section: 'both' }; // section: both / listening / reading
const SECTIONS = [['both', '聽力＋閱讀'], ['listening', '只考聽力'], ['reading', '只考閱讀']];
let view = 'home';
let resultFilter = 'wrong'; // 題目回顧：wrong / right / all
let shownAttempt = null;

/* ---------- storage ---------- */

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function loadDB() {
  const d = loadJSON(STORE);
  return d && Array.isArray(d.attempts) && d.stats ? d : { attempts: [], stats: {} };
}
function saveDB() {
  try { localStorage.setItem(STORE, JSON.stringify(db)); } catch { toast('無法儲存紀錄（瀏覽器空間不足或私密模式）'); }
}
function saveSession() {
  try {
    if (session) localStorage.setItem(CURRENT, JSON.stringify(session));
    else localStorage.removeItem(CURRENT);
  } catch { /* ignore */ }
}

/* ---------- data ---------- */

async function loadBanks() {
  banks = await (await fetch('data/banks.json')).json();
  let saved = null;
  try { saved = localStorage.getItem(PICK); } catch { /* ignore */ }
  if (saved === 'all' && banks.length > 1) pick.banks = banks.map((b) => b.bank);
  else pick.banks = [banks.some((b) => b.bank === saved) ? saved : banks[0].bank];
}
async function ensureBanks(ids) {
  await Promise.all([...new Set(ids)].filter((b) => !bankData[b]).map(async (b) => {
    const meta = banks.find((x) => x.bank === b);
    if (!meta) return;
    const data = await (await fetch(meta.file)).json();
    bankData[b] = data.questions;
    for (const q of data.questions) Q[q.id] = q;
  }));
}
const bankOf = (qid) => qid.slice(1, qid.indexOf('-'));

/* ---------- utils ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
function fmtDate(t) {
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtDur(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} 分` : `${Math.floor(m / 60)} 時 ${m % 60} 分`;
}
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
}
// 頁內確認視窗（部分環境會封鎖瀏覽器的 confirm()）
function ask(msg, okLabel = '確定') {
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML = `<div class="dialog" role="dialog" aria-modal="true">
      <p>${esc(msg)}</p>
      <div class="row"><button class="btn ghost" data-r="0">取消</button><button class="btn" data-r="1">${esc(okLabel)}</button></div></div>`;
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-r]');
      if (!b && e.target !== box) return;
      e.stopPropagation();
      box.remove();
      resolve(!!b && b.dataset.r === '1');
    });
    document.body.appendChild(box);
    box.querySelector('[data-r="1"]').focus();
  });
}
function copyBackup() {
  const text = JSON.stringify(db);
  const fallback = () => {
    const t = document.createElement('textarea');
    t.value = text;
    document.body.appendChild(t);
    t.select();
    const ok = document.execCommand && document.execCommand('copy');
    t.remove();
    toast(ok ? '已複製備份文字' : '無法複製');
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => toast('已複製備份文字，可貼到記事本保存'), fallback);
  else fallback();
}

function setView(v) {
  view = v;
  const inQuiz = v === 'quiz';
  document.body.classList.toggle('quiz', inQuiz);
  tabs.hidden = inQuiz;
  tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
  window.scrollTo(0, 0);
}

/* ---------- home ---------- */

function renderHome() {
  setView('home');
  const pool = pick.banks.reduce((n, b) => {
    const m = banks.find((x) => x.bank === b);
    return n + (pick.section === 'both' ? m.count : m[pick.section]);
  }, 0);
  const reviewN = reviewPool().length;
  app.innerHTML = `
    <h1>ALCPT 聽力・閱讀練習</h1>
    ${session ? `
      <div class="card">
        <div class="row between"><b>有未完成的測驗</b><span class="muted">${Object.keys(session.answers).length} / ${session.qids.length} 題</span></div>
        <button class="btn" data-a="resume">繼續作答</button>
        <button class="btn ghost" data-a="discard">放棄並重新開始</button>
      </div>` : ''}
    <div class="card">
      <h2 style="margin-top:0"><label for="bank-sel">選擇題庫</label></h2>
      <select id="bank-sel" class="select">
        ${banks.map((b) => {
          const last = lastScore(b.bank);
          return `<option value="${b.bank}" ${pick.banks.length === 1 && pick.banks[0] === b.bank ? 'selected' : ''}>${esc(b.title)}${last === null ? '' : `（上次 ${last}%）`}</option>`;
        }).join('')}
        ${banks.length > 1 ? `<option value="all" ${pick.banks.length > 1 ? 'selected' : ''}>全部題庫混合（${banks.length} 回）</option>` : ''}
      </select>
      <h2>範圍</h2>
      <div class="row wrap">
        ${SECTIONS.map(([k, label]) => `<button class="chip ${pick.section === k ? 'on' : ''}" data-a="section" data-v="${k}">${label}</button>`).join('')}
      </div>
      <h2>題數</h2>
      <div class="row wrap">
        ${COUNTS.map((c) => `<button class="chip ${pick.count === c ? 'on' : ''}" data-a="count" data-v="${c}">${c ? c + ' 題' : `全部 ${pool} 題`}</button>`).join('')}
      </div>
      <p class="muted">依題型順序出題（聽力：問答 → 敘述 → 對話；閱讀：文法字彙 → 閱讀理解），各題型內隨機。聽力題只播放語音，可重播；作答後顯示逐字稿與正解。</p>
      <button class="btn" data-a="start" ${pick.banks.length ? '' : 'disabled'}>開始測驗</button>
    </div>
    <div class="card">
      <div class="row between"><b>錯題複習</b><span class="muted">${reviewN} 題待複習</span></div>
      <p class="muted">收錄最近一次作答仍答錯的題目，答對後自動移出。</p>
      <button class="btn secondary" data-a="review" ${reviewN ? '' : 'disabled'}>開始複習</button>
    </div>`;
}

/* ---------- quiz ---------- */

// 出題順序依 ALCPT 題型分段，只在各段內隨機：
// 聽力 問答 → 敘述 → 對話；閱讀 文法/字彙 → 閱讀理解
const STAGES = [['question'], ['statement'], ['dialogue'], ['grammar', 'vocab', 'usage'], ['reading']];

function orderByStage(qs) {
  return STAGES.flatMap((cats) => shuffle(qs.filter((q) => cats.includes(q.cat))));
}
function buildExam(bankIds, count, section) {
  const all = bankIds.flatMap((b) => bankData[b]).filter((q) => section === 'both' || q.section === section);
  if (!count || count >= all.length) return orderByStage(all).map((q) => q.id);
  // 依各段題數比例抽題（最大餘數法，總數剛好等於 count）
  const groups = STAGES.map((cats) => shuffle(all.filter((q) => cats.includes(q.cat))));
  const quota = groups.map((g) => (count * g.length) / all.length);
  const take = quota.map(Math.floor);
  const order = quota.map((x, i) => [x - take[i], i]).sort((x, y) => y[0] - x[0]);
  for (let k = 0; take.reduce((t, x) => t + x, 0) < count; k++) take[order[k][1]]++;
  return groups.flatMap((g, i) => g.slice(0, take[i])).map((q) => q.id);
}
// 該題庫最近一次單回測驗的得分（%），沒做過回傳 null
function lastScore(bank) {
  const a = db.attempts.find((x) => x.mode === 'exam' && (x.section || 'both') === 'both' && x.banks.length === 1 && x.banks[0] === bank);
  return a ? pct(a.answers.reduce((t, x) => t + x[2], 0), a.answers.length) : null;
}
function attemptTitle(a) {
  if (a.mode === 'review') return '錯題複習';
  const where = a.banks.length > 1 ? `混合 ${a.banks.length} 回` : `第 ${a.banks[0]} 回`;
  const sec = { listening: '・只考聽力', reading: '・只考閱讀' }[a.section] || '';
  return where + sec;
}
function reviewPool() {
  return Object.entries(db.stats).filter(([, s]) => s.last === 0).map(([id]) => id);
}
function startSession(mode, qids, bankIds, section = 'both') {
  session = {
    mode, banks: bankIds, section, qids, idx: 0, answers: {}, plays: {},
    start: Date.now(), breakSeen: false,
    nL: qids.filter((id) => Q[id].section === 'listening').length,
  };
  saveSession();
  renderQuiz(true);
}

function renderQuiz(autoplay) {
  setView('quiz');
  const s = session;
  const total = s.qids.length;
  if (s.idx === s.nL && s.nL > 0 && s.nL < total && !s.breakSeen) return renderBreak();
  const q = Q[s.qids[s.idx]];
  const a = s.answers[q.id];
  const isL = q.section === 'listening';
  const secIdx = isL ? s.idx + 1 : s.idx - s.nL + 1;
  const secTotal = isL ? s.nL : total - s.nL;

  Player.stop();
  let html = `
    <div class="qtop">
      <button class="x" data-a="quit" aria-label="結束測驗">✕</button>
      <span class="badge ${isL ? '' : 'reading'}">${isL ? '聽力' : '閱讀'} ${secIdx}/${secTotal}</span>
      <span class="prog">${s.idx + 1} / ${total}</span>
    </div>
    <div class="bar"><i style="width:${pct(s.idx + (a ? 1 : 0), total)}%"></i></div>
    <div class="cat">${CATS[q.cat]}${s.mode === 'review' ? '・錯題複習' : ''}</div>`;

  if (isL) {
    const n = s.plays[q.id] || 0;
    html += `<button class="play" data-a="play" id="play">▶ 播放題目</button>
      <div class="plays muted" id="plays">${n ? `已播放 ${n} 次` : '點擊播放，可重複聆聽'}</div>`;
  } else {
    html += `<div class="card stem">${stemHtml(q)}</div>`;
  }

  html += `<div class="opts">${optionButtons(q, a && a.pick, !!a)}</div>`;

  if (a) {
    html += `<div class="fb ${a.ok ? 'ok' : 'ng'}" id="fb">${a.ok ? '✔ 答對了' : `✘ 答錯了，正解是 ${q.answer}`}</div>`;
    if (isL) html += transcript(q);
    if (q.explain) html += `<div class="card explain"><b>解析</b>\n${esc(q.explain)}</div>`;
    const last = s.idx === total - 1;
    html += `<div class="next-wrap"><button class="btn" data-a="next">${last ? '完成，看成績' : '下一題 →'}</button></div>`;
  }
  app.innerHTML = html;

  if (a) $('#fb').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (isL && !a && autoplay) playQ(q, true);
  preloadNext();
}

function optionButtons(q, chosen, locked) {
  return ['A', 'B', 'C', 'D'].map((k) => {
    let cls = '';
    if (locked && k === q.answer) cls = 'ok';
    else if (locked && k === chosen) cls = 'ng';
    return `<button class="opt ${cls}" data-a="pick" data-v="${k}" ${locked ? 'disabled' : ''}><b>${k}</b><span>${esc(q.options[k])}</span></button>`;
  }).join('');
}

// 題幹；同義字題把考的字詞（PDF 中的底線）標出來
function stemHtml(q) {
  let html = esc(q.stem);
  for (const u of q.underline || []) {
    const e = esc(u);
    const i = html.indexOf(e);
    if (i >= 0) html = `${html.slice(0, i)}<u class="ul">${e}</u>${html.slice(i + e.length)}`;
  }
  return html;
}

function transcript(q) {
  const body = q.turns
    ? q.turns.map((t) => `<p><span class="spk ${t.s}">${SPEAKER[t.s]}</span> ${esc(t.t)}</p>`).join('')
    : `<p>${esc(q.stem)}</p>`;
  return `<div class="card script"><b>逐字稿</b>${body}</div>`;
}

function renderBreak() {
  const s = session;
  const done = s.qids.slice(0, s.nL).filter((id) => s.answers[id]);
  const ok = done.filter((id) => s.answers[id].ok).length;
  Player.stop();
  app.innerHTML = `
    <div class="card" style="text-align:center;margin-top:18vh">
      <h1>聽力部分結束</h1>
      <p>聽力答對 <b>${ok}</b> / ${s.nL} 題</p>
      <p class="muted">接下來是閱讀部分，共 ${s.qids.length - s.nL} 題。</p>
      <button class="btn" data-a="toReading">開始閱讀 →</button>
    </div>`;
}

function playQ(q, auto) {
  const btn = $('#play');
  const setBtn = (text, on) => { if (btn && btn.isConnected) { btn.textContent = text; btn.classList.toggle('playing', !!on); } };
  setBtn('⏳ 載入中…', false);
  Player.play(q.audio, { onended: () => setBtn('↻ 重播', false) }).then(() => {
    if (!session || session.qids[session.idx] !== q.id) return;
    session.plays[q.id] = (session.plays[q.id] || 0) + 1;
    saveSession();
    const p = $('#plays');
    if (p) p.textContent = `已播放 ${session.plays[q.id]} 次`;
    setBtn('🔊 播放中…（點擊重播）', true);
  }).catch((e) => {
    setBtn('▶ 點擊播放題目', false);
    if (!auto) {
      const p = $('#plays');
      if (p) p.textContent = `無法播放：${e.message}（iPhone 請確認未開啟靜音模式）`;
    }
  });
}

function preloadNext() {
  for (const id of session.qids.slice(session.idx, session.idx + 3)) {
    if (Q[id] && Q[id].audio) Player.prefetch(Q[id].audio).catch(() => {});
  }
}

function choose(k) {
  const q = Q[session.qids[session.idx]];
  if (session.answers[q.id]) return;
  const ok = k === q.answer;
  session.answers[q.id] = { pick: k, ok };
  const st = db.stats[q.id] || (db.stats[q.id] = { seen: 0, wrong: 0, picks: {} });
  st.seen++;
  if (!ok) {
    st.wrong++;
    st.picks[k] = (st.picks[k] || 0) + 1;
  }
  st.last = ok ? 1 : 0;
  st.t = Date.now();
  saveDB();
  saveSession();
  if (navigator.vibrate) navigator.vibrate(ok ? 15 : [30, 40, 30]);
  renderQuiz(false);
}

function next() {
  if (session.idx >= session.qids.length - 1) return finish();
  session.idx++;
  saveSession();
  renderQuiz(true);
}

function finish() {
  Player.stop();
  const s = session;
  const answered = s.qids.filter((id) => s.answers[id]);
  session = null;
  saveSession();
  if (!answered.length) return renderHome();
  const attempt = {
    id: Date.now(),
    mode: s.mode,
    section: s.section || 'both',
    banks: s.banks,
    start: s.start,
    end: Date.now(),
    planned: s.qids.length,
    answers: answered.map((id) => [id, s.answers[id].pick, s.answers[id].ok ? 1 : 0, s.plays[id] || 0]),
  };
  db.attempts.unshift(attempt);
  saveDB();
  renderResult(attempt, false);
}

/* ---------- results ---------- */

function summarize(answers) {
  const by = {};
  for (const [id, , ok] of answers) {
    const q = Q[id];
    if (!q) continue;
    for (const key of ['sec:' + q.section, q.cat]) { // 'reading' 同時是大項與題型，需分開
      const b = by[key] || (by[key] = { n: 0, ok: 0 });
      b.n++;
      b.ok += ok;
    }
  }
  return by;
}

function meter(label, ok, n) {
  const p = pct(ok, n);
  return `<div class="meter ${p < 60 ? 'low' : p < 80 ? 'mid' : ''}">
    <div class="lbl"><span>${label}</span><span>${ok}/${n}（${p}%）</span></div>
    <div class="track"><i style="width:${p}%"></i></div></div>`;
}

function missItem(q, chosen, extra) {
  const body = `${q.section === 'listening' ? transcript(q) : `<div class="stem">${stemHtml(q)}</div>`}
    ${optionButtons(q, chosen, true)}
    ${q.explain ? `<div class="explain muted">${esc(q.explain)}</div>` : ''}`;
  const title = q.section === 'listening' ? (q.turns ? q.turns.map((t) => t.t).join(' ') : q.stem) : q.stem;
  return `<details><summary><span class="n">第${q.id.slice(1, 3)}回 #${q.n}</span>${esc(title.length > 70 ? title.slice(0, 70) + '…' : title)}
    <div class="muted">${CATS[q.cat]}${extra ? '・' + extra : ''}</div></summary>
    <div class="miss-body">${body}</div></details>`;
}

function reviewList(att) {
  const list = att.answers.filter((a) => resultFilter === 'all' || (resultFilter === 'right') === !!a[2]);
  if (!list.length) return `<div class="empty">${resultFilter === 'wrong' ? '全部答對，太棒了！' : '這次沒有答對的題目。'}</div>`;
  return list.map(([id, p, ok]) => Q[id] ? missItem(Q[id], p, ok ? `<span class="good">✔ 答對（${p}）</span>` : `<span class="bad">✘ 你選 ${p}，正解 ${Q[id].answer}</span>`) : '').join('');
}

async function renderResult(att, fromHistory) {
  await ensureBanks(att.answers.map(([id]) => bankOf(id)));
  setView(fromHistory ? 'history' : 'result');
  const n = att.answers.length;
  const ok = att.answers.reduce((t, a) => t + a[2], 0);
  const by = summarize(att.answers);
  shownAttempt = att;
  const bankTitle = att.mode === 'exam' ? attemptTitle(att) : '';
  app.innerHTML = `
    ${fromHistory ? '<button class="btn ghost" data-a="tab" data-v="history">← 回到紀錄</button>' : ''}
    <h1>${att.mode === 'review' ? '錯題複習結果' : '測驗結果'}</h1>
    <div class="card" style="text-align:center">
      <div class="score">${pct(ok, n)}<small style="font-size:1.2rem">%</small></div>
      <div>答對 ${ok} / ${n} 題${n < att.planned ? `（共 ${att.planned} 題，提前結束）` : ''}</div>
      <div class="muted">${fmtDate(att.start)}・用時 ${fmtDur(att.end - att.start)}${bankTitle ? '・' + bankTitle : ''}</div>
    </div>
    <div class="card">
      ${by['sec:listening'] ? meter('<b>聽力</b>', by['sec:listening'].ok, by['sec:listening'].n) : ''}
      ${by['sec:reading'] ? meter('<b>閱讀</b>', by['sec:reading'].ok, by['sec:reading'].n) : ''}
      ${Object.keys(CATS).filter((c) => by[c]).map((c) => meter(CATS[c], by[c].ok, by[c].n)).join('')}
    </div>
    <h2>題目回顧</h2>
    <div class="row wrap" id="rfilter">
      ${[['wrong', `答錯 ${n - ok}`], ['right', `答對 ${ok}`], ['all', `全部 ${n}`]].map(([k, label]) =>
        `<button class="chip ${resultFilter === k ? 'on' : ''}" data-a="rf" data-v="${k}">${label}</button>`).join('')}
    </div>
    <div class="card" id="rlist">${reviewList(att)}</div>
    ${fromHistory ? '' : '<button class="btn" data-a="tab" data-v="home">回到首頁</button>'}`;
}

/* ---------- history ---------- */

function renderHistory() {
  setView('history');
  const list = db.attempts;
  app.innerHTML = `
    <h1>考試紀錄</h1>
    ${list.length ? '' : '<div class="empty">還沒有紀錄，先去做一回測驗吧。</div>'}
    ${list.map((a, i) => {
      const n = a.answers.length;
      const ok = a.answers.reduce((t, x) => t + x[2], 0);
      const L = a.answers.filter((x) => x[0] && Q[x[0]] ? Q[x[0]].section === 'listening' : Number(x[0].slice(-3)) <= 60);
      const Lok = L.reduce((t, x) => t + x[2], 0);
      return `<button class="hist" data-a="att" data-v="${i}">
        <div><div><b>${attemptTitle(a)}</b></div>
        <div class="muted">${fmtDate(a.start)}・${n} 題${L.length ? `・聽力 ${Lok}/${L.length}` : ''}${n - L.length ? `・閱讀 ${ok - Lok}/${n - L.length}` : ''}</div></div>
        <div class="pct">${pct(ok, n)}%</div></button>`;
    }).join('')}
    <h2>資料備份</h2>
    <div class="card">
      <p class="muted" style="margin-top:0">紀錄只存在這支手機的瀏覽器。換手機或清除瀏覽器資料前，請先匯出備份。</p>
      <button class="btn secondary" data-a="export">匯出紀錄檔</button>
      <button class="btn ghost" data-a="copy">複製備份文字</button>
      <button class="btn ghost" data-a="import">匯入紀錄檔</button>
      <button class="btn ghost" data-a="wipe">清除所有紀錄</button>
      <input type="file" id="file" accept="application/json,.json" hidden>
    </div>`;
}

/* ---------- common mistakes ---------- */

async function renderMistakes() {
  setView('mistakes');
  const ids = Object.keys(db.stats);
  await ensureBanks(ids.map(bankOf));
  const by = {};
  for (const id of ids) {
    const q = Q[id];
    if (!q) continue;
    const s = db.stats[id];
    const b = by[q.cat] || (by[q.cat] = { n: 0, ok: 0 });
    b.n += s.seen;
    b.ok += s.seen - s.wrong;
  }
  const cats = Object.keys(CATS).filter((c) => by[c]).sort((x, y) => by[x].ok / by[x].n - by[y].ok / by[y].n);
  const missed = ids.filter((id) => Q[id] && db.stats[id].wrong > 0)
    .sort((x, y) => db.stats[y].wrong - db.stats[x].wrong || db.stats[y].wrong / db.stats[y].seen - db.stats[x].wrong / db.stats[x].seen)
    .slice(0, 30);
  const reviewN = reviewPool().length;

  app.innerHTML = `
    <h1>常見錯誤</h1>
    ${cats.length ? `
      <div class="card">
        <b>各題型答對率</b><span class="muted">（由弱到強，累計所有作答）</span>
        ${cats.map((c) => meter(CATS[c], by[c].ok, by[c].n)).join('')}
        ${pct(by[cats[0]].ok, by[cats[0]].n) < 80 ? `<p class="muted">最需要加強：<b>${CATS[cats[0]]}</b></p>` : ''}
      </div>
      <button class="btn" data-a="review" ${reviewN ? '' : 'disabled'}>複習待加強錯題（${reviewN} 題）</button>
      <button class="btn secondary" data-a="drill" ${missed.length ? '' : 'disabled'}>練習最常錯的 ${Math.min(20, missed.length)} 題</button>
      <h2>最常答錯的題目</h2>
      <div class="card">${missed.length ? missed.map((id) => {
        const s = db.stats[id];
        const top = Object.entries(s.picks).sort((a, b) => b[1] - a[1])[0];
        return missItem(Q[id], top && top[0], `錯 ${s.wrong} / 作答 ${s.seen} 次${top ? `・常選 ${top[0]}` : ''}${s.last === 0 ? '・尚未答對' : ''}`);
      }).join('') : '<div class="empty">目前沒有答錯的題目。</div>'}</div>`
    : '<div class="empty">完成測驗後，這裡會分析你的常見錯誤。</div>'}`;
}

/* ---------- backup ---------- */

function exportData() {
  const blob = new Blob([JSON.stringify(db)], { type: 'application/json' });
  const d = new Date();
  const name = `alcpt-records-${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.json`;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData(file) {
  const r = new FileReader();
  r.onload = async () => {
    try {
      const d = JSON.parse(r.result);
      if (!Array.isArray(d.attempts) || typeof d.stats !== 'object') throw new Error();
      if (!await ask(`匯入 ${d.attempts.length} 筆紀錄，將取代目前的紀錄，確定嗎？`)) return;
      db = d;
      saveDB();
      toast('匯入完成');
      renderHistory();
    } catch {
      toast('檔案格式不正確');
    }
  };
  r.readAsText(file);
}

/* ---------- events ---------- */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-a]');
  if (!el || el.disabled) return;
  const v = el.dataset.v;
  switch (el.dataset.a) {
    case 'tab':
      if (v === 'home') renderHome();
      else if (v === 'history') { await ensureBanks(db.attempts.flatMap((a) => a.answers.map(([id]) => bankOf(id)))); renderHistory(); }
      else renderMistakes();
      break;
    case 'count': pick.count = Number(v); renderHome(); break;
    case 'section': pick.section = v; renderHome(); break;
    case 'start':
      if (session && !await ask('目前有未完成的測驗，要放棄並開始新的嗎？')) return;
      await ensureBanks(pick.banks);
      startSession('exam', buildExam(pick.banks, pick.count, pick.section), pick.banks.slice(), pick.section);
      break;
    case 'review': case 'drill': {
      if (session && !await ask('目前有未完成的測驗，要放棄並開始複習嗎？')) return;
      let ids = el.dataset.a === 'review' ? reviewPool()
        : Object.keys(db.stats).filter((id) => db.stats[id].wrong > 0)
          .sort((x, y) => db.stats[y].wrong - db.stats[x].wrong).slice(0, 20);
      await ensureBanks(ids.map(bankOf));
      ids = orderByStage(ids.filter((id) => Q[id]).map((id) => Q[id])).map((q) => q.id);
      if (ids.length) startSession('review', ids, []);
      break;
    }
    case 'resume':
      await ensureBanks(session.qids.map(bankOf));
      renderQuiz(false);
      break;
    case 'discard':
      if (await ask('確定放棄這次未完成的測驗？已作答的題目仍會計入常見錯誤統計。')) { session = null; saveSession(); renderHome(); }
      break;
    case 'play': playQ(Q[session.qids[session.idx]], false); break;
    case 'pick': choose(v); break;
    case 'next': next(); break;
    case 'toReading': session.breakSeen = true; saveSession(); renderQuiz(false); break;
    case 'quit': {
      const n = Object.keys(session.answers).length;
      if (!await ask(n ? `結束測驗並儲存已作答的 ${n} 題成績？` : '結束測驗？')) return;
      finish();
      break;
    }
    case 'att': renderResult(db.attempts[Number(v)], true); break;
    case 'rf':
      resultFilter = v;
      document.querySelectorAll('#rfilter .chip').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
      $('#rlist').innerHTML = reviewList(shownAttempt);
      break;
    case 'export': exportData(); break;
    case 'copy': copyBackup(); break;
    case 'import': $('#file').click(); break;
    case 'wipe':
      if (await ask('確定清除所有考試紀錄與錯題統計？此動作無法復原。')) { db = { attempts: [], stats: {} }; saveDB(); renderHistory(); }
      break;
  }
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'file' && e.target.files[0]) importData(e.target.files[0]);
  if (e.target.id === 'bank-sel') {
    const v = e.target.value;
    pick.banks = v === 'all' ? banks.map((b) => b.bank) : [v];
    try { localStorage.setItem(PICK, v); } catch { /* ignore */ }
    renderHome();
  }
});

(async () => {
  try {
    await loadBanks();
    if (session) await ensureBanks(session.qids.map(bankOf));
    renderHome();
  } catch (err) {
    app.innerHTML = `<p class="empty">題庫載入失敗：${esc(err.message)}<br>請透過網站（http/https）開啟，而非直接開啟檔案。</p>`;
  }
})();
