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
const MODES = [['practice', '練習（即時看答案）'], ['mock', '模擬考（交卷才計分）']];
const DAY = 86400000;
// 間隔複習：答錯 → 1 天後到期；到期時答對 → 3 天、7 天；再答對即為已掌握
const INTERVALS = { 1: 1, 2: 3, 3: 7 };

const $ = (s) => document.querySelector(s);
const app = $('#app');
const tabs = $('#tabs');

let banks = [];
const bankData = {};   // bank -> questions[]
const Q = {};          // question id -> question
let db = loadDB();
let session = loadJSON(CURRENT);
let pick = { banks: [], count: 0, section: 'both', mode: 'practice' }; // section: both / listening / reading
const SECTIONS = [['both', '聽力＋閱讀'], ['listening', '只考聽力'], ['reading', '只考閱讀']];
let view = 'home';
let resultFilter = 'wrong'; // 題目回顧：wrong / right / all
let shownAttempt = null;
let flash = null; // 閃卡複習：{ list, i, show }

/* ---------- storage ---------- */

function loadJSON(key) {
  try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
}
function loadDB() {
  const loaded = loadJSON(STORE);
  const d = loaded && Array.isArray(loaded.attempts) && loaded.stats ? loaded : { attempts: [], stats: {} };
  return migrate(d);
}
function migrate(d) {
  d.vocab = d.vocab || {};
  for (const s of Object.values(d.stats)) {
    if (s.box === undefined) {  // 舊版紀錄：最近一次仍答錯的題目，轉為今天到期
      s.box = s.last === 0 ? 1 : 0;
      if (s.box) s.due = Date.now();
    }
  }
  return d;
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
  const dueN = duePool().length;
  const openN = openPool().length;
  const nextDue = Math.min(...Object.values(db.stats).filter((x) => x.box > 0 && x.due > Date.now()).map((x) => x.due));
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
      <h2>模式</h2>
      <div class="row wrap">
        ${MODES.map(([k, label]) => `<button class="chip ${pick.mode === k ? 'on' : ''}" data-a="mode" data-v="${k}">${label}</button>`).join('')}
      </div>
      <h2>範圍</h2>
      <div class="row wrap">
        ${SECTIONS.map(([k, label]) => `<button class="chip ${pick.section === k ? 'on' : ''}" data-a="section" data-v="${k}">${label}</button>`).join('')}
      </div>
      <h2>題數</h2>
      <div class="row wrap">
        ${COUNTS.map((c) => `<button class="chip ${pick.count === c ? 'on' : ''}" data-a="count" data-v="${c}">${c ? c + ' 題' : `全部 ${pool} 題`}</button>`).join('')}
      </div>
      <p class="muted">依題型順序出題（聽力：問答 → 敘述 → 對話；閱讀：文法字彙 → 閱讀理解），各題型內隨機。${pick.mode === 'mock'
        ? '模擬考：聽力只播放一次、作答時不顯示對錯，可隨時交卷，交卷後才顯示分數與解析。'
        : '聽力題只播放語音，可重播；作答後立即顯示逐字稿、正解與解析。'}</p>
      <button class="btn" data-a="start" ${pick.banks.length ? '' : 'disabled'}>${pick.mode === 'mock' ? '開始模擬考' : '開始練習'}</button>
    </div>
    <div class="card">
      <div class="row between"><b>錯題複習</b><span class="muted">今天到期 ${dueN} 題・未掌握 ${openN} 題</span></div>
      <p class="muted">答錯的題目會在 1、3、7 天後再出現，到期時連續答對三次即為已掌握；中途答錯就從 1 天重來。${!dueN && openN && Number.isFinite(nextDue) ? `下次到期：${fmtDate(nextDue)}` : ''}</p>
      <button class="btn secondary" data-a="review" ${dueN ? '' : 'disabled'}>複習今天到期（${dueN}）</button>
      <button class="btn ghost" data-a="reviewAll" ${openN ? '' : 'disabled'}>複習全部未掌握（${openN}）</button>
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
  const a = db.attempts.find((x) => (x.mode === 'exam' || x.mode === 'mock') && (x.section || 'both') === 'both' && x.banks.length === 1 && x.banks[0] === bank);
  return a ? pct(a.answers.reduce((t, x) => t + x[2], 0), a.answers.length) : null;
}
function attemptTitle(a) {
  if (a.mode === 'review') return '錯題複習';
  const where = a.banks.length > 1 ? `混合 ${a.banks.length} 回` : `第 ${a.banks[0]} 回`;
  const sec = { listening: '・只考聽力', reading: '・只考閱讀' }[a.section] || '';
  return (a.mode === 'mock' ? '模擬考・' : '') + where + sec;
}
// 間隔複習：到期（今天該複習）與所有未掌握的題目
function duePool() {
  const now = Date.now();
  return Object.entries(db.stats).filter(([, s]) => s.box > 0 && s.due <= now).map(([id]) => id);
}
function openPool() {
  return Object.entries(db.stats).filter(([, s]) => s.box > 0).map(([id]) => id);
}
// 記錄一題作答結果（常見錯誤統計＋間隔複習）
function recordStat(id, k, ok) {
  const st = db.stats[id] || (db.stats[id] = { seen: 0, wrong: 0, picks: {}, box: 0 });
  st.seen++;
  st.last = ok ? 1 : 0;
  st.t = Date.now();
  if (!ok) {
    st.wrong++;
    st.picks[k] = (st.picks[k] || 0) + 1;
    st.box = 1;
    st.due = st.t + INTERVALS[1] * DAY;
  } else if (st.box > 0 && st.due <= st.t) {
    st.box++;
    if (st.box > 3) { st.box = 0; delete st.due; } else st.due = st.t + INTERVALS[st.box] * DAY;
  }
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
  const mock = s.mode === 'mock';
  if (mock) return renderMock(q, a, isL, secIdx, secTotal, autoplay);

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
    html += explainBox(q);
    const last = s.idx === total - 1;
    html += `<div class="next-wrap"><button class="btn" data-a="next">${last ? '完成，看成績' : '下一題 →'}</button></div>`;
  }
  app.innerHTML = html;

  if (a) $('#fb').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (isL && !a && autoplay) playQ(q, true);
  preloadNext();
}

