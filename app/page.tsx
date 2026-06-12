import { redirect } from "next/navigation";

// 既定ランディングは Inbox Triage（虚栄カウンターの Dashboard を既定にしない）。
export default function RootIndexPage() {
  redirect("/inbox");
}
