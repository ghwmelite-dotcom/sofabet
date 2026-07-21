/**
 * Bet tracker handlers — everything under /api/bets. All routes are protected
 * by requireSyncKey: stake data is private. Market evaluation and profit /
 * summary math live in src/model/bets.ts (pure).
 */

import { evaluateBet, settleProfit, summarizeBets } from "../model/bets";
import type { BetResult } from "../model/bets";
import { HttpError } from "../types";
import type { BetRow } from "../types";
import { json, parseJsonBody, requireSyncKey } from "./util";

/* ---- D1 access (only consumer is this module) ---- */

async function listBetRows(db: D1Database, status: string): Promise<BetRow[]> {
  const where = status === "open" ? "WHERE status = 'open'" : status === "settled" ? "WHERE status != 'open'" : "";
  const { results } = await db
    .prepare(`SELECT * FROM bets ${where} ORDER BY created_at DESC, id DESC`)
    .all<BetRow>();
  return results;
}

async function getBetRow(db: D1Database, id: number): Promise<BetRow | null> {
  return db.prepare("SELECT * FROM bets WHERE id = ?").bind(id).first<BetRow>();
}

async function applySettlement(db: D1Database, id: number, result: BetResult, profit: number): Promise<void> {
  await db
    .prepare("UPDATE bets SET status = ?, settled_at = ?, profit = ? WHERE id = ?")
    .bind(result, new Date().toISOString(), profit, id)
    .run();
}

/* ---- handlers ---- */

async function handleList(url: URL, env: Env): Promise<Response> {
  const status = url.searchParams.get("status") ?? "all";
  if (status !== "open" && status !== "settled" && status !== "all") {
    throw new HttpError(400, "'status' must be open, settled or all");
  }
  const bets = await listBetRows(env.DB, status);
  return json({ count: bets.length, bets });
}

function reqString(body: Record<string, unknown>, name: string): string {
  const v = body[name];
  if (typeof v !== "string" || v.trim().length === 0) {
    throw new HttpError(400, `'${name}' is required and must be a non-empty string`);
  }
  return v.trim();
}

function optString(body: Record<string, unknown>, name: string): string | null {
  const v = body[name];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new HttpError(400, `'${name}' must be a string`);
  return v.trim() || null;
}

function reqNumber(body: Record<string, unknown>, name: string): number {
  const v = body[name];
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new HttpError(400, `'${name}' is required and must be a finite number`);
  }
  return v;
}

async function handleCreate(request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const matchLabel = reqString(body, "matchLabel");
  const bookmaker = reqString(body, "bookmaker");
  const market = reqString(body, "market");
  const selection = reqString(body, "selection");
  const league = optString(body, "league");
  const odds = reqNumber(body, "odds");
  const stake = reqNumber(body, "stake");
  if (odds <= 1) throw new HttpError(400, "'odds' must be greater than 1");
  if (stake <= 0) throw new HttpError(400, "'stake' must be greater than 0");
  let line: number | null = null;
  if (body.line !== undefined && body.line !== null) {
    line = reqNumber(body, "line");
  }
  let matchId: number | null = null;
  if (body.matchId !== undefined && body.matchId !== null) {
    const v = body.matchId;
    if (typeof v !== "number" || !Number.isInteger(v)) throw new HttpError(400, "'matchId' must be an integer");
    const exists = await env.DB.prepare("SELECT id FROM matches WHERE id = ?").bind(v).first<{ id: number }>();
    if (!exists) throw new HttpError(400, `match ${v} not found`);
    matchId = v;
  }
  const createdAt = new Date().toISOString();
  const res = await env.DB.prepare(
    `INSERT INTO bets (created_at, league, match_id, match_label, bookmaker, market, selection, line, odds, stake)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(createdAt, league, matchId, matchLabel, bookmaker, market, selection, line, odds, stake)
    .run();
  const id = res.meta.last_row_id;
  const bet = await getBetRow(env.DB, Number(id));
  return json({ ok: true, bet }, 201);
}

async function handleSettle(id: number, request: Request, env: Env): Promise<Response> {
  const body = await parseJsonBody(request);
  const result = body.result;
  if (result !== "won" && result !== "lost" && result !== "void") {
    throw new HttpError(400, "'result' must be won, lost or void");
  }
  const bet = await getBetRow(env.DB, id);
  if (!bet) throw new HttpError(404, `bet ${id} not found`);
  if (bet.status !== "open") throw new HttpError(409, `bet ${id} is already settled (${bet.status})`);
  const profit = settleProfit(result, bet.odds, bet.stake);
  await applySettlement(env.DB, id, result, profit);
  return json({ ok: true, bet: await getBetRow(env.DB, id) });
}

async function handleDelete(id: number, env: Env): Promise<Response> {
  const res = await env.DB.prepare("DELETE FROM bets WHERE id = ?").bind(id).run();
  if ((res.meta.changes ?? 0) === 0) throw new HttpError(404, `bet ${id} not found`);
  return json({ ok: true, deleted: id });
}

interface FinishedScore {
  home_goals: number;
  away_goals: number;
}

async function handleAutosettle(env: Env): Promise<Response> {
  const open = await env.DB.prepare("SELECT * FROM bets WHERE status = 'open' AND match_id IS NOT NULL").all<BetRow>();
  const outcomes: { id: number; result: BetResult; profit: number }[] = [];
  const skipped: { id: number; market: string; selection: string }[] = [];
  let pending = 0;
  for (const bet of open.results) {
    const score = await env.DB.prepare(
      "SELECT home_goals, away_goals FROM matches WHERE id = ? AND status = 'FINISHED' AND home_goals IS NOT NULL AND away_goals IS NOT NULL",
    )
      .bind(bet.match_id)
      .first<FinishedScore>();
    if (!score) {
      pending++;
      continue;
    }
    const result = evaluateBet(bet.market, bet.selection, bet.line, score.home_goals, score.away_goals);
    if (result === null) {
      skipped.push({ id: bet.id, market: bet.market, selection: bet.selection });
      continue;
    }
    const profit = settleProfit(result, bet.odds, bet.stake);
    await applySettlement(env.DB, bet.id, result, profit);
    outcomes.push({ id: bet.id, result, profit });
  }
  return json({ ok: true, settled: outcomes.length, pending, outcomes, skipped });
}

async function handleSummary(env: Env): Promise<Response> {
  const { results } = await env.DB.prepare("SELECT * FROM bets").all<BetRow>();
  return json(summarizeBets(results));
}

export async function handleBets(request: Request, env: Env, url: URL): Promise<Response> {
  requireSyncKey(env, request);
  const path = url.pathname;
  const method = request.method;
  if (path === "/api/bets" && method === "GET") return handleList(url, env);
  if (path === "/api/bets" && method === "POST") return handleCreate(request, env);
  if (path === "/api/bets/summary" && method === "GET") return handleSummary(env);
  if (path === "/api/bets/autosettle" && method === "POST") return handleAutosettle(env);
  const action = /^\/api\/bets\/(\d+)\/(settle|delete)$/.exec(path);
  if (action && method === "POST") {
    const id = Number(action[1]);
    return action[2] === "settle" ? handleSettle(id, request, env) : handleDelete(id, env);
  }
  throw new HttpError(404, `no route for ${method} ${path}`);
}