// 模擬考：不顯示對錯、聽力只播一次、可隨時交卷
function renderMock(q, a, isL, secIdx, secTotal, autoplay) {
  const s = session;
  const total = s.qids.length;
  const last = s.idx === total - 1;
  const played = (s.plays[q.id] || 0) > 0;
  Player.stop();
  let html = `
    <div class="qtop">
      <button class="chip" data-a="submit">交卷</button>
      <span class="badge ${isL ? '' : 'reading'}">${isL ? '聽力' : '閱讀'} ${secIdx}/${secTotal}</span>
      <span class="prog">${s.idx + 1} / ${total}</span>
    </div>
    <div class="bar"><i style="width:${pct(s.idx, total)}%"></i></div>
    <div class="cat">模擬考・${CATS[q.cat]}</div>`;
  if (isL) {
    html += `<button class="play" data-a="play" id="play" ${played ? 'disabled' : ''}>${played ? '已播放（模擬考只播一次）' : '▶ 播放題目（只能播一次）'}</button>
      <div class="plays muted" id="plays">${played ? '' : '載入中，會自動播放'}</div>`;
  } else {
    html += `<div class="card stem">${stemHtml(q)}</div>`;
  }
  html += `<div class="opts">${['A', 'B', 'C', 'D'].map((k) =>
    `<button class="opt ${a && a.pick === k ? 'sel' : ''}" data-a="pick" data-v="${k}"><b>${k}</b><span>${esc(q.options[k])}</span></button>`).join('')}</div>
    <div class="next-wrap"><button class="btn" data-a="next">${last ? '交卷' : a ? '下一題 →' : '略過 →'}</button></div>`;
  app.innerHTML = html;
  if (isL && !played && autoplay) playQ(q, true);
  preloadNext();
}

function explainBox(q) {
  if (!q.explain) return '';
  return `<div class="card explain"><b>解析${q.explain_ai ? '<span class="ai">AI 產生，僅供參考</span>' : ''}</b>
${esc(q.explain)}${vocabChips(q)}</div>`;
}

/* ---------- vocabulary ---------- */

