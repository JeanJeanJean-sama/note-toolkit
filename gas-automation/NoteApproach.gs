// ============================================================
// NoteApproach.gs — 読者開拓（note巡回アプローチ）v2.1
// ------------------------------------------------------------
// 自分の記事と相性のよさそうな著者を、ハッシュタグの新着記事から探し、
// ターゲット像とコメント案を Discord に通知します。
//
// v1 からの変更点
//  1. 分析に使う自分の記事を「新しい順」に
//  2. AI には候補の「番号」だけを答えさせ、URL・タイトルはコード側で埋める（架空URL対策）
//  3. 自分の記事を候補から除外
//  4. 提案済みの著者を「アプローチ履歴」シートに記録し、一定期間（既定30日）は再提案しない
//  5. 候補をハッシュタグごとに順番に取り、最初のタグに偏らないように
//  6. 検索用ハッシュタグをキャッシュ（既定7日ごと）。SEARCH_HASHTAGS で手動指定も可
//  7. [v2.1] Gemini が混雑（503）で使えなかった場合、30分後に自動で再実行
//
// 必要なスクリプトプロパティ
//  MY_NOTE_USER_ID, GEMINI_API_KEY, DISCORD_WEBHOOK_APPROACH（旧 DISCORD_WEBHOOK_SPAM でも可）
//  任意: GEMINI_MODEL, GEMINI_FALLBACK_MODEL, SEARCH_HASHTAGS, APPROACH_COOLDOWN_DAYS,
//        HASHTAG_REFRESH_DAYS, NOTE_CANDIDATE_COUNT, DISCORD_WEBHOOK_LOG
//
// ※ コメント案は「参考」です。投稿は必ずご自身の言葉で、手動で行ってください。
// ============================================================

const APPROACH_HISTORY_SHEET = 'アプローチ履歴';
const RSS_INTERVAL_MS = 1000;     // RSS 取得の間隔（note への負荷対策）
const MAX_APPROACH_CANDIDATES = 20;

