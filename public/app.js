/* Sofabet PWA — build-step-free vanilla JS. Hash router + small render
   functions per screen, one api() helper, one state object. */

const state = {
  leagues: null, // cached /api/leagues payload
  fixturesByLeague: {}, // session cache of /api/fixtures per league
  formByTeam: {}, // session cache of /api/form per "league:teamId"
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
    err.data = data;
    throw err;
  }
  return data;
}

const pct = (p) => `${(p * 100).toFixed(1)}%`;
const pct0 = (p) => `${Math.round(p * 100)}%`;
const num = (x, d = 2) => (x == null ? "–" : Number(x).toFixed(d));
const money = (x) => (x == null ? "–" : (x > 0 ? "+" : "") + Number(x).toFixed(2));

/* Inline SVG icons (Lucide-style paths) — never emoji/text characters. */
const ICONS = {
  star: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
};

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

async function getFixtures(league) {
  if (!state.fixturesByLeague[league]) {
    state.fixturesByLeague[league] = await api(`/api/fixtures?league=${encodeURIComponent(league)}`);
  }
  return state.fixturesByLeague[league];
}

async function getForm(league, teamId) {
  const key = `${league}:${teamId}`;
  if (!state.formByTeam[key]) {
    state.formByTeam[key] = await api(`/api/form?league=${encodeURIComponent(league)}&team=${teamId}`);
  }
  return state.formByTeam[key];
}

/* ---------- probability cells ---------- */

/**
 * Color ramp for probability cells: hue 4 (red) at/below neutral-0.25,
 * 45 (amber) at neutral, 130 (green) at/above neutral+0.25.
 * 1X2 cells use neutral 0.33, BTTS/totals 0.5.
 */
function probHue(p, neutral) {
  const lo = Math.max(0, neutral - 0.25);
  const hi = Math.min(1, neutral + 0.25);
  if (p <= lo) return 4;
  if (p >= hi) return 130;
  if (p <= neutral) return 4 + ((p - lo) / (neutral - lo)) * (45 - 4);
  return 45 + ((p - neutral) / (hi - neutral)) * (130 - 45);
}

function pcell(label, p, neutral = 0.5, icon = null) {
  const hue = probHue(p, neutral);
  const confident = p >= Math.min(1, neutral + 0.25);
  const alpha = confident ? 0.95 : 0.85;
  const darkText = hue >= 35 && hue <= 60; // amber needs dark text for contrast
  const cell = el("span", {
    class: `pcell${darkText ? " dark-text" : ""}`,
    style: `background:hsl(${Math.round(hue)} 72% 42% / ${alpha})`,
    title: `${label} ${pct(p)}`,
  });
  if (icon) cell.innerHTML = icon;
  cell.append(document.createTextNode(label));
  return cell;
}

function formDots(recent) {
  return el(
    "span",
    { class: "form-dots" },
    recent.map((g) =>
      el("span", {
        class: `fdot ${g.result}`,
        title: `${g.homeAway === "home" ? "H" : "A"} vs ${g.opponentName}: ${g.goalsFor}–${g.goalsAgainst}`,
        text: g.result,
      }),
    ),
  );
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

/* Deterministic monogram crest: 2 initials on an hsl derived from the name. */
function crest(name, size = 40) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const words = name.replace(/[^a-zA-Z0-9 ]/g, " ").trim().split(/\s+/).filter(Boolean);
  const initials =
    words.length >= 2 ? words[0][0] + words[1][0] : (words[0] || "?").slice(0, 2);
  return el("span", {
    class: "crest",
    style: `background:hsl(${hue} 65% 32%);width:${size}px;height:${size}px;font-size:${Math.max(10, Math.round(size * 0.34))}px`,
    text: initials.toUpperCase(),
  });
}

