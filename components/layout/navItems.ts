export type NavItem = { href: string; label: string };

// グローバルナビ6項目。既定ランディングは Inbox（虚栄カウンターの Dashboard を既定にしない）。
// Settings は枠だけ（中身は Slice 2+）。順序が表示順。
// Watchlist（task-37）は Candidates の次に置く（候補の定点観測＝候補管理の隣接導線）。
export const NAV_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox" },
  { href: "/raw-signals", label: "Raw Signals" },
  { href: "/candidates", label: "Candidates" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/imports", label: "Imports" },
  { href: "/settings", label: "Settings" },
];
