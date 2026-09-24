/* ② 期間指定取得 → 「カスタム指定DB」
 * 旧版は表示中ページのURLから期間を推測していたが、v2 は期間をダイアログで指定する */
function presetRanges() {
  const y = addDays(today(), -1); // 当日分は未集計のため既定は昨日まで
  const now = new Date();
  const firstThis = fmtLocal(new Date(now.getFullYear(), now.getMonth(), 1));
  const firstLast = fmtLocal(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const lastLast = fmtLocal(new Date(now.getFullYear(), now.getMonth(), 0));
  return [
    { label: '昨日', range: () => [y, y] },
    { label: '過去7日', range: () => [addDays(y, -6), y] },
    { label: '過去28日', range: () => [addDays(y, -27), y] },
    { label: '今月', range: () => [firstThis, today()] },
    { label: '先月', range: () => [firstLast, lastLast] },
  ];
}

async function main() {
  if (!guardPage()) return;
  const y = addDays(today(), -1);
  const input = await dialog({
    title: '【期間指定取得】',
    message: '指定した期間の記事別データを取得し、「カスタム指定DB」に保存します。\n開始日＝終了日にすると単日の実測値になります（日次データの突合に使えます）。',
    presets: presetRanges(),
    fields: [
      { id: 'start', label: '開始日', type: 'date', value: addDays(y, -27) },
      { id: 'end', label: '終了日', type: 'date', value: y },
    ],
    okLabel: '取得開始',
  });
  if (!input) return;
  const { start, end } = input;
  if (!start || !end || start > end) {
    await dialog({ title: '入力エラー', message: '開始日・終了日を正しく指定してください。', okLabel: 'OK' });
    return;
  }

  const label = start === end ? start : `${start}～${end}`;
  const ui = progressPanel('note 期間指定取得');
  const t0 = Date.now();
  try {
    ui.set(`${label} を取得中…`);
    const rows = await fetchNoteList({ unit: 'CUSTOM', date: start, endDate: end }, ui.isCancelled);
    if (rows.length === 0) {
      ui.done(`${label} のデータは0件でした。`);
      return;
    }
    ui.set(`${rows.length}件を取得。GASへ送信中…`);
    const r = await sendToGas({ version: 2, mode: 'CUSTOM', targetDate: label, data: rows });
    const saved = r.status === 'success' ? `保存 ${r.saved}件 / 重複スキップ ${r.skipped_as_duplicate}件` : '送信済み（保存件数はシートで確認してください）';
    ui.done(`✅ ${label}：${rows.length}件\n${saved}\n所要時間: ${fmtSec((Date.now() - t0) / 1000)}`);
  } catch (e) {
    ui.done(`❌ ${e.message}`);
    reportError('CUSTOM_FETCH_FAILED', e.message);
  }
}
