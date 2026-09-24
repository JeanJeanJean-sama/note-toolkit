// ============================================================
// Common.gs — 共通設定・ユーティリティ（v2）
// ------------------------------------------------------------
// v1 からの変更点
//  ・fetchRssItems: note の著者名（note:creatorName）を取得できるよう修正
//                   （名前空間URLに依存しない方式）＋ 記事URLから urlname を抽出
//  ・callGeminiAPI: APIキーをURLではなくヘッダーで送信（ログ等にキーが残りにくい）
//  ・postDiscord:   Discord の文字数制限に合わせて自動で切り詰め、送信失敗をログ出力
//  ・getRecentArticles: 記事一覧シートを「新しい順」で取得（古い記事ばかり使う問題の修正）
//  ・DISCORD_WEBHOOK_APPROACH を追加（旧名 DISCORD_WEBHOOK_SPAM も引き続き使用可）
//  ・[v2.1] callGeminiAPI: 503/429 の再試行を指数バックオフ（5→10→20秒）に強化、
//           予備モデル（GEMINI_FALLBACK_MODEL）への自動切り替え、400系エラーは即停止
//  ・[v2.1] scheduleRetry_: Gemini が混雑で使えなかったとき、30分後に1回だけ自動再実行
//  ・[v2.1] field_ を共通化（NoteApproach.gs / TrendMatching.gs で使用）
// SyncMyArticles.gs / FetchQA.gs はそのまま動きます。
// ============================================================

function getEnvProps() {
  const props = PropertiesService.getScriptProperties();
  return {
    noteUserId: props.getProperty('MY_NOTE_USER_ID') || 'your_note_id',
    geminiApiKey: props.getProperty('GEMINI_API_KEY'),
    geminiModel: props.getProperty('GEMINI_MODEL') || 'gemini-3.8-flash',
    geminiFallbackModel: props.getProperty('GEMINI_FALLBACK_MODEL') || '',
    webhookApproach: props.getProperty('DISCORD_WEBHOOK_APPROACH') || props.getProperty('DISCORD_WEBHOOK_SPAM'),
    webhookTrend: props.getProperty('DISCORD_WEBHOOK_TREND'),
    webhookLog: props.getProperty('DISCORD_WEBHOOK_LOG'),
    articleSheetName: props.getProperty('ARTICLE_SHEET_NAME') || '記事一覧',
    trendMatchThreshold: props.getProperty('TREND_MATCH_THRESHOLD') || '7',
    noteCandidateCount: props.getProperty('NOTE_CANDIDATE_COUNT') || '3',
    approachCooldownDays: props.getProperty('APPROACH_COOLDOWN_DAYS') || '30',
    hashtagRefreshDays: props.getProperty('HASHTAG_REFRESH_DAYS') || '7'
  };
}

function sendLog(message, isError = false) {
  const env = getEnvProps();
  Logger.log((isError ? '[ERROR] ' : '[LOG] ') + message);
  if (!env.webhookLog) return;
  UrlFetchApp.fetch(env.webhookLog, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      content: truncate_(isError ? `⚠️ **[ERROR]** ${message}` : `ℹ️ **[LOG]** ${message}`, 1900)
    }),
    muteHttpExceptions: true
  });
}

// ------------------------------------------------------------
// Gemini
// ------------------------------------------------------------
/** Gemini が一時的に使えない（混雑・過負荷）ことを表すエラー */
class GeminiUnavailableError extends Error {}

/**
 * Gemini を呼び出してテキストを返す。
 *  ・503（混雑）/ 429（回数制限）/ 5xx / 通信エラー → 5秒・10秒・20秒と間隔を倍にして再試行
 *  ・それでもだめなら GEMINI_FALLBACK_MODEL（設定時）で同じ手順を繰り返す
 *  ・400系（キー間違い・モデル名間違いなど）は再試行しても直らないので即エラー
 */
