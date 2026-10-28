// AUBE_WIDGET · style « Épuré » (petit, moyen, grand)
// Ce fichier est chargé par le script Scriptable collé sur l'iPhone : le modifier ici met à jour le widget partout.
// Reçoit KEY, API, SITE.

const fm = FileManager.local();
const cachePath = fm.joinPath(fm.documentsDirectory(), "aube-widget.json");
let data = null;
try {
  const req = new Request(API + "/widget?key=" + KEY);
  req.timeoutInterval = 15;
  data = await req.loadJSON();
  if (data && data.days) fm.writeString(cachePath, JSON.stringify(data));
} catch (e) {}
if (!data || !data.days) {
  try { data = JSON.parse(fm.readString(cachePath)); } catch (e) { data = null; }
}

// ---------- taille ----------
let fam = config.widgetFamily;
if (!fam) {
  const a = new Alert();
  a.title = "Aperçu du widget Aube";
  a.addAction("Petit"); a.addAction("Moyen"); a.addAction("Grand");
  a.addCancelAction("Annuler");
  const i = await a.presentSheet();
  if (i < 0) { Script.complete(); return; }
  fam = ["small", "medium", "large"][i];
}

// ---------- outils ----------
const now = new Date();
const pad = n => String(n).padStart(2, "0");
const iso = d => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
const hm = m => pad(Math.floor(m / 60) % 24) + ":" + pad(m % 60);
const nowMin = now.getHours() * 60 + now.getMinutes();
const todayIso = iso(now);
const JOURS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const num = n => Math.round(n || 0).toLocaleString("fr-FR");
const dur = m => m >= 60 ? Math.floor(m / 60) + " h" + (m % 60 ? " " + pad(m % 60) : "") : m + " min";
const dayDiff = d => Math.round((new Date(d + "T12:00:00") - new Date(todayIso + "T12:00:00")) / 86400000);
const dayName = d => { const n = dayDiff(d); return n === 0 ? "aujourd'hui" : n === 1 ? "demain" : JOURS[new Date(d + "T12:00:00").getDay()]; };

const dyn = (l, d) => Color.dynamic(new Color(l), new Color(d));
const BG = dyn("#FFFFFF", "#1C1C1E");
const INK = dyn("#111111", "#FFFFFF");
const MUTED = dyn("#8A8A8E", "#8D8D93");
const ACC = dyn("#F05A28", "#FF6B3D");
const COL = { pro: dyn("#2F6BFF", "#5B8CFF"), perso: dyn("#FF4F7B", "#FF6B8F"), focus: dyn("#34C759", "#30D158") };

function line(stack, s, font, color, lines) {
  const r = stack.addStack();
  const t = txt(r, s, font, color, lines);
  r.addSpacer();
  return t;
}
function txt(stack, s, font, color, lines) {
  const t = stack.addText(s);
  t.font = font; t.textColor = color || INK; t.lineLimit = lines || 1;
  t.minimumScaleFactor = 0.85;
  return t;
}
const F = {
  reg: s => Font.systemFont(s), med: s => Font.mediumSystemFont(s), semi: s => Font.semiboldSystemFont(s),
  bold: s => Font.boldSystemFont(s), light: s => Font.lightSystemFont(s)
};

