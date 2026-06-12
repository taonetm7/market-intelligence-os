import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { NavList } from "../../components/layout/NavList";
import { PageHeader } from "../../components/layout/PageHeader";
import { NAV_ITEMS } from "../../components/layout/navItems";
import { Badge } from "../../components/ui/Badge";
import { Button } from "../../components/ui/Button";
import { Input } from "../../components/ui/Input";
import { Modal } from "../../components/ui/Modal";
import { Select } from "../../components/ui/Select";
import { Table, type Column } from "../../components/ui/Table";

// task-16 描画スモーク（spec v2 §9.1 / §13）:
// - ナビ5項目（Inbox 既定）が表示・遷移できる
// - 共通 UI が import 可能で描画できる
// 依存追加を避けるため react-dom/server の静的描画でアサートする。

describe("ナビゲーション", () => {
  it("ナビは5項目を Inbox 先頭の順で持つ", () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      "Inbox",
      "Raw Signals",
      "Candidates",
      "Imports",
      "Settings",
    ]);
    expect(NAV_ITEMS[0]).toEqual({ href: "/inbox", label: "Inbox" });
  });

  it("NavList は5項目を href 付きで描画し、既定アクティブは Inbox", () => {
    const html = renderToStaticMarkup(<NavList activePath="/inbox" />);

    for (const item of NAV_ITEMS) {
      expect(html).toContain(item.label);
      expect(html).toContain(`href="${item.href}"`);
    }

    const inboxAnchor = html.split("</a>").find((s) => s.includes('href="/inbox"'));
    expect(inboxAnchor).toContain('aria-current="page"');

    // 非アクティブ項目には aria-current を付けない。
    const settingsAnchor = html.split("</a>").find((s) => s.includes('href="/settings"'));
    expect(settingsAnchor).not.toContain("aria-current");
  });

  it("アクティブ判定は配下パス（/candidates/:id 等）にも及ぶ", () => {
    const html = renderToStaticMarkup(<NavList activePath="/candidates/c-1" />);
    const candAnchor = html.split("</a>").find((s) => s.includes('href="/candidates"'));
    expect(candAnchor).toContain('aria-current="page"');
  });
});

describe("レイアウト共通部品", () => {
  it("PageHeader はタイトルと説明を描画する", () => {
    const html = renderToStaticMarkup(
      <PageHeader title="Inbox Triage" description="さばく既定ランディング" />,
    );
    expect(html).toContain("Inbox Triage");
    expect(html).toContain("さばく既定ランディング");
  });
});

describe("共通 UI", () => {
  it("Button は children と variant クラス・既定 type=button を描画する", () => {
    const html = renderToStaticMarkup(<Button variant="primary">保存</Button>);
    expect(html).toContain("保存");
    expect(html).toContain("mi-btn--primary");
    expect(html).toContain('type="button"');
  });

  it("Badge は children と tone クラスを描画する", () => {
    const html = renderToStaticMarkup(<Badge tone="success">accepted</Badge>);
    expect(html).toContain("accepted");
    expect(html).toContain("mi-badge--success");
  });

  it("Input は placeholder を透過描画する", () => {
    const html = renderToStaticMarkup(<Input placeholder="検索" />);
    expect(html).toContain('placeholder="検索"');
    expect(html).toContain("mi-input");
  });

  it("Select は placeholder と options を描画する", () => {
    const html = renderToStaticMarkup(
      <Select
        placeholder="選択してください"
        options={[
          { value: "a", label: "A 区分" },
          { value: "b", label: "B 区分" },
        ]}
      />,
    );
    expect(html).toContain("選択してください");
    expect(html).toContain("A 区分");
    expect(html).toContain('value="b"');
  });

  it("Table はヘッダ・行を描画し、空配列では empty を描画する", () => {
    type Row = { id: string; name: string };
    const columns: Column<Row>[] = [
      { key: "id", header: "ID" },
      { key: "name", header: "名称" },
    ];

    const html = renderToStaticMarkup(
      <Table<Row> columns={columns} rows={[{ id: "r1", name: "行1" }]} getRowKey={(r) => r.id} />,
    );
    expect(html).toContain("ID");
    expect(html).toContain("名称");
    expect(html).toContain("行1");

    const emptyHtml = renderToStaticMarkup(
      <Table<Row> columns={columns} rows={[]} empty="空です" />,
    );
    expect(emptyHtml).toContain("空です");
  });

  it("Modal は open=false で何も描画せず、open=true でダイアログを描画する", () => {
    expect(renderToStaticMarkup(<Modal open={false} title="確認" />)).toBe("");

    const html = renderToStaticMarkup(
      <Modal open title="削除確認">
        本当に削除しますか？
      </Modal>,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain("削除確認");
    expect(html).toContain("本当に削除しますか？");
  });
});
