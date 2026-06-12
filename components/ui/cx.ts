// 最小の className 連結ヘルパー（falsy を除いてスペース結合）。
// 共通 UI の API を安定させるための内部ユーティリティ。
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}
