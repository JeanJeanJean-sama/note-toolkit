// ============================================================
// SyncMyArticles.gs — 自分の記事の自動同期（v2）
// ------------------------------------------------------------
// v1 からの変更点
//  1. 本文を記事詳細API（/api/v3/notes/{key}）からJSONで取得
//     v1 の __NEXT_DATA__ 解析は、note の記事ページの作りが変わって現在は使われず、
//     HTML解析のほうが動いていた。v2 はAPIで本文だけを確実に取得（失敗時はHTML解析で代替）
//  2. 見出し・箇条書き・引用などの改行を保って本文をテキスト化
//  3. セルの上限（5万文字）を超える長い記事は切り詰めて保存（v1 ではエラーで止まっていた）
//  4. 有料記事は無料部分のみ取得されるため、その旨を本文末尾に明記
//  5. 書き込みをまとめて実行（1件ずつの appendRow より高速）＋ 同時実行の排他制御
//  6. GAS の実行時間上限（6分）の手前で自動的に止め、残りは次回実行で追加
//  7. 【新機能】backfillArticlesFromUrls：RSS（最新25件のみ）に出てこない古い記事を、
//     URL一覧から一括で取り込み
//
// シートの列構成は v1 と同じ（A:URL / B:タイトル / C:本文全文 / D:日付）です。
// ============================================================

const SYNC_TIME_BUDGET_MS = 5 * 60 * 1000; // 6分上限の手前で止める
const NOTE_REQUEST_INTERVAL_MS = 1000;      // note への負荷対策
const CELL_CHAR_LIMIT = 49000;              // スプレッドシートのセル上限（50,000文字）の手前
const BACKFILL_SHEET_NAME = '記事URL取込';