/* One segmented 1X2 bar (home green / draw slate / away blue) + legend. */
function segBar(homeWin, draw, awayWin) {
  const seg = (value, cls, title) =>
    el("div", { class: `seg ${cls}`, style: `width:${(value * 100).toFixed(2)}%`, title }, [
      value >= 0.12 ? el("span", { text: pct0(value) }) : null,
    ]);
  const legendItem = (cls, label, value) =>
    el("span", {}, [
      el("span", { class: "dot", style: `background:${cls}` }),
      el("span", { text: `${label} ${pct(value)}` }),
    ]);
  return el("div", {}, [
    el("div", { class: "seg-bar" }, [
      seg(homeWin, "seg-home", `Home ${pct(homeWin)}`),
      seg(draw, "seg-draw", `Draw ${pct(draw)}`),
      seg(awayWin, "seg-away", `Away ${pct(awayWin)}`),
    ]),
    el("div", { class: "seg-legend" }, [
      legendItem("var(--accent)", "Home", homeWin),
      legendItem("var(--slate)", "Draw", draw),
      legendItem("var(--blue)", "Away", awayWin),
    ]),
  ]);
}

function liveBadge() {
  return el("span", { class: "live-badge" }, [el("span", { class: "live-dot" }), el("span", { text: "LIVE" })]);
}

/* ---------- #/fixtures ---------- */

const WEEK_MS = 7 * 86_400_000;

function localDayKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dayHeader(iso) {
  const d = new Date(iso);
  const key = localDayKey(d);
  const today = localDayKey(new Date());
  const tomorrow = localDayKey(new Date(Date.now() + 86_400_000));
  if (key === today) return "Today";
  if (key === tomorrow) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "short" });
}

async function renderFixtures(root, params) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.scheduled > 0);
    if (pool.length === 0) {
      root.replaceChildren(el("p", { class: "note", text: "No scheduled fixtures in any league." }));
      return;
    }
    // Prefetch fixtures for every league once per session so the default view
    // can land on the first league playing within the next 7 days.
    await Promise.all(pool.map((l) => getFixtures(l.key)));
    const inNextWeek = (key) => {
      const data = state.fixturesByLeague[key];
      const limit = Date.now() + WEEK_MS;
      return data.fixtures.some((f) => Date.parse(f.utcDate) <= limit);
    };
    const selected =
      params.get("league") && pool.some((l) => l.key === params.get("league"))
        ? params.get("league")
        : (pool.find((l) => inNextWeek(l.key)) ?? pool[0]).key;
    root.replaceChildren(
      leagueChips(selected, (key) => renderFixtures(root, new URLSearchParams(`league=${key}`)), pool),
    );
    const data = await getFixtures(selected);
    const fixtures = data.fixtures;
    if (fixtures.length === 0) {
      root.append(el("p", { class: "note", text: "No scheduled fixtures for this league." }));
      return;
    }
    const limit = Date.now() + WEEK_MS;
    if (!fixtures.some((f) => Date.parse(f.utcDate) <= limit)) {
      const resume = new Date(fixtures[0].utcDate).toLocaleDateString(undefined, { day: "numeric", month: "short" });
      root.append(
        el("p", { class: "note", text: `No fixtures in the next 7 days — off-season, resumes ${resume}.` }),
      );
    }
    const byDay = new Map();
    for (const f of fixtures) {
      const key = localDayKey(new Date(f.utcDate));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(f);
    }
    let firstRow = true;
    for (const [day, dayFixtures] of byDay) {
      root.append(el("div", { class: "date-header", text: dayHeader(dayFixtures[0].utcDate) }));
      void day;
      for (const f of dayFixtures) {
        root.append(matchRow(selected, f, firstRow));
        firstRow = false;
      }
    }
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

const plusIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;

