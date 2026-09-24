# note 内部API 調査メモ（2026-09-24 実測）

※ すべて非公式。仕様は予告なく変わる可能性あり。

## 1. ダッシュボード（アクセス状況）

- URL: `https://note.com/dashboard`（旧 `/sitesettings/stats` はリダイレクト）
  - クエリ: `?date=YYYY-MM-DD` など
- フロント: Next.js App Router（`__NEXT_DATA__` なし）＋ Apollo Client
- データ取得: **GraphQL** `POST https://graphql.note.com/graphql`
- 認証: Cookie `note_gql_auth_token` の値を `Authorization: Bearer <token>` で送信
  - ヘッダー: `content-type: application/json`, `accept: application/json`

### 使用されているクエリ

| operationName | 用途 | 主な引数 |
|---|---|---|
| `Dashboard_StatsLayoutSummaryQuery` | 期間合計（IMP/PV/スキ/コメント/売上） | unit, date, endDate |
| `Dashboard_StatPageQuery` | 記事別一覧（ページング） | unit, date, endDate, order, first, after |
| `Dashboard_MetricChartQuery` | 日別推移グラフ | unit, date, endDate, metric |
| `Dashboard_ReferrerSectionQuery` | 流入元（note.com / Google / X …） | unit, date, endDate, includeTimeSeries |

- `unit`（DashboardPeriodUnit）: `LAST_7_DAYS` `LAST_28_DAYS` `LAST_365_DAYS` `ALL` `THIS_MONTH` `LAST_MONTH` `CUSTOM`
- `metric`（DashboardMetricKind）: `IMPRESSION` `PAGE_VIEW` `LIKE` `COMMENT` `SALES`
- `order`: `PUBLISHED_DATE_DESC` は動作確認済み。`PAGE_VIEW_DESC` はエラー（別名の可能性）
- `first`: 100 で動作確認済み（ALL / CUSTOM とも）
- 日付は `YYYY-MM-DDT00:00:00.000Z` 形式
- **単日取得**: `unit: CUSTOM, date = endDate = 同日` で記事別の日次値が取れる（ブックマークレット③の代替）

### 記事別一覧の最小クエリ（動作確認済み）

```graphql
query Q($unit: DashboardPeriodUnit!, $date: Datetime!, $endDate: Datetime,
        $order: DashboardNoteListOrder, $first: Int!, $after: String) {
  dashboardNoteListConnection(unit: $unit, date: $date, endDate: $endDate,
                              order: $order, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      note { title status publishedAt link { absoluteUrl } }
      metrics { pageViewCount impressionCount likeCount commentCount salesAmount }
    } }
  }
  dashboardStatLastUpdatedTimes { noteStatLastUpdatedAt }
}
```

## 2. 記事ページ

- フロント: **Nuxt**（`window.__NUXT__` あり、`__NEXT_DATA__` なし）
  - → 既存GASの `__NEXT_DATA__` 解析は現在は機能せず、HTMLフォールバックが動いている可能性
- 記事詳細API: `GET https://note.com/api/v3/notes/{key}`
  - `body`（HTML本文）, `name`, `like_count`, `comment_count`, `publish_at`, `hashtag_notes`, `user.follower_count`
  - 閲覧権限系: `can_read`, `is_limited`, `is_purchased`, `can_member_read`, `is_trial`, `paywall` → **Phase 2 会員判定に使える候補**

## 3. クリエイター

- `GET https://note.com/api/v2/creators/{urlname}` → `followerCount`, `followingCount`, `noteCount`
- `GET https://note.com/api/v2/creators/{urlname}/contents?kind=note&page=N`
  - 1ページの件数・totalCount が noteCount と一致せず挙動が不安定 → 全記事一覧は GraphQL の `ALL` を使う

## 4. コメント（2026-09-24 追加調査）

- 一覧: `GET https://note.com/api/v3/notes/{key}/note_comments`（`?page=N`）
  - レスポンス: `data[]`, `current_page`, `next_page`, `total_count`（= ルートコメント数。記事の comment_count は返信込み）
  - 各コメント: `key`, `comment`（本文のAST）, `user{key,urlname,nickname,profile_image_url}`, `to_user`,
    `created_at`, `like_count`, `reply_count`, `is_root`, `note_key`,
    **`is_creator_replied`（記事の著者が返信済みか）**, **`is_creator_liked`**, `latest_creator_reply`, `is_replied_to_root`
  - → **未返信判定は `is_creator_replied === false` かつ投稿者が自分以外** で可能
- 返信一覧のエンドポイントは未特定（`/api/v3/note_comments/{key}/replies` 等は 404）。未返信判定には不要
- `/api/v1/note/{id}/comments` は空配列を返す（旧API、使わない）

## 5. 通知

- `GET https://note.com/api/v3/notices?page=N`（1ページ12件、**最大25ページ≒300件・約2〜3週間分**まで）
  - 各通知: `kind`, `note_name`, `all_area_url`, `featured_area_url`, `action_users[]{name,url,…}`, `noticed_at`, `read_flag`
  - コメント関連の kind: `note_comment`（自分の記事へのコメント）, **`note_comment_reply`（自分のコメントへの返信）**, **`note_comment_like`（自分のコメントへのスキ）**
  - → 他人の記事への自分のコメントは、返信/スキの通知から**直近分のみ**逆引き可能
- `GET /api/v3/notice_counts` → 未読数
- 「自分が書いたコメント一覧」API は見つからず（`/api/v3/current_user/note_comments` 等は 404）

## 6. 質問箱

- `GET https://note.com/api/v3/users/{urlname}/qa_questions?page=N`（既存GASで利用中、今回未検証）