// 從解析挑出「英文: 中文」的重點單字；同義字題考的字詞也列入
function vocabCandidates(q) {
  const out = [];
  const seen = new Set();
  const add = (term, meaning) => {
    term = term.trim();
    meaning = meaning.trim().replace(/[。.;；]$/, '');
    const key = term.toLowerCase();
    if (!term || !meaning || term.length > 40 || seen.has(key) || /^(Q|M|W|A|B|M2|W2)$/.test(term)) return;
    seen.add(key);
    out.push({ term, meaning });
  };
  for (const u of q.underline || []) add(u, q.options[q.answer]);
  const text = (q.explain || '').replace(/(^|\n)\s*解析\s*[:：]\s*/g, '$1');
  for (const seg of text.split(/[;；\n]/)) {
    let m = seg.match(/^\s*(?:\(\d+\)|\d+[.)、])?\s*([A-Za-z][A-Za-z'’\- ./]{0,38}[A-Za-z.])\s*[:：]\s*(.{1,60})$/);
    if (m) { add(m[1], m[2]); continue; }
    // 「on the same page有共識: harmonious」：英文後面直接接中文
    m = seg.match(/^\s*([A-Za-z][A-Za-z'’\- ]{0,38}[A-Za-z])\s*([\u4e00-\u9fff][^:：]{0,15})\s*[:：]\s*(.{1,50})$/);
    if (m) add(m[1], `${m[2]}（${m[3]}）`);
  }
  return out.slice(0, 6);
}

function vocabChips(q) {
  const c = vocabCandidates(q);
  if (!c.length) return '';
  return `<div class="vchips"><span class="muted">加入生字本：</span>${c.map((v) => {
    const on = !!db.vocab[v.term.toLowerCase()];
    return `<button class="vchip ${on ? 'on' : ''}" data-a="vocab" data-q="${q.id}" data-v="${esc(v.term)}" data-m="${esc(v.meaning)}">${on ? '★' : '＋'} ${esc(v.term)}</button>`;
  }).join('')}</div>`;
}

function toggleVocab(el) {
  const term = el.dataset.v;
  const key = term.toLowerCase();
  const on = !db.vocab[key];
  if (on) db.vocab[key] = { term, meaning: el.dataset.m, qid: el.dataset.q, t: Date.now() };
  else delete db.vocab[key];
  saveDB();
  document.querySelectorAll('.vchip').forEach((b) => {
    if (b.dataset.v.toLowerCase() === key) { b.classList.toggle('on', on); b.textContent = `${on ? '★' : '＋'} ${b.dataset.v}`; }
  });
  toast(on ? `已加入生字本：${term}` : `已移出生字本：${term}`);
}

function renderVocab() {
  setView('vocab');
  flash = null;
  const list = Object.values(db.vocab).sort((a, b) => b.t - a.t);
  app.innerHTML = `
    <h1>生字本</h1>
    ${list.length ? `
      <button class="btn" data-a="flash">閃卡複習（${list.length} 個）</button>
      <div class="card">${list.map((v) => `
        <div class="vrow">
          <div class="vtext"><b>${esc(v.term)}</b><div>${esc(v.meaning)}</div>
            <div class="muted">第${v.qid.slice(1, 3)}回 #${Number(v.qid.slice(-3))}</div></div>
          <button class="x" data-a="vdel" data-v="${esc(v.term)}" aria-label="移出生字本">✕</button>
        </div>`).join('')}</div>`
    : '<div class="empty">作答後，在解析下方點「＋ 單字」，就會收藏到這裡。</div>'}`;
}

function renderFlash() {
  setView('vocab');
  const v = flash.list[flash.i];
  app.innerHTML = `
    <button class="btn ghost" data-a="tab" data-v="vocab">← 回到生字本</button>
    <button class="card flash" data-a="flip">
      <span class="muted">${flash.i + 1} / ${flash.list.length}</span>
      <span class="fterm">${esc(v.term)}</span>
      ${flash.show ? `<span class="fmean">${esc(v.meaning)}</span>` : '<span class="muted">點一下顯示意思</span>'}
    </button>
    <div class="row">
      <button class="btn ghost" data-a="vdel" data-v="${esc(v.term)}">移出生字本</button>
      <button class="btn" data-a="fnext">下一張 →</button>
    </div>`;
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
      <p>${s.mode === 'mock' ? `聽力已作答 <b>${done.length}</b> / ${s.nL} 題` : `聽力答對 <b>${ok}</b> / ${s.nL} 題`}</p>
      <p class="muted">接下來是閱讀部分，共 ${s.qids.length - s.nL} 題。</p>
      <button class="btn" data-a="toReading">開始閱讀 →</button>
    </div>`;
}

function playQ(q, auto) {
  const btn = $('#play');
  const setBtn = (text, on) => { if (btn && btn.isConnected) { btn.textContent = text; btn.classList.toggle('playing', !!on); } };
  setBtn('⏳ 載入中…', false);
  const mock = session.mode === 'mock';
  Player.play(q.audio, { onended: () => setBtn(mock ? '已播放（模擬考只播一次）' : '↻ 重播', false) }).then(() => {
    if (!session || session.qids[session.idx] !== q.id) return;
    session.plays[q.id] = (session.plays[q.id] || 0) + 1;
    saveSession();
    const p = $('#plays');
    if (p) p.textContent = `已播放 ${session.plays[q.id]} 次`;
    if (session.mode === 'mock') { setBtn('🔊 播放中…', true); const b = $('#play'); if (b) b.disabled = true; }
    else setBtn('🔊 播放中…（點擊重播）', true);
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
  if (session.mode === 'mock') {  // 可改選，交卷時才計分
    session.answers[q.id] = { pick: k, ok: k === q.answer };
    saveSession();
    document.querySelectorAll('.opt').forEach((b) => b.classList.toggle('sel', b.dataset.v === k));
    const nx = $('[data-a=next]');
    if (nx && session.idx < session.qids.length - 1) nx.textContent = '下一題 →';
    return;
  }
  if (session.answers[q.id]) return;
  const ok = k === q.answer;
  session.answers[q.id] = { pick: k, ok };
  recordStat(q.id, k, ok);
  saveDB();
  saveSession();
  if (navigator.vibrate) navigator.vibrate(ok ? 15 : [30, 40, 30]);
  renderQuiz(false);
}

async function submitMock() {
  const left = session.qids.filter((id) => !session.answers[id]).length;
  if (!await ask(left ? `還有 ${left} 題未作答（算錯），確定交卷？` : '確定交卷？', '交卷')) return;
  finish();
}

function next() {
  if (session.idx >= session.qids.length - 1) return session.mode === 'mock' ? submitMock() : finish();
  session.idx++;
  saveSession();
  renderQuiz(true);
}

function finish() {
  Player.stop();
  const s = session;
  const mock = s.mode === 'mock';
  const answered = s.qids.filter((id) => s.answers[id]);
  session = null;
  saveSession();
  if (!answered.length) return renderHome();
  if (mock) for (const id of answered) recordStat(id, s.answers[id].pick, s.answers[id].ok);
  const attempt = {
    id: Date.now(),
    mode: s.mode,
    section: s.section || 'both',
    banks: s.banks,
    start: s.start,
    end: Date.now(),
    planned: s.qids.length,
    // 模擬考交卷時，未作答的題目也列入（算錯）
    answers: (mock ? s.qids : answered).map((id) => {
      const x = s.answers[id];
      return [id, x ? x.pick : '', x && x.ok ? 1 : 0, s.plays[id] || 0];
    }),
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
    ${explainBox(q)}`;
  const title = q.section === 'listening' ? (q.turns ? q.turns.map((t) => t.t).join(' ') : q.stem) : q.stem;
  return `<details><summary><span class="n">第${q.id.slice(1, 3)}回 #${q.n}</span>${esc(title.length > 70 ? title.slice(0, 70) + '…' : title)}
    <div class="muted">${CATS[q.cat]}${extra ? '・' + extra : ''}</div></summary>
    <div class="miss-body">${body}</div></details>`;
}

function reviewList(att) {
  const list = att.answers.filter((a) => resultFilter === 'all' || (resultFilter === 'right') === !!a[2]);
  if (!list.length) return `<div class="empty">${resultFilter === 'wrong' ? '全部答對，太棒了！' : '這次沒有答對的題目。'}</div>`;
  return list.map(([id, p, ok]) => Q[id] ? missItem(Q[id], p, ok ? `<span class="good">✔ 答對（${p}）</span>`
    : `<span class="bad">✘ ${p ? `你選 ${p}` : '未作答'}，正解 ${Q[id].answer}</span>`) : '').join('');
}

async function renderResult(att, fromHistory) {
  await ensureBanks(att.answers.map(([id]) => bankOf(id)));
  setView(fromHistory ? 'history' : 'result');
  const n = att.answers.length;
  const ok = att.answers.reduce((t, a) => t + a[2], 0);
  const by = summarize(att.answers);
  shownAttempt = att;
  const skipped = att.answers.filter((a) => !a[1]).length;
  const bankTitle = att.mode !== 'review' ? attemptTitle(att) : '';
  app.innerHTML = `
    ${fromHistory ? '<button class="btn ghost" data-a="tab" data-v="history">← 回到紀錄</button>' : ''}
    <h1>${{ review: '錯題複習結果', mock: '模擬考結果' }[att.mode] || '測驗結果'}</h1>
    <div class="card" style="text-align:center">
      <div class="score">${pct(ok, n)}<small style="font-size:1.2rem">%</small></div>
      <div>答對 ${ok} / ${n} 題${n < att.planned ? `（共 ${att.planned} 題，提前結束）` : ''}${skipped ? `・未作答 ${skipped} 題` : ''}</div>
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
  const reviewN = duePool().length;

  app.innerHTML = `
    <h1>常見錯誤</h1>
    ${cats.length ? `
      <div class="card">
        <b>各題型答對率</b><span class="muted">（由弱到強，累計所有作答）</span>
        ${cats.map((c) => meter(CATS[c], by[c].ok, by[c].n)).join('')}
        ${pct(by[cats[0]].ok, by[cats[0]].n) < 80 ? `<p class="muted">最需要加強：<b>${CATS[cats[0]]}</b></p>` : ''}
      </div>
      <button class="btn" data-a="review" ${reviewN ? '' : 'disabled'}>複習今天到期的錯題（${reviewN} 題）</button>
      <button class="btn secondary" data-a="drill" ${missed.length ? '' : 'disabled'}>練習最常錯的 ${Math.min(20, missed.length)} 題</button>
      <h2>最常答錯的題目</h2>
      <div class="card">${missed.length ? missed.map((id) => {
        const s = db.stats[id];
        const top = Object.entries(s.picks).sort((a, b) => b[1] - a[1])[0];
        return missItem(Q[id], top && top[0], `錯 ${s.wrong} / 作答 ${s.seen} 次${top ? `・常選 ${top[0]}` : ''}${s.box > 0 ? '・未掌握' : ''}`);
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
      db = migrate(d);
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
      else if (v === 'vocab') renderVocab();
      else if (v === 'history') { await ensureBanks(db.attempts.flatMap((a) => a.answers.map(([id]) => bankOf(id)))); renderHistory(); }
      else renderMistakes();
      break;
    case 'count': pick.count = Number(v); renderHome(); break;
    case 'mode': pick.mode = v; renderHome(); break;
    case 'vocab': toggleVocab(el); break;
    case 'flash': flash = { list: shuffle(Object.values(db.vocab)), i: 0, show: false }; renderFlash(); break;
    case 'flip': flash.show = !flash.show; renderFlash(); break;
    case 'fnext': flash.i = (flash.i + 1) % flash.list.length; flash.show = false; renderFlash(); break;
    case 'vdel':
      delete db.vocab[v.toLowerCase()];
      saveDB();
      if (flash) {
        flash.list.splice(flash.i, 1);
        if (!flash.list.length) renderVocab();
        else { flash.i %= flash.list.length; flash.show = false; renderFlash(); }
      } else renderVocab();
      break;
    case 'submit': submitMock(); break;
    case 'section': pick.section = v; renderHome(); break;
    case 'start':
      if (session && !await ask('目前有未完成的測驗，要放棄並開始新的嗎？')) return;
      await ensureBanks(pick.banks);
      startSession(pick.mode === 'mock' ? 'mock' : 'exam', buildExam(pick.banks, pick.count, pick.section), pick.banks.slice(), pick.section);
      break;
    case 'review': case 'reviewAll': case 'drill': {
      if (session && !await ask('目前有未完成的測驗，要放棄並開始複習嗎？')) return;
      let ids = el.dataset.a === 'review' ? duePool() : el.dataset.a === 'reviewAll' ? openPool()
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
      if (await ask('確定清除所有考試紀錄、錯題統計與生字本？此動作無法復原。')) { db = migrate({ attempts: [], stats: {} }); saveDB(); renderHistory(); }
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
