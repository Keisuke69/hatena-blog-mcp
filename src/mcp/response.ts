import { AtomPubError } from "../atompub/errors.js";

export interface ToolTextResult {
  [key: string]: unknown;
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/**
 * Wrap a JSON-serialisable payload as an MCP tool result.
 *
 * `structuredContent` is the machine-readable channel; the text content
 * carries the same JSON so clients that don't support structuredContent yet
 * (or that display tool output as plain text) still show something useful.
 */
export function ok(payload: Record<string, unknown>): ToolTextResult {
  const text = JSON.stringify(payload, null, 2);
  return {
    content: [{ type: "text", text }],
    structuredContent: payload,
  };
}

/**
 * Map an AtomPubError to a user-facing Japanese message (as specified in the
 * tool spec). The raw response body and stack trace are intentionally dropped
 * from the client-facing result — server operators still see them in logs.
 */
export function toolError(err: unknown): ToolTextResult {
  const message = formatErrorMessage(err);
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof AtomPubError) {
    switch (err.code) {
      case "unauthorized":
        return "認証に失敗しました。APIキーを確認してください。";
      case "forbidden":
        return "操作が許可されていません (403)。";
      case "not_found":
        return "リソースが見つかりませんでした (404)。";
      case "rate_limited":
        return "レート制限に達しました。しばらく待ってから再試行してください。";
      case "server_error":
        return `はてなブログAPIがサーバーエラーを返しました (${err.status})。`;
      case "bad_request":
        return `リクエストが不正です (${err.status})。`;
      case "parse_error":
        return "AtomPubレスポンスの解析に失敗しました。";
      case "network_error":
        return "はてなブログAPIに接続できませんでした。";
      default:
        return `はてなブログAPIでエラーが発生しました (${err.status})。`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
