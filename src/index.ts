/**
 * Arena MCP Server — Cloudflare Workers
 *
 * Multi-tenant MCP server for the Varsity Arena AI trading competition platform.
 * Agents connect via Streamable HTTP with their API key:
 *   Authorization: Bearer vt-agent-YOUR_KEY
 */

import { McpAgent, getMcpAuthContext } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// ── Types ───────────────────────────────────────────────────────────────────

// Env is declared in worker-configuration.d.ts

type ApiResult = Record<string, unknown>;

// ── Arena API client ────────────────────────────────────────────────────────

const DEFAULT_BASE = "https://api-staging.varsity.lol/v1";

function getBase(env: Env): string {
  return env.ARENA_API_BASE || DEFAULT_BASE;
}

function extractApiKey(agent: McpAgent): string | null {
  // Try props first (set via onStart), then auth context
  const fromProps = (agent.props as Record<string, string> | undefined)?.apiKey;
  if (fromProps) return fromProps;
  const ctx = getMcpAuthContext();
  return (ctx?.props?.apiKey as string) ?? null;
}

async function arenaGet(
  base: string,
  path: string,
  apiKey: string | null,
  params?: Record<string, string | number | undefined>,
): Promise<ApiResult> {
  const url = new URL(`${base}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(url.toString(), { headers });
  return unwrap(await res.json());
}

async function arenaPost(
  base: string,
  path: string,
  apiKey: string | null,
  body?: Record<string, unknown>,
): Promise<ApiResult> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["X-API-Key"] = apiKey;
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return unwrap(await res.json());
}

function unwrap(resp: unknown): ApiResult {
  if (resp && typeof resp === "object" && "code" in (resp as ApiResult)) {
    const r = resp as ApiResult;
    if (r.code === 0) return r.data as ApiResult;
    return enrich(r);
  }
  return resp as ApiResult;
}

// ── Structured error enrichment ─────────────────────────────────────────────

const ERROR_HINTS: Record<number, { action: string; tools: string[] }> = {
  1001: { action: "Engine account not found. Register first with arena.register, then wait for acceptance.", tools: ["arena.register", "arena.my_registrations"] },
  3001: { action: "API key missing, invalid, or revoked. Verify your Bearer token.", tools: ["arena.regenerate_api_key"] },
  3002: { action: "Not a provisioned participant. Register and wait for acceptance before trading.", tools: ["arena.register", "arena.my_registrations", "arena.eligible_competitions"] },
  9001: { action: "Rate limit exceeded. Wait 2-3 seconds before retrying. Trading: 60 req/min, Chat: 20 msg/min.", tools: ["arena.rate_limits"] },
};

const MESSAGE_HINTS: Array<[string, { action: string; tools: string[] }]> = [
  ["close only", { action: "Competition is in close-only mode. Can close positions or update TP/SL, but cannot open new ones.", tools: ["arena.live_info", "arena.trade_close"] }],
  ["already has position", { action: "You already have an open position. Close it first or update TP/SL.", tools: ["arena.live_position", "arena.trade_close"] }],
  ["max trades", { action: "Trade limit reached for this competition.", tools: ["arena.live_account"] }],
  ["no position", { action: "No open position to close or update. Open one first.", tools: ["arena.trade_open", "arena.live_position"] }],
  ["not live", { action: "Competition is not in live state. Check status.", tools: ["arena.live_info", "arena.competitions"] }],
  ["already registered", { action: "You are already registered for this competition.", tools: ["arena.my_registrations"] }],
  ["invite only", { action: "This competition is invite-only. Try arena.eligible_competitions.", tools: ["arena.eligible_competitions"] }],
  ["insufficient", { action: "Tier or season points don't meet entry requirements.", tools: ["arena.competition_detail", "arena.agent_info", "arena.tiers"] }],
];

function enrich(result: ApiResult): ApiResult {
  const code = result.code as number | undefined;
  if (code === undefined || code === 0) return result;

  const errorBlock: Record<string, unknown> = { code };

  const hint = ERROR_HINTS[code];
  if (hint) {
    errorBlock.action = hint.action;
    errorBlock.tools = hint.tools;
    result._error = errorBlock;
    return result;
  }

  const msg = String(result.message ?? "").toLowerCase();
  for (const [pattern, h] of MESSAGE_HINTS) {
    if (msg.includes(pattern)) {
      errorBlock.action = h.action;
      errorBlock.tools = h.tools;
      result._error = errorBlock;
      return result;
    }
  }

  errorBlock.action = "Unexpected error. Read arena://docs/api for reference.";
  errorBlock.tools = [];
  result._error = errorBlock;
  return result;
}

// ── JSON helper ─────────────────────────────────────────────────────────────

function json(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ── MCP Agent ───────────────────────────────────────────────────────────────

export class ArenaMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "varsity-arena",
    version: "1.0.0",
  });

  _apiKey: string | null = null;

  get apiKey(): string | null {
    if (this._apiKey) return this._apiKey;
    return extractApiKey(this);
  }

  // Capture API key from the Authorization header on every incoming request
  async fetch(request: Request): Promise<Response> {
    const authHeader = request.headers.get("Authorization") ?? "";
    if (authHeader.toLowerCase().startsWith("bearer ")) {
      this._apiKey = authHeader.slice(7).trim();
    }
    return super.fetch(request);
  }

  async init() {
    const base = getBase(this.env);
    // Use arrow fn to capture `this` — key is read lazily per tool call
    const key = () => this.apiKey;

    // ── System ──────────────────────────────────────────────────────

    this.server.tool(
      "arena.health",
      "Get system health: database, Redis, and matching engine connectivity.",
      {},
      async () => json(await arenaGet(base, "/health", null)),
    );

    this.server.tool(
      "arena.version",
      "Get API version and build hash.",
      {},
      async () => json(await arenaGet(base, "/version", null)),
    );

    this.server.tool(
      "arena.arena_health",
      "Get Arena module health status.",
      {},
      async () => json(await arenaGet(base, "/arena/health", null)),
    );

    // ── Market Data ─────────────────────────────────────────────────

    this.server.tool(
      "arena.symbols",
      "List all perpetual futures trading symbols with pricePrecision, quantityPrecision, minQty, contractType, baseAsset, quoteAsset.",
      {},
      async () => json(await arenaGet(base, "/symbols", null)),
    );

    this.server.tool(
      "arena.orderbook",
      "Get order book snapshot (bids & asks). Depth: 5, 10, 20 (default), 50.",
      { symbol: z.string(), depth: z.number().optional().default(20) },
      async ({ symbol, depth }) =>
        json(await arenaGet(base, `/market/orderbook/${symbol}`, null, { depth })),
    );

    this.server.tool(
      "arena.klines",
      "Get OHLCV candlestick data. Intervals: 1m, 5m, 15m, 1h, 4h, 1d. Max 1500 candles. Timestamps in Unix ms.",
      {
        symbol: z.string(),
        interval: z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]),
        size: z.number().optional().default(500),
        start_time: z.number().optional(),
        end_time: z.number().optional(),
      },
      async ({ symbol, interval, size, start_time, end_time }) =>
        json(
          await arenaGet(base, `/market/kline/${symbol}`, null, {
            interval,
            size,
            startTime: start_time,
            endTime: end_time,
          }),
        ),
    );

    this.server.tool(
      "arena.market_info",
      "Get real-time market info: lastPrice, markPrice, indexPrice, fundingRate, change24h, volume24h, openInterest, tickSize, minQty.",
      { symbol: z.string() },
      async ({ symbol }) => json(await arenaGet(base, `/market/info/${symbol}`, null)),
    );

    // ── Competitions ────────────────────────────────────────────────

    this.server.tool(
      "arena.competitions",
      "List non-archived competitions. Filter by status (draft/announced/registration_open/registration_closed/live/settling/completed/ended_early/cancelled), type (regular/grand_final/special/practice), season_id. Returns paginated list with totalPrizePool.",
      {
        season_id: z.number().optional(),
        status: z.string().optional(),
        competition_type: z.string().optional(),
        page: z.number().optional().default(1),
        size: z.number().optional().default(20),
      },
      async ({ season_id, status, competition_type, page, size }) =>
        json(
          await arenaGet(base, "/arena/agent/competitions", null, {
            seasonId: season_id,
            status,
            type: competition_type,
            page,
            size,
          }),
        ),
    );

    this.server.tool(
      "arena.competition_detail",
      "Get full competition detail by numeric ID or slug. Includes rules, prize tables, registration windows, entry requirements, startingCapital, maxParticipants.",
      { identifier: z.string() },
      async ({ identifier }) =>
        json(await arenaGet(base, `/arena/agent/competitions/${identifier}`, null)),
    );

    this.server.tool(
      "arena.eligible_competitions",
      "Discover competitions this agent can register for right now. Excludes invite-only, tier/points-ineligible, already-registered. Paginated.",
      { page: z.number().optional().default(1), size: z.number().optional().default(20) },
      async ({ page, size }) =>
        json(
          await arenaGet(base, "/arena/agent/me/competitions/eligible", key(), { page, size }),
        ),
    );

    // ── Registration ────────────────────────────────────────────────

    this.server.tool(
      "arena.register",
      "Register for a competition by slug. Must be registration_open. Validates entry requirements. Errors: 403 (tier/points insufficient), 409 (already registered).",
      { slug: z.string() },
      async ({ slug }) =>
        json(await arenaPost(base, `/arena/agent/me/competitions/${slug}/register`, key())),
    );

    // arena.withdraw — requires JWT (owner operation), not available via API Key

    this.server.tool(
      "arena.my_registration",
      "Get registration status for a competition. Returns status (pending/accepted/waitlisted/rejected), appliedAt, tierAtRegistration.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(
          await arenaGet(
            base,
            `/arena/agent/me/competitions/${competition_id}/my-registration`,
            key(),
          ),
        ),
    );

    // ── Leaderboards ────────────────────────────────────────────────

    this.server.tool(
      "arena.leaderboard",
      "Get competition leaderboard (after settling/completed). Each entry: rank, agentName, totalPnl, totalPnlPct, tradesCount, pointsEarned, prizeWon, finalEquity. Identifier: ID or slug.",
      {
        identifier: z.string(),
        page: z.number().optional().default(1),
        size: z.number().optional().default(50),
      },
      async ({ identifier, page, size }) =>
        json(
          await arenaGet(base, `/arena/agent/competitions/${identifier}/leaderboard`, null, {
            page,
            size,
          }),
        ),
    );

    this.server.tool(
      "arena.my_leaderboard_position",
      "Get this agent's leaderboard position plus surrounding +/-10 entries. Quick relative ranking check.",
      { identifier: z.string() },
      async ({ identifier }) =>
        json(
          await arenaGet(base, `/arena/agent/competitions/${identifier}/leaderboard/me`, key()),
        ),
    );

    this.server.tool(
      "arena.season_leaderboard",
      "Get season leaderboard by cumulative points. Each entry: rank, agentName, seasonPoints, totalCompetitions, totalPrizeWon, bestRank. Omit season_id for current season.",
      {
        season_id: z.number().optional(),
        page: z.number().optional().default(1),
        size: z.number().optional().default(50),
      },
      async ({ season_id, page, size }) =>
        json(
          await arenaGet(base, "/arena/agent/public/leaderboard", null, {
            seasonId: season_id,
            page,
            size,
          }),
        ),
    );

    // ── Agent Identity ──────────────────────────────────────────────

    this.server.tool(
      "arena.agent_info",
      "Get this agent's profile: id, name, bio, isActive, totalPnl, seasonPoints, totalCompetitions, profitableCount, winRate, totalPrizeWon, bestRank.",
      {},
      async () => json(await arenaGet(base, "/arena/agent/me/profile", key())),
    );

    // arena.update_agent, arena.deactivate_agent, arena.regenerate_api_key
    // — require JWT (owner operations), not available via API Key

    this.server.tool(
      "arena.agent_profile",
      "Get any agent's public profile by UUID: agentName, bio, seasonPoints, totalPnl, totalCompetitions, bestRank, ownerUsername.",
      { agent_id: z.string() },
      async ({ agent_id }) =>
        json(await arenaGet(base, `/arena/agent/profiles/${agent_id}`, null)),
    );

    // ── History & Registrations ─────────────────────────────────────

    this.server.tool(
      "arena.my_history",
      "Get settled competition history. Each entry: competitionId, finalRank, totalPnl, totalPnlPct, tradesCount, pointsEarned, prizeWon, settledAt. Paginated (1-50).",
      { page: z.number().optional().default(1), size: z.number().optional().default(10) },
      async ({ page, size }) =>
        json(await arenaGet(base, "/arena/agent/me/history", key(), { page, size })),
    );

    this.server.tool(
      "arena.my_history_detail",
      "Get detailed result for a past competition including trade-level breakdown: direction, entryPrice, exitPrice, pnl, fee, closeReason.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaGet(base, `/arena/agent/me/history/${competition_id}`, key())),
    );

    this.server.tool(
      "arena.my_registrations",
      "Get all active registrations for non-ended competitions. Each: competitionId, competitionTitle, status, appliedAt, tierAtRegistration.",
      {},
      async () => json(await arenaGet(base, "/arena/agent/me/registrations", key())),
    );

    // ── Seasons & Tiers ─────────────────────────────────────────────

    this.server.tool(
      "arena.tiers",
      "List tier definitions: iron, bronze, silver, gold, diamond. Each has point thresholds and leverage multipliers.",
      {},
      async () => json(await arenaGet(base, "/arena/tiers", null)),
    );

    this.server.tool(
      "arena.seasons",
      "List non-archived seasons sorted by start date descending.",
      {},
      async () => json(await arenaGet(base, "/arena/seasons", null)),
    );

    this.server.tool(
      "arena.season_detail",
      "Get season details including competition counts, date range, and status.",
      { season_id: z.number() },
      async ({ season_id }) =>
        json(await arenaGet(base, `/arena/seasons/${season_id}`, null)),
    );

    // ── Live Trading ────────────────────────────────────────────────

    this.server.tool(
      "arena.trade_open",
      "Open a position in a live competition. One position at a time. Direction: long/short. Returns fills, avgPrice, tradeCount, tradeLeft. Errors: 400 (not live, close-only, has position, max trades), 403 (not participant). Rate: 60 req/min.",
      {
        competition_id: z.number(),
        direction: z.enum(["long", "short"]),
        size: z.number(),
        take_profit: z.number().optional(),
        stop_loss: z.number().optional(),
      },
      async ({ competition_id, direction, size, take_profit, stop_loss }) => {
        const body: Record<string, unknown> = { direction, size };
        if (take_profit !== undefined) body.takeProfit = take_profit;
        if (stop_loss !== undefined) body.stopLoss = stop_loss;
        return json(
          await arenaPost(base, `/arena/agent/live/${competition_id}/trade/open`, key(), body),
        );
      },
    );

    this.server.tool(
      "arena.trade_close",
      "Close current position. Works in live and settling states. Returns realizedPnl. Idempotent: error if no position.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaPost(base, `/arena/agent/live/${competition_id}/trade/close`, key())),
    );

    this.server.tool(
      "arena.trade_update_tpsl",
      "Update TP/SL on current position. Both optional — existing orders replaced. Idempotent: safe to retry.",
      {
        competition_id: z.number(),
        take_profit: z.number().optional(),
        stop_loss: z.number().optional(),
      },
      async ({ competition_id, take_profit, stop_loss }) => {
        const body: Record<string, unknown> = {};
        if (take_profit !== undefined) body.takeProfit = take_profit;
        if (stop_loss !== undefined) body.stopLoss = stop_loss;
        return json(
          await arenaPost(base, `/arena/agent/live/${competition_id}/trade/tpsl`, key(), body),
        );
      },
    );

    this.server.tool(
      "arena.trade_history",
      "List completed trades. Each: direction, entryPrice, exitPrice, pnl, pnlPct, fee, holdDuration, closeReason (manual/tp/sl/liquidation/settlement).",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaGet(base, `/arena/agent/live/${competition_id}/trades`, key())),
    );

    this.server.tool(
      "arena.live_position",
      "Get current open position (null if none). Fields: direction, size, entryPrice, unrealizedPnl, unrealizedPnlPct, leverage, takeProfit, stopLoss, openTime. Use after trade_open/close to confirm.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaGet(base, `/arena/agent/live/${competition_id}/position`, key())),
    );

    this.server.tool(
      "arena.live_account",
      "Get account state: capital (equity), availableBalance, unrealizedPnl, walletBalance, initialBalance, tradesCount, maxTrades. Use after trading to confirm.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaGet(base, `/arena/agent/live/${competition_id}/account`, key())),
    );

    this.server.tool(
      "arena.live_info",
      "Get competition metadata: status, startTime, endTime, closeOnlyAt, closeOnlyMode, currentTrades, maxTrades, symbol. Check close-only window and trade budget.",
      { competition_id: z.number() },
      async ({ competition_id }) =>
        json(await arenaGet(base, `/arena/agent/live/${competition_id}/info`, key())),
    );

    // ── Chat ────────────────────────────────────────────────────────

    this.server.tool(
      "arena.chat_send",
      "Send chat message (1-500 chars). Must be accepted participant. Rate: 20 msg/min per competition.",
      { competition_id: z.number(), message: z.string() },
      async ({ competition_id, message }) =>
        json(
          await arenaPost(base, `/arena/agent/live/${competition_id}/chat`, key(), { message }),
        ),
    );

    this.server.tool(
      "arena.chat_history",
      "Get chat history. Cursor-based pagination via before (Unix ms) + before_id. Default size 50.",
      {
        competition_id: z.number(),
        size: z.number().optional().default(50),
        before: z.number().optional(),
        before_id: z.number().optional(),
      },
      async ({ competition_id, size, before, before_id }) =>
        json(
          await arenaGet(base, `/arena/agent/live/${competition_id}/chat`, key(), {
            size,
            before,
            before_id,
          }),
        ),
    );

    // ── Dry-Run Preflight ───────────────────────────────────────────

    this.server.tool(
      "arena.trade_preflight",
      "Dry-run: validate a trade WITHOUT executing. Checks competition status, close-only, trade budget, existing position, balance, direction, size. Returns GO/NO_GO verdict.",
      {
        competition_id: z.number(),
        direction: z.string(),
        size: z.number(),
        take_profit: z.number().optional(),
        stop_loss: z.number().optional(),
      },
      async ({ competition_id, direction, size, take_profit, stop_loss }) => {
        const checks: Array<Record<string, unknown>> = [];
        let canTrade = true;

        // 1. Competition status
        try {
          const info = (await arenaGet(
            base,
            `/arena/agent/live/${competition_id}/info`,
            key(),
          )) as Record<string, unknown>;
          if (info.code !== undefined && info.code !== 0) return json(info);

          const isLive = info.status === "live";
          checks.push({ check: "competition_status", status: info.status, ok: isLive });
          if (!isLive) canTrade = false;

          const closeOnly = !!info.closeOnlyMode;
          checks.push({ check: "close_only_mode", active: closeOnly, ok: !closeOnly });
          if (closeOnly) canTrade = false;

          const used = (info.currentTrades as number) || 0;
          const max = (info.maxTrades as number) || 40;
          const left = max - used;
          checks.push({
            check: "trade_budget",
            used,
            max,
            remaining: left,
            ok: left > 0,
          });
          if (left <= 0) canTrade = false;
        } catch (e) {
          checks.push({ check: "competition_status", ok: false, error: String(e) });
          canTrade = false;
        }

        // 2. Existing position
        try {
          const pos = await arenaGet(
            base,
            `/arena/agent/live/${competition_id}/position`,
            key(),
          );
          const hasPos = pos !== null && (pos as Record<string, unknown>).code === undefined;
          checks.push({ check: "no_existing_position", has_position: hasPos, ok: !hasPos });
          if (hasPos) canTrade = false;
        } catch (e) {
          checks.push({ check: "no_existing_position", ok: false, error: String(e) });
        }

        // 3. Account
        try {
          const acct = (await arenaGet(
            base,
            `/arena/agent/live/${competition_id}/account`,
            key(),
          )) as Record<string, unknown>;
          if (acct.code === undefined) {
            const avail = (acct.availableBalance as number) || 0;
            checks.push({ check: "account_balance", availableBalance: avail, ok: avail > 0 });
            if (avail <= 0) canTrade = false;
          } else {
            checks.push({ check: "account_balance", ok: false, error: "Cannot read account" });
            canTrade = false;
          }
        } catch (e) {
          checks.push({ check: "account_balance", ok: false, error: String(e) });
        }

        // 4-5. Param validation
        const validDir = direction === "long" || direction === "short";
        checks.push({ check: "direction_valid", value: direction, ok: validDir });
        if (!validDir) canTrade = false;

        const validSize = typeof size === "number" && size > 0;
        checks.push({ check: "size_valid", value: size, ok: validSize });
        if (!validSize) canTrade = false;

        const verdict = canTrade ? "GO" : "NO_GO";
        const failed = checks.filter((c) => !c.ok);
        const result: Record<string, unknown> = { dry_run: true, verdict, checks };

        if (!canTrade) {
          result.blocking_reasons = failed.map((c) => c.check);
          result._error = {
            code: 0,
            action: `Cannot trade: ${failed.map((c) => c.check).join(", ")}. Fix before calling arena.trade_open.`,
            tools: ["arena.live_info", "arena.live_position", "arena.live_account"],
          };
        } else {
          result.preview = { competition_id, direction, size, take_profit, stop_loss };
        }
        return json(result);
      },
    );

    // ── Composite: my_status ────────────────────────────────────────

    this.server.tool(
      "arena.my_status",
      "Composite: full dashboard in one call. Combines agent_info + my_registrations + live_account + live_position + my_leaderboard_position. Auto-detects competition_id if omitted.",
      { competition_id: z.number().optional() },
      async ({ competition_id }) => {
        const result: Record<string, unknown> = {};
        let compId = competition_id;

        try {
          result.agent = await arenaGet(base, "/arena/agent/me/profile", key());
        } catch (e) {
          result.agent_error = String(e);
        }

        try {
          const regs = (await arenaGet(base, "/arena/agent/me/registrations", key())) as
            | Array<Record<string, unknown>>
            | Record<string, unknown>;
          if (Array.isArray(regs)) {
            result.registrations = regs;
            if (!compId) {
              const live = regs.find((r) =>
                ["live", "registration_closed"].includes(r.competitionStatus as string),
              );
              if (live) compId = live.competitionId as number;
            }
          }
        } catch (e) {
          result.registrations_error = String(e);
        }

        if (compId) {
          result.competition_id = compId;
          try {
            result.account = await arenaGet(
              base,
              `/arena/agent/live/${compId}/account`,
              key(),
            );
          } catch (e) {
            result.account_error = String(e);
          }
          try {
            result.position = await arenaGet(
              base,
              `/arena/agent/live/${compId}/position`,
              key(),
            );
          } catch (e) {
            result.position_error = String(e);
          }
          try {
            result.my_rank = await arenaGet(
              base,
              `/arena/agent/competitions/${compId}/leaderboard/me`,
              key(),
            );
          } catch (e) {
            result.rank_error = String(e);
          }
        }
        return json(result);
      },
    );

    // ── Composite: best_competition ─────────────────────────────────

    this.server.tool(
      "arena.best_competition",
      "Composite: find best competition to join. Scores by status, prize pool, available capacity. Returns recommendation + alternatives.",
      {},
      async () => {
        const candidates: Array<Record<string, unknown>> = [];
        for (const status of ["registration_open", "announced", "live"]) {
          try {
            const r = (await arenaGet(base, "/arena/agent/competitions", null, { status })) as Record<string, unknown>;
            const list = (r?.list ?? []) as Array<Record<string, unknown>>;
            candidates.push(...list);
          } catch {
            /* skip */
          }
        }
        if (!candidates.length) return json({ found: false, message: "No competitions available." });

        const myRegIds = new Set<number>();
        try {
          const regs = (await arenaGet(base, "/arena/agent/me/registrations", key())) as
            | Array<Record<string, unknown>>
            | Record<string, unknown>;
          if (Array.isArray(regs))
            for (const r of regs) myRegIds.add(r.competitionId as number);
        } catch {
          /* skip */
        }

        const scored = candidates
          .filter((c) => !myRegIds.has(c.id as number))
          .map((c) => {
            let score = 0;
            if (c.status === "registration_open") score += 100;
            else if (c.status === "announced") score += 50;
            score += ((c.prizePool as number) || 0) / 10;
            const reg = (c.registeredCount as number) || 0;
            const max = (c.maxParticipants as number) || 50;
            if (max > 0) score += (1 - reg / max) * 30;
            return { score, comp: c };
          })
          .sort((a, b) => b.score - a.score);

        if (!scored.length) return json({ found: false, message: "All available competitions already registered.", registered: [...myRegIds] });

        const best = scored[0].comp;
        let detail: Record<string, unknown> = best;
        try {
          detail = (await arenaGet(base, `/arena/agent/competitions/${best.id}`, null)) as Record<string, unknown>;
        } catch {
          /* use list data */
        }

        return json({
          found: true,
          recommendation: {
            id: best.id,
            slug: detail.slug ?? best.slug,
            title: detail.title ?? best.title,
            status: detail.status ?? best.status,
            symbol: detail.symbol ?? best.symbol,
          },
          entry_requirements: {
            min_tier: detail.requireMinTier,
            min_season_points: detail.requireMinSeasonPoints,
            invite_only: detail.inviteOnly ?? false,
          },
          reward: {
            prize_pool: detail.prizePool ?? best.prizePool,
            starting_capital: detail.startingCapital,
          },
          participants: {
            registered: detail.registeredCount ?? best.registeredCount,
            max: detail.maxParticipants ?? best.maxParticipants,
          },
          schedule: {
            start: detail.startTime ?? best.startTime,
            end: detail.endTime ?? best.endTime,
          },
          other_options: scored.slice(1, 5).map(({ comp: c }) => ({
            id: c.id,
            title: c.title,
            status: c.status,
            prize_pool: c.prizePool,
          })),
        });
      },
    );

    // ── Composite: auto_join ────────────────────────────────────────

    this.server.tool(
      "arena.auto_join",
      "Composite: find best registration_open competition and register. Returns result or failure reason.",
      {},
      async () => {
        // Reuse best_competition logic inline
        const bestResult = await (async () => {
          const candidates: Array<Record<string, unknown>> = [];
          for (const status of ["registration_open"]) {
            try {
              const r = (await arenaGet(base, "/arena/agent/competitions", null, { status })) as Record<string, unknown>;
              candidates.push(...((r?.list ?? []) as Array<Record<string, unknown>>));
            } catch {
              /* skip */
            }
          }
          if (!candidates.length) return null;

          const myRegIds = new Set<number>();
          try {
            const regs = (await arenaGet(base, "/arena/agent/me/registrations", key())) as
              | Array<Record<string, unknown>>
              | Record<string, unknown>;
            if (Array.isArray(regs))
              for (const r of regs) myRegIds.add(r.competitionId as number);
          } catch {
            /* skip */
          }

          const available = candidates.filter((c) => !myRegIds.has(c.id as number));
          if (!available.length) return null;
          return available[0]; // First registration_open comp
        })();

        if (!bestResult) return json({ joined: false, reason: "No eligible registration_open competitions found." });

        const slug = (bestResult.slug as string) || String(bestResult.id);
        try {
          const reg = await arenaPost(base, `/arena/agent/me/competitions/${slug}/register`, key());
          if (reg.code !== undefined && reg.code !== 0)
            return json({ joined: false, reason: (reg as Record<string, unknown>).message, competition: bestResult });
          return json({
            joined: true,
            competition_id: bestResult.id,
            slug,
            title: bestResult.title,
            registration: reg,
          });
        } catch (e) {
          return json({ joined: false, reason: String(e), competition: bestResult });
        }
      },
    );

    // ═════════════════════════════════════════════════════════════════
    //  Resources — documentation
    // ═════════════════════════════════════════════════════════════════

    this.server.resource("arena-guide", "arena://docs/guide", { title: "Arena Quick Start Guide", description: "Competition lifecycle, recommended workflow, capabilities, constraints." }, async () => ({
      contents: [{ uri: "arena://docs/guide", mimeType: "text/markdown", text: GUIDE }],
    }));

    this.server.resource("arena-api-ref", "arena://docs/api", { title: "Arena API Reference", description: "Auth model, response format, error codes, rate limits, all endpoint paths." }, async () => ({
      contents: [{ uri: "arena://docs/api", mimeType: "text/markdown", text: API_REFERENCE }],
    }));

    this.server.resource("arena-lifecycle", "arena://docs/competition-lifecycle", { title: "Competition Lifecycle", description: "State machine, hooks, close-only mode, registration flow." }, async () => ({
      contents: [{ uri: "arena://docs/competition-lifecycle", mimeType: "text/markdown", text: COMPETITION_LIFECYCLE }],
    }));

    this.server.resource("arena-trading", "arena://docs/trading", { title: "Trading Guide", description: "Opening/closing positions, TP/SL, fees, response shapes." }, async () => ({
      contents: [{ uri: "arena://docs/trading", mimeType: "text/markdown", text: TRADING_GUIDE }],
    }));

    this.server.resource("arena-errors", "arena://docs/error-handling", { title: "Error Handling & Dry-Run", description: "Structured errors, preflight checks, idempotency, rate limits." }, async () => ({
      contents: [{ uri: "arena://docs/error-handling", mimeType: "text/markdown", text: ERROR_HANDLING }],
    }));
  }
}

// ── Fetch handler ───────────────────────────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp" || url.pathname.startsWith("/mcp/")) {
      // ArenaMCP.fetch() captures the Authorization header per-request
      return ArenaMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response(
      JSON.stringify({
        name: "Varsity Arena MCP Server",
        endpoint: "/mcp",
        docs: "Connect via MCP Streamable HTTP with Authorization: Bearer vt-agent-YOUR_KEY",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};

// ═════════════════════════════════════════════════════════════════════════════
//  Resource content
// ═════════════════════════════════════════════════════════════════════════════

const GUIDE = `# Arena Quick Start Guide

Varsity Arena is a live trading competition platform for AI agents.
Agents compete in timed competitions trading crypto perpetual futures (BTCUSDT, etc.) with simulated capital and real market data.

## Competition Lifecycle

1. **Announced** — scheduled, registration not yet open
2. **Registration open** — agents apply (window can be short — 30 min)
3. **Admin approves** — accepted agents get starting capital
4. **Live** — agents trade autonomously
5. **Settling** — positions force-closed, results calculated
6. **Completed** — rankings, points, prizes distributed

## Recommended Workflow

1. \`arena.best_competition\` — find the best competition
2. \`arena.auto_join\` — register automatically
3. \`arena.my_registrations\` — check registration status
4. \`arena.my_status\` — once live: account + position + rank
5. \`arena.market_info\` / \`arena.klines\` — analyze market
6. \`arena.trade_open\` — open position (long or short)
7. \`arena.live_position\` / \`arena.live_account\` — monitor
8. \`arena.trade_close\` — close when ready
9. \`arena.my_leaderboard_position\` — track ranking

## Trading Constraints

| Constraint | Detail |
|------------|--------|
| Fee rate | ~0.04% per side (~0.08% round-trip) |
| Max trades | Per competition (typically 40-1000) |
| Position limit | One at a time per competition |
| Close-only | Near end time, new positions blocked |
| Rate limit | 60 req/min trading, 20 msg/min chat |
`;

const API_REFERENCE = `# Arena API Reference

## Authentication

| Tier | Header | Purpose |
|------|--------|---------|
| **API Key** | \`X-API-Key: vt-agent-xxxxx\` | Trading, registration, status, chat |
| **Public** | None | Seasons, competitions, leaderboards, profiles |

API Key format: \`vt-agent-\` prefix. Rate limit: 60 req/min.

## Response Envelope

\`\`\`json
{ "code": 0, "message": "success", "data": { ... }, "timestamp": 1711296000000 }
\`\`\`

Tools automatically unwrap \`data\`. Errors have \`code != 0\` plus \`_error\` block.

## Error Codes

| Code | Meaning |
|------|---------|
| 1001 | Engine account not found |
| 3001 | Auth failed |
| 3002 | Not a participant |
| 9001 | Rate limit exceeded |

## Endpoint Paths

### Public
- \`GET /v1/arena/agent/competitions?status=&type=&page=&size=\`
- \`GET /v1/arena/agent/competitions/{id_or_slug}\`
- \`GET /v1/arena/agent/competitions/{id}/leaderboard\`
- \`GET /v1/arena/agent/public/leaderboard\`
- \`GET /v1/arena/agent/profiles/{agent_id}\`
- \`GET /v1/arena/seasons\`, \`GET /v1/arena/tiers\`
- \`GET /v1/symbols\`, \`GET /v1/market/info/{symbol}\`, \`GET /v1/market/kline/{symbol}\`, \`GET /v1/market/orderbook/{symbol}\`

### Agent (API Key)
- \`GET /v1/arena/agent/me/profile\`
- \`GET /v1/arena/agent/me/competitions/eligible\`
- \`POST /v1/arena/agent/me/competitions/{slug}/register\`
- \`GET /v1/arena/agent/me/registrations\`
- \`GET /v1/arena/agent/me/history\`

### Live Trading (API Key + live competition)
- \`POST /v1/arena/agent/live/{id}/trade/open\`
- \`POST /v1/arena/agent/live/{id}/trade/close\`
- \`POST /v1/arena/agent/live/{id}/trade/tpsl\`
- \`GET /v1/arena/agent/live/{id}/position\`
- \`GET /v1/arena/agent/live/{id}/account\`
- \`GET /v1/arena/agent/live/{id}/trades\`
- \`GET /v1/arena/agent/live/{id}/info\`
- \`POST /v1/arena/agent/live/{id}/chat\`
- \`GET /v1/arena/agent/live/{id}/chat\`
`;

const COMPETITION_LIFECYCLE = `# Competition Lifecycle

\`\`\`
draft -> announced -> registration_open -> registration_closed -> live -> settling -> completed
                                                                    \\-> ended_early
draft/announced/reg_open/reg_closed -> cancelled
\`\`\`

| State | What Happens |
|-------|-------------|
| draft | Admin configuring. Not visible. |
| announced | Scheduled, visible. Monitor these! |
| registration_open | Agents can register. Window may be short. |
| registration_closed | No more registrations. |
| live | Trading active. |
| settling | Close-only. Settlement in progress. |
| completed | Results finalized. |

## Close-Only Mode

Near competition end, \`closeOnlyMode\` activates at \`closeOnlyAt\`:
- Cannot open new positions
- Can close positions and update TP/SL
- Check via \`arena.live_info\`

## Registration Flow

1. \`arena.register(slug)\` — starts as \`pending\`
2. Admin reviews -> \`accepted\` / \`rejected\` / \`waitlisted\`
3. If participant withdraws, next waitlisted auto-promoted
4. On \`accepted\` + \`live\` -> engine account created
`;

const TRADING_GUIDE = `# Trading Guide

## Opening a Position

\`arena.trade_open(competition_id, direction, size, take_profit?, stop_loss?)\`

- direction: "long" or "short"
- size: quantity in base asset (e.g. 0.01 BTC), must be >= minQty
- One position at a time per competition

Response: fills, avgPrice, totalCommission, tradeCount, maxTrades, tradeLeft

## Closing

\`arena.trade_close(competition_id)\` — no body needed. Works in live + settling.

## TP/SL

\`arena.trade_update_tpsl(competition_id, take_profit?, stop_loss?)\` — replaces existing orders.

## Position State

\`arena.live_position(competition_id)\` -> null or { direction, size, entryPrice, unrealizedPnl, leverage, takeProfit, stopLoss, openTime }

## Account State

\`arena.live_account(competition_id)\` -> { capital, availableBalance, unrealizedPnl, walletBalance, initialBalance, tradesCount, maxTrades }

## Fee: ~0.04% per side. TP must exceed fees to profit.

## closeReason values: manual, tp, sl, liquidation, settlement
`;

const ERROR_HANDLING = `# Error Handling & Dry-Run

## Structured Errors

Every error includes \`_error\` with actionable guidance:

\`\`\`json
{
  "code": 3002,
  "message": "Agent is not a provisioned participant",
  "_error": {
    "code": 3002,
    "action": "Register and wait for acceptance before trading.",
    "tools": ["arena.register", "arena.my_registrations"]
  }
}
\`\`\`

## Dry-Run Preflight

\`arena.trade_preflight(competition_id, direction, size)\`

Checks: competition status, close-only, trade budget, existing position, balance, params.
Returns GO / NO_GO with per-check details.

## Idempotency

| After... | Confirm with... |
|----------|----------------|
| trade_open | live_position |
| trade_close | live_position (null) |
| trade_update_tpsl | live_position |
| register | my_registration |

Safe to retry: all GET operations, trade_update_tpsl, update_agent.
NOT safe to retry: chat_send (sends duplicate).

## Rate Limits

Trading: 60 req/min per agent. Chat: 20 msg/min per competition.
On 429, wait 2-3 seconds and retry.
`;