// ============================================================
// 新着記事の同期（定期実行用）
// ============================================================
function syncMyNewArticles() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    sendLog('記事同期: 別の同期処理が実行中のためスキップしました。');
    return;
  }
  try {
    sendLog('自分のnote新着記事の同期処理を開始します...');
    const env = getEnvProps();
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(env.articleSheetName);
    if (!sheet) {
      sendLog(`シート「${env.articleSheetName}」が見つかりません。`, true);
      return;
    }

    const existingKeys = loadExistingArticleKeys_(sheet);
    const items = fetchRssItems(`https://note.com/${env.noteUserId}/rss`);
    if (items.length === 0) {
      sendLog('noteのRSSを取得できなかったか、中身が空でした。', true);
      return;
    }

    const targets = items
      .map(it => ({ key: extractNoteKey_(it.link), link: it.link, title: it.title, pubDateRaw: it.pubDateRaw }))
      .filter(t => t.key && !existingKeys.has(t.key));

    if (targets.length === 0) {
      sendLog('新しく追加する記事はありませんでした。（全記事登録済み）');
      return;
    }
    sendLog(`未登録の記事を ${targets.length} 件検出しました（RSS経由）。本文を取得して追加します...`);

    const result = importArticles_(sheet, targets);
    sendLog(`🎉 新着記事を ${result.added} 件追加しました。` +
      (result.remaining > 0 ? `（時間切れのため残り ${result.remaining} 件は次回追加します）` : ''));
  } catch (e) {
    sendLog(`syncMyNewArticles でエラーが発生しました: ${e.message}`, true);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 古い記事の一括取り込み（手動実行用）
// ------------------------------------------------------------
// 1. 「記事URL取込」シートのA列に、取り込みたい記事URLを貼り付ける
//    （例：ブックマークレットの「アクセス解析DB」のC列＝全記事URL をそのまま貼れます）
// 2. この関数を実行 → 未登録の記事だけを追加し、B列に結果を記録
// 3. 時間切れで止まった場合は、もう一度実行すると続きから処理します
// ============================================================
function backfillArticlesFromUrls() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10 * 1000)) {
    sendLog('記事取り込み: 別の同期処理が実行中のためスキップしました。');
    return;
  }
  try {
    const env = getEnvProps();
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(env.articleSheetName);
    if (!sheet) {
      sendLog(`シート「${env.articleSheetName}」が見つかりません。`, true);
      return;
    }
    let src = ss.getSheetByName(BACKFILL_SHEET_NAME);
    if (!src) {
      src = ss.insertSheet(BACKFILL_SHEET_NAME);
      src.appendRow(['記事URL（A列に貼り付け）', '結果']);
      src.getRange(1, 1, 1, 2).setFontWeight('bold').setBackground('#f3f3f3');
      sendLog(`シート「${BACKFILL_SHEET_NAME}」を作成しました。A列に記事URLを貼り付けてから再実行してください。`);
      return;
    }

    const existingKeys = loadExistingArticleKeys_(sheet);
    const lastRow = src.getLastRow();
    if (lastRow < 2) {
      sendLog(`「${BACKFILL_SHEET_NAME}」のA列に記事URLがありません。`);
      return;
    }
    const rows = src.getRange(2, 1, lastRow - 1, 2).getValues();
    const seen = new Set();
    const targets = [];
    const statusUpdates = []; // [rowNumber, status]
    rows.forEach((r, i) => {
      if (r[1]) return; // 処理済み
      const url = String(r[0]).trim().split('?')[0];
      const key = extractNoteKey_(url);
      if (!key) { statusUpdates.push([i + 2, 'URL形式エラー']); return; }
      if (existingKeys.has(key) || seen.has(key)) { statusUpdates.push([i + 2, '登録済み']); return; }
      seen.add(key);
      targets.push({ key: key, link: url, title: '', pubDateRaw: '', rowNumber: i + 2 });
    });

    if (targets.length === 0) {
      statusUpdates.forEach(([row, s]) => src.getRange(row, 2).setValue(s));
      sendLog('取り込み対象の新しい記事はありませんでした。');
      return;
    }
    sendLog(`未登録の記事 ${targets.length} 件を取り込みます（1件あたり約1〜2秒）...`);

    const result = importArticles_(sheet, targets);
    result.doneKeys.forEach(k => {
      const t = targets.find(x => x.key === k);
      if (t) statusUpdates.push([t.rowNumber, '取込済']);
    });
    statusUpdates.forEach(([row, s]) => src.getRange(row, 2).setValue(s));

    sendLog(`🎉 古い記事を ${result.added} 件取り込みました。` +
      (result.remaining > 0 ? `残り ${result.remaining} 件は、もう一度 backfillArticlesFromUrls を実行してください。` : '（すべて完了）'));
  } catch (e) {
    sendLog(`backfillArticlesFromUrls でエラーが発生しました: ${e.message}`, true);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// 共通処理
// ============================================================
/**
 * 記事を取得してシートに追記する。
 * 実行時間の上限が近づいたら途中で止め、処理済みの分だけ書き込む。
 */
function importArticles_(sheet, targets) {
  const startedAt = Date.now();
  const rowsToAppend = [];
  const doneKeys = [];

  for (let i = 0; i < targets.length; i++) {
    if (Date.now() - startedAt > SYNC_TIME_BUDGET_MS) break;
    const t = targets[i];
    const detail = fetchNoteDetail_(t.key, t.link);

    const title = detail.title || t.title || '（タイトル取得失敗）';
    let content = detail.content || '（本文の取得に失敗しました）';
    if (content.length > CELL_CHAR_LIMIT) {
      content = content.slice(0, CELL_CHAR_LIMIT) + '\n\n（※セルの文字数上限のため以降を省略）';
    }

    let date = detail.pubDate ? new Date(detail.pubDate) : new Date(t.pubDateRaw);
    if (isNaN(date.getTime())) date = new Date();

    rowsToAppend.push({
      sortKey: date.getTime(),
      row: [detail.url || t.link, title, content, Utilities.formatDate(date, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')]
    });
    doneKeys.push(t.key);
    if (i < targets.length - 1) Utilities.sleep(NOTE_REQUEST_INTERVAL_MS);
  }

  if (rowsToAppend.length > 0) {
    rowsToAppend.sort((a, b) => a.sortKey - b.sortKey); // 古い順に追記（v1 と同じ並び）
    const values = rowsToAppend.map(r => r.row);
    sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 4).setValues(values);
  }
  return { added: rowsToAppend.length, remaining: targets.length - doneKeys.length, doneKeys: doneKeys };
}

/** 既存の記事キー（/n/xxxx）の集合 */
function loadExistingArticleKeys_(sheet) {
  const keys = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return keys;
  sheet.getRange(2, 1, lastRow - 1, 1).getValues().forEach(r => {
    const k = extractNoteKey_(String(r[0]));
    if (k) keys.add(k);
  });
  return keys;
}

function extractNoteKey_(url) {
  const m = String(url).match(/\/n\/(n[0-9a-zA-Z]+)/);
  return m ? m[1] : '';
}

/**
 * 記事詳細を取得。まず API（JSON）、だめなら記事ページのHTMLから抽出。
 * @return {{title?:string, content?:string, pubDate?:string, url?:string}}
 */
function fetchNoteDetail_(key, fallbackUrl) {
  try {
    const res = UrlFetchApp.fetch(`https://note.com/api/v3/notes/${key}`, {
      muteHttpExceptions: true,
      headers: { Accept: 'application/json' }
    });
    if (res.getResponseCode() === 200) {
      const d = JSON.parse(res.getContentText('UTF-8')).data || {};
      if (d.body || d.name) {
        let content = noteHtmlToText_(d.body || '');
        // ログインなしで取得するため、有料記事は無料部分のみ
        if (d.is_limited && d.can_read === false) {
          content += '\n\n（※ここから先は有料部分のため未取得）';
        }
        return {
          title: d.name,
          content: content,
          pubDate: d.publish_at || d.created_at,
          url: d.note_url || fallbackUrl
        };
      }
    }
  } catch (e) {
    Logger.log(`記事API取得失敗 ${key}: ${e.message}`);
  }
  return getNoteDetail(fallbackUrl || `https://note.com/_/n/${key}`, '');
}

/** note の本文HTML → 読みやすいテキスト（段落・見出し・箇条書きの改行を保持） */
function noteHtmlToText_(html) {
  if (!html) return '';
  return String(html)
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<figure[\s\S]*?<\/figure>/gi, '\n')         // 画像・埋め込み
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n・')
    .replace(/<h[1-6][^>]*>/gi, '\n\n■ ')
    .replace(/<\/li>/gi, '')
    .replace(/<\/(p|h[1-6]|blockquote|pre|div|ul|ol)>/gi, '\n')
    .replace(/<blockquote[^>]*>/gi, '\n> ')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ============================================================
// 以下はAPIが使えない場合の代替（v1 のHTML解析をそのまま残しています）
// ============================================================
function getNoteDetail(url, fallbackTitle) {
  try {
    const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return {};
    const html = res.getContentText('UTF-8');

    let targetHtml = html;
    const mainBlock = html.match(/<(?:main|article)[^>]*>([\s\S]*?)<\/(?:main|article)>/i);
    if (mainBlock && mainBlock[1]) targetHtml = mainBlock[1];

    const elements = targetHtml.match(/<(?:p|h1|h2|h3|h4|blockquote)[^>]*>([\s\S]*?)<\/(?:p|h1|h2|h3|h4|blockquote)>/gi);
    if (elements && elements.length > 0) {
      const rawLines = elements.map(el => cleanHtmlToText(el)).filter(t => t.length > 0);
      const filteredText = filterContentNoise(rawLines.join('\n\n'), fallbackTitle);
      if (filteredText) return { content: filteredText };
    }
    return {};
  } catch (e) {
    return {};
  }
}

function filterContentNoise(text, articleTitle) {
  if (!text) return '';
  const lines = text.split('\n');
  const cleanLines = [];
  const targetTitle = (articleTitle || '').trim();
  for (let line of lines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    if (
      trimmedLine.includes('いいなと思ったら応援しよう') ||
      trimmedLine.includes('この記事が参加している募集') ||
      trimmedLine.includes('この記事が気に入ったら') ||
      trimmedLine.includes('クリエイターを応援')
    ) break;
    if (targetTitle && trimmedLine === targetTitle) continue;
    if (
      trimmedLine === 'ログイン' ||
      trimmedLine === '会員登録' ||
      trimmedLine === 'noteの書き方' ||
      /^[\d,]+件$/.test(trimmedLine) ||
      /^\d+月\d+日まで$/.test(trimmedLine) ||
      /^[\d.]+[万千]?件$/.test(trimmedLine)
    ) continue;
    cleanLines.push(trimmedLine);
  }
  return cleanLines.join('\n\n');
}

function cleanHtmlToText(htmlStr) {
  return noteHtmlToText_(htmlStr);
}
