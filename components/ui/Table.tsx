import type { ReactNode } from "react";

import { cx } from "./cx";

export type Column<T> = {
  key: string;
  header: ReactNode;
  render?: (row: T) => ReactNode;
};

export type TableProps<T> = {
  columns: Column<T>[];
  rows: T[];
  getRowKey?: (row: T, index: number) => string | number;
  empty?: ReactNode;
  className?: string;
};

// 列定義駆動の最小テーブル。render 未指定の列は row[key] を素直に表示する。
// 以降のタスク（task-17〜23）が再利用するため API を安定させる。
export function Table<T>({
  columns,
  rows,
  getRowKey,
  empty = "データがありません",
  className,
}: TableProps<T>) {
  return (
    <table className={cx("mi-table", className)}>
      <thead>
        <tr>
          {columns.map((col) => (
            <th key={col.key}>{col.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.length === 0 ? (
          <tr>
            <td className="mi-table__empty" colSpan={columns.length}>
              {empty}
            </td>
          </tr>
        ) : (
          rows.map((row, index) => (
            <tr key={getRowKey ? getRowKey(row, index) : index}>
              {columns.map((col) => (
                <td key={col.key}>{col.render ? col.render(row) : defaultCell(row, col.key)}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  );
}

function defaultCell<T>(row: T, key: string): ReactNode {
  const value = (row as Record<string, unknown>)[key];
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number") return value;
  return String(value);
}
