/* Tableau de bord du catalogue eSIM.
 * Toutes les statistiques sont calculées en Python (esim_dashboard/stats.py) :
 * ce script les affiche, les filtre et gère la navigation, sans recalcul métier.
 * Les textes issus des CSV sont insérés avec textContent, jamais en HTML. */
(() => {
  "use strict";

  const payload = JSON.parse(document.getElementById("payload").textContent);
  const { stats, meta } = payload;
  const overall = stats.overview.kpis;

  /* ---------- Formatage fr-FR ---------- */

  const formatters = new Map();
  const nf = (options) => {
    const key = JSON.stringify(options);
    if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat("fr-FR", options));
    return formatters.get(key);
  };
  // Une valeur absente s'affiche « – » plutôt que « 0 ».
  const safe = (format) => (v, ...rest) => (v == null || Number.isNaN(v) ? "–" : format(v, ...rest));
  const int = safe((v) => nf({ maximumFractionDigits: 0 }).format(v));
  const num = safe((v, d = 1) => nf({ minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
  const eur = safe((v) => nf({ style: "currency", currency: "EUR" }).format(v));
  const pct = safe((v, d = 1) => nf({ style: "percent", minimumFractionDigits: d, maximumFractionDigits: d }).format(v));
  const signedPct = safe((v, d = 1) => nf({ style: "percent", minimumFractionDigits: d, maximumFractionDigits: d, signDisplay: "exceptZero" }).format(v));
  const gb = safe((v) => `${nf({ maximumFractionDigits: 1 }).format(v)} Go`);
  const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });

  /* ---------- DOM ---------- */

  function h(tag, props = {}, ...children) {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === "class") el.className = value;
      else if (key === "text") el.textContent = value;
      else if (key === "style") Object.assign(el.style, value);
      else if (key === "vars") for (const [name, v] of Object.entries(value)) el.style.setProperty(name, v);
      else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
      else el.setAttribute(key, value === true ? "" : value);
    }
    for (const child of children.flat(Infinity)) {
      if (child == null || child === false) continue;
      el.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return el;
  }
  const byId = (id) => document.getElementById(id);
  const setKpi = (name, ...content) => {
    const el = document.querySelector(`[data-kpi="${name}"]`);
    if (el) el.replaceChildren(...content);
  };

  /* ---------- Infobulle (souris et clavier) ---------- */

  const tooltip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
  document.body.append(tooltip);

  function placeTooltip(x, y) {
    const { offsetWidth: w, offsetHeight: ht } = tooltip;
    const left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
    const top = y - ht - 12 < 8 ? y + 18 : y - ht - 12;
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function tip(el, value, label, focusable = true) {
    el.dataset.tip = "";
    if (focusable) {
      el.tabIndex = 0;
      el.setAttribute("aria-label", `${label} : ${value}`);
    }
    const show = (x, y) => {
      tooltip.replaceChildren(h("strong", { text: value }), h("span", { text: label }));
      tooltip.hidden = false;
      placeTooltip(x, y);
    };
    el.addEventListener("pointermove", (e) => show(e.clientX, e.clientY));
    el.addEventListener("pointerleave", () => (tooltip.hidden = true));
    el.addEventListener("focus", () => {
      const r = el.getBoundingClientRect();
      show(r.left + r.width / 2, r.top);
    });
    el.addEventListener("blur", () => (tooltip.hidden = true));
    return el;
  }
  window.addEventListener("scroll", () => (tooltip.hidden = true), { passive: true });

  /* ---------- Graphiques ---------- */

  // Barres horizontales triées ; une ligne peut servir de filtre (clic ou Entrée).
  function hbars(container, rows, { selected = "", onSelect = null, compact = false } = {}) {
    const max = Math.max(...rows.map((r) => r.value || 0)) || 1;
    const items = rows.map((r) => {
      const isSelected = selected && r.key === selected;
      const bar = h("span", { class: "hbar__bar", vars: { "--w": String((r.value || 0) / max) } });
      const row = h(
        "li",
        { class: `hbar${onSelect ? " hbar--button" : ""}${isSelected ? " is-selected" : ""}` },
        h("span", { class: "hbar__label", title: r.label, text: r.label }),
        h("span", { class: "hbar__track" }, tip(bar, r.tipValue, r.label, !onSelect)),
        h("span", { class: "hbar__value", text: r.valueText }),
        compact ? null : h("span", { class: "hbar__share", text: r.shareText ?? "" }),
      );
      if (onSelect) {
        row.tabIndex = 0;
        row.setAttribute("role", "button");
        row.setAttribute("aria-pressed", String(Boolean(isSelected)));
        row.setAttribute("aria-label", `${r.label} : ${r.tipValue}. ${isSelected ? "Retirer le filtre" : "Filtrer sur ce fournisseur"}`);
        row.addEventListener("click", () => onSelect(r.key));
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(r.key);
          }
        });
      }
      return row;
    });
    container.replaceChildren(h("ul", { class: `hbars${compact ? " hbars--compact" : ""}${selected ? " has-selection" : ""}` }, items));
  }

  function niceTicks(max, count = 4) {
    const raw = max / count || 1;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v < max + step; v += step) ticks.push(v);
    return ticks;
  }

  // Colonnes : histogramme (axe Y, seuil) ou colonnes étiquetées (valeur au sommet).
  function columns(container, items, { height = 180, yAxis = false, xAxis = null, threshold = null, label = "" } = {}) {
    const max = Math.max(...items.map((d) => d.value || 0), 0);
    const ticks = yAxis ? niceTicks(max) : null;
    const top = ticks ? ticks[ticks.length - 1] : max * 1.18 || 1;
    const plot = h(
      "div",
      { class: "cols__plot" },
      ticks ? ticks.slice(1).map((t) => h("span", { class: "cols__grid", style: { bottom: `${(t / top) * 100}%` } })) : null,
      h(
        "div",
        { class: "cols__bars" },
        items.map((d) => {
          const bar = h("span", { class: "cols__bar", style: { height: `${((d.value || 0) / top) * 100}%` } });
          return h(
            "div",
            { class: `cols__col${d.tone ? ` is-${d.tone}` : ""}` },
            d.topText ? h("span", { class: "cols__top", text: d.topText }) : null,
            d.value ? tip(bar, d.tipValue, d.tipLabel) : bar,
          );
        }),
      ),
      threshold ? h("span", { class: "threshold", style: { left: threshold.left } }, h("span", { text: threshold.label })) : null,
    );
    const y = ticks
      ? h("div", { class: "cols__y", "aria-hidden": "true" }, ticks.map((t) => h("span", { style: { bottom: `${(t / top) * 100}%` }, text: int(t) })))
      : null;
    const x = xAxis
      ? h("div", { class: "cols__x cols__x--axis", "aria-hidden": "true" }, xAxis.map((a) => h("span", { style: { left: a.left }, text: a.text })))
      : h("div", { class: "cols__x" }, items.map((d) => h("span", { title: d.label }, d.label, d.sublabel ? h("small", { text: d.sublabel }) : null)));
    container.replaceChildren(h("div", { class: `cols${yAxis ? "" : " cols--bare"}`, vars: { "--plot-h": `${height}px` }, role: "img", "aria-label": label }, y, plot, x));
  }

  // Barres empilées à 100 %, libellées dans les segments assez larges.
  function stacks(container, groups) {
    container.replaceChildren(
      h(
        "div",
        { class: "stacks" },
        groups.map((g) => {
          const total = g.parts.reduce((s, p) => s + p.count, 0) || 1;
          return h(
            "div",
            { class: "stack-row" },
            h("p", { class: "stack-row__label", text: g.label }),
            h(
              "div",
              { class: "stack-row__bar" },
              g.parts
                .filter((p) => p.count > 0)
                .map((p) => {
                  const share = p.count / total;
                  const seg = h(
                    "span",
                    { class: `stack-row__seg${p.light ? " is-light" : ""}`, style: { flexGrow: String(p.count), flexBasis: "0", background: p.color } },
                    share >= 0.13 ? [h("b", { text: p.label }), pct(share, 0)] : null,
                  );
                  return tip(seg, `${pct(share)} · ${int(p.count)} cartes`, `${g.label} : ${p.label}`);
                }),
            ),
          );
        }),
      ),
    );
  }

  // Carte de chaleur : rampe séquentielle d'une seule teinte, échelle logarithmique.
  function heatmap(container, matrix) {
    const values = matrix.values.flat().filter((v) => v != null);
    if (!values.length) {
      container.replaceChildren(h("p", { class: "empty", text: "Pas de données pour ce filtre." }));
      return;
    }
    const lo = Math.log(Math.min(...values));
    const hi = Math.log(Math.max(...values));
    const step = (v) => 1 + Math.min(6, Math.floor(((Math.log(v) - lo) / (hi - lo || 1)) * 7));
    const table = h(
      "table",
      { class: "heatmap" },
      h("caption", { class: "sr-only", text: "Prix médian en euros par volume (lignes) et par durée (colonnes)" }),
      h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "" }), matrix.columns.map((c) => h("th", { scope: "col", text: c })))),
      h(
        "tbody",
        {},
        matrix.rows.map((row, r) =>
          h(
            "tr",
            {},
            h("th", { scope: "row", text: row }),
            matrix.values[r].map((v, c) =>
              v == null ? h("td", { text: "–" }) : tip(h("td", { class: `heat-${step(v)}`, text: eur(v) }), eur(v), `${row}, ${matrix.columns[c]}`),
            ),
          ),
        ),
      ),
    );
    const scale = h(
      "div",
      { class: "scale", "aria-hidden": "true" },
      h("span", { text: "Moins cher" }),
      h("span", { class: "scale__ramp" }, [1, 2, 3, 4, 5, 6, 7].map((i) => h("span", { style: { background: `var(--heat-${i})` } }))),
      h("span", { text: "Plus cher" }),
    );
    container.replaceChildren(h("div", { class: "table-wrap" }, table), scale);
  }

  // Points autour de zéro : écart au prix médian du marché (domaine minimal ±5 % pour ne pas grossir des écarts infimes).
  function dotplot(container, rows, { selected = "" } = {}) {
    const domain = Math.max(0.05, ...rows.map((r) => Math.abs(r.value || 0)));
    const pos = (v) => 50 + (v / domain) * 50;
    const items = rows.map((r) => {
      const v = r.value || 0;
      const at = pos(v);
      return h(
        "li",
        { class: `dot-row ${v < 0 ? "is-below" : "is-above"}${selected && r.key === selected ? " is-selected" : ""}` },
        h("span", { class: "hbar__label", title: r.label, text: r.label }),
        h(
          "span",
          { class: "dot-row__track" },
          h("span", { class: "dot-row__zero" }),
          h("span", { class: "dot-row__stem", style: { left: `${Math.min(50, at)}%`, width: `${Math.abs(at - 50)}%` } }),
          tip(h("span", { class: "dot-row__dot", style: { left: `${at}%` } }), signedPct(v, 2), r.label),
        ),
        h("span", { class: "hbar__value", text: signedPct(v) }),
      );
    });
    container.replaceChildren(
      h("ul", { class: "dots" }, items),
      h(
        "div",
        { class: "dots__axis", "aria-hidden": "true" },
        h("span"),
        h("span", {}, h("span", { text: `${signedPct(-domain, 0)} · moins cher` }), h("span", { text: "0" }), h("span", { text: `plus cher · ${signedPct(domain, 0)}` })),
        h("span"),
      ),
    );
  }

  // Tableau triable : la version détaillée et accessible des graphiques.
  function dataTable(columns, rows, { caption, sortable = false, initialSort = null } = {}) {
    let sortState = initialSort;
    const tbody = h("tbody");
    const headCells = columns.map((col, i) => {
      const th = h("th", { scope: "col", class: col.num ? "is-num" : null });
      if (sortable && col.sort !== false) th.append(h("button", { type: "button", class: "sort", text: col.label, onclick: () => sortBy(i) }));
      else th.textContent = col.label;
      return th;
    });

    function render() {
      const sorted = [...rows];
      if (sortState) {
        const { index, dir } = sortState;
        const key = columns[index].key ?? ((r) => r[index]);
        sorted.sort((a, b) => {
          const va = key(a);
          const vb = key(b);
          const cmp = typeof va === "number" && typeof vb === "number" ? va - vb : collator.compare(String(va ?? ""), String(vb ?? ""));
          return dir === "ascending" ? cmp : -cmp;
        });
        headCells.forEach((th, i) => (i === index ? th.setAttribute("aria-sort", dir) : th.removeAttribute("aria-sort")));
      }
      tbody.replaceChildren(
        ...sorted.map((r) =>
          h(
            "tr",
            {},
            columns.map((col, i) => {
              const content = col.render ? col.render(r) : col.format ? col.format(r[i]) : r[i];
              return h(i === 0 ? "th" : "td", { scope: i === 0 ? "row" : null, class: col.num ? "is-num" : null }, content ?? "–");
            }),
          ),
        ),
      );
    }

    function sortBy(index) {
      const dir = sortState && sortState.index === index && sortState.dir === "descending" ? "ascending" : "descending";
      sortState = { index, dir };
      render();
    }

    render();
    return h("div", { class: "table-wrap" }, h("table", { class: "table" }, caption ? h("caption", { text: caption }) : null, h("thead", {}, h("tr", {}, headCells)), tbody));
  }

  const cellBar = (value, max, text) =>
    h(
      "span",
      { class: "cell-bar" },
      h("span", { text }),
      h("span", { class: "cell-bar__track", "aria-hidden": "true" }, h("span", { class: "cell-bar__fill", style: { width: `${max ? ((value || 0) / max) * 100 : 0}%` } })),
    );

  const kpi = (label, value, ...notes) =>
    h("div", { class: "kpi", role: "listitem" }, h("p", { class: "kpi__label", text: label }), h("p", { class: "kpi__value", text: value }), notes.filter(Boolean).map((n) => h("p", { class: "kpi__note", text: n })));

  /* ---------- État : page affichée et filtre fournisseur ---------- */

  const PAGES = ["vue-ensemble", "prix", "fournisseurs", "destinations", "comparateur", "qualite"];
  const FILTERED_PAGES = new Set(["vue-ensemble", "prix"]);
  const providerNames = Object.keys(stats.by_provider).sort(collator.compare);
  const state = { provider: "", page: "vue-ensemble" };
  const rendered = new Set();
  const profile = () => (state.provider ? stats.by_provider[state.provider] : stats.overview);

  function fillHeadlines() {
    const p = profile();
    document.querySelectorAll("[data-headline]").forEach((el) => (el.textContent = stats.headlines[el.dataset.headline] ?? ""));
    document.querySelectorAll("[data-headline-profile]").forEach((el) => (el.textContent = p.headlines[el.dataset.headlineProfile] ?? ""));
  }

  function setProvider(name) {
    state.provider = name && stats.by_provider[name] ? name : "";
    const select = byId("provider-filter");
    select.value = state.provider;
    select.classList.toggle("is-active", Boolean(state.provider));
    const url = new URL(window.location.href);
    if (state.provider) url.searchParams.set("fournisseur", state.provider);
    else url.searchParams.delete("fournisseur");
    history.replaceState(null, "", url);
    FILTERED_PAGES.forEach((page) => rendered.delete(page));
    renderPage(state.page);
  }

  const toggleProvider = (name) => setProvider(state.provider === name ? "" : name);

  function showPage(id) {
    state.page = PAGES.includes(id) ? id : "vue-ensemble";
    for (const page of PAGES) byId(page).hidden = page !== state.page;
    document.querySelectorAll(".tabs a").forEach((a) => {
      if (a.dataset.tab === state.page) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    });
    document.body.dataset.page = state.page;
    const tab = document.querySelector(`.tabs a[data-tab="${state.page}"]`);
    document.title = `${tab ? tab.textContent : "Tableau de bord"} · Catalogue eSIM`;
    renderPage(state.page);
  }

  function renderPage(id) {
    if (rendered.has(id)) return;
    ({ "vue-ensemble": renderOverview, prix: renderPrices, fournisseurs: renderProviders, destinations: renderDestinations, comparateur: renderExplorer, qualite: renderQuality })[id]();
    rendered.add(id);
    fillHeadlines();
  }

  /* ---------- 1. Vue d'ensemble ---------- */

  function renderOverview() {
    const p = profile();
    const k = p.kpis;

    byId("scope-label").replaceChildren(
      ...(state.provider
        ? [
            "Filtré sur ",
            h("mark", { text: state.provider }),
            ` : ${pct(k.products / overall.products)} du catalogue, ${k.destinations} destinations. `,
            h("button", { type: "button", class: "link-button", text: "Retirer le filtre", onclick: () => setProvider("") }),
          ]
        : [`Tout le catalogue : ${int(k.providers)} fournisseurs, ${int(k.destinations)} destinations.`]),
    );

    setKpi("products", int(k.products));
    setKpi("products-note", state.provider ? `${pct(k.products / overall.products)} du catalogue` : `${k.providers} fournisseurs · ${k.destinations} destinations`);
    setKpi("over", int(k.over_threshold));
    setKpi("over-note", `${pct(k.over_threshold_share)} des cartes · prix strictement supérieur à 100 €`);
    document.querySelector('[data-kpi="over"]').title = p.over_threshold_text;
    setKpi("range", `${eur(k.price_min)} – ${eur(k.price_max)}`);
    setKpi("range-note", "La moitié des cartes entre ", h("strong", { text: eur(k.price_q1) }), " et ", h("strong", { text: eur(k.price_q3) }), ` · médiane ${eur(k.price_median)}`);
    priceRange(byId("price-range"), k);
    setKpi("data", gb(k.data_mean_gb));
    setKpi("data-note", `Médiane ${gb(k.data_median_gb)} · hors ${int(k.unlimited_count)} forfaits illimités (${pct(k.unlimited_share, 0)})`);
    setKpi("price", eur(k.price_mean));
    setKpi("price-note", `Médiane ${eur(k.price_median)}`);

    hbars(
      byId("chart-providers"),
      stats.providers.map((r) => ({
        key: r.provider,
        label: r.provider,
        value: r.products,
        valueText: int(r.products),
        shareText: pct(r.share),
        tipValue: `${int(r.products)} cartes · ${pct(r.share)} du catalogue`,
      })),
      { selected: state.provider, onSelect: toggleProvider },
    );

    const bins = p.price_histogram;
    const first = bins[0].from;
    const last = bins[bins.length - 1].to;
    const at = (v) => `${((v - first) / (last - first)) * 100}%`;
    const over = bins.filter((b) => b.from >= meta.threshold).reduce((s, b) => s + b.count, 0);
    const axis = [];
    for (let v = first; v <= last; v += 50) axis.push({ left: at(v), text: `${int(v)} €` });
    columns(
      byId("chart-histogram"),
      bins.map((b) => ({
        value: b.count,
        tone: b.from >= meta.threshold ? "accent" : null,
        tipValue: `${int(b.count)} cartes`,
        tipLabel: `De ${int(b.from)} à ${int(b.to)} €`,
      })),
      {
        height: 168,
        yAxis: true,
        xAxis: axis,
        threshold: { left: at(meta.threshold), label: `100 € · ${int(over)} cartes au-delà` },
        label: "Histogramme du nombre de cartes par tranche de prix de 10 euros",
      },
    );

    byId("takeaways").replaceChildren(
      ...stats.takeaways.map((t) => h("li", { class: "takeaway" }, h("span", { class: "takeaway__figure", text: t.figure }), h("p", { class: "takeaway__text", text: t.text }))),
    );

    columns(
      byId("chart-data-mix"),
      p.data_mix.map((d) => ({
        label: d.label,
        value: d.count,
        topText: int(d.count),
        tone: d.label === "Illimité" ? "soft" : null,
        tipValue: `${int(d.count)} cartes · ${pct(d.count / k.products)}`,
        tipLabel: d.label,
      })),
      { height: 150, label: "Nombre de cartes par volume de data" },
    );

    const validityColors = ["var(--heat-3)", "var(--heat-5)", "var(--heat-7)"];
    stacks(byId("chart-composition"), [
      {
        label: "Durée de validité",
        parts: p.validity_mix.map((d, i) => ({ label: d.label.replace(" jours", " j"), count: d.count, color: validityColors[i % 3], light: i === 0 })),
      },
      {
        label: "Réseau",
        parts: p.network_mix.map((d, i) => ({ label: d.label, count: d.count, color: i === 0 ? "var(--data)" : "var(--accent)" })),
      },
      {
        label: "Recharge possible",
        parts: p.top_up_mix.map((d, i) => ({ label: i === 0 ? "Oui" : "Non", count: d.count, color: i === 0 ? "var(--data)" : "var(--muted)", light: i === 1 })),
      },
    ]);
  }

  // Réglette de prix : extrêmes, moitié centrale (1er au 3e quartile) et médiane, sur une échelle linéaire.
  function priceRange(container, k) {
    const span = k.price_max - k.price_min || 1;
    const at = (v) => `${((v - k.price_min) / span) * 100}%`;
    container.replaceChildren(
      h("span", { class: "range__track" }),
      h("span", { class: "range__iqr", style: { left: at(k.price_q1), width: `calc(${at(k.price_q3)} - ${at(k.price_q1)})` } }),
      h("span", { class: "range__mark", style: { left: at(k.price_median) } }),
      h("span", { class: "range__end", style: { left: "0%" } }),
      h("span", { class: "range__end", style: { left: "100%" } }),
    );
  }

  /* ---------- 2. Prix ---------- */

  function renderPrices() {
    const p = profile();
    const m = stats.market;
    const best = m.best_example;

    byId("scope-prix").textContent = state.provider
      ? `Prix au Go et matrice filtrés sur ${state.provider}. Les comparaisons entre fournisseurs portent sur tout le catalogue.`
      : "Ce qui fait varier les prix, et ce que rapporte la comparaison des offres.";

    byId("market-kpis").replaceChildren(
      ...(best
        ? [
            kpi("Économie moyenne", pct(m.saving_vs_mean), "En choisissant l'offre la moins chère d'un même forfait, par rapport au prix moyen"),
            kpi("Écart moyen min. / max.", pct(m.saving_vs_max), "Entre l'offre la moins chère et la plus chère d'un même forfait"),
            kpi("Écart record", pct(best.saving, 0), `${best.label} : de ${eur(best.min)} à ${eur(best.max)}`),
            kpi("Forfaits comparables", int(m.competitive_offers), `Proposés par au moins deux fournisseurs, sur ${int(m.offers)} forfaits distincts`),
          ]
        : [h("p", { class: "empty", text: "Aucun forfait n'est proposé par au moins deux fournisseurs : pas de comparaison possible." })]),
    );

    columns(
      byId("chart-price-per-gb"),
      p.price_per_gb.map((d) => ({ label: d.label, value: d.value, topText: eur(d.value), tipValue: `${eur(d.value)} par Go`, tipLabel: `Forfait ${d.label}` })),
      { height: 170, label: "Prix médian au Go selon le volume du forfait" },
    );

    heatmap(byId("chart-price-matrix"), p.price_matrix);

    const byWinRate = [...m.providers].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0));
    hbars(
      byId("chart-win-rate"),
      byWinRate.map((r) => ({
        key: r.provider,
        label: r.provider,
        value: r.win_rate,
        valueText: pct(r.win_rate, 0),
        tipValue: `${pct(r.win_rate)} · ${int(r.wins)} forfaits sur ${int(r.presence)}`,
      })),
      { selected: state.provider, compact: true },
    );

    const byIndex = [...m.providers].sort((a, b) => (a.price_index ?? 0) - (b.price_index ?? 0));
    dotplot(byId("chart-price-index"), byIndex.map((r) => ({ key: r.provider, label: r.provider, value: r.price_index })), { selected: state.provider });

    const n = stats.network;
    if (n.available) {
      const max = Math.max(Math.abs(n.raw_gap), Math.abs(n.same_offer_gap), 0.01);
      const row = (label, value, accent) =>
        h(
          "div",
          { class: `versus__row${accent ? " is-accent" : ""}` },
          h("p", { class: "versus__label", text: label }),
          tip(h("span", { class: "versus__bar", style: { width: `${Math.max(0.6, (Math.abs(value) / max) * 100)}%` } }), signedPct(value), label),
          h("span", { class: "versus__value", text: signedPct(value, Math.abs(value) < 0.1 ? 1 : 0) }),
        );
      byId("chart-network").replaceChildren(
        h(
          "div",
          { class: "versus" },
          row(`Écart brut entre prix médians : 5G ${eur(n.median_5g)} contre 4G ${eur(n.median_4g)}`, n.raw_gap, false),
          row(`À forfait identique, sur ${int(n.paired_offers)} forfaits vendus en 4G et en 5G`, n.same_offer_gap, true),
        ),
        h("p", { class: "note", text: `Explication : la 5G est surtout présente sur les forfaits illimités, plus chers (${pct(n.share_5g_unlimited, 0)} d'entre eux, contre ${pct(n.share_5g_limited, 0)} des autres).` }),
      );
    } else {
      byId("chart-network").replaceChildren(h("p", { class: "empty", text: "Comparaison 4G / 5G indisponible pour ces données." }));
    }

    columns(
      byId("chart-unlimited"),
      stats.unlimited.by_validity.map((u) => ({
        label: `${u.days} jours`,
        sublabel: `${eur(u.price_median)} le forfait`,
        value: u.price_per_day,
        topText: `${eur(u.price_per_day)}/j`,
        tipValue: `${eur(u.price_per_day)} par jour`,
        tipLabel: `Illimité ${u.days} jours`,
      })),
      { height: 150, label: "Prix médian d'une journée de forfait illimité, selon la durée" },
    );
  }

  /* ---------- 3. Fournisseurs ---------- */

  function renderProviders() {
    const market = Object.fromEntries(stats.market.providers.map((r) => [r.provider, r]));
    const maxProducts = Math.max(...stats.providers.map((r) => r.products));
    byId("table-providers").replaceChildren(
      dataTable(
        [
          {
            label: "Fournisseur",
            render: (r) =>
              h("button", {
                type: "button",
                class: "link-button",
                text: r[0],
                title: `Voir la vue d'ensemble de ${r[0]}`,
                onclick: () => {
                  setProvider(r[0]);
                  window.location.hash = "vue-ensemble";
                },
              }),
          },
          { label: "Cartes", num: true, render: (r) => cellBar(r[1], maxProducts, int(r[1])) },
          { label: "Part", num: true, format: (v) => pct(v) },
          { label: "Destinations", num: true },
          { label: "Prix moyen", num: true, format: eur },
          { label: "Prix médian", num: true, format: eur },
          { label: "Data moy.", num: true, format: gb },
          { label: "Illimités", num: true, format: (v) => pct(v, 0) },
          { label: "5G", num: true, format: (v) => pct(v, 0) },
          { label: "Recharge", num: true, format: (v) => pct(v, 0) },
          { label: "Moins cher", num: true, format: (v) => pct(v, 0) },
          { label: "Écart marché", num: true, format: (v) => signedPct(v) },
        ],
        stats.providers.map((r) => [
          r.provider,
          r.products,
          r.share,
          r.destinations,
          r.price_mean,
          r.price_median,
          r.data_mean_gb,
          r.unlimited_share,
          r.share_5g,
          r.top_up_share,
          market[r.provider]?.win_rate ?? null,
          market[r.provider]?.price_index ?? null,
        ]),
        {
          sortable: true,
          initialSort: { index: 1, dir: "descending" },
          caption: "« Moins cher » : part des forfaits où le fournisseur propose l'offre la moins chère. « Écart marché » : écart moyen au prix médian du même forfait.",
        },
      ),
    );
  }

  /* ---------- 4. Destinations ---------- */

  function renderDestinations() {
    const d = stats.destinations;
    byId("destination-kpis").replaceChildren(
      kpi("Destinations", int(d.count), `${int(d.countries)} pays et ${int(d.regions)} zones multi-pays`),
      kpi("Zones multi-pays", int(d.regions), d.region_names.join(", ")),
      kpi("Prix médian au Go, pays", eur(d.country_price_per_gb), "Forfaits d'un seul pays, hors illimités"),
      kpi("Prix médian au Go, multi-pays", eur(d.region_price_per_gb), `${signedPct(d.region_premium_per_gb, 0)} par rapport aux forfaits pays`),
    );
    const maxPpg = Math.max(...d.table.map((r) => r.price_per_gb || 0));
    byId("table-destinations").replaceChildren(
      dataTable(
        [
          { label: "Destination" },
          { label: "Type" },
          { label: "Offres", num: true, format: int },
          { label: "Fournisseurs", num: true },
          { label: "Prix médian", num: true, format: eur },
          { label: "Prix médian au Go", num: true, render: (r) => (r[5] == null ? "–" : cellBar(r[5], maxPpg, eur(r[5]))) },
        ],
        d.table.map((r) => [r.name, r.is_region ? "Zone multi-pays" : "Pays", r.offers, r.providers, r.price_median, r.price_per_gb]),
        { sortable: true, initialSort: { index: 2, dir: "descending" }, caption: "Cliquez sur un en-tête pour trier." },
      ),
    );
  }

  /* ---------- 5. Comparateur ---------- */

  function renderExplorer() {
    const ex = payload.explorer;
    const col = Object.fromEntries(ex.columns.map((name, i) => [name, i]));
    const dest = byId("ex-destination");
    const tier = byId("ex-tier");
    const validity = byId("ex-validity");
    const network = byId("ex-network");

    const regions = ex.destinations.map((d, i) => ({ ...d, i })).filter((d) => d.is_region);
    const countries = ex.destinations.map((d, i) => ({ ...d, i })).filter((d) => !d.is_region).sort((a, b) => collator.compare(a.name, b.name));
    dest.replaceChildren(
      h("optgroup", { label: "Zones multi-pays" }, regions.map((d) => h("option", { value: d.i, text: d.name }))),
      h("optgroup", { label: "Pays" }, countries.map((d) => h("option", { value: d.i, text: d.name }))),
    );
    tier.replaceChildren(...ex.tiers.map((t, i) => h("option", { value: i, text: t })));
    validity.replaceChildren(...ex.validities.map((v) => h("option", { value: v, text: `${v} jours` })));
    network.replaceChildren(h("option", { value: "", text: "4G et 5G" }), ...ex.networks.map((n) => h("option", { value: n, text: n })));

    const pick = (select, predicate) => {
      const option = [...select.options].find(predicate);
      if (option) select.value = option.value;
    };
    pick(dest, (o) => ex.destinations[o.value]?.code === "EU");
    pick(tier, (o) => ex.tiers[o.value] === "10 Go");
    pick(validity, (o) => o.value === "30");

    function update() {
      const rows = ex.rows
        .filter(
          (r) =>
            r[col.destination] === Number(dest.value) &&
            r[col.tier] === Number(tier.value) &&
            r[col.validity_days] === Number(validity.value) &&
            (!network.value || r[col.network] === network.value),
        )
        .sort((a, b) => a[col.price] - b[col.price]);
      const summary = byId("explorer-summary");
      const results = byId("explorer-results");
      if (!rows.length) {
        summary.textContent = "Aucune offre pour cette combinaison.";
        results.replaceChildren(h("p", { class: "empty", text: "Essayez un autre volume ou une autre durée." }));
        return;
      }
      const cheapest = rows[0][col.price];
      const priciest = rows[rows.length - 1][col.price];
      const providerCount = new Set(rows.map((r) => r[col.provider])).size;
      summary.replaceChildren(
        h("strong", { text: `${int(rows.length)} offre${rows.length > 1 ? "s" : ""}` }),
        ` de ${int(providerCount)} fournisseur${providerCount > 1 ? "s" : ""}, de ${eur(cheapest)} à ${eur(priciest)}.`,
        rows.length > 1 ? ` La moins chère coûte ${pct(1 - cheapest / priciest, 0)} de moins que la plus chère.` : "",
      );
      const unlimited = rows[0][col.data_gb] == null;
      results.replaceChildren(
        dataTable(
          [
            { label: "Fournisseur" },
            {
              label: "Prix",
              num: true,
              render: (r) => {
                const [rank, price] = r[1];
                return h("span", {}, rank === 0 ? h("span", { class: "tag", text: "Meilleur prix" }) : null, eur(price));
              },
            },
            { label: unlimited ? "Prix par jour" : "Prix au Go", num: true, format: eur },
            { label: "Réseau" },
            { label: "Recharge" },
            { label: "SKU", render: (r) => h("span", { class: "code", text: r[5] }) },
          ],
          rows.map((r, i) => [
            ex.providers[r[col.provider]],
            [i, r[col.price]],
            unlimited ? r[col.price] / r[col.validity_days] : r[col.price] / r[col.data_gb],
            r[col.network],
            r[col.top_up] == null ? "–" : r[col.top_up] ? "Oui" : "Non",
            r[col.sku],
          ]),
        ),
      );
    }

    byId("explorer-form").addEventListener("submit", (e) => e.preventDefault());
    for (const select of [dest, tier, validity, network]) select.addEventListener("change", update);
    update();
  }

  /* ---------- 6. Qualité des données ---------- */

  const STATUS = { ok: "OK", info: "Info", warning: "À vérifier", error: "Erreur" };

  function renderQuality() {
    byId("checks").replaceChildren(
      ...payload.checks.map((c) =>
        h(
          "li",
          { class: `check check--${c.status}` },
          h("span", { class: "check__status", text: STATUS[c.status] ?? "Info" }),
          h("div", {}, h("p", { class: "check__title", text: c.label }), h("p", { class: "check__detail", text: c.detail })),
        ),
      ),
    );
    byId("table-files").replaceChildren(
      dataTable(
        [{ label: "Fichier" }, { label: "Fournisseur" }, { label: "Lignes", num: true, format: int }, { label: "Retenues", num: true, format: int }],
        payload.files.map((f) => [f.name, f.error ? `Rejeté : ${f.error}` : f.providers.join(", "), f.rows_read, f.rows_kept]),
      ),
    );
  }

  /* ---------- Démarrage ---------- */

  const select = byId("provider-filter");
  select.append(...providerNames.map((name) => h("option", { value: name, text: `${name} (${int(stats.by_provider[name].kpis.products)})` })));
  select.addEventListener("change", () => setProvider(select.value));

  byId("theme-toggle").addEventListener("click", () => {
    const root = document.documentElement;
    const current = root.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    root.dataset.theme = next;
    try {
      localStorage.setItem("theme", next);
    } catch (e) {
      /* stockage indisponible (navigation privée) : le thème vaut pour la session en cours */
    }
  });

  window.addEventListener("hashchange", () => {
    showPage(window.location.hash.slice(1));
    window.scrollTo(0, 0);
  });

  const fromUrl = new URLSearchParams(window.location.search).get("fournisseur");
  state.provider = fromUrl && stats.by_provider[fromUrl] ? fromUrl : "";
  select.value = state.provider;
  select.classList.toggle("is-active", Boolean(state.provider));
  showPage(window.location.hash.slice(1));
})();
