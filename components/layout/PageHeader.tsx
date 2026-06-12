import type { ReactNode } from "react";

export type PageHeaderProps = {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
};

// 各画面共通のヘッダ。右側 actions は任意（ボタン等を載せる）。
export function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header className="mi-page-header">
      <div className="mi-page-header__text">
        <h1 className="mi-page-header__title">{title}</h1>
        {description ? <p className="mi-page-header__desc">{description}</p> : null}
      </div>
      {actions ? <div className="mi-page-header__actions">{actions}</div> : null}
    </header>
  );
}
