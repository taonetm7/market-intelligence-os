import Link from "next/link";

import { cx } from "../ui/cx";
import { NAV_ITEMS, type NavItem } from "./navItems";

// 現在パスがその項目（またはその配下）に一致すればアクティブ。
function isActive(activePath: string, href: string): boolean {
  return activePath === href || activePath.startsWith(`${href}/`);
}

// 純粋な presentational ナビ。activePath を受け取り、router へ依存しない
// （描画スモークテストが容易になるよう Nav から分離）。
export function NavList({ activePath }: { activePath: string }) {
  return (
    <nav className="mi-nav" aria-label="Primary">
      <ul className="mi-nav__list">
        {NAV_ITEMS.map((item: NavItem) => {
          const active = isActive(activePath, item.href);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cx("mi-nav__link", active && "mi-nav__link--active")}
                aria-current={active ? "page" : undefined}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
