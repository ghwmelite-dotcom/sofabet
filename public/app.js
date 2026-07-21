/* Sofabet PWA — build-step-free vanilla JS. Hash router + small render
   functions per screen, one api() helper, one state object. */

const state = {
  leagues: null, // cached /api/leagues payload
  key: localStorage.getItem("sofabet_key") || "",
  betPrefill: null, // prefill handed to the bet form by "+ bet" buttons
};

/* ---------- helpers ---------- */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) {
    if (c != null) node.append(c);
  }
  return node;
}

async function api(path, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (opts.auth && state.key) headers.Authorization = `Bearer ${state.key}`;
  if (opts.body) headers["Content-Type"] = "application/json";
  const res = await fetch(path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error((data && data.error) || `HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const num = (x, d = 2) => (x == null ? "–" : Number(x).toFixed(d));
const money = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + Number(x).toFixed(2));

function loading() {
  return el("p", { class: "note", text: "Loading…" });
}

function errorBox(err) {
  return el("div", { class: "error", text: err.message || String(err) });
}

async function loadLeagues() {
  if (!state.leagues) {
    const data = await api("/api/leagues");
    // Registry leagues first, demo leagues (no fdOrgCode) last.
    state.leagues = data.leagues.sort((a, b) => (b.fdOrgCode !== "") - (a.fdOrgCode !== ""));
  }
  return state.leagues;
}

function leagueChips(selected, onPick, leagues) {
  return el(
    "div",
    { class: "chips" },
    leagues.map((l) =>
      el("button", {
        class: `chip${l.key === selected ? " active" : ""}`,
        text: l.key,
        onclick: () => onPick(l.key),
      }),
    ),
  );
}

function probBars(homeWin, draw, awayWin) {
  const row = (label, value, cls) =>
    el("div", { class: "bar-row" }, [
      el("span", { class: "muted", text: label }),
      el("div", { class: "bar-track" }, [el("div", { class: `bar-fill ${cls}`, style: `width:${(value * 100).toFixed(1)}%` })]),
      el("span", { class: "bar-pct", text: pct(value) }),
    ]);
  return el("div", { class: "bars" }, [row("1", homeWin, ""), row("X", draw, "draw"), row("2", awayWin, "away")]);
}

/* ---------- #/fixtures ---------- */

async function renderFixtures(root, params) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const withFixtures = leagues.filter((l) => l.matches.scheduled > 0);
    const pool = withFixtures.length > 0 ? withFixtures : leagues;
    const selected = params.get("league") && pool.some((l) => l.key === params.get("league"))
      ? params.get("league")
      : pool[0]?.key;
    root.replaceChildren(leagueChips(selected, (key) => renderFixtures(root, new URLSearchParams(`league=${key}`)), pool));
    if (!selected) {
      root.append(el("p", { class: "note", text: "No leagues available." }));
      return;
    }
    const data = await api(`/api/fixtures?league=${encodeURIComponent(selected)}`);
    if (data.fixtures.length === 0) {
      root.append(el("p", { class: "note", text: "No scheduled fixtures for this league." }));
      return;
    }
    const byDate = new Map();
    for (const f of data.fixtures) {
      const day = f.utcDate.slice(0, 10);
      if (!byDate.has(day)) byDate.set(day, []);
      byDate.get(day).push(f);
    }
    for (const [day, fixtures] of byDate) {
      root.append(el("div", { class: "date-header", text: new Date(`${day}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" }) }));
      for (const f of fixtures) root.append(fixtureCard(selected, f));
    }
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

function fixtureCard(league, f) {
  const p = f.prediction;
  const matchHref = `#/match/${league}/${f.homeTeamId}/${f.awayTeamId}`;
  const betBtn = el("button", {
    class: "btn btn-small",
    text: "+ bet",
    onclick: () => {
      state.betPrefill = { league, matchId: f.matchId, matchLabel: `${f.homeTeamName} vs ${f.awayTeamName}` };
      location.hash = "#/bets";
    },
  });
  return el("div", { class: "card" }, [
    el("div", { class: "fixture-teams" }, [
      el("a", { href: matchHref, text: `${f.homeTeamName} vs ${f.awayTeamName}` }),
      el("span", { class: "kickoff", text: new Date(f.utcDate).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }),
    ]),
    p ? probBars(p.homeWin, p.draw, p.awayWin) : el("p", { class: "note", text: "No prediction (teams missing from model window)." }),
    p
      ? el("div", { class: "meta-row" }, [
          el("span", { class: "chip static", text: `O2.5 ${pct(p.over25)}` }),
          el("span", { class: "chip static", text: `BTTS ${pct(p.bttsYes)}` }),
          p.mostLikelyScore ? el("span", { class: "chip static", text: `${p.mostLikelyScore.home}–${p.mostLikelyScore.away} ${pct(p.mostLikelyScore.prob)}` }) : null,
          el("span", { style: "flex:1" }),
          betBtn,
        ])
      : el("div", { class: "meta-row" }, [betBtn]),
  ]);
}

/* ---------- #/match/:league/:homeId/:awayId ---------- */

async function renderMatch(root, league, homeId, awayId) {
  root.replaceChildren(loading());
  try {
    const [pred, model] = await Promise.all([
      api(`/api/predict?league=${encodeURIComponent(league)}&home=${homeId}&away=${awayId}`),
      api(`/api/model/${encodeURIComponent(league)}`),
    ]);
    const m = pred.markets;
    root.replaceChildren();
    root.append(el("h2", { text: `${pred.home.name} vs ${pred.away.name}` }));

    const ratingsOf = (id) => model.ratings.find((r) => r.teamId === id);
    const ratingRow = (team) => {
      const r = ratingsOf(team.id);
      return r ? el("p", { class: "note", text: `${team.name}: attack ${num(r.attack)}, defence ${num(r.defence)}, rating ${num(r.rating)}` }) : null;
    };

    root.append(
      el("div", { class: "card" }, [
        el("h3", { text: "1X2" }),
        probBars(m.homeWin, m.draw, m.awayWin),
        el("p", { class: "note", text: `Expected goals: ${pred.home.name} ${num(pred.expectedHomeGoals)} – ${pred.away.name} ${num(pred.expectedAwayGoals)}` }),
        ratingRow(pred.home),
        ratingRow(pred.away),
      ]),
    );

    const dc = m.doubleChance;
    const dnb = m.drawNoBet;
    root.append(
      el("div", { class: "card" }, [
        el("h3", { text: "Double chance & draw no bet" }),
        el("div", { class: "meta-row" }, [
          el("span", { class: "chip static", text: `1X ${pct(dc.homeOrDraw)}` }),
          el("span", { class: "chip static", text: `X2 ${pct(dc.awayOrDraw)}` }),
          el("span", { class: "chip static", text: `12 ${pct(dc.homeOrAway)}` }),
        ]),
        el("p", { class: "note", text: `DNB: ${pred.home.name} ${pct(dnb.home)} (fair ${num(dnb.fairOddsHome)}) · ${pred.away.name} ${pct(dnb.away)} (fair ${num(dnb.fairOddsAway)})` }),
        el("p", { class: "note", text: `BTTS yes ${pct(m.bttsYes)} / no ${pct(m.bttsNo)}` }),
      ]),
    );

    root.append(
      el("div", { class: "card" }, [
        el("h3", { text: "Match totals" }),
        ouTable(m.overUnder),
        el("h4", { text: `${pred.home.name} totals` }),
        ouTable(m.teamTotals.home),
        el("h4", { text: `${pred.away.name} totals` }),
        ouTable(m.teamTotals.away),
      ]),
    );

    root.append(el("div", { class: "card" }, [el("h3", { text: "Asian handicap (home line / away line)" }), ahTable(m.asianHandicap)]));
    root.append(el("div", { class: "card" }, [el("h3", { text: "European handicap" }), ehTable(m.europeanHandicap)]));

    if (pred.cards) {
      const c = pred.cards;
      root.append(
        el("div", { class: "card" }, [
          el("h3", { text: "Cards (yellows)" }),
          el("p", { class: "note", text: `Expected: ${pred.home.name} ${num(c.expectedHomeYellow)} – ${pred.away.name} ${num(c.expectedAwayYellow)} (total ${num(c.expectedTotalYellow)})` }),
          ouTable(c.totalOverUnder),
        ]),
      );
    }

    root.append(
      el("div", { class: "card" }, [
        el("h3", { text: "Top correct scores" }),
        el("div", { class: "meta-row" }, m.topScores.map((s) => el("span", { class: "chip static", text: `${s.home}–${s.away} ${pct(s.prob)}` }))),
        el("p", { class: "note", text: `Model fitted ${new Date(pred.model.fittedAt).toLocaleString()} on ${pred.model.matchCount} matches (${pred.model.fromCache ? "cached" : "fresh"}).` }),
      ]),
    );
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

function ouTable(lines) {
  return el("table", { class: "market" }, [
    el("tr", {}, [el("th", { text: "Line" }), el("th", { text: "Over" }), el("th", { text: "Under" })]),
    lines.map((l) => el("tr", {}, [el("td", { text: String(l.line) }), el("td", { text: pct(l.over) }), el("td", { text: pct(l.under) })])),
  ]);
}

function ahTable(ah) {
  const central = [1.5, 1, 0.5, 0, -0.5, -1, -1.5];
  const find = (side, line) => side.find((l) => l.line === line);
  return el("table", { class: "market" }, [
    el("tr", {}, [el("th", { text: "Line" }), el("th", { text: "Home win" }), el("th", { text: "Fair" }), el("th", { text: "Away win" }), el("th", { text: "Fair" })]),
    central.map((line) => {
      const h = find(ah.home, line);
      const a = find(ah.away, -line);
      return el("tr", {}, [
        el("td", { text: `${line > 0 ? "+" : ""}${line} / ${-line > 0 ? "+" : ""}${-line}` }),
        el("td", { text: h ? pct(h.pWin) : "–" }),
        el("td", { text: h && h.fairOdds ? num(h.fairOdds) : "–" }),
        el("td", { text: a ? pct(a.pWin) : "–" }),
        el("td", { text: a && a.fairOdds ? num(a.fairOdds) : "–" }),
      ]);
    }),
  ]);
}

function ehTable(lines) {
  return el("table", { class: "market" }, [
    el("tr", {}, [el("th", { text: "Line" }), el("th", { text: "Home" }), el("th", { text: "Draw" }), el("th", { text: "Away" })]),
    lines.map((l) =>
      el("tr", {}, [
        el("td", { text: `${l.line > 0 ? "+" : ""}${l.line}` }),
        el("td", { text: pct(l.pHome) }),
        el("td", { text: pct(l.pDraw) }),
        el("td", { text: pct(l.pAway) }),
      ]),
    ),
  ]);
}

/* ---------- #/ratings ---------- */

async function renderRatings(root, params) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.finished > 0);
    const selected = params.get("league") && pool.some((l) => l.key === params.get("league")) ? params.get("league") : pool[0]?.key;
    root.replaceChildren(leagueChips(selected, (key) => renderRatings(root, new URLSearchParams(`league=${key}`)), pool));
    if (!selected) {
      root.append(el("p", { class: "note", text: "No finished matches yet." }));
      return;
    }
    const data = await api(`/api/model/${encodeURIComponent(selected)}`);
    root.append(
      el("div", { class: "card" }, [
        el("h3", { text: `${selected} ratings` }),
        el("p", { class: "note", text: `Home advantage ${num(data.homeAdv, 3)}, rho ${num(data.rho, 3)}. Fitted on ${data.model.matchCount} matches.` }),
        el("table", { class: "market" }, [
          el("tr", {}, [el("th", { text: "Team" }), el("th", { text: "Attack" }), el("th", { text: "Defence" }), el("th", { text: "Rating" })]),
          data.ratings.map((r) =>
            el("tr", {}, [el("td", { text: r.name }), el("td", { text: num(r.attack, 3) }), el("td", { text: num(r.defence, 3) }), el("td", { text: num(r.rating, 3) })]),
          ),
        ]),
      ]),
    );
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

/* ---------- #/accuracy ---------- */

async function renderAccuracy(root) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.finished >= 150);
    root.replaceChildren(el("p", { class: "note", text: "Walk-forward backtest per league (loads on demand — it is CPU-heavy)." }));
    if (pool.length === 0) {
      root.append(el("p", { class: "note", text: "No league with 150+ finished matches yet." }));
      return;
    }
    for (const l of pool) {
      const btn = el("button", { class: "btn", text: "Load backtest" });
      const card = el("div", { class: "card" }, [el("h3", { text: l.name }), el("div", { class: "meta-row" }, [btn])]);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Loading…";
        try {
          const bt = await api(`/api/backtest?league=${encodeURIComponent(l.key)}`);
          card.replaceChildren(el("h3", { text: l.name }), backtestView(bt));
        } catch (err) {
          card.append(errorBox(err));
          btn.disabled = false;
          btn.textContent = "Load backtest";
        }
      });
      root.append(card);
    }
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

