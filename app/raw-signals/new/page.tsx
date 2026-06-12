import { PageHeader } from "../../../components/layout/PageHeader";
import { QuickCapture } from "../../../components/raw-signal/QuickCapture";

// task-17 — Raw Signal の Quick Capture 画面（spec v2 §9.2）。
// 4 項目で素早く登録し、保存後はそのまま連続入力できる。
export default function NewRawSignalPage() {
  return (
    <>
      <PageHeader
        title="Raw Signal を登録"
        description="4 項目で素早く記録。保存後もフォームは残り、続けて登録できます。"
      />
      <div style={{ maxWidth: 560 }}>
        <QuickCapture />
      </div>
    </>
  );
}
