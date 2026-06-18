export type NavItem = { href: string; label: string };

// グローバルナビ7項目。既定ランディングは Inbox（虚栄カウンターの Dashboard を既定にしない）。
// Settings は枠だけ（中身は Slice 2+）。順序が表示順。
// Watchlist（task-37）は Candidates の次に置く（候補の定点観測＝候補管理の隣接導線）。
// Reports（task-38）は Watchlist の次に置く（観測・判断の週次まとめ＝振り返りの導線）。
export const NAV_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox" },
  { href: "/raw-signals", label: "Raw Signals" },
  { href: "/candidates", label: "Candidates" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/reports", label: "Reports" },
  { href: "/imports", label: "Imports" },
  { href: "/settings", label: "Settings" },
];
