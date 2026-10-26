// Passerelle d'Aube (Cloudflare Worker). 1) IA : vérifie l'utilisateur connecté puis interroge Mistral. 2) Pas iPhone : reçoit les pas envoyés par le raccourci Apple.
// 3) Agendas : Outlook (Microsoft Graph) et Google Agenda, lecture et écriture. 4) Notifications (Web Push) envoyées par la tâche planifiée.
// Variables : MISTRAL_API_KEY (secret), FIREBASE_PROJECT_ID, ALLOWED_ORIGIN, MISTRAL_MODEL, DAILY_LIMIT, MS_CLIENT_ID, MS_CLIENT_SECRET (secret), GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (secret). Liaison KV : STEPS_KV. Déclencheur cron : */5 * * * *.
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
let jwksCache = null, jwksExp = 0;
const usage = new Map();
export default {
async fetch(request, env) {
const url = new URL(request.url);
const path = url.pathname.replace(/\/+$/, "") || "/";
const origin = request.headers.get("Origin") || "";
const allowed = (env.ALLOWED_ORIGIN || "").replace(/\/$/, "");
const cors = { "Access-Control-Allow-Origin": allowed || "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Vary": "Origin" };
if (request.method === "OPTIONS") return new Response(null, { headers: cors });
if (request.method === "GET" && (path === "/ms/callback" || path === "/gc/callback")) return msCallback(url, env, path === "/gc/callback");
if (request.method !== "POST") return json({ error: "method" }, 405, cors);
if (path === "/steps") return stepsIn(request, env);
if (allowed && origin !== allowed) return json({ error: "origin" }, 403, cors);
if (!env.FIREBASE_PROJECT_ID) return json({ error: "config" }, 500, cors);
const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
let uid;
try { uid = await verifyFirebaseToken(token, env.FIREBASE_PROJECT_ID); } catch (e) { return json({ error: "auth" }, 401, cors); }
let body;
try { body = await request.json(); } catch (e) { return json({ error: "body" }, 400, cors); }
if (path === "/link" || path === "/unlink") return linkRoute(path, uid, body, env, cors);
if (path.startsWith("/ms/")) return msRoute(path, uid, body, env, cors, url);
if (path.startsWith("/push/")) return pushRoute(path, uid, body, env, cors);
if (!env.MISTRAL_API_KEY) return json({ error: "config" }, 500, cors);
const limit = parseInt(env.DAILY_LIMIT || "60", 10);
const key = uid + ":" + new Date().toISOString().slice(0, 10);
const n = (usage.get(key) || 0) + 1;
if (usage.size > 5000) usage.clear();
usage.set(key, n);
if (n > limit) return json({ error: "limit", source: "daily" }, 429, cors);
const prompt = String(body.prompt || "").slice(0, 24000);
if (!prompt) return json({ error: "prompt" }, 400, cors);
const payload = { model: env.MISTRAL_MODEL || "ministral-8b-2512", messages: [{ role: "user", content: prompt }], temperature: 0.3, max_tokens: 1200 };
if (body.json) payload.response_format = { type: "json_object" };
const r = await fetch("https://api.mistral.ai/v1/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": "Bearer " + env.MISTRAL_API_KEY.trim() }, body: JSON.stringify(payload) });
if (!r.ok) { const detail = (await r.text()).slice(0, 400); return json({ error: r.status === 429 ? "limit" : "upstream", source: "mistral", status: r.status, detail }, r.status === 429 ? 429 : 502, cors); }
const data = await r.json();
const text = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
return json({ text }, 200, cors);
},
async scheduled(event, env, ctx) { ctx.waitUntil(runPush(env)); }
};
async function linkRoute(path, uid, body, env, cors) {
if (!env.STEPS_KV) return json({ error: "config" }, 500, cors);
const old = await env.STEPS_KV.get("u:" + uid);
if (old) await env.STEPS_KV.delete("k:" + old);
if (path === "/unlink") { await env.STEPS_KV.delete("u:" + uid); return json({ ok: true }, 200, cors); }
const rt = String(body.rt || ""), apiKey = String(body.apiKey || "");
if (!rt || !apiKey) return json({ error: "body" }, 400, cors);
const t = await exchange(rt, apiKey, env);
if (!t || t.user_id !== uid) return json({ error: "auth" }, 401, cors);
const raw = crypto.getRandomValues(new Uint8Array(24));
const k = "aube_" + btoa(String.fromCharCode(...raw)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const h = await sha(k);
await env.STEPS_KV.put("k:" + h, JSON.stringify({ uid, rt: t.refresh_token || rt, apiKey, t: Date.now() }));
await env.STEPS_KV.put("u:" + uid, h);
return json({ key: k }, 200, cors);
}
async function stepsIn(request, env) {
const h0 = { "Content-Type": "application/json" };
if (!env.STEPS_KV || !env.FIREBASE_PROJECT_ID) return json({ error: "config", message: "Synchro non configurée." }, 500, h0);
let body = {};
const copy = request.clone();
try { body = await request.json(); } catch (e) { try { body = Object.fromEntries(await copy.formData()); } catch (e2) {} }
const k = String(body.key || body.cle || "").trim();
if (!/^aube_[A-Za-z0-9_-]{20,}$/.test(k)) return json({ error: "key", message: "Clé Aube invalide." }, 401, h0);
const h = await sha(k);
const rec = JSON.parse((await env.STEPS_KV.get("k:" + h)) || "null");
if (!rec) return json({ error: "key", message: "Clé Aube inconnue ou désactivée. Crée une nouvelle clé dans Aube." }, 401, h0);
const n = Math.round(parseFloat(String(body.steps == null ? "" : body.steps).replace(/[^0-9.,]/g, "").replace(",", ".")));
if (!(n >= 0) || n > 150000) return json({ error: "steps", message: "Nombre de pas illisible." }, 400, h0);
const date = /^\d{4}-\d{2}-\d{2}$/.test(String(body.date || "")) ? String(body.date) : new Intl.DateTimeFormat("fr-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const t = await exchange(rec.rt, rec.apiKey, env);
if (!t || t.user_id !== rec.uid) return json({ error: "auth", message: "Connexion expirée. Crée une nouvelle clé dans Aube." }, 401, h0);
if (t.refresh_token && t.refresh_token !== rec.rt) { rec.rt = t.refresh_token; await env.STEPS_KV.put("k:" + h, JSON.stringify(rec)); }
const doc = "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/users/" + rec.uid + "/steps/" + date + "?updateMask.fieldPaths=date&updateMask.fieldPaths=steps&updateMask.fieldPaths=src";
const w = await fetch(doc, { method: "PATCH", headers: { "Content-Type": "application/json", "Authorization": "Bearer " + t.id_token }, body: JSON.stringify({ fields: { date: { stringValue: date }, steps: { integerValue: String(n) }, src: { stringValue: "iphone" } } }) });
if (!w.ok) return json({ error: "write", status: w.status, message: "Enregistrement impossible pour le moment." }, 502, h0);
return json({ ok: true, date, steps: n, message: n.toLocaleString("fr-FR") + " pas envoyés à Aube" }, 200, h0);
}
async function exchange(rt, apiKey, env) {
const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + encodeURIComponent(apiKey), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", "Referer": (env.ALLOWED_ORIGIN || "").replace(/\/$/, "") + "/aube/" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(rt) });
if (!r.ok) return null;
return r.json();
}
async function sha(s) { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, "0")).join(""); }
function json(obj, status, headers) { return new Response(JSON.stringify(obj), { status, headers: Object.assign({}, headers, { "Content-Type": "application/json" }) }); }
function b64u(str) { return Uint8Array.from(atob(str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)), c => c.charCodeAt(0)); }
async function getJwks() {
if (jwksCache && Date.now() < jwksExp) return jwksCache;
const r = await fetch(JWKS_URL);
if (!r.ok) throw new Error("jwks");
jwksCache = (await r.json()).keys;
jwksExp = Date.now() + 3600 * 1000;
return jwksCache;
}
async function verifyFirebaseToken(token, projectId) {
const parts = token.split(".");
if (parts.length !== 3) throw new Error("format");
const h = parts[0], p = parts[1], sig = parts[2];
const header = JSON.parse(new TextDecoder().decode(b64u(h)));
const payload = JSON.parse(new TextDecoder().decode(b64u(p)));
const now = Math.floor(Date.now() / 1000);
if (header.alg !== "RS256") throw new Error("alg");
if (payload.aud !== projectId || payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("aud");
if (!payload.sub || payload.exp < now || payload.iat > now + 300) throw new Error("time");
const jwk = (await getJwks()).find(k => k.kid === header.kid);
if (!jwk) throw new Error("kid");
const cryptoKey = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, b64u(sig), new TextEncoder().encode(h + "." + p));
if (!ok) throw new Error("signature");
return payload.sub;
}