// anneau de progression (pas)
function ring(pct, size) {
  const sc = 3, S = size * sc, lw = 2.6 * sc, r = (S - lw) / 2, c = S / 2;
  const ctx = new DrawContext();
  ctx.size = new Size(S, S); ctx.opaque = false; ctx.respectScreenScale = false;
  ctx.setLineWidth(lw);
  ctx.setStrokeColor(new Color("#8E8E93", 0.28));
  ctx.strokeEllipse(new Rect(lw / 2, lw / 2, S - lw, S - lw));
  const p = Math.max(0, Math.min(1, pct || 0));
  if (p > 0) {
    const path = new Path(), steps = Math.max(2, Math.round(80 * p));
    for (let i = 0; i <= steps; i++) {
      const a = -Math.PI / 2 + (2 * Math.PI * p * i) / steps;
      const pt = new Point(c + r * Math.cos(a), c + r * Math.sin(a));
      if (i === 0) path.move(pt); else path.addLine(pt);
    }
    ctx.addPath(path);
    ctx.setStrokeColor(new Color(p >= 1 ? "#30D158" : "#34C759"));
    ctx.strokePath();
  }
  return ctx.getImage();
}
function sym(stack, name, size, color) {
  const s = SFSymbol.named(name);
  if (!s) return null;
  s.applyFont(Font.semiboldSystemFont(size));
  const im = stack.addImage(s.image);
  im.imageSize = new Size(size + 1, size + 1);
  im.tintColor = color || MUTED;
  return im;
}
function statLine(stack, kind, size) {
  const row = stack.addStack();
  row.centerAlignContent();
  if (kind === "steps") {
    const st = data.steps || {};
    const im = row.addImage(ring(st.g ? (st.v || 0) / st.g : 0, size + 1));
    im.imageSize = new Size(size + 1, size + 1);
    row.addSpacer(6);
    txt(row, num(st.v) + (fam === "large" && st.g ? " / " + num(st.g) : "") + " pas", F.semi(size - 2.5), MUTED);
  } else if (kind === "tasks") {
    sym(row, "checkmark.square", size - 2);
    row.addSpacer(6);
    const n = (data.tasks && data.tasks.n) || 0;
    txt(row, n ? n + " tâche" + (n > 1 ? "s" : "") : "Aucune tâche", F.semi(size - 2.5), MUTED);
  } else if (kind === "focus") {
    sym(row, "bolt.fill", size - 2);
    row.addSpacer(6);
    txt(row, "Focus " + dur((data.focus && data.focus.v) || 0), F.semi(size - 2.5), MUTED);
  }
  return row;
}

// ---------- données ----------
const empty = !data || !data.days;
const days = empty ? [] : data.days;
const upcoming = [];
for (const day of days) for (const e of day.ev || []) {
  if (day.d < todayIso || (day.d === todayIso && e.e <= nowMin)) continue;
  upcoming.push(Object.assign({}, e, { d: day.d }));
}
const isLive = e => e.d === todayIso && e.s <= nowMin;
function subLine(e, withDay, place) {
  const when = isLive(e) ? "En cours · jusqu'à " + hm(e.e)
    : (withDay && e.d !== todayIso ? dayName(e.d).replace(/^./, c => c.toUpperCase()) + " " : "") + hm(e.s) + " – " + hm(e.e);
  return when + (e.w && (place || !isLive(e)) ? " · " + e.w : "");
}
function eventRow(stack, e, o) {
  const row = stack.addStack();
  row.layoutHorizontally();
  const bar = row.addStack();
  bar.size = new Size(3, o.h);
  bar.cornerRadius = 1.5;
  bar.backgroundColor = COL[e.c] || COL.pro;
  row.addSpacer(8);
  const col = row.addStack();
  col.layoutVertically();
  txt(col, e.t, F.semi(o.t + (o.first && isLive(e) ? 1.5 : 0)), INK, o.lines || 1);
  col.addSpacer(1);
  txt(col, subLine(e, o.withDay, o.place), F.med(o.s), MUTED);
  row.addSpacer();
  return row;
}

// ---------- widget ----------
const w = new ListWidget();
w.backgroundColor = BG;
w.url = SITE;
w.refreshAfterDate = new Date(Date.now() + 15 * 60000);

function dateBlock(stack, big) {
  const v = stack.addStack();
  v.layoutVertically();
  txt(v, (fam === "small" ? JOURS[now.getDay()].slice(0, 3) + "." : JOURS[now.getDay()]).toUpperCase(), F.bold(fam === "small" ? 11 : 12), ACC);
  const n = v.addStack();
  n.bottomAlignContent();
  txt(n, String(now.getDate()), F.light(big), INK);
  if (fam === "large") { n.addSpacer(6); const m = n.addStack(); m.layoutVertically(); txt(m, MOIS[now.getMonth()], F.med(14), MUTED); m.addSpacer(7); }
  return v;
}
function emptyMsg(stack) {
  line(stack, "Ouvre Aube une fois", F.semi(14), INK);
  line(stack, "pour remplir le widget.", F.med(12), MUTED, 2);
}