function matchRow(league, f, isFirst) {
  const p = f.prediction;
  const matchHref = `#/match/${league}/${f.homeTeamId}/${f.awayTeamId}`;
  const live = f.status === "IN_PLAY" || f.status === "PAUSED";
  const d = new Date(f.utcDate);
  const dayKey = localDayKey(d);
  const dayLabel =
    dayKey === localDayKey(new Date())
      ? "today"
      : dayKey === localDayKey(new Date(Date.now() + 86_400_000))
        ? "tomorrow"
        : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });

  const betBtn = el("button", {
    class: "icon-btn",
    title: "Log a bet for this match",
    onclick: (e) => {
      e.stopPropagation();
      state.betPrefill = { league, matchId: f.matchId, matchLabel: `${f.homeTeamName} vs ${f.awayTeamName}` };
      location.hash = "#/bets";
    },
  });
  betBtn.innerHTML = plusIcon;

  let cells;
  if (!p) {
    cells = [el("span", { class: "badge-newcomer", text: "limited data" })];
  } else {
    // Star cell: the model's single highest-probability 1X2 outcome.
    const tips = [
      ["1", p.homeWin],
      ["X", p.draw],
      ["2", p.awayWin],
    ];
    tips.sort((a, b) => b[1] - a[1]);
    cells = [
      pcell("1", p.homeWin, 0.33),
      pcell("X", p.draw, 0.33),
      pcell("2", p.awayWin, 0.33),
      pcell("O2.5", p.over25),
      pcell("U2.5", 1 - p.over25),
      pcell("BTTS", p.bttsYes),
      pcell(tips[0][0], tips[0][1], 0.33, ICONS.star),
    ];
  }

  const row = el("div", { class: "match-row" }, [
    el("div", { class: "mr-kick" }, [
      live
        ? liveBadge()
        : el("span", { class: "time", text: d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) }),
      el("span", { class: "day", text: live ? "" : dayLabel }),
      isFirst && !live ? el("div", { class: "tz-note", text: "local time" }) : null,
    ]),
    el("div", { class: "mr-teams" }, [
      el("div", { class: "mr-team" }, [crest(f.homeTeamName, 24), el("span", { class: "name", text: f.homeTeamName })]),
      el("div", { class: "mr-team" }, [crest(f.awayTeamName, 24), el("span", { class: "name", text: f.awayTeamName })]),
    ]),
    el("div", { class: "mr-cells" }, cells),
    betBtn,
  ]);
  row.addEventListener("click", () => {
    location.hash = matchHref;
  });
  return row;
}

/* ---------- #/match/:league/:homeId/:awayId ---------- */

