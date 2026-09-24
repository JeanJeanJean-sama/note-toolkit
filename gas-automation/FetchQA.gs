// ==========================================
// FetchQA.gs — note質問箱（回答済み）の自動収集（v2）
// ------------------------------------------
// v1 からの変更点
//  1. APIの応答形式を実測して確定（2026-09 時点）。推測で多数の項目名を試す処理を整理
//       data[]: { key, body(質問), answer{ body, published_at, like_count, merged_like_count }, ... }
//       next_page / total_count
//  2. 差分取得：新しい順に返ってくるので、登録済みだけのページに到達したら終了
//     （毎回全ページを読まない → 147件でも通常は1〜2リクエスト）
//     全件を読み直したい場合は fetchAnsweredQAFull() を実行
//  3. リクエスト間隔を 0.5秒 → 1秒 に（note への負荷対策）
//  4. 書き込みをまとめて実行。新しく追加する分は古い順に並べて追記
//  5. 定期実行（トリガー）でも動くよう、画面のアラート（getUi）をやめてログ出力に
//  6. ブラウザを装う User-Agent の指定を削除
//
// シートの列構成・重複判定のキー（A列URL）は v1 と同じなので、既存データはそのまま使えます。
// ==========================================
const QA_SHEET_NAME = '質問箱';
const QA_MAX_PAGES = 100;

function fetchAnsweredQA() {
  fetchAnsweredQA_(false);
}

/** 全ページを読み直して、取りこぼしがあれば追加（手動実行用） */
function fetchAnsweredQAFull() {
  fetchAnsweredQA_(true);
}

function fetchAnsweredQA_(fullScan) {
  const env = getEnvProps();
  const user = env.noteUserId;
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  let sheet = ss.getSheetByName(QA_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(QA_SHEET_NAME);
  }
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(['質問ID / URL', '質問内容', '回答内容', '回答日時']);
    sheet.getRange(1, 1, 1, 4).setBackground('#f3f3f3').setFontWeight('bold');
  }

  const existingIds = new Set();
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues()
      .forEach(r => existingIds.add(String(r[0]).trim()));
  }

  sendLog(`質問箱の取得を開始します（${fullScan ? '全件' : '差分'}モード）...`);

  const newRows = [];
  let page = 1;
  try {
    while (page && page <= QA_MAX_PAGES) {
      const res = UrlFetchApp.fetch(`https://note.com/api/v3/users/${encodeURIComponent(user)}/qa_questions?page=${page}`, {
        muteHttpExceptions: true,
        headers: { Accept: 'application/json' }
      });
      if (res.getResponseCode() !== 200) {
        sendLog(`質問箱API エラー (HTTP ${res.getResponseCode()}) / page ${page}`, true);
        break;
      }
      const json = JSON.parse(res.getContentText('UTF-8'));
      const items = Array.isArray(json.data) ? json.data : [];
      if (items.length === 0) break;

      let newInPage = 0;
      items.forEach(q => {
        const answer = q.answer;
        const answerBody = answer && typeof answer.body === 'string' ? answer.body.trim() : '';
        if (!answerBody) return; // 未回答はスキップ

        const qUrl = `https://note.com/qa/${user}#${q.key}`; // v1 と同じ形式（重複判定の互換性のため）
        if (existingIds.has(qUrl) || existingIds.has(String(q.key))) return;
        existingIds.add(qUrl);
        newInPage++;

        const answeredAt = new Date(answer.published_at || q.shared_at || '');
        newRows.push({
          t: isNaN(answeredAt.getTime()) ? 0 : answeredAt.getTime(),
          row: [
            qUrl,
            String(q.body || '').trim(),
            answerBody,
            isNaN(answeredAt.getTime()) ? '' : Utilities.formatDate(answeredAt, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm')
          ]
        });
      });

      // 差分モード：このページに新規がなければ、以降は取得済みとみなして終了
      if (!fullScan && newInPage === 0) break;

      page = json.next_page || null;
      if (page) Utilities.sleep(1000);
    }

    if (newRows.length > 0) {
      newRows.sort((a, b) => a.t - b.t);
      const values = newRows.map(r => r.row);
      sheet.getRange(sheet.getLastRow() + 1, 1, values.length, 4).setValues(values);
    }
    sendLog(`🎉 質問箱: 新たに ${newRows.length} 件の回答済み質問を保存しました。`);
  } catch (e) {
    sendLog(`fetchAnsweredQA でエラーが発生しました: ${e.message}`, true);
  }
}