// ============================================================
// 検索用ハッシュタグ
// ============================================================
function extractHashtagsFromMyArticles(sheet) {
  const titles = getRecentArticles(sheet, 60).map(a => a.title);
  if (titles.length === 0) {
    sendLog('スプレッドシートからタイトルが取得できませんでした（B列を確認してください）。', true);
    return [];
  }

  const prompt = `以下は、あるnoteユーザーが最近書いた記事タイトルの一覧です（新しい順）。
この人の記事に興味を持ちそうな読者を見つけるために、note.com上で検索するのに適した
ハッシュタグ（日本語、#は付けない、6個程度）をカンマ区切りで出力してください。
利用者の多すぎる一般的なタグ（例：日記、エッセイ）より、テーマが絞られたタグを優先してください。
説明文は不要で、ハッシュタグの単語のみを出力してください。

タイトル一覧:
${titles.join('\n')}`;

  return callGeminiAPI(prompt)
    .split(/[,、\n]/)
    .map(t => t.trim().replace(/^#/, ''))
    .filter(t => t.length > 0 && t.length < 20)
    .slice(0, 8);
}

/** 手動指定 → キャッシュ → 再生成 の順で検索用ハッシュタグを返す */
function getSearchHashtags_(sheet) {
  const env = getEnvProps();
  const props = PropertiesService.getScriptProperties();

  const manual = (props.getProperty('SEARCH_HASHTAGS') || '')
    .split(/[,、]/).map(t => t.trim().replace(/^#/, '')).filter(Boolean);
  if (manual.length > 0) return manual;

  let cached = null;
  try { cached = JSON.parse(props.getProperty('CACHED_HASHTAGS') || 'null'); } catch (e) { cached = null; }
  const maxAgeMs = (parseInt(env.hashtagRefreshDays, 10) || 7) * 24 * 60 * 60 * 1000;
  if (cached && cached.tags && cached.tags.length && Date.now() - cached.at < maxAgeMs) {
    return cached.tags;
  }

  sendLog('検索用ハッシュタグを再生成しています...');
  const tags = extractHashtagsFromMyArticles(sheet);
  if (tags.length > 0) {
    props.setProperty('CACHED_HASHTAGS', JSON.stringify({ tags: tags, at: Date.now() }));
    return tags;
  }
  return cached && cached.tags ? cached.tags : [];
}

/** キャッシュを消して次回実行時にハッシュタグを作り直す（手動実行用） */
function resetHashtagCache() {
  PropertiesService.getScriptProperties().deleteProperty('CACHED_HASHTAGS');
  sendLog('検索用ハッシュタグのキャッシュを削除しました。');
}

// ============================================================
// 読者開拓（note巡回アプローチ）
// ============================================================
function runNoteApproach() {
  clearRetry_('runNoteApproach');
  try {
    sendLog('note巡回アプローチ処理を開始します。');
    const env = getEnvProps();
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(env.articleSheetName);
    if (!sheet) {
      sendLog(`シート「${env.articleSheetName}」が見つかりません。`, true);
      return;
    }

    const hashtags = getSearchHashtags_(sheet);
    if (hashtags.length === 0) {
      sendLog('note検索用ハッシュタグを用意できませんでした。処理を停止します。', true);
      return;
    }
    sendLog(`note検索対象ハッシュタグ: ${hashtags.join(', ')}`);

    const now = Date.now();
    const WINDOW_MS = 24 * 60 * 60 * 1000;
    const cooldownAuthors = loadRecentlyApproachedAuthors_(parseInt(env.approachCooldownDays, 10) || 30);
    const myUrlname = String(env.noteUserId).toLowerCase();

    // --- ハッシュタグごとに候補を集める ---
    const perTag = hashtags.map((tag, i) => {
      if (i > 0) Utilities.sleep(RSS_INTERVAL_MS);
      return fetchRssItems(`https://note.com/hashtag/${encodeURIComponent(tag)}/rss`)
        .filter(it => {
          const t = new Date(it.pubDateRaw).getTime();
          return !isNaN(t) && now - t <= WINDOW_MS;
        })
        .map(it => Object.assign(it, { tag: tag }));
    });

    // --- タグを順番に1件ずつ取り出して偏りを防ぐ（ラウンドロビン） ---
    const seenAuthors = new Set();
    let skippedSelf = 0, skippedCooldown = 0;
    const candidates = [];
    for (let round = 0; candidates.length < MAX_APPROACH_CANDIDATES; round++) {
      let anyLeft = false;
      for (const list of perTag) {
        if (round >= list.length) continue;
        anyLeft = true;
        const it = list[round];
        const authorKey = (it.urlname || it.creator || it.link).toLowerCase();
        if (!authorKey || seenAuthors.has(authorKey)) continue;
        seenAuthors.add(authorKey);
        if (it.urlname.toLowerCase() === myUrlname) { skippedSelf++; continue; }
        if (cooldownAuthors.has(authorKey)) { skippedCooldown++; continue; }
        candidates.push({
          title: it.title,
          link: it.link,
          description: it.description.substring(0, 200),
          author: it.creator || it.urlname || '(不明)',
          authorKey: authorKey,
          tag: it.tag
        });
        if (candidates.length >= MAX_APPROACH_CANDIDATES) break;
      }
      if (!anyLeft) break;
    }

    if (candidates.length === 0) {
      sendLog(`直近24時間で対象となる新着記事が見つかりませんでした（自分の記事 ${skippedSelf}件・提案済み著者 ${skippedCooldown}件を除外）。`);
      return;
    }
    sendLog(`候補 ${candidates.length}件でAI選定を行います（自分の記事 ${skippedSelf}件・提案済み著者 ${skippedCooldown}件を除外）。`);

    // --- AI 選定（番号で答えさせる） ---
    const myTitles = getRecentArticles(sheet, 15).map(a => a.title);
    const candidateCount = parseInt(env.noteCandidateCount, 10) || 3;
    const candidateText = candidates
      .map((c, i) => `[${i + 1}] 著者:${c.author} / タイトル:${c.title} / 概要:${c.description}`)
      .join('\n\n');

    const prompt = `あなたはnote上で読者開拓を行うマーケティング担当です。
以下は「私」が最近書いた記事タイトルの一部です。

【私の記事テーマ例】
${myTitles.join('\n')}

以下は、直近24時間以内にnoteで更新された記事の一覧です。各記事の先頭に [番号] があります。

【新着記事一覧】
${candidateText}

この中から、「私」の記事内容に関心を持ちそう（興味・価値観が合いそう）な著者を最大${candidateCount}名選び、
以下のフォーマットで出力してください。該当者が少なければ、見つかった人数分だけで構いません。
記事URLやタイトルは書かず、必ず一覧の [番号] で指定してください。
コメント案は、その記事の内容に具体的に触れた、宣伝色のない自然な感想にしてください。

出力フォーマット（1人ごとに区切り線 --- を入れる）:
---
【番号】（一覧の番号の数字のみ）
【ターゲット像】（50文字程度）
【コメント案】（100文字程度）
---`;

    const blocks = callGeminiAPI(prompt).split('---').map(b => b.trim()).filter(b => b.includes('【'));
    const picked = [];
    const usedIdx = new Set();
    blocks.forEach(block => {
      const idx = parseInt((field_(block, '番号').match(/\d+/) || [])[0], 10) - 1;
      if (isNaN(idx) || !candidates[idx] || usedIdx.has(idx)) return; // 範囲外・重複は捨てる
      usedIdx.add(idx);
      picked.push({ c: candidates[idx], target: field_(block, 'ターゲット像'), comment: field_(block, 'コメント案') });
    });

    if (picked.length === 0) {
      sendLog('候補者の選定結果を解析できませんでした。', true);
      return;
    }

    const embeds = picked.slice(0, candidateCount).map(p => ({
      title: `📝 ${p.c.title}`,
      url: p.c.link,
      color: 3066993,
      description:
        `**著者**：${p.c.author}（#${p.c.tag}）\n` +
        `**ターゲット像**：${p.target}\n\n` +
        `**コメント案**（参考。投稿はご自身の言葉で）\n${p.comment}`,
      footer: { text: 'note読者開拓AI | 自動分析システム' }
    }));

    if (postDiscord(env.webhookApproach, embeds, 'note巡回アプローチ')) {
      recordApproachHistory_(picked.slice(0, candidateCount).map(p => p.c));
      sendLog(`note巡回アプローチ: ${embeds.length}件の候補をDiscordに送信しました。`);
    }
  } catch (e) {
    sendLog(`runNoteApproach でエラーが発生しました: ${e.message}`, true);
    if (e instanceof GeminiUnavailableError) scheduleRetry_('runNoteApproach');
  }
}

// ---------- アプローチ履歴 ----------
function getApproachHistorySheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(APPROACH_HISTORY_SHEET);
  if (!sh) {
    sh = ss.insertSheet(APPROACH_HISTORY_SHEET);
    sh.appendRow(['提案日時', '著者', '著者キー', '記事タイトル', '記事URL', 'ハッシュタグ']);
    sh.getRange(1, 1, 1, 6).setFontWeight('bold').setBackground('#f3f3f3');
  }
  return sh;
}

function loadRecentlyApproachedAuthors_(days) {
  const sh = getApproachHistorySheet_();
  const set = new Set();
  if (sh.getLastRow() < 2) return set;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  sh.getRange(2, 1, sh.getLastRow() - 1, 3).getValues().forEach(r => {
    const t = r[0] instanceof Date ? r[0].getTime() : new Date(r[0]).getTime();
    if (!isNaN(t) && t >= since && r[2]) set.add(String(r[2]).toLowerCase());
  });
  return set;
}

function recordApproachHistory_(list) {
  if (!list.length) return;
  const sh = getApproachHistorySheet_();
  const now = new Date();
  const rows = list.map(c => [now, c.author, c.authorKey, c.title, c.link, c.tag]);
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