function backtestView(bt) {
  const beats = (metric) => {
    const delta = 1 - bt.model[metric] / bt.baseline[metric];
    return `${delta >= 0 ? "beats" : "loses to"} baseline by ${Math.abs(delta * 100).toFixed(1)}%`;
  };
  return el("div", {}, [
    el("p", { class: "note", text: `${bt.matchCount} matches, ${bt.predicted} walk-forward predictions (burn-in ${bt.burnIn}, refit every ${bt.refitEvery}).` }),
    el("table", { class: "market" }, [
      el("tr", {}, [el("th", { text: "Metric" }), el("th", { text: "Model" }), el("th", { text: "Baseline" }), el("th", { text: "Uniform" }), el("th", {})]),
      ["logLoss", "brier", "rps"].map((k) =>
        el("tr", {}, [
          el("td", { text: k === "logLoss" ? "Log loss" : k === "brier" ? "Brier" : "RPS" }),
          el("td", { text: num(bt.model[k], 4) }),
          el("td", { text: num(bt.baseline[k], 4) }),
          el("td", { text: num(bt.uniform[k], 4) }),
          el("td", { class: "small muted", text: beats(k) }),
        ]),
      ),
    ]),
    el("h4", { text: "Home-win calibration (deciles)" }),
    calibrationChart(bt.calibration),
  ]);
}

