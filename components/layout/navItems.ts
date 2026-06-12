export type NavItem = { href: string; label: string };

// グローバルナビ5項目。既定ランディングは Inbox（虚栄カウンターの Dashboard を既定にしない）。
// Settings は枠だけ（中身は Slice 2+）。順序が表示順。
export const NAV_ITEMS: NavItem[] = [
  { href: "/inbox", label: "Inbox" },
  { href: "/raw-signals", label: "Raw Signals" },
  { href: "/candidates", label: "Candidates" },
  { href: "/imports", label: "Imports" },
  { href: "/settings", label: "Settings" },
];