const MS_SCOPE = "offline_access openid email profile User.Read Calendars.ReadWrite";
const MS_LOGIN = "https://login.microsoftonline.com/common/oauth2/v2.0/";
const GRAPH = "https://graph.microsoft.com/v1.0";
const G_SCOPE = "openid email https://www.googleapis.com/auth/calendar.events";
const G_CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const msCache = new Map();
const siteUrl = env => (env.SITE_URL || ((env.ALLOWED_ORIGIN || "").replace(/\/$/, "") + "/aube/"));
const msRec = async (env, uid) => JSON.parse((await env.STEPS_KV.get("ms:" + uid)) || "{}");
const pad2 = n => String(n).padStart(2, "0");
const hm = m => pad2(Math.floor(m / 60)) + ":" + pad2(m % 60) + ":00";
const isG = a => a === "google";
const provOf = env => ({ ms: !!(env.MS_CLIENT_ID && env.MS_CLIENT_SECRET), google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) });
async function msRoute(path, uid, body, env, cors, url) {
const prov = provOf(env);
if (!env.STEPS_KV || (!prov.ms && !prov.google)) return json({ error: "config" }, 500, cors);
const acc = ["pro", "perso", "google"].includes(body.acc) ? body.acc : "pro";
if (path === "/ms/start") {
if (!prov[isG(acc) ? "google" : "ms"]) return json({ error: "config" }, 500, cors);
const st = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
await env.STEPS_KV.put("st:" + st, JSON.stringify({ uid, acc }), { expirationTtl: 900 });
if (isG(acc)) {
const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, response_type: "code", redirect_uri: url.origin + "/gc/callback", scope: G_SCOPE, access_type: "offline", prompt: "consent select_account", include_granted_scopes: "true", state: st });
return json({ url: "https://accounts.google.com/o/oauth2/v2/auth?" + q }, 200, cors);
}
const q = new URLSearchParams({ client_id: env.MS_CLIENT_ID, response_type: "code", redirect_uri: url.origin + "/ms/callback", response_mode: "query", scope: MS_SCOPE, state: st, prompt: "select_account" });
return json({ url: MS_LOGIN + "authorize?" + q }, 200, cors);
}
const rec = await msRec(env, uid);
if (path === "/ms/accounts") return json({ accounts: Object.entries(rec).map(([k, v]) => ({ acc: k, email: v.email, name: v.name })), providers: prov }, 200, cors);
if (path === "/ms/disconnect") { delete rec[acc]; msCache.delete(uid + ":" + acc); await env.STEPS_KV.put("ms:" + uid, JSON.stringify(rec)); return json({ ok: true }, 200, cors); }
if (path === "/ms/events") {
const from = /^\d{4}-\d{2}-\d{2}$/.test(body.from || "") ? body.from : new Date().toISOString().slice(0, 10);
const to = /^\d{4}-\d{2}-\d{2}$/.test(body.to || "") ? body.to : from;
const events = [], errors = [];
for (const k of Object.keys(rec)) {
try {
const tok = await msToken(env, uid, k, rec);
if (isG(k)) {
let pageToken = "";
for (let i = 0; i < 5; i++) {
const q = new URLSearchParams({ timeMin: from + "T00:00:00Z", timeMax: to + "T23:59:59Z", singleEvents: "true", orderBy: "startTime", maxResults: "250", timeZone: "Europe/Paris" });
if (pageToken) q.set("pageToken", pageToken);
const r = await fetch(G_CAL + "?" + q, { headers: { "Authorization": "Bearer " + tok } });
if (!r.ok) throw new Error("google " + r.status);
const d = await r.json();
for (const e of d.items || []) if (e.status !== "cancelled") events.push({ id: e.id, acc: k, title: e.summary || "(Sans titre)", start: (e.start && (e.start.dateTime || e.start.date)) || "", end: (e.end && (e.end.dateTime || e.end.date)) || "", allDay: !!(e.start && e.start.date), where: e.location || "", free: e.transparency === "transparent" });
pageToken = d.nextPageToken || ""; if (!pageToken) break;
}
} else {
let next = GRAPH + "/me/calendarView?" + new URLSearchParams({ startDateTime: from + "T00:00:00", endDateTime: to + "T23:59:59", "$select": "id,subject,start,end,location,isAllDay,isCancelled,showAs", "$orderby": "start/dateTime", "$top": "200" });
for (let i = 0; next && i < 5; i++) {
const r = await fetch(next, { headers: { "Authorization": "Bearer " + tok, "Prefer": "outlook.timezone=\"Europe/Paris\"" } });
if (!r.ok) throw new Error("graph " + r.status);
const d = await r.json();
for (const e of d.value || []) if (!e.isCancelled) events.push({ id: e.id, acc: k, title: e.subject || "(Sans titre)", start: e.start && e.start.dateTime, end: e.end && e.end.dateTime, allDay: !!e.isAllDay, where: (e.location && e.location.displayName) || "", free: e.showAs === "free" });
next = d["@odata.nextLink"] || null;
}
}
} catch (e) { errors.push({ acc: k, error: String(e.message || e) }); }
}
return json({ events, errors, accounts: Object.keys(rec) }, 200, cors);
}
const k = rec[acc] ? acc : Object.keys(rec)[0];
if (!k) return json({ error: "noaccount" }, 404, cors);
const tok = await msToken(env, uid, k, rec).catch(() => null);
if (!tok) return json({ error: "auth" }, 401, cors);
const H = { "Authorization": "Bearer " + tok, "Content-Type": "application/json" };
const when = () => ({ start: { dateTime: body.date + "T" + hm(body.start), timeZone: "Europe/Paris" }, end: { dateTime: body.date + "T" + hm(body.end), timeZone: "Europe/Paris" } });
const ev = () => isG(k) ? Object.assign({ summary: String(body.title || "Rendez-vous").slice(0, 200), location: String(body.where || "").slice(0, 200) }, when()) : Object.assign({ subject: String(body.title || "Rendez-vous").slice(0, 200), location: { displayName: String(body.where || "").slice(0, 200) } }, when());
const base = isG(k) ? G_CAL : GRAPH + "/me/events";
if (path === "/ms/create") {
if (!/^\d{4}-\d{2}-\d{2}$/.test(body.date || "") || !(body.end > body.start)) return json({ error: "body" }, 400, cors);
const r = await fetch(base, { method: "POST", headers: H, body: JSON.stringify(ev()) });
if (!r.ok) return json({ error: "graph", status: r.status }, 502, cors);
const d = await r.json();
return json({ id: d.id, acc: k }, 200, cors);
}
const id = encodeURIComponent(String(body.id || ""));
if (!id) return json({ error: "body" }, 400, cors);
if (path === "/ms/update") {
const r = await fetch(base + "/" + id, { method: "PATCH", headers: H, body: JSON.stringify(ev()) });
return json({ ok: r.ok, status: r.status }, r.ok ? 200 : 502, cors);
}
if (path === "/ms/delete") {
const r = await fetch(base + "/" + id, { method: "DELETE", headers: H });
return json({ ok: r.ok || r.status === 404 || r.status === 410, status: r.status }, 200, cors);
}
return json({ error: "path" }, 404, cors);
}
async function msToken(env, uid, k, rec) {
const c = msCache.get(uid + ":" + k);
if (c && c.exp > Date.now() + 60000) return c.tok;
const a = rec[k]; if (!a) throw new Error("noaccount");
const g = isG(k);
const r = await fetch(g ? "https://oauth2.googleapis.com/token" : MS_LOGIN + "token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(g ? { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: a.rt } : { client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, grant_type: "refresh_token", refresh_token: a.rt, scope: MS_SCOPE }) });
if (!r.ok) throw new Error("token " + r.status);
const d = await r.json();
if (d.refresh_token && d.refresh_token !== a.rt) { a.rt = d.refresh_token; await env.STEPS_KV.put("ms:" + uid, JSON.stringify(rec)); }
msCache.set(uid + ":" + k, { tok: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 });
if (msCache.size > 2000) msCache.clear();
return d.access_token;
}
async function msCallback(url, env, google) {
const back = (q) => Response.redirect(siteUrl(env) + "?" + q + "#connect", 302);
const code = url.searchParams.get("code"), st = url.searchParams.get("state");
const prov = provOf(env);
if (!code || !st || !env.STEPS_KV || !prov[google ? "google" : "ms"]) return back("ms=err");
const s = JSON.parse((await env.STEPS_KV.get("st:" + st)) || "null");
if (!s || isG(s.acc) !== !!google) return back("ms=expired");
await env.STEPS_KV.delete("st:" + st);
const r = await fetch(google ? "https://oauth2.googleapis.com/token" : MS_LOGIN + "token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(google ? { client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: url.origin + "/gc/callback" } : { client_id: env.MS_CLIENT_ID, client_secret: env.MS_CLIENT_SECRET, grant_type: "authorization_code", code, redirect_uri: url.origin + "/ms/callback", scope: MS_SCOPE }) });
if (!r.ok) return back("ms=err");
const t = await r.json();
if (!t.refresh_token) return back("ms=err");
let email = "", name = "";
try {
if (google) { const p = JSON.parse(new TextDecoder().decode(b64u(String(t.id_token || "").split(".")[1] || ""))); email = p.email || ""; name = p.name || ""; }
else { const me = await (await fetch(GRAPH + "/me?$select=displayName,mail,userPrincipalName", { headers: { "Authorization": "Bearer " + t.access_token } })).json(); email = me.mail || me.userPrincipalName || ""; name = me.displayName || ""; }
} catch (e) {}
const rec = await msRec(env, s.uid);
rec[s.acc] = { rt: t.refresh_token, email, name, t: Date.now() };
await env.STEPS_KV.put("ms:" + s.uid, JSON.stringify(rec));
msCache.set(s.uid + ":" + s.acc, { tok: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 });
return back("ms=ok&acc=" + s.acc);
}
const enc = new TextEncoder();
const b64e = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const cat = (...arrs) => { const out = new Uint8Array(arrs.reduce((t, a) => t + a.length, 0)); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
async function hmac(key, data) { const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]); return new Uint8Array(await crypto.subtle.sign("HMAC", k, data)); }
async function getVapid(env) {
let v = JSON.parse((await env.STEPS_KV.get("vapid")) || "null");
if (v) return v;
const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
v = { pub: b64e(await crypto.subtle.exportKey("raw", kp.publicKey)), jwk: await crypto.subtle.exportKey("jwk", kp.privateKey) };
await env.STEPS_KV.put("vapid", JSON.stringify(v));
return v;
}
async function vapidAuth(endpoint, v, env) {
const h = b64e(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
const p = b64e(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: siteUrl(env) })));
const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(h + "." + p));
return "vapid t=" + h + "." + p + "." + b64e(sig) + ", k=" + v.pub;
}
async function encryptPush(sub, text) {
const uaPub = b64u(sub.keys.p256dh), auth = b64u(sub.keys.auth);
const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
const ikm = await hmac(await hmac(auth, shared), cat(enc.encode("WebPush: info"), new Uint8Array([0]), uaPub, asPub, new Uint8Array([1])));
const salt = crypto.getRandomValues(new Uint8Array(16));
const prk = await hmac(salt, ikm);
const cek = (await hmac(prk, cat(enc.encode("Content-Encoding: aes128gcm"), new Uint8Array([0, 1])))).slice(0, 16);
const nonce = (await hmac(prk, cat(enc.encode("Content-Encoding: nonce"), new Uint8Array([0, 1])))).slice(0, 12);
const k = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, k, cat(enc.encode(text), new Uint8Array([2]))));
return cat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPub, ct);
}
async function sendPush(env, sub, data) {
const v = await getVapid(env);
const r = await fetch(sub.endpoint, { method: "POST", headers: { "Authorization": await vapidAuth(sub.endpoint, v, env), "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", "TTL": "3600", "Urgency": "high" }, body: await encryptPush(sub, JSON.stringify(data)) });
return r.status;
}
const pushRec = async (env, uid) => JSON.parse((await env.STEPS_KV.get("push:" + uid)) || "null") || { uid, subs: [], plan: [], sent: [] };
async function pushIndex(env, uid, add) {
const idx = JSON.parse((await env.STEPS_KV.get("push:index")) || "[]");
const has = idx.includes(uid);
if (add && !has) idx.push(uid); else if (!add && has) idx.splice(idx.indexOf(uid), 1); else return;
await env.STEPS_KV.put("push:index", JSON.stringify(idx));
}
const clip = (x, n) => String(x == null ? "" : x).slice(0, n);
async function pushRoute(path, uid, body, env, cors) {
if (!env.STEPS_KV) return json({ error: "config" }, 500, cors);
if (path === "/push/key") return json({ key: (await getVapid(env)).pub }, 200, cors);
const rec = await pushRec(env, uid);
if (path === "/push/status") return json({ subs: rec.subs.length, here: !!body.endpoint && rec.subs.some(s => s.endpoint === body.endpoint) }, 200, cors);
if (path === "/push/sub") {
const s = body.sub || {};
if (!/^https:\/\//.test(s.endpoint || "") || !s.keys || !s.keys.p256dh || !s.keys.auth) return json({ error: "body" }, 400, cors);
rec.subs = rec.subs.filter(x => x.endpoint !== s.endpoint).concat([{ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth } }]).slice(-6);
if (body.rt) rec.rt = String(body.rt); if (body.apiKey) rec.apiKey = String(body.apiKey);
await env.STEPS_KV.put("push:" + uid, JSON.stringify(rec));
await pushIndex(env, uid, true);
let status = 0;
if (!body.quiet) status = await sendPush(env, rec.subs[rec.subs.length - 1], { title: "Notifications activées", body: "Aube te préviendra ici : départs, brief du matin, pas et bilan.", tag: "welcome", url: "./#connect" }).catch(() => -1);
return json({ ok: true, subs: rec.subs.length, test: status }, 200, cors);
}
if (path === "/push/unsub") {
rec.subs = rec.subs.filter(x => x.endpoint !== body.endpoint);
await env.STEPS_KV.put("push:" + uid, JSON.stringify(rec));
if (!rec.subs.length) await pushIndex(env, uid, false);
return json({ ok: true, subs: rec.subs.length }, 200, cors);
}
if (path === "/push/plan") {
const items = (Array.isArray(body.items) ? body.items : []).slice(0, 40).filter(i => Number.isFinite(+i.at)).map(i => ({ at: +i.at, tag: clip(i.tag, 90), title: clip(i.title, 90), body: clip(i.body, 220), url: clip(i.url || "./", 40), kind: i.kind === "steps" ? "steps" : "", date: /^\d{4}-\d{2}-\d{2}$/.test(i.date || "") ? i.date : "", goal: Math.max(0, Math.min(100000, +i.goal || 0)) }));
if (JSON.stringify(items) !== JSON.stringify(rec.plan)) { rec.plan = items; await env.STEPS_KV.put("push:" + uid, JSON.stringify(rec)); }
return json({ ok: true, n: items.length }, 200, cors);
}
return json({ error: "path" }, 404, cors);
}
async function readSteps(env, rec, date) {
if (!rec.rt || !rec.apiKey || !env.FIREBASE_PROJECT_ID) return null;
const t = await exchange(rec.rt, rec.apiKey, env);
if (!t || !t.id_token) return null;
const r = await fetch("https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID + "/databases/(default)/documents/users/" + rec.uid + "/steps/" + date, { headers: { "Authorization": "Bearer " + t.id_token } });
if (r.status === 404) return 0;
if (!r.ok) return null;
const d = await r.json();
return d.fields && d.fields.steps ? +(d.fields.steps.integerValue || d.fields.steps.doubleValue || 0) : 0;
}
async function runPush(env) {
if (!env.STEPS_KV) return;
const idx = JSON.parse((await env.STEPS_KV.get("push:index")) || "[]"), now = Date.now();
for (const uid of idx) {
try {
const rec = await pushRec(env, uid);
const due = (rec.plan || []).filter(i => i.at <= now + 150000 && i.at > now - 20 * 60000 && !rec.sent.includes(i.tag));
if (!due.length || !rec.subs.length) continue;
let changed = false;
for (const it of due) {
rec.sent.push(it.tag); changed = true;
let body = it.body;
if (it.kind === "steps") {
const n = await readSteps(env, rec, it.date);
if (n == null || !it.goal || n >= it.goal * 0.75) continue;
body = "Tu en es à " + n.toLocaleString("fr-FR") + " pas sur " + it.goal.toLocaleString("fr-FR") + ". Une petite marche avant la fin de journée ?";
}
const alive = [];
for (const s of rec.subs) { const st = await sendPush(env, s, { title: it.title, body, tag: it.tag, url: it.url }).catch(() => 0); if (st !== 404 && st !== 410) alive.push(s); }
rec.subs = alive;
}
rec.sent = rec.sent.slice(-200);
if (changed) await env.STEPS_KV.put("push:" + uid, JSON.stringify(rec));
if (!rec.subs.length) await pushIndex(env, uid, false);
} catch (e) {}
}
}