function calibrationChart(rows) {
  const W = 340;
  const H = 200;
  const pad = 28;
  const inner = (v) => pad + v * (W - pad - 8);
  const innerY = (v) => H - pad - v * (H - pad - 12);
  const populated = rows.filter((r) => r.count > 0);
  const points = populated.map((r) => `${inner(r.meanPredicted).toFixed(1)},${innerY(r.empirical).toFixed(1)}`).join(" ");
  const circles = populated
    .map(
      (r) =>
        `<circle cx="${inner(r.meanPredicted).toFixed(1)}" cy="${innerY(r.empirical).toFixed(1)}" r="${Math.min(8, 3 + Math.sqrt(r.count)).toFixed(1)}" fill="#22c55e" fill-opacity="0.75"><title>${r.bucket}: predicted ${(r.meanPredicted * 100).toFixed(1)}%, actual ${(r.empirical * 100).toFixed(1)}% (n=${r.count})</title></circle>`,
    )
    .join("");
  const holder = el("div", {});
  holder.innerHTML =
    `<svg class="svg-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="calibration chart">` +
    `<line x1="${pad}" y1="${H - pad}" x2="${W - 8}" y2="${H - pad}" stroke="#334155"/>` +
    `<line x1="${pad}" y1="${H - pad}" x2="${pad}" y2="12" stroke="#334155"/>` +
    `<line x1="${inner(0)}" y1="${innerY(0)}" x2="${inner(1)}" y2="${innerY(1)}" stroke="#475569" stroke-dasharray="4 4"/>` +
    `<text x="${W - 8}" y="${H - 6}" fill="#94a3b8" font-size="10" text-anchor="end">predicted</text>` +
    `<text x="6" y="16" fill="#94a3b8" font-size="10">actual</text>` +
    (points ? `<polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="1.5"/>` : "") +
    circles +
    `</svg>`;
  return holder;
}