if (fam === "small") {
  w.setPadding(14, 14, 13, 14);
  dateBlock(w, 30);
  w.addSpacer();
  if (empty) emptyMsg(w);
  else if (upcoming[0]) {
    const e = upcoming[0];
    const row = w.addStack();
    const bar = row.addStack(); bar.size = new Size(3, 34); bar.cornerRadius = 1.5; bar.backgroundColor = COL[e.c] || COL.pro;
    row.addSpacer(7);
    const col = row.addStack(); col.layoutVertically();
    txt(col, e.t, F.semi(13.5), INK, 2);
    txt(col, isLive(e) ? "jusqu'à " + hm(e.e) : (e.d !== todayIso ? dayName(e.d).replace(/^./, c => c.toUpperCase()) + " " : "") + hm(e.s), F.med(11.5), MUTED);
  } else line(w, "Rien de prévu", F.semi(14), INK);
  w.addSpacer(8);
  if (!empty) statLine(w, "steps", 13);

} else if (fam === "medium") {
  w.setPadding(14, 15, 14, 15);
  const main = w.addStack();
  const left = main.addStack();
  left.layoutVertically();
  left.size = new Size(84, 0);
  dateBlock(left, 40);
  left.addSpacer();
  if (!empty) { statLine(left, "steps", 13); left.addSpacer(6); statLine(left, "tasks", 13); }
  main.addSpacer(12);
  const right = main.addStack();
  right.layoutVertically();
  if (empty) emptyMsg(right);
  else if (!upcoming.length) line(right, "Rien de prévu ces prochains jours.", F.semi(13), INK, 2);
  else upcoming.slice(0, 3).forEach((e, i) => { if (i) right.addSpacer(9); eventRow(right, e, { h: 30, t: 13.5, s: 11.5, withDay: true, first: i === 0 }); });
  right.addSpacer();

} else {
  // grand : 4 × 4
  w.setPadding(16, 16, 14, 16);
  const head = w.addStack();
  head.centerAlignContent();
  dateBlock(head, 44);
  head.addSpacer();
  const stats = head.addStack();
  stats.layoutVertically();
  if (!empty) {
    statLine(stats, "steps", 14); stats.addSpacer(5);
    statLine(stats, "tasks", 14);
    if ((data.focus && (data.focus.v || data.focus.g))) { stats.addSpacer(5); statLine(stats, "focus", 14); }
  }
  w.addSpacer(12);
  const sep = w.addStack(); sep.size = new Size(0, 1); sep.backgroundColor = dyn("#E5E5EA", "#38383A"); sep.addSpacer();
  w.addSpacer(10);

  if (empty) emptyMsg(w);
  else {
    const todayEv = upcoming.filter(e => e.d === todayIso);
    const nextDay = days.find(d => d.d > todayIso && (d.ev || []).length);
    const nextEv = nextDay ? nextDay.ev.map(e => Object.assign({}, e, { d: nextDay.d })) : [];
    const tasks = (data.tasks && data.tasks.top) || [];
    const ROW = 40, LAB = 21, GAP = 12, TASK = 20, NONE = 20, BUDGET = 272;
    let a = Math.min(todayEv.length, 4), b = Math.min(nextEv.length, 3), c = Math.min(tasks.length, 3);
    const cost = () => LAB + (a ? a * ROW : NONE) + (b ? GAP + LAB + b * ROW : 0) + (c ? GAP + LAB + c * TASK : 0);
    while (cost() > BUDGET) {
      if (a > 2) a--;
      else if (c > 2) c--;
      else if (b > 1) b--;
      else if (a > 1) a--;
      else if (c > 1) c--;
      else if (b) b = 0;
      else break;
    }
    const label = s => { line(w, s.toUpperCase(), F.bold(11), MUTED); w.addSpacer(6); };
    label("Aujourd'hui");
    if (a) todayEv.slice(0, a).forEach((e, i) => { if (i) w.addSpacer(8); eventRow(w, e, { h: 30, t: 14, s: 12, first: i === 0, place: true }); });
    else line(w, "Plus rien de prévu aujourd'hui.", F.med(13), MUTED);
    if (b) {
      w.addSpacer(12);
      const dn = dayName(nextDay.d);
      label(dn === "demain" ? "Demain" : dn + " " + new Date(nextDay.d + "T12:00:00").getDate());
      nextEv.slice(0, b).forEach((e, i) => { if (i) w.addSpacer(8); eventRow(w, e, { h: 30, t: 14, s: 12 }); });
    }
    if (c) {
      w.addSpacer(12);
      label("À faire");
      tasks.slice(0, c).forEach((t, i) => {
        if (i) w.addSpacer(5);
        const r = w.addStack(); r.centerAlignContent();
        sym(r, "circle", 13, MUTED); r.addSpacer(8);
        txt(r, t, F.med(13.5), INK);
        r.addSpacer();
      });
    }
  }
  w.addSpacer();
}

if (config.runsInWidget) Script.setWidget(w);
else if (fam === "small") await w.presentSmall();
else if (fam === "large") await w.presentLarge();
else await w.presentMedium();
Script.complete();
