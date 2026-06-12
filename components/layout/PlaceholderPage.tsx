import type { ReactNode } from "react";

import { PageHeader } from "./PageHeader";

export type PlaceholderPageProps = {
  title: string;
  description?: ReactNode;
};

// 各ルートの最小プレースホルダ（本実装は task-17 以降が置き換える）。
// shell の「ナビ5項目が遷移できる」を満たすための器。
export function PlaceholderPage({ title, description }: PlaceholderPageProps) {
  return (
    <div className="mi-page">
      <PageHeader title={title} description={description} />
      <p className="mi-placeholder-note">この画面は後続タスクで実装されます（プレースホルダ）。</p>
    </div>
  );
}
