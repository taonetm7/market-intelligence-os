import type { ButtonHTMLAttributes } from "react";

import { cx } from "./cx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

// 機能本位の最小ボタン。type は明示しない限り "button"（form の暗黙 submit を防ぐ）。
export function Button({ variant = "secondary", className, type, ...rest }: ButtonProps) {
  return (
    <button
      type={type ?? "button"}
      className={cx("mi-btn", `mi-btn--${variant}`, className)}
      {...rest}
    />
  );
}
