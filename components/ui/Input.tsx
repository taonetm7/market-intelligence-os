import type { InputHTMLAttributes } from "react";

import { cx } from "./cx";

export type InputProps = InputHTMLAttributes<HTMLInputElement>;

// ネイティブ input の薄いラッパ。props はそのまま透過し API を安定させる。
export function Input({ className, ...rest }: InputProps) {
  return <input className={cx("mi-input", className)} {...rest} />;
}