async function renderMatch(root, league, homeId, awayId) {
  root.replaceChildren(loading());
  try {
    const [pred, model, homeForm, awayForm] = await Promise.all([
      api(`/api/predict?league=${encodeURIComponent(league)}&home=${homeId}&away=${awayId}`),
      api(`/api/model/${encodeURIComponent(league)}`),
      api(`/api/form?league=${encodeURIComponent(league)}&team=${homeId}`),
      api(`/api/form?league=${encodeURIComponent(league)}&team=${awayId}`),
    ]);
    const m = pred.markets;
    root.replaceChildren();
    root.append(
      el("h2", { class: "screen-title" }, [
        el("div", { class: "fx-team", style: "margin-bottom:6px" }, [crest(pred.home.name, 34), el("span", { text: pred.home.name })]),
        el("div", { class: "fx-team" }, [crest(pred.away.name, 34), el("span", { text: pred.away.name })]),
      ]),
    );

    const ratingsOf = (id) => model.ratings.find((r) => r.teamId === id);
    const ratingRow = (team) => {
      const r = ratingsOf(team.id);
      return r ? el("p", { class: "note", text: `${team.name}: attack ${num(r.attack)}, defence ${num(r.defence)}, rating ${num(r.rating)}` }) : null;
    };

    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Match result" }),
        segBar(m.homeWin, m.draw, m.awayWin),
        el("p", { class: "note", text: `Expected goals: ${pred.home.name} ${num(pred.expectedHomeGoals)} – ${pred.away.name} ${num(pred.expectedAwayGoals)}` }),
        ratingRow(pred.home),
        ratingRow(pred.away),
      ]),
    );

    const formPanel = (team, form, venueSplit) =>
      el("div", { style: "margin-bottom:10px" }, [
        el("div", { class: "fx-team", style: "margin-bottom:6px" }, [
          crest(team.name, 24),
          el("span", { style: "font-weight:600", text: team.name }),
          formDots(form.recent),
        ]),
        el("p", { class: "note", text: `last ${form.overall.played}: ${form.overall.gf} scored / ${form.overall.ga} conceded · ${venueSplit.label} (last ${venueSplit.played}): ${venueSplit.gf} / ${venueSplit.ga}` }),
      ]);
    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Form" }),
        formPanel(pred.home, homeForm, { label: "at home", ...homeForm.home }),
        formPanel(pred.away, awayForm, { label: "away", ...awayForm.away }),
      ]),
    );

    const cg = (label, cell) => el("div", { class: "cg-item" }, [el("span", { class: "cg-label", text: label }), cell]);
    const dc = m.doubleChance;
    const dnb = m.drawNoBet;
    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Double chance & BTTS" }),
        el("div", { class: "cell-grid" }, [
          cg("1X", pcell(pct0(dc.homeOrDraw), dc.homeOrDraw)),
          cg("X2", pcell(pct0(dc.awayOrDraw), dc.awayOrDraw)),
          cg("12", pcell(pct0(dc.homeOrAway), dc.homeOrAway)),
          cg("BTTS yes", pcell(pct0(m.bttsYes), m.bttsYes)),
          cg("BTTS no", pcell(pct0(m.bttsNo), m.bttsNo)),
        ]),
        el("p", { class: "note", style: "margin-top:10px", text: `Draw no bet: ${pred.home.name} ${pct(dnb.home)} (fair ${num(dnb.fairOddsHome)}) · ${pred.away.name} ${pct(dnb.away)} (fair ${num(dnb.fairOddsAway)})` }),
      ]),
    );

    const ouGrid = (lines) =>
      el(
        "div",
        { class: "cell-grid" },
        lines.flatMap((l) => [
          cg(`O ${l.line}`, pcell(pct0(l.over), l.over)),
          cg(`U ${l.line}`, pcell(pct0(l.under), l.under)),
        ]),
      );
    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Totals" }),
        ouGrid(m.overUnder),
        el("h4", { class: "section-title", style: "margin-top:14px", text: `${pred.home.name} totals` }),
        ouGrid(m.teamTotals.home),
        el("h4", { class: "section-title", style: "margin-top:14px", text: `${pred.away.name} totals` }),
        ouGrid(m.teamTotals.away),
      ]),
    );

    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Asian handicap" }),
        ahTable(m.asianHandicap),
        el("h3", { class: "section-title", style: "margin-top:14px", text: "European handicap" }),
        ehTable(m.europeanHandicap),
      ]),
    );

    if (pred.cards) {
      const c = pred.cards;
      root.append(
        el("div", { class: "card" }, [
          el("h3", { class: "section-title", text: "Cards (yellow)" }),
          el("p", { class: "note", text: `Expected: ${pred.home.name} ${num(c.expectedHomeYellow)} – ${pred.away.name} ${num(c.expectedAwayYellow)} (total ${num(c.expectedTotalYellow)})` }),
          ouGrid(c.totalOverUnder),
        ]),
      );
    }

    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: "Correct score" }),
        el("div", { class: "meta-row" }, m.topScores.map((s) => el("span", { class: "chip static", text: `${s.home}–${s.away} ${pct(s.prob)}` }))),
        el("p", { class: "note", text: `Model fitted ${new Date(pred.model.fittedAt).toLocaleString()} on ${pred.model.matchCount} matches (${pred.model.fromCache ? "cached" : "fresh"}).` }),
      ]),
    );
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
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
        el("td", {}, h ? [pcell(pct0(h.pWin), h.pWin)] : ["–"]),
        el("td", { class: "num", text: h && h.fairOdds ? num(h.fairOdds) : "–" }),
        el("td", {}, a ? [pcell(pct0(a.pWin), a.pWin)] : ["–"]),
        el("td", { class: "num", text: a && a.fairOdds ? num(a.fairOdds) : "–" }),
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
        el("td", {}, [pcell(pct0(l.pHome), l.pHome, 0.33)]),
        el("td", {}, [pcell(pct0(l.pDraw), l.pDraw, 0.33)]),
        el("td", {}, [pcell(pct0(l.pAway), l.pAway, 0.33)]),
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
    // Form dots per visible team, fetched in parallel and cached per session.
    const forms = new Map();
    await Promise.all(
      data.ratings.map(async (r) => {
        try {
          forms.set(r.teamId, await getForm(selected, r.teamId));
        } catch {
          forms.set(r.teamId, null);
        }
      }),
    );
    root.append(
      el("div", { class: "card" }, [
        el("h3", { class: "section-title", text: `${selected} ratings` }),
        el("p", { class: "note", text: `Home advantage ${num(data.homeAdv, 3)}, rho ${num(data.rho, 3)}. Fitted on ${data.model.matchCount} matches.` }),
        el("table", { class: "market" }, [
          el("tr", {}, [el("th", { text: "Team" }), el("th", { text: "Form" }), el("th", { text: "Attack" }), el("th", { text: "Defence" }), el("th", { text: "Rating" })]),
          data.ratings.map((r) => {
            const form = forms.get(r.teamId);
            return el("tr", {}, [
              el("td", {}, [el("div", { class: "fx-team" }, [crest(r.name, 26), el("span", { text: r.name })])]),
              el("td", {}, form && form.recent.length > 0 ? [formDots(form.recent)] : ["–"]),
              el("td", { class: "num", text: num(r.attack, 3) }),
              el("td", { class: "num", text: num(r.defence, 3) }),
              el("td", { class: "num", text: num(r.rating, 3) }),
            ]);
          }),
        ]),
      ]),
    );
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

