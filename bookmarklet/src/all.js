/* ① 全期間取得 → 「アクセス解析DB」 */
async function main() {
  if (!guardPage()) return;
  const ok = await dialog({
    title: '【全期間取得】',
    message: '全記事の全期間データ（IMP・PV・スキ・コメント・売上）を取得し、「アクセス解析DB」に保存します。\n※ページ移動は不要です。',
  });
  if (!ok) return;

  const ui = progressPanel('note 全期間取得');
  const t0 = Date.now();
  try {
    ui.set('取得中…');
    const date = today();
    const rows = await fetchNoteList({ unit: 'ALL', date }, ui.isCancelled);
    if (rows.length === 0) {
      ui.done('記事データが見つかりませんでした。');
      return;
    }
    ui.set(`${rows.length}件を取得。GASへ送信中…`);
    const r = await sendToGas({ version: 2, mode: 'ALL', targetDate: date, data: rows });
    const saved = r.status === 'success' ? `保存 ${r.saved}件 / 重複スキップ ${r.skipped_as_duplicate}件` : '送信済み（保存件数はシートで確認してください）';
    ui.done(`✅ ${date} の全期間データ ${rows.length}件\n${saved}\n所要時間: ${fmtSec((Date.now() - t0) / 1000)}`);
  } catch (e) {
    ui.done(`❌ ${e.message}`);
    reportError('ALL_FETCH_FAILED', e.message);
  }
}
