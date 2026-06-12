"use client";

import { useParams } from "next/navigation";

import { CandidateDetail } from "../../../components/candidate/CandidateDetail";

// task-21 — Candidate 詳細ページ（spec v2 §9.5）。
// 動的セグメント [id] を useParams（App Router の Client Component フック）で読み、
// 詳細の中核（取得・表示・promote/reject・採点）は CandidateDetail に委譲する。
// このページは param 取り出しだけの薄いシェルにとどめ、ロジック/状態は持たない。

export default function CandidateDetailPage() {
  const params = useParams<{ id: string }>();
  // catch-all ではないため id は string。型安全のため string 以外は空にフォールバックする。
  const id = typeof params.id === "string" ? params.id : "";
  return <CandidateDetail candidateId={id} />;
}