/* ---------- #/accuracy (Record: live track record + backtest) ---------- */

function gradeCell(label, hit) {
  const cell = el("span", {
    class: "pcell",
    style: `background:${hit ? "hsl(130 60% 30% / 0.95)" : "hsl(4 72% 42% / 0.9)"}`,
  });
  cell.append(document.createTextNode(label));
  cell.insertAdjacentHTML("beforeend", hit ? ICONS.check : ICONS.x);
  return cell;
}

async function renderAccuracy(root, params) {
  root.replaceChildren(el("h2", { class: "screen-title", text: "Record" }));
  const track = el("div", {});
  root.append(track);
  await renderTrackRecord(track, params);
  renderBacktestSection(root);
}

async function renderTrackRecord(root, params) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.finished > 0);
    const selected = params.get("league") && pool.some((l) => l.key === params.get("league")) ? params.get("league") : pool[0]?.key;
    const days = [7, 14, 30].includes(Number(params.get("days"))) ? Number(params.get("days")) : 14;
    const repick = (league, d) => {
      const p = new URLSearchParams();
      if (league) p.set("league", league);
      if (d) p.set("days", String(d));
      renderTrackRecord(root, p);
    };
    const dayChips = el(
      "div",
      { class: "chips" },
      [7, 14, 30].map((d) => el("button", { class: `chip${d === days ? " active" : ""}`, text: `${d} days`, onclick: () => repick(selected, d) })),
    );
    const content = el("div", {});
    root.replaceChildren(
      el("h3", { class: "section-title", text: "Live track record" }),
      leagueChips(selected, (key) => repick(key, days), pool),
      dayChips,
      content,
    );
    if (!selected) {
      content.append(el("p", { class: "note", text: "No finished matches yet." }));
      return;
    }
    const data = await api(`/api/results?league=${encodeURIComponent(selected)}&days=${days}`);
    if (data.summary === null) {
      content.append(
        el("div", { class: "card" }, [
          el("p", { class: "note", text: data.note ?? "No graded matches in this window yet — snapshots accumulate from the daily cron." }),
        ]),
      );
      return;
    }
    const s = data.summary;
    content.append(
      el("div", { class: "chips" }, [
        el("span", { class: "chip static", text: `1X2 ${pct0(s.outcomeHitRate)}` }),
        el("span", { class: "chip static", text: `logLoss ${num(s.meanLogLoss)}` }),
        el("span", { class: "chip static", text: `O2.5 ${pct0(s.over25HitRate)}` }),
        el("span", { class: "chip static", text: `BTTS ${pct0(s.bttsHitRate)}` }),
        el("span", { class: "chip static", text: `${s.count} graded` }),
      ]),
    );
    if (data.matches.length === 0) {
      content.append(el("p", { class: "note", text: "Snapshots exist but none of their matches have finished in this window yet." }));
      return;
    }
    const byDay = new Map();
    for (const m of data.matches) {
      const key = localDayKey(new Date(m.utcDate));
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(m);
    }
    for (const dayMatches of byDay.values()) {
      content.append(el("div", { class: "date-header", text: dayHeader(dayMatches[0].utcDate) }));
      for (const m of dayMatches) content.append(resultRow(m));
    }
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

