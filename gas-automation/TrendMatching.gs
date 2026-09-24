// ============================================================
// TrendMatching.gs — トレンド × 過去記事マッチング v2.1
// ------------------------------------------------------------
// 時事ニュース・SNSの話題と自分の過去記事を照合し、相性がよいものを
// X投稿案つきで Discord に通知します。
//
// v1 からの変更点
//  1. 照合に使う過去記事を「新しい順」に100件（v1 はシート先頭＝古い記事）
//  2. AI には話題・記事の「番号」だけを答えさせ、URL・タイトルはコード側で埋める
//  3. ニュース側のリンクも Discord に表示
//  4. [v2.1] Gemini が混雑で失敗したパート（ニュース／SNS）だけを、30分後に自動で再実行
//
// 必要なスクリプトプロパティ
//  MY_NOTE_USER_ID, GEMINI_API_KEY, DISCORD_WEBHOOK_TREND
//  任意: GEMINI_MODEL, GEMINI_FALLBACK_MODEL, TREND_MATCH_THRESHOLD, DISCORD_WEBHOOK_LOG
// ============================================================

const TREND_PENDING_KEY = 'TREND_PENDING_PARTS';

function runTrendMatching() {
  clearRetry_('runTrendMatching');
  const props = PropertiesService.getScriptProperties();
  // 自動再実行のときは、前回失敗したパートだけを実行（成功済みパートの二重通知を防ぐ）
  const pending = (props.getProperty(TREND_PENDING_KEY) || '').split(',').filter(Boolean);
  props.deleteProperty(TREND_PENDING_KEY);
  const parts = pending.length ? pending : ['news', 'buzz'];

  try {
    sendLog(`トレンド監視＆過去記事マッチング処理を開始します（${parts.map(p => p === 'news' ? '時事ニュース' : 'SNSバズ').join(' ＆ ')}）。`);
    const env = getEnvProps();
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(env.articleSheetName);
    if (!sheet) {
      sendLog(`シート「${env.articleSheetName}」が見つかりません。`, true);
      return;
    }
    const articles = getRecentArticles(sheet, 100); // 新しい順に100件
    if (articles.length === 0) {
      sendLog('照合対象となる過去記事が存在しません。', true);
      return;
    }
    const threshold = parseInt(env.trendMatchThreshold, 10) || 7;

    const failed = [];
    parts.forEach((part, i) => {
      if (i > 0) Utilities.sleep(2000);
      try {
        runTrendPart_(part, articles, threshold, env);
      } catch (e) {
        sendLog(`トレンド照合（${part}）でエラー: ${e.message}`, true);
        if (e instanceof GeminiUnavailableError) failed.push(part);
      }
    });

    if (failed.length) {
      props.setProperty(TREND_PENDING_KEY, failed.join(','));
      if (!scheduleRetry_('runTrendMatching')) props.deleteProperty(TREND_PENDING_KEY);
    }
  } catch (e) {
    sendLog(`runTrendMatching でエラーが発生しました: ${e.message}`, true);
  }
}

function runTrendPart_(part, articles, threshold, env) {
  if (part === 'news') {
    const hardNews = collectFeeds_([
      { url: 'https://news.google.com/rss/headlines/section/topic/NATION?hl=ja&gl=JP&ceid=JP:ja', label: '社会・政治', take: 3 },
      { url: 'https://news.google.com/rss/headlines/section/topic/BUSINESS?hl=ja&gl=JP&ceid=JP:ja', label: '経済・ビジネス', take: 3 },
      { url: 'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ja&gl=JP&ceid=JP:ja', label: 'IT・技術', take: 2 }
    ]);
    matchTopicsWithArticles_({
      topics: hardNews,
      articles: articles,
      threshold: threshold,
      webhook: env.webhookTrend,
      topicLabel: '時事ニュース',
      persona: 'あなたは社会情勢、人間社会、文化的背景に明るい時事・思想ライターです。',
      instruction: 'ニュースの背景にある問題意識や社会的テーマ、人間心理と、過去記事の論点が深く合致するものを1つ選出し、ニュースに対する知的な考察ポスト案を作成してください。',
      postStyle: '時事ニュースへの考察から持論へ繋げる文面',
      embedTitle: '📰 【時事ニュース×過去記事マッチング】',
      color: 3447003,
      footer: '時事ニュース監視AI | 自動照合システム'
    });
  } else if (part === 'buzz') {
    const buzz = collectFeeds_([
      { url: 'https://togetter.com/rss/hot', label: 'Togetter話題', take: 3 },
      { url: 'https://b.hatena.ne.jp/hotentry.rss', label: 'SNS注目議論', take: 3 },
      { url: 'https://b.hatena.ne.jp/hotentry/social.rss', label: '社会・世論の話題', take: 2 },
      { url: 'https://b.hatena.ne.jp/hotentry/fun.rss', label: 'サブカル・エンタメ', take: 2 }
    ]);
    matchTopicsWithArticles_({
      topics: buzz,
      articles: articles,
      threshold: threshold,
      webhook: env.webhookTrend,
      topicLabel: 'SNSバズ',
      persona: 'あなたはネット論争、サブカルチャー、現代社会論に精通した鋭いエッセイストです。',
      instruction: 'SNS上のバズや議論に対し、著者の過去記事の「独自の切り口や持論」を提示することで読者をハッとさせられるものを1つ選出してください。',
      postStyle: 'バズ・議論へのハッとする問いかけや考察から記事へ繋げる文面',
      embedTitle: '🔥 【SNSバズ・文化話題×過去記事マッチング】',
      color: 15158332,
      footer: 'SNSトレンド監視AI | バズ・話題照合システム'
    });
  }
}

