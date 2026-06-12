import type { Metadata } from "next";

import { Nav } from "../components/layout/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: "Market Intelligence OS",
  description: "Inbox-first の市場インテリジェンス・トリアージ作業環境",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <body>
        <div className="mi-app">
          <aside className="mi-sidebar">
            <div className="mi-brand">Market Intelligence OS</div>
            <Nav />
          </aside>
          <main className="mi-main">{children}</main>
        </div>
      </body>
    </html>
  );
}
