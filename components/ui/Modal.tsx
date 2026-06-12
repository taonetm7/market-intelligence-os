import type { ReactNode } from "react";

export type ModalProps = {
  open: boolean;
  onClose?: () => void;
  title?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
};

// 制御コンポーネント（open で表示制御）。open=false では何も描画しない。
// onClose を渡すとヘッダに閉じるボタンを出す（backdrop クリック等は呼び出し側の裁量）。
export function Modal({ open, onClose, title, children, footer }: ModalProps) {
  if (!open) return null;
  return (
    <div className="mi-modal__overlay">
      <div className="mi-modal__dialog" role="dialog" aria-modal="true">
        {title || onClose ? (
          <div className="mi-modal__header">
            {title ? <div className="mi-modal__title">{title}</div> : <span />}
            {onClose ? (
              <button
                type="button"
                className="mi-btn mi-btn--ghost"
                onClick={onClose}
                aria-label="閉じる"
              >
                ×
              </button>
            ) : null}
          </div>
        ) : null}
        <div className="mi-modal__body">{children}</div>
        {footer ? <div className="mi-modal__footer">{footer}</div> : null}
      </div>
    </div>
  );
}