function callGeminiAPI(promptText) {
  const env = getEnvProps();
  if (!env.geminiApiKey) {
    throw new Error('GEMINI_API_KEY がスクリプトプロパティに設定されていません。');
  }
  const models = [env.geminiModel, env.geminiFallbackModel].filter((m, i, a) => m && a.indexOf(m) === i);
  const MAX_ATTEMPTS = 4;
  let lastError = '';

  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    if (mi > 0) sendLog(`Gemini: ${models[mi - 1]} が混雑しているため、予備モデル ${model} に切り替えます。`);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      let statusCode = 0;
      let resText = '';
      try {
        const response = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': env.geminiApiKey },
          payload: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] }),
          muteHttpExceptions: true
        });
        statusCode = response.getResponseCode();
        resText = response.getContentText();
      } catch (e) {
        lastError = `通信エラー: ${e.message}`; // ネットワーク系は再試行対象
      }

      if (statusCode === 200) {
        const json = JSON.parse(resText);
        const text = (json.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (text) return text;
        const reason = json.candidates?.[0]?.finishReason || json.promptFeedback?.blockReason || '不明';
        throw new Error(`Gemini の応答が空でした（理由: ${reason}）`);
      }

      if (statusCode) {
        lastError = `HTTP ${statusCode}: ${truncate_(resText, 300)}`;
        const retryable = statusCode === 429 || statusCode >= 500 || /high demand|overloaded|UNAVAILABLE/i.test(resText);
        if (!retryable) throw new Error(`Gemini API エラー（${model}）${lastError}`);
      }

      if (attempt < MAX_ATTEMPTS) {
        const waitMs = 5000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 1000); // 5,10,20秒＋揺らぎ
        sendLog(`⚠️ Gemini(${model}) 一時エラーのため ${Math.round(waitMs / 1000)}秒後に再試行 (${attempt}/${MAX_ATTEMPTS - 1}) ${truncate_(lastError, 120)}`);
        Utilities.sleep(waitMs);
      }
    }
  }
  throw new GeminiUnavailableError(`Gemini が混雑していて応答できませんでした（${lastError}）`);
}

// ------------------------------------------------------------
// 自動再実行（Gemini 混雑時の救済）
// ------------------------------------------------------------
const RETRY_DELAY_MINUTES = 30;
const RETRY_MAX_PER_DAY = 2;

/**
 * fnName を RETRY_DELAY_MINUTES 分後に1回だけ再実行する（1日あたり RETRY_MAX_PER_DAY 回まで）。
 * 既に予約済みなら何もしない。
 */
function scheduleRetry_(fnName) {
  const props = PropertiesService.getScriptProperties();
  const idKey = `RETRY_TRIGGER_${fnName}`;
  const countKey = `RETRY_COUNT_${fnName}`;
  if (props.getProperty(idKey)) return false;

  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  let count = { date: today, n: 0 };
  try { count = JSON.parse(props.getProperty(countKey) || 'null') || count; } catch (e) { /* noop */ }
  if (count.date !== today) count = { date: today, n: 0 };
  if (count.n >= RETRY_MAX_PER_DAY) {
    sendLog(`${fnName}: 本日の自動再実行の上限（${RETRY_MAX_PER_DAY}回）に達したため、次回の定期実行を待ちます。`, true);
    return false;
  }

  const trigger = ScriptApp.newTrigger(fnName).timeBased().after(RETRY_DELAY_MINUTES * 60 * 1000).create();
  props.setProperty(idKey, trigger.getUniqueId());
  count.n++;
  props.setProperty(countKey, JSON.stringify(count));
  sendLog(`${fnName}: ${RETRY_DELAY_MINUTES}分後に自動で再実行します（本日 ${count.n}/${RETRY_MAX_PER_DAY} 回目）。`);
  return true;
}

/** 再実行用に作った一時トリガーを削除（各処理の冒頭で呼ぶ。定期実行のトリガーには触れない） */
function clearRetry_(fnName) {
  const props = PropertiesService.getScriptProperties();
  const idKey = `RETRY_TRIGGER_${fnName}`;
  const id = props.getProperty(idKey);
  if (!id) return;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getUniqueId() === id) ScriptApp.deleteTrigger(t);
  });
  props.deleteProperty(idKey);
}

