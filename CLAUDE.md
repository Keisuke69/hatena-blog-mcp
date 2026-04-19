# CLAUDE.md — hatena-blog-mcp

このファイルは本プロジェクトの実装方針を永続化したものです。以降のセッションでもこれを参照してください。

-----

## 0. 遵守事項（最優先）

### Gitコミット規約

- コミットメッセージに `Co-authored-by: Claude ...` などの**共著者情報を含めない**
- コミットメッセージに `🤖 Generated with Claude Code` などの**生成元フッターを含めない**
- コミット著者（author）および committer は **常に以下を使う**（Claude を著者にしない）:
  - `Keisuke Nishitani <99869611+Keisuke69@users.noreply.github.com>`
  - 毎コミットで `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` / `GIT_COMMITTER_NAME` / `GIT_COMMITTER_EMAIL` を指定するか、`git commit --author=...` + 環境変数で committer も上書きする
  - グローバル git config を書き換える必要はない（書き換えない）
- 署名行（`Signed-off-by:` など）も追加しない
- メッセージは Conventional Commits 形式を推奨: `feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`
- メッセージ本体は簡潔に、必要なら本文で補足

### PR規約

- PR本文にも Claude Code 生成である旨の記載は**入れない**
- 通常のエンジニアが書く形式で、変更内容・動機・テスト結果を記述

-----

## 1. プロジェクト概要

- **名称**: `hatena-blog-mcp`
- **目的**: はてなブログの AtomPub API をラップし、読み取り・**書き込み両対応**の MCP サーバーとして公開
- **第一ターゲット**: Cloudflare Workers（セルフホスト可能な設計）
- **最初のユースケース**: 自分のブログの全記事に対する Claude を使ったカテゴリ一括付け替え
- **ライセンス**: MIT（OSS公開予定）

### 既存実装との差別化

- `mtb-beta/hatena-blog-mcp` (Python, ローカル, 読み取り専用)
- `serima/hatena-blog-mcp` (Node.js, Vercel, 読み取り専用)

本プロジェクトは **TypeScript + Cloudflare Workers + 書き込み対応 + BYOK** である点が差別化要素。

-----

## 2. 技術スタック

| 項目 | 採用 |
| --- | --- |
| 言語 | TypeScript 5.x |
| Webフレームワーク | Hono |
| MCP SDK | `@modelcontextprotocol/sdk`（公式） |
| XMLパース | `fast-xml-parser` |
| ランタイム | Cloudflare Workers（第一）、任意のNode/Denoサーバー |
| トランスポート | MCP Streamable HTTP のみ（SSE・stdioは対応しない） |
| ビルド | Wrangler + tsc |
| テスト | Vitest |
| パッケージマネージャ | pnpm |
| Linter/Formatter | Biome |

### 非採用

- **stdio transport は実装しない**（`mcp-remote` 経由でローカル利用してもらう）
- **SSE transport は実装しない**
- **認証情報の永続化は一切行わない**（ステートレス / BYOK）
- **キャッシュは実装しない**（v1は毎回AtomPubへ問い合わせ）

-----

## 3. アーキテクチャ基本方針

### 3-1. ステートレス & BYOK

- サーバー側にシークレットを一切保存しない
- MCPクライアントから `Authorization: Basic base64(hatena_id:api_key)` を受け取り、そのままはてなAtomPubに中継
- 同一Workerを複数人が自分のAPIキーで共有できる

### 3-2. ブログ識別

- `blog_id` は **ツール呼び出しごとの必須パラメータ**
- `hatena_id` はヘッダ username 部をデフォルトとし、ツール引数で明示指定があればそちらを優先
- 複数ブログでAPIキーが違う場合はMCPセッションを分ける

### 3-3. ステートレス通信

- 1ツール呼び出し = 1〜数回のAtomPubリクエスト
- 複数ページ自動追従や大量バッチはClaude側でオーケストレートさせる

-----

## 4. ディレクトリ構成