function resultRow(m) {
  const snap = m.snapshot;
  const g = m.grade;
  const sideLabel = { home: "1", draw: "X", away: "2" }[g.predicted];
  const sideProb = g.predicted === "home" ? snap.homeWin : g.predicted === "draw" ? snap.draw : snap.awayWin;
  return el("div", { class: "match-row", style: "cursor:default" }, [
    el("div", { class: "mr-teams" }, [
      el("div", { class: "mr-team" }, [crest(m.homeTeam, 24), el("span", { class: "name", text: m.homeTeam })]),
      el("div", { class: "mr-team" }, [crest(m.awayTeam, 24), el("span", { class: "name", text: m.awayTeam })]),
    ]),
    el("span", { class: "num", style: "font-size:16px;font-weight:700", text: `${m.homeGoals}–${m.awayGoals}` }),
    el("div", { class: "mr-cells" }, [
      gradeCell(`${sideLabel} ${pct0(sideProb)}`, g.outcomeHit),
      gradeCell(`O2.5 ${pct0(snap.over25)}`, g.over25Hit),
      gradeCell(`BTTS ${pct0(snap.bttsYes)}`, g.bttsHit),
      gradeCell(`${snap.topScore}`, g.topScoreHit),
    ]),
  ]);
}

async function renderBacktestSection(root) {
  const section = el("div", {});
  section.append(el("h3", { class: "section-title", style: "margin-top:20px", text: "Historical backtest" }));
  root.append(section);
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.finished >= 150);
    section.append(el("p", { class: "note", text: "Walk-forward backtest per league (loads on demand — it is CPU-heavy). Uses only data that existed at each prediction time." }));
    if (pool.length === 0) {
      section.append(el("p", { class: "note", text: "No league with 150+ finished matches yet." }));
      return;
    }
    for (const l of pool) {
      const btn = el("button", { class: "btn", text: "Load backtest" });
      const card = el("div", { class: "card" }, [el("h3", { class: "section-title", text: l.name }), el("div", { class: "meta-row" }, [btn])]);
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        btn.textContent = "Loading…";
        try {
          const bt = await api(`/api/backtest?league=${encodeURIComponent(l.key)}`);
          card.replaceChildren(el("h3", { class: "section-title", text: l.name }), backtestView(bt));
        } catch (err) {
          card.append(errorBox(err));
          btn.disabled = false;
          btn.textContent = "Load backtest";
        }
      });
      section.append(card);
    }
  } catch (err) {
    section.append(errorBox(err));
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
          el("td", { class: "num", text: num(bt.model[k], 4) }),
          el("td", { class: "num", text: num(bt.baseline[k], 4) }),
          el("td", { class: "num", text: num(bt.uniform[k], 4) }),
          el("td", { class: "small muted", text: beats(k) }),
        ]),
      ),
    ]),
    el("h4", { class: "section-title", style: "margin-top:14px", text: "Home-win calibration (deciles)" }),
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
    `<line x1="${pad}" y1="${H - pad}" x2="${W - 8}" y2="${H - pad}" stroke="#1e2b45"/>` +
    `<line x1="${pad}" y1="${H - pad}" x2="${pad}" y2="12" stroke="#1e2b45"/>` +
    `<line x1="${inner(0)}" y1="${innerY(0)}" x2="${inner(1)}" y2="${innerY(1)}" stroke="#475569" stroke-dasharray="4 4"/>` +
    `<text x="${W - 8}" y="${H - 6}" fill="#8b98b4" font-size="10" text-anchor="end">predicted</text>` +
    `<text x="6" y="16" fill="#8b98b4" font-size="10">actual</text>` +
    (points ? `<polyline points="${points}" fill="none" stroke="#22c55e" stroke-width="1.5"/>` : "") +
    circles +
    `</svg>`;
  return holder;
}

