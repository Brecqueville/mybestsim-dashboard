/* Tableau de bord du catalogue eSIM.
 * Toutes les statistiques sont calculées en Python (esim_dashboard/stats.py) :
 * ce script les affiche, les filtre et les met en forme, sans recalcul métier.
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
  // Une valeur absente (null) s'affiche « – » plutôt que « 0 ».
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
  const setKpi = (name, text) => {
    const el = document.querySelector(`[data-kpi="${name}"]`);
    if (el) el.textContent = text;
  };

  /* ---------- Infobulle (souris et clavier) ---------- */

  const tooltip = h("div", { class: "tooltip", role: "tooltip", hidden: true });
  document.body.append(tooltip);

  function placeTooltip(x, y) {
    const { offsetWidth: w, offsetHeight: hgt } = tooltip;
    const left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8);
    const top = y - hgt - 12 < 8 ? y + 18 : y - hgt - 12;
    tooltip.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }

  function tip(el, value, label) {
    el.dataset.tip = "";
    el.tabIndex = 0;
    el.setAttribute("aria-label", `${label} : ${value}`);
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

  // Barres horizontales : une seule série, valeur en bout de barre.
  function barList(container, items, { format, highlight } = {}) {
    const max = Math.max(...items.map((d) => d.value || 0)) || 1;
    container.replaceChildren(
      h(
        "ul",
        { class: "bars" },
        items.map((d) => {
          const state = highlight ? (d.key === highlight ? " is-highlight" : " is-muted") : "";
          const bar = h("span", { class: "bars__bar", vars: { "--w": String((d.value || 0) / max) } });
          return h(
            "li",
            { class: `bars__row${state}` },
            h("span", { class: "bars__label", title: d.label, text: d.label }),
            h("span", { class: "bars__track" }, tip(bar, format(d.value), d.label), h("span", { class: "bars__value", text: d.display ?? format(d.value) })),
          );
        }),
      ),
    );
  }

  // Barres divergentes autour de 0 : domaine minimal de ±5 % pour ne pas grossir des écarts infimes.
  function divergingList(container, items) {
    const domain = Math.max(0.05, ...items.map((d) => Math.abs(d.value || 0)));
    const rows = items.map((d) => {
      const v = d.value || 0;
      const bar = h("span", {
        class: `diverging__bar diverging__bar--${v < 0 ? "neg" : "pos"}`,
        style: { width: `${(Math.abs(v) / domain) * 50}%` },
      });
      return h(
        "li",
        { class: "diverging__row" },
        h("span", { class: "bars__label", title: d.label, text: d.label }),
        h("span", { class: "diverging__track" }, tip(bar, signedPct(v), d.label)),
        h("span", { class: "diverging__value", text: signedPct(v) }),
      );
    });
    container.replaceChildren(
      h("ul", { class: "diverging" }, rows),
      h("div", { class: "diverging__axis", "aria-hidden": "true" }, h("span"), h("span", {}, h("span", { text: signedPct(-domain, 0) }), h("span", { text: "0" }), h("span", { text: signedPct(domain, 0) }))),
    );
  }

  function niceTicks(max, count = 4) {
    const raw = max / count || 1;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= raw);
    const ticks = [];
    for (let v = 0; v < max + step; v += step) ticks.push(v);
    return ticks;
  }

  // Histogramme des prix, tranches à partir du seuil mises en avant.
  function histogram(container, bins, threshold) {
    const ticks = niceTicks(Math.max(...bins.map((b) => b.count)));
    const top = ticks[ticks.length - 1] || 1;
    const lastEdge = bins[bins.length - 1].to;
    const xPos = (value) => `${(value / lastEdge) * 100}%`;
    const thresholdBin = bins.findIndex((b) => b.from >= threshold);

    const plot = h(
      "div",
      { class: "colchart__plot" },
      ticks.slice(1).map((t) => h("span", { class: "colchart__grid", style: { bottom: `${(t / top) * 100}%` } })),
      h(
        "div",
        { class: "colchart__bars" },
        bins.map((b) => {
          const bar = h("span", { class: "colchart__bar", style: { height: `${(b.count / top) * 100}%` } });
          return h("div", { class: `colchart__col${b.from >= threshold ? " is-over" : ""}` }, b.count ? tip(bar, `${int(b.count)} produits`, `De ${int(b.from)} à ${int(b.to)}\u00a0€`) : bar);
        }),
      ),
      thresholdBin > 0 ? h("span", { class: "colchart__marker", style: { left: xPos(threshold) } }, h("span", { text: `${int(threshold)}\u00a0€` })) : null,
    );
    const yAxis = h("div", { class: "colchart__y", "aria-hidden": "true" }, ticks.map((t) => h("span", { style: { bottom: `${(t / top) * 100}%` }, text: int(t) })));
    const labelStep = lastEdge > 100 ? 50 : 20;
    const xLabels = [];
    for (let v = 0; v <= lastEdge; v += labelStep) xLabels.push(h("span", { style: { left: xPos(v) }, text: `${int(v)}\u00a0€` }));
    const xAxis = h("div", { class: "colchart__x", "aria-hidden": "true" }, xLabels);

    const over = bins.filter((b) => b.from >= threshold).reduce((s, b) => s + b.count, 0);
    const legend = h(
      "ul",
      { class: "legend legend--inline" },
      h("li", {}, h("span", { class: "swatch", style: { background: "var(--series-1)" } }), h("span", { class: "legend__label", text: `Moins de ${int(threshold)}\u00a0€` })),
      h("li", {}, h("span", { class: "swatch", style: { background: "var(--series-2)" } }), h("span", { class: "legend__label", text: `${int(threshold)}\u00a0€ et plus (${int(over)})` })),
    );
    container.replaceChildren(h("div", { class: "colchart", role: "img", "aria-label": "Histogramme des prix par tranche de 10 euros" }, yAxis, plot, xAxis), legend);
  }

  // Barre empilée 100 % + légende (identité jamais portée par la seule couleur).
  function shareBar(container, parts, colors) {
    const total = parts.reduce((s, p) => s + p.count, 0) || 1;
    const bar = h(
      "div",
      { class: "share" },
      parts.filter((p) => p.count > 0).map((p) => {
        const i = parts.indexOf(p);
        const seg = h("span", { class: "share__seg", style: { flexGrow: String(p.count), background: colors[i] } });
        return tip(seg, `${pct(p.count / total)} (${int(p.count)})`, p.label);
      }),
    );
    const legend = h(
      "ul",
      { class: "legend" },
      parts.map((p, i) =>
        h(
          "li",
          {},
          h("span", { class: "swatch", style: { background: colors[i] } }),
          h("span", { class: "legend__label", text: p.label }),
          h("span", { class: "legend__value" }, pct(p.count / total, 0), h("small", { text: int(p.count) })),
        ),
      ),
    );
    container.replaceChildren(bar, legend);
  }

  // Carte de chaleur : rampe séquentielle (une teinte, du clair au foncé), échelle logarithmique.
  function heatmap(container, matrix) {
    const values = matrix.values.flat().filter((v) => v != null);
    const lo = Math.log(Math.min(...values));
    const hi = Math.log(Math.max(...values));
    const step = (v) => 1 + Math.min(6, Math.floor(((Math.log(v) - lo) / (hi - lo || 1)) * 7));
    container.replaceChildren(
      h(
        "div",
        { class: "table-wrap" },
        h(
          "table",
          { class: "heatmap" },
          h("caption", { class: "sr-only", text: "Prix médian en euros par volume (lignes) et durée (colonnes)" }),
          h("thead", {}, h("tr", {}, h("th", { scope: "col", text: "Volume" }), matrix.columns.map((c) => h("th", { scope: "col", text: c })))),
          h(
            "tbody",
            {},
            matrix.rows.map((row, r) =>
              h(
                "tr",
                {},
                h("th", { scope: "row", text: row }),
                matrix.values[r].map((v, c) => (v == null ? h("td", { text: "–" }) : tip(h("td", { class: `heat-${step(v)}`, text: eur(v) }), eur(v), `${row}, ${matrix.columns[c]}`))),
              ),
            ),
          ),
        ),
      ),
    );
  }

  // Tableau de données : la version accessible de chaque graphique.
  function dataTable(columns, rows, { caption, sortable = false, initialSort = null } = {}) {
    let sortState = initialSort;
    const tbody = h("tbody");
    const headCells = columns.map((col, i) => {
      const th = h("th", { scope: "col", class: col.num ? "num" : null });
      if (sortable && col.sort !== false) {
        th.append(h("button", { type: "button", class: "sort", text: col.label, onclick: () => sortBy(i) }));
      } else {
        th.textContent = col.label;
      }
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
              return h(i === 0 ? "th" : "td", { scope: i === 0 ? "row" : null, class: col.num ? "num" : null }, content ?? "–");
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

  const tile = (label, value, ...notes) =>
    h("article", { class: "tile" }, h("p", { class: "tile__label", text: label }), h("p", { class: "tile__value", text: value }), notes.filter(Boolean).map((n) => h("p", { class: "tile__note", text: n })));

  /* ---------- Vue d'ensemble (filtrable par fournisseur) ---------- */

  const providerSelect = byId("provider-filter");
  const providerNames = Object.keys(stats.by_provider).sort(collator.compare);

  function renderOverview(provider) {
    const profile = provider ? stats.by_provider[provider] : stats.overview;
    const k = profile.kpis;

    byId("overview-scope").textContent = provider
      ? `Filtré sur ${provider} : ${pct(k.products / overall.products)} du catalogue. Les sections suivantes portent sur tout le catalogue.`
      : "Tout le catalogue, tous fournisseurs confondus.";

    setKpi("products", int(k.products));
    setKpi("products-note", provider ? `${k.destinations} destinations couvertes` : `${k.providers} fournisseurs · ${k.destinations} destinations`);
    setKpi("over", int(k.over_threshold));
    setKpi("over-note", `${pct(k.over_threshold_share)} des cartes${provider ? ` de ${provider}` : ""} · prix strictement supérieur à ${int(meta.threshold)}\u00a0€`);
    setKpi("range", `${eur(k.price_min)} – ${eur(k.price_max)}`);
    const range = document.querySelector('[data-kpi="range-note"]');
    range.replaceChildren(
      `Min : ${k.price_min_product.name} (${k.price_min_product.provider})`,
      h("br"),
      `Max : ${k.price_max_product.name} (${k.price_max_product.provider})`,
    );
    setKpi("data", gb(k.data_mean_gb));
    setKpi("data-note", `Médiane ${gb(k.data_median_gb)} · calculée sur ${int(k.limited_count)} forfaits chiffrés, hors illimités`);
    setKpi("price", eur(k.price_mean));
    setKpi("price-note", `Médiane ${eur(k.price_median)}`);
    setKpi("unlimited", int(k.unlimited_count));
    setKpi("unlimited-note", `${pct(k.unlimited_share)} des cartes · sans volume chiffré`);

    histogram(byId("chart-histogram"), profile.price_histogram, meta.threshold);
    byId("table-histogram").replaceChildren(
      dataTable(
        [{ label: "Tranche de prix" }, { label: "Produits", num: true, format: int }],
        profile.price_histogram.map((b) => [`${int(b.from)} à ${int(b.to)}\u00a0€`, b.count]),
      ),
    );

    barList(
      byId("chart-data-mix"),
      profile.data_mix.map((d) => ({ key: d.label, label: d.label, value: d.count, display: `${int(d.count)} · ${pct(d.count / k.products, 0)}` })),
      { format: (v) => `${int(v)} produits` },
    );
    byId("table-data-mix").replaceChildren(
      dataTable(
        [{ label: "Volume" }, { label: "Produits", num: true, format: int }, { label: "Part", num: true, format: (v) => pct(v) }],
        profile.data_mix.map((d) => [d.label, d.count, d.count / k.products]),
      ),
    );

    shareBar(byId("chart-validity"), profile.validity_mix, ["var(--ord-1)", "var(--ord-2)", "var(--ord-3)"]);
    shareBar(byId("chart-network"), profile.network_mix, ["var(--series-1)", "var(--series-2)", "var(--series-3)"]);
    shareBar(byId("chart-topup"), profile.top_up_mix, ["var(--series-1)", "var(--series-2)"]);

    renderProviders(provider);
  }

  /* ---------- Fournisseurs ---------- */

  function renderProviders(selected) {
    barList(
      byId("chart-providers"),
      stats.providers.map((p) => ({ key: p.provider, label: p.provider, value: p.products, display: `${int(p.products)} · ${pct(p.share)}` })),
      { format: (v) => `${int(v)} cartes`, highlight: selected || null },
    );
  }

  function renderProvidersTable() {
    byId("table-providers").replaceChildren(
      dataTable(
        [
          { label: "Fournisseur" },
          { label: "Cartes", num: true, format: int },
          { label: "Part", num: true, format: (v) => pct(v) },
          { label: "Destinations", num: true },
          { label: "Prix moyen", num: true, format: eur },
          { label: "Prix médian", num: true, format: eur },
          { label: "Data moy. (hors ill.)", num: true, format: gb },
          { label: "Illimités", num: true, format: (v) => pct(v, 0) },
          { label: "5G", num: true, format: (v) => pct(v, 0) },
          { label: "Rechargeables", num: true, format: (v) => pct(v, 0) },
        ],
        stats.providers.map((p) => [p.provider, p.products, p.share, p.destinations, p.price_mean, p.price_median, p.data_mean_gb, p.unlimited_share, p.share_5g, p.top_up_share]),
        { sortable: true, initialSort: { index: 1, dir: "descending" } },
      ),
    );
  }

  /* ---------- Enseignements ---------- */

  function renderInsights() {
    byId("insights").replaceChildren(...stats.insights.map((i) => h("article", { class: "insight" }, h("h3", { text: i.title }), h("p", { text: i.text }))));
  }

  /* ---------- Prix ---------- */

  function renderPricing() {
    const ppg = stats.overview.price_per_gb;
    barList(
      byId("chart-price-per-gb"),
      ppg.map((d) => ({ key: d.label, label: d.label, value: d.value, display: `${eur(d.value)}/Go` })),
      { format: (v) => `${eur(v)} par Go` },
    );
    byId("table-price-per-gb").replaceChildren(
      dataTable([{ label: "Volume" }, { label: "Prix médian au Go", num: true, format: eur }], ppg.map((d) => [d.label, d.value])),
    );
    heatmap(byId("chart-price-matrix"), stats.overview.price_matrix);

    const m = stats.market;
    const best = m.best_example;
    byId("market-tiles").replaceChildren(
      ...(best
        ? [
            tile("Économie vs prix moyen", pct(m.saving_vs_mean), "En choisissant l'offre la moins chère d'un même forfait"),
            tile("Économie vs offre la plus chère", pct(m.saving_vs_max), "Écart moyen entre la moins chère et la plus chère"),
            tile("Écart record", pct(best.saving, 0), `${best.label} : de ${eur(best.min)} à ${eur(best.max)}`),
            tile("Forfaits comparables", int(m.competitive_offers), `sur ${int(m.offers)} forfaits distincts, ${num(m.avg_offers_per_offer)} offres par forfait en moyenne`),
          ]
        : [h("p", { class: "empty", text: "Aucun forfait n'est proposé par au moins deux fournisseurs : pas de comparaison possible." })]),
    );

    const byWinRate = [...m.providers].sort((a, b) => (b.win_rate ?? 0) - (a.win_rate ?? 0));
    barList(
      byId("chart-win-rate"),
      byWinRate.map((p) => ({ key: p.provider, label: p.provider, value: p.win_rate, display: pct(p.win_rate, 0) })),
      { format: (v) => `${pct(v)} des forfaits` },
    );
    const byIndex = [...m.providers].sort((a, b) => (a.price_index ?? 0) - (b.price_index ?? 0));
    divergingList(byId("chart-price-index"), byIndex.map((p) => ({ label: p.provider, value: p.price_index })));
    byId("table-market").replaceChildren(
      dataTable(
        [
          { label: "Fournisseur" },
          { label: "Forfaits en concurrence", num: true, format: int },
          { label: "Fois le moins cher", num: true, format: int },
          { label: "Taux", num: true, format: (v) => pct(v) },
          { label: "Écart au marché", num: true, format: (v) => signedPct(v, 2) },
        ],
        m.providers.map((p) => [p.provider, p.presence, p.wins, p.win_rate, p.price_index]),
        { sortable: true, initialSort: { index: 3, dir: "descending" } },
      ),
    );

    byId("unlimited-tiles").replaceChildren(
      ...stats.unlimited.by_validity.map((u) => tile(`${u.days} jours`, `${eur(u.price_per_day)}/jour`, `${eur(u.price_median)} le forfait (médiane)`)),
    );

    const n = stats.network;
    byId("network-tiles").replaceChildren(
      ...(n.available
        ? [
            tile("Écart brut", signedPct(n.raw_gap, 0), `Prix médian 5G ${eur(n.median_5g)} contre 4G ${eur(n.median_4g)}`),
            tile("À forfait identique", signedPct(n.same_offer_gap), `Sur ${int(n.paired_offers)} forfaits vendus en 4G et en 5G`),
            tile("Part de 5G", pct(n.share_5g, 0), `${pct(n.share_5g_unlimited, 0)} des illimités, ${pct(n.share_5g_limited, 0)} des autres`),
          ]
        : [h("p", { class: "empty", text: "Comparaison 4G / 5G indisponible pour ces données." })]),
    );
  }

  /* ---------- Destinations ---------- */

  function renderDestinations() {
    const d = stats.destinations;
    byId("destination-tiles").replaceChildren(
      tile("Destinations", int(d.count), `${int(d.countries)} pays et ${int(d.regions)} zones multi-pays`),
      tile("Prix médian au Go, forfaits pays", `${eur(d.country_price_per_gb)}`, "Hors forfaits illimités"),
      tile("Prix médian au Go, multi-pays", `${eur(d.region_price_per_gb)}`, `Soit ${signedPct(d.region_premium_per_gb, 0)} par rapport aux forfaits pays`),
    );
    const maxPpg = Math.max(...d.table.map((r) => r.price_per_gb || 0)) || 1;
    byId("table-destinations").replaceChildren(
      dataTable(
        [
          { label: "Destination" },
          { label: "Type", key: (r) => r[1] },
          { label: "Offres", num: true, format: int },
          { label: "Fournisseurs", num: true },
          { label: "Prix médian", num: true, format: eur },
          {
            label: "Prix médian au Go",
            num: true,
            render: (r) =>
              r[5] == null
                ? "–"
                : h(
                    "span",
                    { class: "inline-bar" },
                    h("span", { text: eur(r[5]) }),
                    h("span", { class: "inline-bar__track", "aria-hidden": "true" }, h("span", { class: "inline-bar__fill", style: { width: `${(r[5] / maxPpg) * 100}%` } })),
                  ),
          },
        ],
        d.table.map((r) => [r.name, r.is_region ? "Zone multi-pays" : "Pays", r.offers, r.providers, r.price_median, r.price_per_gb]),
        { sortable: true, initialSort: { index: 2, dir: "descending" }, caption: "Trié par nombre d'offres. Cliquez sur un en-tête pour changer le tri." },
      ),
    );
  }

  /* ---------- Comparateur ---------- */

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
      const d = Number(dest.value);
      const t = Number(tier.value);
      const v = Number(validity.value);
      const net = network.value;
      const rows = ex.rows
        .filter((r) => r[col.destination] === d && r[col.tier] === t && r[col.validity_days] === v && (!net || r[col.network] === net))
        .sort((a, b) => a[col.price] - b[col.price]);
      const summary = byId("explorer-summary");
      const results = byId("explorer-results");
      if (!rows.length) {
        summary.textContent = "";
        results.replaceChildren(h("p", { class: "empty", text: "Aucune offre pour cette combinaison. Essayez un autre volume ou une autre durée." }));
        return;
      }
      const cheapest = rows[0][col.price];
      const priciest = rows[rows.length - 1][col.price];
      const providerCount = new Set(rows.map((r) => r[col.provider])).size;
      summary.replaceChildren(
        h("strong", { text: `${int(rows.length)} offre${rows.length > 1 ? "s" : ""}` }),
        ` de ${int(providerCount)} fournisseur${providerCount > 1 ? "s" : ""}, de ${eur(cheapest)} à ${eur(priciest)}.`,
        rows.length > 1 ? ` Choisir la moins chère fait économiser ${pct(1 - cheapest / priciest, 0)} par rapport à la plus chère.` : "",
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
                return h("span", {}, rank === 0 ? [h("span", { class: "tag tag--best", text: "Moins cher" }), " "] : null, eur(price));
              },
            },
            { label: unlimited ? "Prix par jour" : "Prix au Go", num: true, format: eur },
            { label: "Réseau" },
            { label: "Recharge" },
            { label: "SKU" },
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

  /* ---------- Qualité ---------- */

  const STATUS = {
    ok: { icon: "✓", label: "OK" },
    info: { icon: "i", label: "Info" },
    warning: { icon: "!", label: "À vérifier" },
    error: { icon: "×", label: "Erreur" },
  };

  function renderQuality() {
    byId("checks").replaceChildren(
      ...payload.checks.map((c) => {
        const s = STATUS[c.status] ?? STATUS.info;
        return h(
          "li",
          { class: `check check--${c.status}` },
          h("span", { class: "check__icon", "aria-hidden": "true", text: s.icon }),
          h("div", {}, h("p", {}, h("span", { class: "check__title", text: c.label }), h("span", { class: "check__status", text: s.label })), h("p", { class: "check__detail", text: c.detail })),
        );
      }),
    );
    byId("table-files").replaceChildren(
      dataTable(
        [{ label: "Fichier" }, { label: "Fournisseur" }, { label: "Lignes lues", num: true, format: int }, { label: "Retenues", num: true, format: int }],
        payload.files.map((f) => [f.name, f.error ? `Rejeté : ${f.error}` : f.providers.join(", "), f.rows_read, f.rows_kept]),
      ),
    );
  }

  /* ---------- Navigation, thème, état dans l'URL ---------- */

  function initProviderFilter() {
    providerSelect.append(...providerNames.map((name) => h("option", { value: name, text: `${name} (${int(stats.by_provider[name].kpis.products)})` })));
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("fournisseur");
    if (fromUrl && stats.by_provider[fromUrl]) providerSelect.value = fromUrl;
    providerSelect.addEventListener("change", () => {
      const value = providerSelect.value;
      const url = new URL(window.location.href);
      if (value) url.searchParams.set("fournisseur", value);
      else url.searchParams.delete("fournisseur");
      history.replaceState(null, "", url);
      renderOverview(value);
    });
    renderOverview(providerSelect.value);
  }

  function initThemeToggle() {
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
  }

  function initSectionNav() {
    const links = [...document.querySelectorAll(".sections a")];
    const targets = links.map((a) => document.querySelector(a.getAttribute("href"))).filter(Boolean);
    if (!("IntersectionObserver" in window)) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          links.forEach((a) => a.classList.toggle("is-active", a.getAttribute("href") === `#${entry.target.id}`));
        }
      },
      { rootMargin: "-30% 0px -60% 0px" },
    );
    targets.forEach((t) => observer.observe(t));
  }

  initProviderFilter();
  renderProvidersTable();
  renderInsights();
  renderPricing();
  renderDestinations();
  renderExplorer();
  renderQuality();
  initThemeToggle();
  initSectionNav();

  // Le contenu est construit après le chargement : on rejoint l'ancre d'un lien partagé (#comparateur…).
  if (window.location.hash) document.getElementById(window.location.hash.slice(1))?.scrollIntoView();
})();
