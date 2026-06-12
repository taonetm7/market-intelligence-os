"use client";

import { usePathname } from "next/navigation";

import { NavList } from "./NavList";

// 現在パスを読み取りアクティブ表示を付ける client ラッパ。
// 実描画ロジックは presentational な NavList に委譲する。
export function Nav() {
  const pathname = usePathname();
  return <NavList activePath={pathname ?? "/inbox"} />;
}