```
hatena-blog-mcp/
├─ src/
│  ├─ atompub/
│  │  ├─ client.ts       # AtomPub HTTPクライアント
│  │  ├─ xml.ts          # AtomPub XML ⇄ JS 変換
│  │  ├─ types.ts        # Entry, Page, Category 等
│  │  └─ errors.ts       # AtomPubError
│  ├─ mcp/
│  │  ├─ server.ts       # MCP Server 生成（ツール登録）
│  │  └─ tools/
│  │     ├─ entries.ts
│  │     ├─ pages.ts
│  │     └─ categories.ts
│  ├─ adapters/
│  │  └─ cloudflare/
│  │     └─ index.ts     # Workers エントリ（Hono + Streamable HTTP）
│  └─ utils/
│     ├─ auth.ts         # Authorizationヘッダ処理
│     └─ retry.ts        # 指数バックオフ+jitter
├─ test/
│  ├─ fixtures/          # 実AtomPubレスポンスのサンプルXML
│  ├─ atompub/
│  └─ mcp/tools/
├─ wrangler.jsonc
├─ package.json
├─ pnpm-workspace.yaml
├─ tsconfig.json
├─ vitest.config.ts
├─ biome.json
├─ README.md
├─ CLAUDE.md
└─ LICENSE
```

-----

## 5. AtomPub仕様サマリ

### エンドポイント

| 用途 | URI |
| --- | --- |
| サービス文書 | `https://blog.hatena.ne.jp/{hatena_id}/{blog_id}/atom` |
| エントリコレクション | `.../atom/entry` |
| エントリメンバ | `.../atom/entry/{entry_id}` |
| 固定ページコレクション | `.../atom/page` |
| 固定ページメンバ | `.../atom/page/{page_id}` |
| カテゴリ文書 | `.../atom/category` |

### ページネーション

- エントリ一覧は1ページ**7件**、固定ページは**10件**
- 次ページは `<link rel="next" href="...?page={epoch}"/>` の href を使う
- `page` パラメータは epoch 数値

### XML名前空間

- `http://www.w3.org/2005/Atom`（default）
- `http://www.w3.org/2007/app`（app:）
- `http://www.hatena.ne.jp/info/xmlns#hatenablog`（hatenablog:）
- `http://www.hatena.ne.jp/info/xmlns#`（hatena:）

### 記法 (content の type 属性)

- `text/x-hatena-syntax` … はてな記法
- `text/x-markdown` … Markdown
- `text/html` … 見たまま
- **編集時は GET で取得した `content/@type` を必ず維持して送り返す**

### 落とし穴

- **PUTは全文置換**。指定しないフィールドは消える
- **`updated` を送ると投稿日時が書き換わる**。軽微な更新では送らない
- **`hatenablog:custom-url` を省略した場合のみ既存URLが維持される**
- **`draft` を明示指定しないと「下書きでない」扱い**
- `hatena:formatted-content` はXMLエンティティが二重エスケープ

-----

## 6. 認証（BYOK）

### クライアント → サーバー

```
Authorization: Basic <base64(hatena_id:api_key)>
```

### サーバーの挙動

1. `Authorization` ヘッダを受け取る
2. decode して `{ hatena_id, api_key }` を取得
3. AtomPubへは**同じ `Authorization: Basic ...` を中継**
4. ヘッダ無し/不正 → 401

### ツール引数との整合

- ツール引数の `hatena_id` なし → ヘッダの username 部
- ツール引数の `hatena_id` あり → そちらを優先（api_keyはヘッダ値のまま）

-----

## 7. ツール仕様（全11）

### Entries（5）

1. **`list_entries`** (readOnly): `blog_id`, `hatena_id?`, `page?`, `include_html?` → `{ entries, next_page }`
2. **`get_entry`** (readOnly): `blog_id`, `hatena_id?`, `entry_id`, `include_html?` → `Entry`
3. **`create_entry`**: `blog_id`, `hatena_id?`, `title`, `content`, `content_type?`, `categories?`, `draft?`, `preview?`, `scheduled?`, `updated?`, `custom_url?` → `Entry`
4. **`update_entry`** (destructive, idempotent): **部分更新**。既存エントリをGET→マージ→PUT。未指定は既存値維持。`content_type`は必ず既存維持。`touch_updated` (default false) でのみ `updated` を送る
5. **`delete_entry`** (destructive, idempotent): `blog_id`, `hatena_id?`, `entry_id` → `{ ok: true }`

### Pages（5） — Entriesと同様。差分:

- `custom_url` は **作成時必須**
- カテゴリなし
- `scheduled` なし

### Categories（1）

