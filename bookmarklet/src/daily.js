/* ③ 日次連続取得 → 「日次アクセスDB」
 * 1日ずつ「開始日＝終了日」で API を呼ぶ。画面操作がないのでタブが裏にあっても止まらない。
 * GASへの送信は BATCH_DAYS 日分ずつまとめて行う（GAS v2 が必要） */
const BATCH_DAYS = 10;

async function main() {
  if (!guardPage()) return;
  const y = addDays(today(), -1);
  const input = await dialog({
    title: '【日次データ連続取得】',
    message: '指定期間を1日ずつ取得し、「日次アクセスDB」に保存します。\n取得済みの日はGAS側で自動スキップされるので、途中で止めても再実行すれば続きから埋まります。',
    fields: [
      { id: 'start', label: '開始日', type: 'date', value: addDays(y, -29) },
      { id: 'end', label: '終了日（当日分は未集計のため昨日まで推奨）', type: 'date', value: y },
    ],
    okLabel: '取得開始',
  });
  if (!input) return;
  const { start, end } = input;
  if (!start || !end || start > end) {
    await dialog({ title: '入力エラー', message: '開始日・終了日を正しく指定してください。', okLabel: 'OK' });
    return;
  }

  const total = daysBetween(start, end);
  const ui = progressPanel('note 日次データ取得');
  const t0 = Date.now();
  const failed = [];
  const log = [];
  let ok = 0, empty = 0, rowsTotal = 0, saved = 0, unverified = false;
  let batch = [];

  const render = (i, line) => {
    if (line) log.push(line);
    const elapsed = (Date.now() - t0) / 1000;
    const eta = i > 0 ? (elapsed / i) * (total - i) : 0;
    ui.set(`${i}/${total}日　残り約 ${fmtSec(eta)}\n✅成功:${ok}　⚪0件:${empty}　❌失敗:${failed.length}\n----------\n${log.slice(-5).join('\n')}`);
  };

  const flush = async () => {
    if (batch.length === 0) return;
    const r = await sendToGas({ version: 2, mode: 'DAILY', batches: batch });
    if (r.status === 'success') saved += r.saved; else unverified = true;
    batch = [];
  };

  try {
    for (let i = 0; i < total; i++) {
      if (ui.isCancelled()) break;
      const day = addDays(start, i);
      render(i, `🔄 ${day} 取得中…`);
      try {
        const rows = await fetchNoteList({ unit: 'CUSTOM', date: day, endDate: day }, ui.isCancelled);
        if (rows.length === 0) {
          empty++;
          log[log.length - 1] = `⚪ ${day} 0件`;
        } else {
          ok++;
          rowsTotal += rows.length;
          batch.push({ targetDate: day, data: rows });
          log[log.length - 1] = `✅ ${day} ${rows.length}件`;
        }
      } catch (e) {
        if (e instanceof FatalError) throw e;
        failed.push(day);
        log[log.length - 1] = `❌ ${day} ${e.message}`;
        reportError('DAILY_FETCH_FAILED', `${day}: ${e.message}`);
      }
      if (batch.length >= BATCH_DAYS) {
        log.push('📤 GASへ送信中…');
        render(i + 1);
        await flush();
      }
      render(i + 1);
      await sleep(REQUEST_INTERVAL_MS);
    }
    await flush();

    const stopped = ui.isCancelled() ? '⏹ 途中で停止しました（再実行すると続きから埋まります）\n' : '';
    ui.done(
      `${stopped}期間: ${start} ～ ${end}\n✅成功:${ok}日（${rowsTotal}行）　⚪0件:${empty}日　❌失敗:${failed.length}日\n` +
      (unverified ? '保存件数: 一部未確認（シートで確認してください）\n' : `保存: ${saved}行（重複は自動スキップ）\n`) +
      (failed.length ? `失敗日: ${failed.join(', ')}\n→ 同じ期間で再実行すると失敗日だけ埋まります\n` : '') +
      `所要時間: ${fmtSec((Date.now() - t0) / 1000)}`
    );
  } catch (e) {
    try { await flush(); } catch (_) { /* noop */ }
    ui.done(`❌ ${e.message}\n（取得済み分は送信済みです）`);
    reportError('DAILY_FATAL', e.message);
  }
}
