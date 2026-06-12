import type { SelectHTMLAttributes } from "react";

import { cx } from "./cx";

export type SelectOption = { value: string; label: string };

export type SelectProps = Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
  options: SelectOption[];
  placeholder?: string;
};

// options 配列駆動の最小 select。placeholder は無効な先頭 option として描画する。
export function Select({ options, placeholder, className, ...rest }: SelectProps) {
  return (
    <select className={cx("mi-select", className)} {...rest}>
      {placeholder ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}
