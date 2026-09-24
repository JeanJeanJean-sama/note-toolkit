// ============================================================
// note アクセス解析 GAS v2 — doPost（受信処理）
// ------------------------------------------------------------
// 【差し替え方法】既存の doPost / normalizeDateValue_ を削除し、このファイルの内容を貼り付けてください。
//   onOpen / crossCheckDailyAgainstCustom はそのまま使えます（変更不要）。
// 【v1からの変更点】
//   ・日次ループの複数日分まとめ送信（batches）に対応 → 送信回数とシート読み込みが1/10に
//   ・同時実行でシートが壊れないよう LockService で排他制御
//   ・旧ブックマークレット（1日ずつ送信）からのデータもそのまま受信可能
//   ・シートの列構成は v1 と同じ（既存データはそのまま使えます）
// ============================================================
const SHEET_BY_MODE = { ALL: 'アクセス解析DB', CUSTOM: 'カスタム指定DB', DAILY: '日次アクセスDB' };
const HEADER = ['対象日時/期間', '記事タイトル', '記事URL', 'インプレッション', 'PV数', 'スキ数', 'コメント数', '売上'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(30 * 1000);
    const requestData = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();

    // --- エラーレポート ---
    if (requestData.error) {
      let errSheet = ss.getSheetByName('エラーログ');
      if (!errSheet) {
        errSheet = ss.insertSheet('エラーログ');
        errSheet.appendRow(['発生日時', 'エラー種別', 'エラー内容']);
      }
      errSheet.appendRow([Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd HH:mm:ss'), requestData.type || '実行エラー', requestData.error]);
      return json_({ status: 'error_logged' });
    }

    const mode = SHEET_BY_MODE[requestData.mode] ? requestData.mode : 'ALL';
    const todayStr = Utilities.formatDate(new Date(), 'JST', 'yyyy-MM-dd');

    // v2: batches = [{ targetDate, data: [...] }, ...] ／ v1: { targetDate, data }
    const batches = Array.isArray(requestData.batches)
      ? requestData.batches
      : [{ targetDate: requestData.targetDate, data: requestData.data || [] }];

    const sheet = getOrCreateSheet_(ss, SHEET_BY_MODE[mode]);
    const existingKeys = loadExistingKeys_(sheet);

    const rowsToAppend = [];
    let received = 0;
    batches.forEach(b => {
      const targetDate = String(b.targetDate || todayStr);
      (b.data || []).forEach(a => {
        received++;
        const key = targetDate + '||' + String(a.url).trim();
        if (existingKeys.has(key)) return;
        existingKeys.add(key);
        rowsToAppend.push([
          targetDate,
          a.title,
          a.url,
          a.impressions || 0,
          a.readCount || 0,
          a.likeCount || 0,
          a.commentCount || 0,
          a.salesAmount || 0
        ]);
      });
    });

    if (rowsToAppend.length > 0) {
      const start = sheet.getLastRow() + 1;
      // A列（対象日時）は日付の自動変換を防ぐためテキスト書式に
      sheet.getRange(start, 1, rowsToAppend.length, 1).setNumberFormat('@');
      sheet.getRange(start, 1, rowsToAppend.length, HEADER.length).setValues(rowsToAppend);
    }

    return json_({
      status: 'success',
      version: 2,
      received: received,
      saved: rowsToAppend.length,
      skipped_as_duplicate: received - rowsToAppend.length
    });
  } catch (error) {
    return json_({ status: 'fatal_error', message: error.toString() });
  } finally {
    lock.releaseLock();
  }
}

function getOrCreateSheet_(ss, name) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(HEADER);
    sheet.getRange(1, 1, 1, HEADER.length).setFontWeight('bold').setBackground('#f3f3f3');
    sheet.getRange('A:A').setNumberFormat('@');
  }
  return sheet;
}

function loadExistingKeys_(sheet) {
  const keys = new Set();
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 3).getValues().forEach(r => {
      keys.add(normalizeDateValue_(r[0]) + '||' + String(r[2]).trim());
    });
  }
  return keys;
}

// セル値が Date に誤変換されていても "yyyy-MM-dd" に揃える（v1 から変更なし）
function normalizeDateValue_(value) {
  if (Object.prototype.toString.call(value) === '[object Date]') {
    return Utilities.formatDate(value, 'JST', 'yyyy-MM-dd');
  }
  return String(value).trim();
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
