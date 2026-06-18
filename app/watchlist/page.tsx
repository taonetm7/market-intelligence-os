import { WatchlistView } from "./WatchlistView";

// task-37 — Watchlist 一覧ページ（spec v2 §9.8）。
// ページは薄いラッパで、一覧/フィルタ/CRUD/値更新の状態は client の WatchlistView が持つ
// （candidates ページと同じ流儀。PageHeader は WatchlistView 内で描画する）。
export default function WatchlistPage() {
  return <WatchlistView />;
}