/* ---------- #/bets ---------- */

const MARKET_SELECTIONS = {
  "1X2": ["home", "draw", "away"],
  doubleChance: ["1X", "X2", "12"],
  overUnder: ["over", "under"],
  btts: ["yes", "no"],
};

async function renderBets(root) {
  if (!state.key) {
    renderKeyPrompt(root);
    return;
  }
  root.replaceChildren(loading());
  try {
    const [summary, open, settled] = await Promise.all([
      api("/api/bets/summary", { auth: true }),
      api("/api/bets?status=open", { auth: true }),
      api("/api/bets?status=settled", { auth: true }),
    ]);
    const prefill = state.betPrefill;
    state.betPrefill = null;
    root.replaceChildren(
      summaryView(summary),
      betForm(root, prefill),
      autosettleCard(root),
      openBetsCard(root, open.bets),
      settledCard(settled.bets),
      settingsCard(root),
    );
  } catch (err) {
    if (err.status === 401) {
      renderKeyPrompt(root, "Key rejected — check it and try again.");
    } else {
      root.replaceChildren(errorBox(err), settingsCard(root));
    }
  }
}

function renderKeyPrompt(root, note) {
  const input = el("input", { type: "password", placeholder: "Admin key (SYNC_KEY)", autocomplete: "off" });
  const save = () => {
    const v = input.value.trim();
    if (!v) return;
    state.key = v;
    localStorage.setItem("sofabet_key", v);
    renderBets(document.getElementById("app"));
  };
  root.replaceChildren(
    el("div", { class: "card" }, [
      el("h3", { text: "Bet tracker is private" }),
      el("p", { class: "note", text: "Enter the admin key once. It is stored in this browser only (localStorage) and sent as a Bearer token to your own worker." }),
      note ? el("p", { class: "error", text: note }) : null,
      el("div", { class: "meta-row" }, [
        input,
        el("button", { class: "btn", text: "Save key", onclick: save }),
      ]),
    ]),
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") save();
  });
}