/* ---------- #/value ---------- */

async function renderValue(root, params) {
  root.replaceChildren(loading());
  try {
    const leagues = await loadLeagues();
    const pool = leagues.filter((l) => l.matches.scheduled > 0);
    const selected = params.get("league") && pool.some((l) => l.key === params.get("league")) ? params.get("league") : pool[0]?.key;
    const quotaBadge = el("span", { class: "note", text: "odds API quota: …" });
    const syncMsg = el("p", { class: "note" });
    const list = el("div", {});
    const refreshBtn = el("button", {
      class: "btn btn-small",
      text: "Refresh odds",
      onclick: async () => {
        if (!state.key) {
          renderKeyPrompt(
            root,
            "Viewing is open — but refreshing spends your the-odds-api quota, so it needs the admin key.",
            () => renderValue(root, params),
          );
          return;
        }
        refreshBtn.disabled = true;
        syncMsg.textContent = "Syncing odds (h2h + totals)…";
        try {
          const r = await api(`/api/sync-odds?league=${encodeURIComponent(selected)}&markets=h2h,totals`, { auth: true, method: "POST" });
          syncMsg.textContent =
            `Synced ${r.events} events (${r.matched} matched, ${r.snapshots} snapshots).` +
            (r.unmatched.length > 0 ? ` Unmatched: ${r.unmatched.join("; ")}` : "");
          if (r.quotaRemaining != null) quotaBadge.textContent = `odds API quota: ${r.quotaRemaining} left`;
          await loadValueList(list, selected, quotaBadge);
        } catch (err) {
          syncMsg.textContent = err.message;
          if (err.status === 401) renderKeyPrompt(root, "Key rejected — check it and try again.", () => renderValue(root, params));
        } finally {
          refreshBtn.disabled = false;
        }
      },
    });
    root.replaceChildren(
      leagueChips(selected, (key) => renderValue(root, new URLSearchParams(`league=${key}`)), pool),
      el("div", { class: "meta-row" }, [refreshBtn, quotaBadge]),
      syncMsg,
      list,
    );
    if (selected) await loadValueList(list, selected, quotaBadge);
  } catch (err) {
    root.replaceChildren(errorBox(err));
  }
}

