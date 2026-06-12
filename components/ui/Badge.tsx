import type { ReactNode } from "react";

import { cx } from "./cx";

export type BadgeTone = "neutral" | "info" | "success" | "warning" | "danger";

export type BadgeProps = {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
};

// ステータス表示などに使う最小バッジ。neutral は既定スタイルのみ。
export function Badge({ children, tone = "neutral", className }: BadgeProps) {
  return (
    <span className={cx("mi-badge", tone !== "neutral" && `mi-badge--${tone}`, className)}>
      {children}
    </span>
  );
}