function summaryView(s) {
  const stat = (value, label, cls = "") => el("div", { class: "stat" }, [el("div", { class: `value ${cls}`, text: value }), el("div", { class: "label", text: label })]);
  return el("div", { class: "stat-grid" }, [
    stat(money(s.profit), "profit", s.profit > 0 ? "positive" : s.profit < 0 ? "negative" : ""),
    stat(s.roiPct == null ? "–" : `${s.roiPct}%`, "ROI", s.roiPct > 0 ? "positive" : s.roiPct < 0 ? "negative" : ""),
    stat(s.strikeRate == null ? "–" : `${s.strikeRate}%`, "strike rate"),
    stat(money(s.staked), "settled stake"),
    stat(money(s.openStaked), "open stake"),
    stat(`${s.counts.open} / ${s.counts.won + s.counts.lost + s.counts.void}`, "open / settled"),
  ]);
}

function betForm(root, prefill) {
  const league = el("input", { placeholder: "league (optional)", value: prefill?.league || "" });
  const matchLabel = el("input", { placeholder: "e.g. Arsenal vs Chelsea", value: prefill?.matchLabel || "" });
  const bookmaker = el("select", {}, ["SportyBet", "1xBet", "other"].map((b) => el("option", { value: b, text: b })));
  const market = el("select", {}, Object.keys(MARKET_SELECTIONS).map((mk) => el("option", { value: mk, text: mk })));
  const selection = el("select", {});
  const line = el("input", { type: "number", step: "0.25", placeholder: "2.5" });
  const odds = el("input", { type: "number", step: "0.01", min: "1.01", placeholder: "1.95" });
  const stake = el("input", { type: "number", step: "0.01", min: "0.01", placeholder: "10" });
  const lineField = el("label", { class: "field", text: "Line" }, [line]);

  const syncSelections = () => {
    selection.replaceChildren(...MARKET_SELECTIONS[market.value].map((s) => el("option", { value: s, text: s })));
    lineField.style.display = market.value === "overUnder" ? "" : "none";
  };
  market.addEventListener("change", syncSelections);
  syncSelections();

  const msg = el("p", { class: "note" });
  const submit = el("button", {
    class: "btn",
    text: "Add bet",
    onclick: async () => {
      msg.textContent = "";
      const body = {
        league: league.value.trim() || undefined,
        matchId: prefill?.matchId,
        matchLabel: matchLabel.value.trim(),
        bookmaker: bookmaker.value,
        market: market.value,
        selection: selection.value,
        line: market.value === "overUnder" && line.value !== "" ? Number(line.value) : undefined,
        odds: Number(odds.value),
        stake: Number(stake.value),
      };
      try {
        await api("/api/bets", { auth: true, method: "POST", body });
        renderBets(root);
      } catch (err) {
        msg.textContent = err.message;
      }
    },
  });

  return el("div", { class: "card" }, [
    el("h3", { text: "Add bet" }),
    el("div", { class: "form-grid" }, [
      el("label", { class: "field full", text: "Match" }, [matchLabel]),
      el("label", { class: "field", text: "League" }, [league]),
      el("label", { class: "field", text: "Bookmaker" }, [bookmaker]),
      el("label", { class: "field", text: "Market" }, [market]),
      el("label", { class: "field", text: "Selection" }, [selection]),
      lineField,
      el("label", { class: "field", text: "Odds" }, [odds]),
      el("label", { class: "field", text: "Stake" }, [stake]),
    ]),
    el("div", { class: "meta-row", style: "margin-top:10px" }, [submit, msg]),
  ]);
}

function autosettleCard(root) {
  const msg = el("span", { class: "note" });
  return el("div", { class: "card" }, [
    el("div", { class: "row-between" }, [
      el("div", {}, [el("h3", { text: "Auto-settle" }), el("p", { class: "note", text: "Settles open bets linked to a FINISHED match (1X2, doubleChance, overUnder, btts)." })]),
      el("button", {
        class: "btn",
        text: "Run",
        onclick: async (e) => {
          e.target.disabled = true;
          try {
            const r = await api("/api/bets/autosettle", { auth: true, method: "POST" });
            msg.textContent = `settled ${r.settled}, pending ${r.pending}, skipped ${r.skipped.length}`;
            setTimeout(() => renderBets(root), 800);
          } catch (err) {
            msg.textContent = err.message;
            e.target.disabled = false;
          }
        },
      }),
    ]),
    msg,
  ]);
}