async function loadValueList(list, league, quotaBadge) {
  list.replaceChildren(loading());
  try {
    const data = await api(`/api/value?league=${encodeURIComponent(league)}`);
    if (data.quotaRemaining != null) quotaBadge.textContent = `odds API quota: ${data.quotaRemaining} left`;
    if (data.count === 0) {
      list.replaceChildren(
        el("div", { class: "card" }, [
          el("h3", { class: "section-title", text: "Nothing flagged" }),
          el("p", { class: "note", text: "No +EV spots right now — most days have none. The model only flags when its probability beats the best available price by 4%+." }),
        ]),
      );
      return;
    }
    list.replaceChildren(
      ...data.opportunities.map((r) => {
        const kickoff = new Date(r.utcDate).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
        const marketLabel = r.market === "h2h" ? "1X2" : `O/U ${r.line}`;
        return el("div", { class: "match-row", style: "cursor:default" }, [
          el("div", { class: "mr-teams" }, [
            el("div", { style: "font-weight:600", text: `${r.homeTeam} vs ${r.awayTeam}` }),
            el("div", { class: "small muted", text: `${kickoff} · ${marketLabel} · ${r.selection}` }),
            el("div", { class: "small muted num", text: `best ${num(r.bestOdds)} · fair ${num(r.fairOdds)} · consensus ${num(r.consensusOdds)} · ${r.bookmakers} books` }),
          ]),
          pcell(pct0(r.modelProb), r.modelProb, r.market === "h2h" ? 0.33 : 0.5),
          el("span", { class: "ev-pill", text: `+${(r.evPct * 100).toFixed(1)}% EV` }),
          (() => {
            const btn = el("button", { class: "icon-btn", title: "Log this bet" });
            btn.innerHTML = plusIcon;
            btn.addEventListener("click", () => {
              state.betPrefill = {
                league,
                matchId: r.matchId,
                matchLabel: `${r.homeTeam} vs ${r.awayTeam}`,
                market: r.market === "h2h" ? "1X2" : "overUnder",
                selection: r.selection,
                line: r.line,
                odds: r.bestOdds,
              };
              location.hash = "#/bets";
            });
            return btn;
          })(),
        ]);
      }),
    );
  } catch (err) {
    if (err.data && err.data.code === "no_odds_synced") {
      list.replaceChildren(
        el("div", { class: "card" }, [
          el("h3", { class: "section-title", text: "No odds synced yet" }),
          el("p", { class: "note", text: "Odds for this league haven't been fetched. Hit “Refresh odds” above to pull the latest EU bookmaker prices (uses 2 quota units)." }),
        ]),
      );
    } else {
      list.replaceChildren(errorBox(err));
    }
  }
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

function renderKeyPrompt(root, note, onSaved) {
  const input = el("input", { type: "password", placeholder: "Admin key (SYNC_KEY)", autocomplete: "off" });
  const save = () => {
    const v = input.value.trim();
    if (!v) return;
    state.key = v;
    localStorage.setItem("sofabet_key", v);
    (onSaved || (() => renderBets(document.getElementById("app"))))();
  };
  root.replaceChildren(
    el("div", { class: "card" }, [
      el("h3", { class: "section-title", text: "This area is private" }),
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
  // "+ bet" / "log bet" shortcuts prefill the form from a fixture or value row.
  if (prefill?.market && MARKET_SELECTIONS[prefill.market]) market.value = prefill.market;
  syncSelections();
  if (prefill?.selection) selection.value = prefill.selection;
  if (prefill?.line != null) line.value = String(prefill.line);
  if (prefill?.odds != null) odds.value = String(prefill.odds);

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
    el("h3", { class: "section-title", text: "Add bet" }),
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
      el("div", {}, [el("h3", { class: "section-title", text: "Auto-settle" }), el("p", { class: "note", text: "Settles open bets linked to a FINISHED match (1X2, doubleChance, overUnder, btts)." })]),
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
    el("h3", { class: "section-title", text: `Open bets (${bets.length})` }),
    bets.length === 0 ? el("p", { class: "note", text: "Nothing open." }) : null,
    bets.map((b) =>
      el("div", { class: "row-between", style: "padding:8px 0;border-bottom:1px solid var(--line)" }, [
        el("div", {}, [
          el("div", { style: "font-weight:600", text: `${b.match_label}` }),
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
    el("h3", { class: "section-title", text: `Settled (${bets.length})` }),
    bets.length === 0 ? el("p", { class: "note", text: "No history yet." }) : null,
    bets.slice(0, 50).map((b) =>
      el("div", { class: "row-between", style: "padding:8px 0;border-bottom:1px solid var(--line)" }, [
        el("div", {}, [
          el("div", { text: b.match_label }),
          el("div", { class: "small muted", text: `${b.bookmaker} · ${b.market} · ${b.selection}${b.line != null ? ` ${b.line}` : ""} @ ${num(b.odds)} × ${num(b.stake)} · ${b.status}` }),
        ]),
        el("span", { class: `num ${b.profit > 0 ? "positive" : b.profit < 0 ? "negative" : "muted"}`, text: money(b.profit) }),
      ]),
    ),
  ]);
}

function settingsCard(root) {
  return el("div", { class: "card" }, [
    el("h3", { class: "section-title", text: "Settings" }),
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
  for (const a of document.querySelectorAll("[data-nav]")) {
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
  } else if (path === "#/value") {
    setActiveNav("value");
    renderValue(root, params);
  } else if (path === "#/accuracy") {
    setActiveNav("accuracy");
    renderAccuracy(root, params);
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