/** 複数フィードから {label,title,link} を集める */
function collectFeeds_(feeds) {
  const out = [];
  feeds.forEach((f, i) => {
    if (i > 0) Utilities.sleep(500);
    fetchRssItems(f.url).slice(0, f.take).forEach(it => out.push({ label: f.label, title: it.title, link: it.link }));
  });
  return out;
}

/** 話題リストと過去記事を番号で照合し、閾値以上なら Discord へ送信 */
function matchTopicsWithArticles_(o) {
  if (o.topics.length === 0) {
    sendLog(`${o.topicLabel}: フィードを取得できませんでした。`, true);
    return;
  }
  const topicText = o.topics.map((t, i) => `[T${i + 1}] [${t.label}] ${t.title}`).join('\n');
  const articleText = o.articles
    .map((a, i) => `[A${i + 1}] タイトル: ${a.title} / 内容・概要: ${a.body.substring(0, 150).replace(/\s+/g, ' ')}`)
    .join('\n');

  const prompt = `${o.persona}
現在の【${o.topicLabel}トレンド】と、著者の過去記事リスト（新しい順・全${o.articles.length}件）を比較照合してください。
各項目の先頭に [T番号]・[A番号] があります。

【現在の${o.topicLabel}トレンド】
${topicText}

【過去記事リスト】
${articleText}

${o.instruction}
文脈的に弱い場合は「該当なし」とだけ返してください。
記事URLやタイトルは書かず、必ず番号で指定してください。

■ 出力フォーマット（該当する場合）:
【マッチ度】（1〜10の整数のみ）
【話題番号】（T番号。例: T3）
【記事番号】（A番号。例: A12）
【選定理由】（50文字程度）
【Xポスト案】（100〜130文字程度。${o.postStyle}）`;

  const result = callGeminiAPI(prompt);
  const score = parseInt((field_(result, 'マッチ度').match(/\d+/) || [])[0], 10);
  if (isNaN(score) || result.trim().startsWith('該当なし')) {
    sendLog(`${o.topicLabel}: マッチする過去記事はありませんでした。`);
    return;
  }
  if (score < o.threshold) {
    sendLog(`${o.topicLabel}: マッチ度が${score}点（閾値${o.threshold}未満）のためスキップしました。`);
    return;
  }

  const tIdx = parseInt((field_(result, '話題番号').match(/\d+/) || [])[0], 10) - 1;
  const aIdx = parseInt((field_(result, '記事番号').match(/\d+/) || [])[0], 10) - 1;
  const topic = o.topics[tIdx];
  const article = o.articles[aIdx];
  if (!topic || !article) {
    sendLog(`${o.topicLabel}: AIの回答の番号が範囲外だったためスキップしました（T${tIdx + 1} / A${aIdx + 1}）。`, true);
    return;
  }

  const description =
    `**マッチ度**：${score}/10\n\n` +
    `**注目${o.topicLabel}**：[${topic.title}](${topic.link})\n` +
    `**選定過去記事**：[${article.title}](${article.url})\n\n` +
    `**選定理由**：${field_(result, '選定理由')}\n\n` +
    `**Xポスト案**\n${field_(result, 'Xポスト案')}\n${article.url}`;

  const ok = postDiscord(o.webhook, [{
    title: `${o.embedTitle}（マッチ度: ${score}/10）`,
    url: article.url,
    color: o.color,
    description: description,
    footer: { text: o.footer }
  }], o.topicLabel);
  if (ok) sendLog(`${o.topicLabel}のマッチング提案をDiscordに送信しました。`);
}