- **`list_categories`** (readOnly): `blog_id`, `hatena_id?` → `{ categories: string[], fixed: boolean }`

-----

## 8. 実装上の重要制約

### XML処理

- `fast-xml-parser` 使用、名前空間を保持、属性キーは `@_` プレフィックス
- `hatena:formatted-content` の二重エスケープに注意
- パーサー設定:

```typescript
new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  processEntities: true,
});
```

### 部分更新（update_entry / update_page）

```typescript
const existing = await client.getEntry(blog_id, entry_id);
const merged = {
  title: params.title ?? existing.title,
  content: params.content ?? existing.content,
  content_type: existing.content_type, // 必ず維持
  categories: params.categories ?? existing.categories,
  draft: params.draft ?? existing.draft,
  preview: params.preview ?? existing.preview,
  custom_url: params.custom_url ?? existing.custom_url,
  updated: params.touch_updated ? new Date().toISOString() : undefined,
};
```

### リトライ（retry.ts）

- `429`, `502`, `503`, `504` で指数バックオフ + jitter
- `Retry-After` ヘッダ尊重
- 最大3回、ベース1000ms、係数2、jitter ±25%

### Cloudflare Workers制約

- Node.jsビルトイン不可（`Buffer`, `fs` など）
- Base64 は `btoa` / `atob`
- 乱数・ハッシュは `crypto.subtle` / `crypto.getRandomValues`
- CPU time制限（無料50ms/有料30秒）

### エラー扱い

- `AtomPubError` にHTTPステータスとボディ短縮を保持
- MCPレスポンスには日本語ユーザーメッセージ。スタックトレース含めない

-----

## 9. テスト方針

- Vitest
- `xml.ts` と `update_entry` の部分更新ロジックは**カバレッジ90%以上**
- 全体60%以上
- `update_entry` は「カテゴリだけ変更、他は維持」のテストを必ず含める
- E2E: `wrangler dev` + MCP Inspector

-----

## 10. 実装順序

### Phase 0: セットアップ

pnpm init、TypeScript、wrangler.jsonc、Biome、Vitest、.gitignore、LICENSE、README雛形、**CLAUDE.md**

### Phase 1: AtomPubクライアント（MCP非依存）

1. `atompub/types.ts`
2. `atompub/xml.ts` + 往復ユニットテスト
3. `atompub/errors.ts`
4. `utils/retry.ts` + ユニットテスト
5. `atompub/client.ts` + ユニットテスト

### Phase 2: MCPツール

1. `utils/auth.ts` + ユニットテスト
2. `mcp/tools/entries.ts` + `update_entry` 部分更新テスト
3. `mcp/tools/categories.ts`
4. `mcp/tools/pages.ts`
5. `mcp/server.ts`

### Phase 3: Cloudflare Workers アダプタ

1. `adapters/cloudflare/index.ts`（Hono + 認証ミドルウェア + Streamable HTTP）
2. `wrangler dev` → MCP Inspector で疎通確認

### Phase 4: ドキュメント & 公開

1. README（機能、セットアップ、クライアント設定例、BYOK、セキュリティ注意）
2. `wrangler deploy`
3. 実ブログ動作確認

-----

## 11. 完了基準（DoD）

- [ ] 全11ツールが MCP Inspector から呼び出せる
- [ ] 実ブログで **エントリの部分更新（カテゴリのみ）** が動作し、**タイトル・本文・記法・投稿日時が変わらない**
- [ ] 認証エラーで適切なメッセージ
- [ ] 存在しない entry_id で 404 相当
- [ ] `wrangler deploy` が通り workers.dev で動く
- [ ] READMEにセットアップ＋BYOKの説明
- [ ] テストカバレッジ 60%以上（`xml.ts`, `update_entry` は 90%以上）
- [ ] セキュリティ注意事項がREADMEにある

-----

## 12. 参考リンク

- はてなブログAtomPub: https://developer.hatena.ne.jp/ja/documents/blog/apis/atom
- MCP仕様: https://modelcontextprotocol.io/
- `@modelcontextprotocol/sdk`: https://github.com/modelcontextprotocol/typescript-sdk
- Cloudflare Remote MCP: https://developers.cloudflare.com/agents/guides/remote-mcp-server/
- Hono: https://hono.dev/
- fast-xml-parser: https://github.com/NaturalIntelligence/fast-xml-parser
