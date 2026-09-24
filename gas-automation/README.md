# gas-automation

Google Apps Script（GAS）で動く、note運用の自動化スクリプトです。

| ファイル | 主な関数 | 内容 |
|---|---|---|
| `Common.gs` | － | 共通の設定と処理（Gemini、RSS、Discord、記事シートの読み込み） |
| `SyncMyArticles.gs` | `syncMyNewArticles` | RSSで見つけた自分の新着記事を、本文ごとシートに追加 |
| | `backfillArticlesFromUrls` | 「記事URL取込」シートに貼ったURLから、過去の記事をまとめて取り込み |
| `FetchQA.gs` | `fetchAnsweredQA` / `fetchAnsweredQAFull` | 回答済みの質問箱を保存（通常は差分だけ、Fullは全件） |
| `NoteApproach.gs` | `runNoteApproach` | ハッシュタグの新着記事から、相性のよい読者候補とコメント案をDiscordに通知 |
| `TrendMatching.gs` | `runTrendMatching` | ニュースやSNSの話題と過去記事を照合し、X投稿案をDiscordに通知 |

## セットアップ

1. Googleスプレッドシートを作り、「拡張機能 → Apps Script」を開きます。
2. 5つの `.gs` ファイルを作り、それぞれの中身を貼り付けます。
3. 「プロジェクトの設定 → スクリプト プロパティ」に、次の値を設定します。

| プロパティ | 必須 | 例・説明 |
|---|---|---|
| `MY_NOTE_USER_ID` | ○ | noteのID（`https://note.com/◯◯◯` の ◯◯◯ の部分） |
| `GEMINI_API_KEY` | ○（AI機能） | Google AI Studio で発行したAPIキー |
| `GEMINI_MODEL` | | 使うGeminiのモデル名 |
| `GEMINI_FALLBACK_MODEL` | | 混雑（503）時に切り替える予備のモデル名（軽量モデルがおすすめ） |
| `DISCORD_WEBHOOK_APPROACH` | ○（読者開拓） | Discordのウェブフック URL |
| `DISCORD_WEBHOOK_TREND` | ○（トレンド） | Discordのウェブフック URL |
| `DISCORD_WEBHOOK_LOG` | | 実行ログを送るウェブフック URL |
| `ARTICLE_SHEET_NAME` | | 記事一覧のシート名（既定：`記事一覧`） |
| `SEARCH_HASHTAGS` | | 検索に使うハッシュタグをカンマ区切りで指定（指定しない場合はAIが自動で作成） |
| `APPROACH_COOLDOWN_DAYS` | | 同じ著者を再び提案するまでの日数（既定：30） |
| `TREND_MATCH_THRESHOLD` | | トレンド照合で通知する最低マッチ度（既定：7） |

4. 各関数を一度手動で実行して権限を許可します。そのあと「トリガー」で定期実行を設定します（例：記事同期は1日1回、読者開拓は1日1回）。

## Gemini が混雑（503エラー）のとき

1. 5秒 → 10秒 → 20秒と間隔をあけて再試行します。
2. `GEMINI_FALLBACK_MODEL` を設定している場合は、予備のモデルで同じように再試行します。
3. それでも失敗した場合は、30分後に自動で再実行します（1日2回まで）。`runTrendMatching` は、失敗したパート（ニュースまたはSNS）だけを再実行します。

## データの扱い

- 保存先は、あなたのスプレッドシートだけです。
- AI機能では、**自分の記事のタイトル・本文の一部**と、**他の人の記事のタイトル・概要（200文字）**をGemini APIに送ります。Geminiの無料枠では、入力が品質改善に使われる場合があります。気になる場合は有料枠を使ってください。
- ニュースやSNSのRSS（Google ニュース、はてなブックマーク、Togetter）は、それぞれのサービスの規約に従って利用してください。
- GASはnoteにログインしていない状態でアクセスするため、有料記事は無料部分しか保存されません。