function openBetsCard(root, bets) {
  return el("div", { class: "card" }, [
    el("h3", { text: `Open bets (${bets.length})` }),
    bets.length === 0 ? el("p", { class: "note", text: "Nothing open." }) : null,
    bets.map((b) =>
      el("div", { class: "row-between", style: "padding:6px 0;border-bottom:1px solid var(--line)" }, [
        el("div", {}, [
          el("div", { text: `${b.match_label}` }),
          el("div", { class: "small muted", text: `${b.bookmaker} · ${b.market} · ${b.selection}${b.line != null ? ` ${b.line}` : ""} @ ${num(b.odds)} × ${num(b.stake)}` }),
        ]),
        el("div", { class: "bet-actions" }, ["won", "lost", "void"].map((r) =>
          el("button", {
            class: `btn btn-small ${r === "lost" ? "btn-danger" : "btn-ghost"}`,
            text: r,
            onclick: async () => {
              try {
                await api(`/api/bets/${b.id}/settle`, { auth: true, method: "POST", body: { result: r } });
                renderBets(root);
              } catch (err) {
                alert(err.message);
              }
            },
          }),
        )),
      ]),
    ),
  ]);
}

function settledCard(bets) {
  return el("div", { class: "card" }, [
    el("h3", { text: `Settled (${bets.length})` }),
    bets.length === 0 ? el("p", { class: "note", text: "No history yet." }) : null,
    bets.slice(0, 50).map((b) =>
      el("div", { class: "row-between", style: "padding:6px 0;border-bottom:1px solid var(--line)" }, [
        el("div", {}, [
          el("div", { text: b.match_label }),
          el("div", { class: "small muted", text: `${b.bookmaker} · ${b.market} · ${b.selection}${b.line != null ? ` ${b.line}` : ""} @ ${num(b.odds)} × ${num(b.stake)} · ${b.status}` }),
        ]),
        el("span", { class: b.profit > 0 ? "positive" : b.profit < 0 ? "negative" : "muted", text: money(b.profit) }),
      ]),
    ),
  ]);
}

function settingsCard(root) {
  return el("div", { class: "card" }, [
    el("h3", { text: "Settings" }),
    el("div", { class: "meta-row" }, [
      el("span", { class: "note", text: state.key ? "Admin key saved in this browser." : "No admin key saved." }),
      el("button", {
        class: "btn btn-small btn-ghost",
        text: "Change key",
        onclick: () => renderKeyPrompt(root),
      }),
      el("button", {
        class: "btn btn-small btn-danger",
        text: "Clear key",
        onclick: () => {
          state.key = "";
          localStorage.removeItem("sofabet_key");
          renderBets(root);
        },
      }),
    ]),
  ]);
}

/* ---------- router, nav, install, SW ---------- */

function setActiveNav(name) {
  for (const a of document.querySelectorAll(".nav a")) {
    a.classList.toggle("active", a.dataset.nav === name);
  }
}

function route() {
  const root = document.getElementById("app");
  const hash = location.hash || "#/fixtures";
  const params = new URLSearchParams(hash.split("?")[1] || "");
  const path = hash.split("?")[0];
  const matchRe = /^#\/match\/([^/]+)\/(\d+)\/(\d+)$/.exec(path);
  if (path === "#/fixtures" || path === "#/") {
    setActiveNav("fixtures");
    renderFixtures(root, params);
  } else if (matchRe) {
    setActiveNav("fixtures");
    renderMatch(root, matchRe[1], Number(matchRe[2]), Number(matchRe[3]));
  } else if (path === "#/ratings") {
    setActiveNav("ratings");
    renderRatings(root, params);
  } else if (path === "#/accuracy") {
    setActiveNav("accuracy");
    renderAccuracy(root);
  } else if (path === "#/bets") {
    setActiveNav("bets");
    renderBets(root);
  } else {
    location.hash = "#/fixtures";
  }
}

window.addEventListener("hashchange", route);

let deferredInstall = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredInstall = e;
  document.getElementById("installBtn").hidden = false;
});
document.getElementById("installBtn").addEventListener("click", async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
  document.getElementById("installBtn").hidden = true;
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js");
}

route();