/** 【名前】 の後ろの値を取り出す（次の【 または末尾まで） */
function field_(text, name) {
  const m = String(text).match(new RegExp(`【${name}】\\s*([\\s\\S]*?)(?=\\n\\s*【|\\n---|$)`));
  return m ? m[1].trim() : '';
}

// ------------------------------------------------------------
// RSS
// ------------------------------------------------------------
/**
 * RSS を取得して配列で返す。
 * note の RSS は著者名を <note:creatorName> に入れているため、
 * 名前空間URLに依存せず「要素名」で探す。
 */
function fetchRssItems(url) {
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (response.getResponseCode() >= 400) return [];

    const root = XmlService.parse(response.getContentText()).getRootElement();
    const channel = root.getChild('channel');
    const itemElements = channel ? channel.getChildren('item') : root.getChildren('item');

    return itemElements.map(item => {
      const link = (childText_(item, 'link') || '').split('?')[0].trim();
      return {
        title: childText_(item, 'title') || '',
        link: link,
        description: (childText_(item, 'description') || '').replace(/<[^>]*>?/gm, '').trim(),
        pubDateRaw: childText_(item, 'pubDate') || childText_(item, 'date') || '',
        creator: childText_(item, 'creatorName') || childText_(item, 'creator') || '',
        urlname: extractNoteUrlname_(link)
      };
    });
  } catch (e) {
    Logger.log(`RSS取得失敗: ${url} / ${e.message}`);
    return [];
  }
}

/** 名前空間を問わず、要素名が一致する最初の子要素のテキストを返す */
function childText_(element, name) {
  const hit = element.getChildren().find(c => c.getName() === name);
  return hit ? hit.getText() : '';
}

/** https://note.com/{urlname}/n/xxxx → urlname */
function extractNoteUrlname_(link) {
  const m = String(link).match(/^https:\/\/note\.com\/([^\/?#]+)\/n\//);
  return m ? m[1] : '';
}

// ------------------------------------------------------------
// 記事一覧シート
// ------------------------------------------------------------
/**
 * 記事一覧シート（A:URL, B:タイトル, C:本文, D:日付）を新しい順で返す。
 * @return {{url:string,title:string,body:string,date:string}[]}
 */
function getRecentArticles(sheet, limit) {
  const rows = sheet.getDataRange().getValues().slice(1)
    .filter(r => r[0] && r[1])
    .map((r, i) => ({
      url: String(r[0]).trim(),
      title: String(r[1]).trim(),
      body: String(r[2] || ''),
      date: r[3] instanceof Date ? Utilities.formatDate(r[3], 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : String(r[3] || ''),
      rowIndex: i
    }));
  // 日付の降順。日付が同じ・空の場合は下の行（＝後から追加）を新しいとみなす
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.rowIndex - a.rowIndex);
  return typeof limit === 'number' ? rows.slice(0, limit) : rows;
}

// ------------------------------------------------------------
// Discord
// ------------------------------------------------------------
/** Discord の制限（title 256 / description 4096 / embeds 10件）に合わせて送信 */
function postDiscord(webhookUrl, embeds, label) {
  if (!webhookUrl) {
    sendLog(`${label || 'Discord'}: Webhook URL が未設定のため送信をスキップしました。`, true);
    return false;
  }
  const safe = embeds.slice(0, 10).map(e => Object.assign({}, e, {
    title: truncate_(e.title || '', 250),
    description: truncate_(e.description || '', 4000)
  }));
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({ embeds: safe }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code >= 300) {
    sendLog(`${label || 'Discord'} 送信失敗 (HTTP ${code}): ${truncate_(res.getContentText(), 300)}`, true);
    return false;
  }
  return true;
}

function truncate_(text, max) {
  const s = String(text);
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
