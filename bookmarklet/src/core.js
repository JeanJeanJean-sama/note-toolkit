/* ============================================================
 * note アクセス解析ブックマークレット v2 — 共通コア
 * ・画面の表を読む方式 → ダッシュボードと同じ GraphQL API を直接呼ぶ方式
 * ・認証トークン（Cookie: note_gql_auth_token）は note とのやりとりにだけ使い、
 *   GAS を含む外部には一切送らない
 * ============================================================ */
const GQL_URL = 'https://graphql.note.com/graphql';
const REQUEST_INTERVAL_MS = 1000; // note への負荷対策（1秒以上あける）
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const MAX_TRIES = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const LIST_QUERY = `query NoteStatsExport($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime, $order: DashboardNoteListOrder, $first: Int!, $after: String) {
  dashboardNoteListConnection(unit: $unit, date: $date, endDate: $endDate, order: $order, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      note { title status publishedAt link { absoluteUrl } }
      metrics { pageViewCount impressionCount likeCount commentCount salesAmount }
    } }
  }
}`;

/* ---------- 日付（YYYY-MM-DD 文字列で扱う） ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const fmtLocal = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const today = () => fmtLocal(new Date());
const addDays = (ymd, n) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const daysBetween = (a, b) => Math.round((new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)) / 864e5) + 1;
const toApiDate = (ymd) => `${ymd}T00:00:00.000Z`; // ダッシュボード本体と同じ形式

/* ---------- note API ---------- */
function getToken() {
  const m = document.cookie.match(/(?:^|;\s*)note_gql_auth_token=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

class FatalError extends Error {}

async function gql(variables) {
  const token = getToken();
  if (!token) throw new FatalError('noteにログインしていないか、ログインの有効期限が切れています。ログインし直してから実行してください。');
  let lastMsg = '';
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    let status = 0;
    try {
      const res = await fetch(GQL_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ operationName: 'NoteStatsExport', variables, query: LIST_QUERY }),
      });
      status = res.status;
      const json = await res.json().catch(() => null);
      const conn = json && json.data && json.data.dashboardNoteListConnection;
      if (res.ok && conn) return conn;
      if (status === 401 || status === 403) throw new FatalError(`認証エラー（HTTP ${status}）。noteにログインし直してください。`);
      lastMsg = `HTTP ${status} ${(json && json.errors || []).map((e) => e.message).join(', ')}`;
    } catch (e) {
      if (e instanceof FatalError) throw e;
      lastMsg = String(e && e.message || e);
    }
    if (attempt < MAX_TRIES) await sleep(2000 * 2 ** (attempt - 1)); // 2,4,8,16秒
  }
  throw new Error(`note APIの取得に失敗しました（${lastMsg}）`);
}

/** 指定期間の記事別データを全ページ取得（旧版の「もっとみる」連打に相当） */
async function fetchNoteList({ unit, date, endDate }, isCancelled) {
  const rows = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const v = { unit, date: toApiDate(date), order: 'PUBLISHED_DATE_DESC', first: PAGE_SIZE };
    if (endDate) v.endDate = toApiDate(endDate);
    if (after) v.after = after;
    const conn = await gql(v);
    for (const edge of conn.edges || []) {
      const n = edge.node || {};
      const note = n.note || {};
      const m = n.metrics || {};
      rows.push({
        title: note.title || '（タイトルなし）',
        url: (note.link && note.link.absoluteUrl) || '',
        impressions: m.impressionCount || 0,
        readCount: m.pageViewCount || 0,
        likeCount: m.likeCount || 0,
        commentCount: m.commentCount || 0,
        salesAmount: m.salesAmount || 0,
        publishedAt: note.publishedAt || '',
      });
    }
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    if (isCancelled && isCancelled()) break;
    after = conn.pageInfo.endCursor;
    await sleep(REQUEST_INTERVAL_MS);
  }
  return rows;
}

/* ---------- GAS 送信 ----------
 * まず通常モードで送り、GASの応答（保存件数）を読む。
 * ブラウザの制約で応答が読めない場合は no-cors で再送（GAS側で重複排除されるので二重保存はされない）。 */
async function sendToGas(payload) {
  if (!GAS_URL || GAS_URL.indexOf('YOUR_GAS_URL') === 0) throw new FatalError('GAS_URL が設定されていません。');
  const body = JSON.stringify(payload);
  try {
    const res = await fetch(GAS_URL, { method: 'POST', headers: { 'content-type': 'text/plain;charset=utf-8' }, body });
    const json = await res.json();
    if (json.status === 'fatal_error') throw new FatalError(`GAS側でエラー: ${json.message}（GASを最新版に更新しましたか？）`);
    return json;
  } catch (e) {
    if (e instanceof FatalError) throw e;
    await fetch(GAS_URL, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain;charset=utf-8' }, body });
    return { status: 'sent_unverified' };
  }
}

function reportError(type, message) {
  try {
    fetch(GAS_URL, { method: 'POST', mode: 'no-cors', headers: { 'content-type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ error: message, type }) });
  } catch (_) { /* noop */ }
}

/* ---------- UI（ネイティブの alert/confirm を使わない自前パネル） ---------- */
const UI_ID = 'note-stats-bm';
function el(tag, css, html) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (html != null) e.innerHTML = html;
  return e;
}
const BTN = 'padding:8px 16px;border:none;border-radius:6px;cursor:pointer;font-size:14px;';
const BTN_PRIMARY = BTN + 'background:#1a73e8;color:#fff;';
const BTN_SUB = BTN + 'background:#e0e0e0;color:#333;';

function removeUi() {
  const old = document.getElementById(UI_ID);
  if (old) old.remove();
}

/** モーダル。fields: [{id,label,type,value}] → 決定で {id:value} を返す、キャンセルで null */
function dialog({ title, message, fields = [], okLabel = '実行', presets }) {
  removeUi();
  return new Promise((resolve) => {
    const overlay = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:sans-serif;');
    overlay.id = UI_ID;
    const box = el('div', 'background:#fff;color:#222;padding:20px 24px;border-radius:10px;width:300px;box-shadow:0 4px 20px rgba(0,0,0,.3);font-size:14px;line-height:1.6;');
    box.appendChild(el('div', 'font-weight:bold;margin-bottom:10px;', title));
    if (message) box.appendChild(el('div', 'margin-bottom:12px;white-space:pre-wrap;', message));
    const inputs = {};
    if (presets) {
      const row = el('div', 'display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px;');
      presets.forEach((p) => {
        const b = el('button', BTN_SUB + 'padding:4px 8px;font-size:12px;', p.label);
        b.onclick = () => { const [s, e] = p.range(); inputs.start.value = s; inputs.end.value = e; };
        row.appendChild(b);
      });
      box.appendChild(row);
    }
    fields.forEach((f) => {
      box.appendChild(el('label', 'display:block;margin-bottom:4px;', f.label));
      const i = el('input', 'width:100%;box-sizing:border-box;padding:6px;margin-bottom:12px;font-size:14px;');
      i.type = f.type || 'text';
      i.value = f.value || '';
      inputs[f.id] = i;
      box.appendChild(i);
    });
    const btns = el('div', 'display:flex;justify-content:flex-end;gap:8px;');
    const cancel = el('button', BTN_SUB, 'キャンセル');
    const ok = el('button', BTN_PRIMARY, okLabel);
    cancel.onclick = () => { overlay.remove(); resolve(null); };
    ok.onclick = () => {
      const out = {};
      for (const k in inputs) out[k] = inputs[k].value;
      overlay.remove();
      resolve(out);
    };
    btns.append(cancel, ok);
    box.appendChild(btns);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  });
}

/** 右下の進捗パネル。停止ボタン付き */
function progressPanel(title) {
  removeUi();
  const box = el('div', 'position:fixed;bottom:16px;right:16px;z-index:2147483647;background:rgba(20,20,20,.92);color:#fff;font-size:13px;font-family:sans-serif;padding:12px 14px;border-radius:8px;box-shadow:0 2px 10px rgba(0,0,0,.4);width:320px;line-height:1.5;');
  box.id = UI_ID;
  const head = el('div', 'font-weight:bold;margin-bottom:6px;', title);
  const body = el('div', 'white-space:pre-wrap;');
  const foot = el('div', 'display:flex;justify-content:flex-end;margin-top:8px;');
  const stop = el('button', BTN_SUB + 'padding:4px 10px;font-size:12px;', '停止');
  let cancelled = false;
  stop.onclick = () => { cancelled = true; stop.disabled = true; stop.textContent = '停止中…'; };
  foot.appendChild(stop);
  box.append(head, body, foot);
  document.body.appendChild(box);
  return {
    set: (text) => { body.textContent = text; },
    done: (text) => {
      head.textContent = title + '（完了）';
      body.textContent = text;
      stop.textContent = '閉じる';
      stop.disabled = false;
      stop.onclick = () => box.remove();
    },
    isCancelled: () => cancelled,
  };
}

function guardPage() {
  if (location.hostname !== 'note.com') {
    dialog({ title: 'note アクセス解析', message: 'note.com のページ（ダッシュボード推奨）で実行してください。', okLabel: 'OK' });
    return false;
  }
  if (!getToken()) {
    dialog({ title: 'note アクセス解析', message: 'noteにログインしてから実行してください。', okLabel: 'OK' });
    return false;
  }
  return true;
}

const fmtSec = (s) => (s >= 60 ? `${Math.floor(s / 60)}分${pad2(Math.round(s % 60))}秒` : `${Math.round(s)}秒`);
