// Prima Fila: diario di film e serie per due. Cosa avete visto e i voti di ognuno, cosa vedere dopo
// (da soli o insieme), a che episodio siete arrivati e "stasera cosa guardiamo?".
// Tutto resta nel telefono; per passare titoli all'altro telefono si condivide una lista da importare.
import { db, getSetting, setSetting } from './db.js';
import { search, details, genres as loadGenres, providers as loadProviders, discover, poster } from './tmdb.js';
import { bars, hbars } from './charts.js';
import { APP_VERSION } from './version.js';

const $ = sel => document.querySelector(sel);
const view = $('#view');
const sheet = $('#sheet');
const native = window.Android;   // presente solo nell'APK Android

const esc = s => String(s ?? '').replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const fmt = n => (n == null || isNaN(n) ? '—' : (Math.round(n * 10) / 10).toLocaleString('it-IT'));
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const shortDate = iso => new Date(iso + 'T12:00:00').toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: '2-digit' });
const monthName = k => new Date(k + '-15T12:00:00').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
const hours = min => (min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`);
const shuffle = list => list.map(x => [Math.random(), x]).sort((a, b) => a[0] - b[0]).map(([, x]) => x);

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, 2600);
}

// ---------------------------------------------------------------------------
// Stato
// Titolo nel diario: { key, type, id, title, original, year, poster, backdrop, genres, runtime, seasons,
//   providerIds, want: { me, partner }, status: 'watching' | 'watched' | 'dropped' | null,
//   views: [{ date, who: ['me', 'partner'] }], ratings: { me, partner }, progress: { s, e }, note, added, updated }
// "me" è chi usa questo telefono, "partner" l'altra persona (i nomi sono nel profilo).
// ---------------------------------------------------------------------------
let titles = new Map();
let profile = { me: '', partner: '' };
let myPlatforms = [];            // id delle piattaforme che avete (per "stasera" e per i loghi)
let genreNames = {};             // id → nome del genere in italiano
let allProviders = [];
let lastBackup = null;
const briefs = new Map();      // titoli mostrati di recente (per salvarli anche se il dettaglio non arriva)

const nameOf = who => (who === 'me' ? profile.me || 'Io' : profile.partner || 'Partner');
const saveTitle = async t => { t.updated = today(); titles.set(t.key, t); await db.put('titles', t); };
const isWanted = t => t.want?.me || t.want?.partner;
const isTogether = t => t.want?.me && t.want?.partner;

/** Nuovo titolo del diario a partire dal riassunto o dal dettaglio del catalogo. */
function newTitle(d) {
  return {
    key: d.key, type: d.type, id: d.id, title: d.title, original: d.original, year: d.year, poster: d.poster,
    backdrop: d.backdrop, genres: d.genres ?? [], runtime: d.runtime ?? null, seasons: d.seasons ?? [],
    providerIds: d.providers ? d.providers.stream.map(p => p.id) : null,
    want: { me: false, partner: false }, status: null, views: [], ratings: {}, progress: null, note: '', added: today(),
  };
}

/** Aggiorna i dati del catalogo salvati nel diario (durata, stagioni, piattaforme) quando si apre un titolo. */
function refreshFrom(t, d) {
  Object.assign(t, { title: d.title, poster: d.poster, backdrop: d.backdrop, genres: d.genres, runtime: d.runtime,
    seasons: d.seasons, providerIds: d.providers.stream.map(p => p.id), year: d.year });
}

// ---------------------------------------------------------------------------
// Pezzi comuni
// ---------------------------------------------------------------------------
const STAR = '★';
function posterImg(t, size = 'w342') {
  const src = poster(t.poster, size);
  return src ? `<img src="${src}" alt="" loading="lazy">` : `<span class="noposter">${esc(t.title)}</span>`;
}

/** Locandina con titolo e, se c'è, il voto di ognuno (o lo stato). */
function card(t, extra = '') {
  briefs.set(t.key, t);
  const mine = titles.get(t.key) ?? t;
  const r = mine.ratings ?? {};
  const badge = mine.status === 'watched'
    ? `<span class="badge">${['me', 'partner'].filter(w => r[w] != null).map(w => `${nameOf(w)[0]} ${r[w]}`).join(' · ') || '✓'}</span>`
    : mine.status === 'watching' ? `<span class="badge live">${mine.progress ? `S${mine.progress.s} E${mine.progress.e}` : 'In corso'}</span>`
    : isWanted(mine) ? `<span class="badge want">${isTogether(mine) ? 'Insieme' : 'Io'}</span>` : '';
  return `<button class="card" data-open="${t.type}:${t.id}">${posterImg(t)}${badge}
    <span class="card-title">${esc(t.title)}</span><small>${esc(t.year)}${t.type === 'tv' ? ' · serie' : ''}${extra}</small></button>`;
}

const grid = list => (list.length ? `<div class="grid">${list.map(t => card(t)).join('')}</div>` : '');

function logoRow(list) {
  return `<div class="logos">${list.map(p => `<img src="${poster(p.logo, 'w92')}" alt="${esc(p.name)}" title="${esc(p.name)}">`).join('')}</div>`;
}

// ---------------------------------------------------------------------------
// Stasera: cosa guardiamo + serie in corso + ultimi visti
// ---------------------------------------------------------------------------
// Umori → generi del catalogo (gli id dei film e delle serie a volte sono diversi).
const MOODS = [
  ['ridere', 'Ridere', [35]],
  ['emozioni', 'Emozionarsi', [18, 10749]],
  ['brividi', 'Brividi', [27, 53, 9648]],
  ['azione', 'Azione', [28, 12, 10759, 10752]],
  ['gialli', 'Gialli', [80, 9648]],
  ['fantasia', 'Fantasia', [878, 14, 10765]],
  ['leggero', 'Leggero', [16, 10751, 35, 10402]],
  ['realta', 'Storie vere', [99, 36, 10764]],
];
let pick = { who: 'insieme', type: 'any', time: 'any', moods: [], where: 'mine', fresh: false };
let suggestion = null, seen = new Set();

function tonightPage() {
  const watching = [...titles.values()].filter(t => t.status === 'watching').sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  const recent = [...titles.values()].filter(t => t.status === 'watched' && t.views.length)
    .sort((a, b) => b.views.at(-1).date.localeCompare(a.views.at(-1).date)).slice(0, 9);
  const together = [...titles.values()].filter(t => isTogether(t) && t.status !== 'watched').length;
  const chips = (key, options) => options.map(([v, label]) => `<button class="chip ${pick[key] === v ? 'on' : ''}" data-pick-${key}="${v}">${esc(label)}</button>`).join('');
  view.innerHTML = `<header class="top"><div class="brand">PF</div><h1>Prima Fila</h1></header>
    ${updateBanner()}${backupReminder()}
    ${!profile.me ? `<a class="hint" href="#/altro"><b>Come vi chiamate?</b><span>Scrivi i vostri due nomi in Altro: servono per i voti di ognuno e per le liste.</span></a>` : ''}
    <section class="tonight">
      <h2 class="big">Cosa guardiamo stasera?</h2>
      <div class="pick-row"><span>Chi</span><div class="chips">${chips('who', [['insieme', 'Insieme'], ['me', 'Io']])}</div></div>
      <div class="pick-row"><span>Cosa</span><div class="chips">${chips('type', [['any', 'Tutto'], ['movie', 'Film'], ['tv', 'Serie']])}</div></div>
      <div class="pick-row"><span>Tempo</span><div class="chips">${chips('time', [['any', 'Quanto serve'], ['105', '< 1h45'], ['135', '< 2h15']])}</div></div>
      <div class="pick-row"><span>Voglia di</span><div class="chips">${MOODS.map(([v, label]) => `<button class="chip ${pick.moods.includes(v) ? 'on' : ''}" data-mood="${v}">${label}</button>`).join('')}</div></div>
      ${myPlatforms.length ? `<div class="pick-row"><span>Dove</span><div class="chips">${chips('where', [['mine', 'Le nostre piattaforme'], ['any', 'Ovunque']])}</div></div>`
        : '<p class="note">Scegli in Altro le piattaforme che avete: propongo solo quello che potete vedere.</p>'}
      <label class="check"><input type="checkbox" id="pickFresh" ${pick.fresh ? 'checked' : ''}> Proponi anche titoli nuovi, non solo dalla lista "Da vedere"</label>
      <button class="primary" data-suggest>Scegli tu!</button>
      <div id="suggestion"></div>
      ${together ? `<p class="note">${plural(together, 'titolo', 'titoli')} da vedere insieme in lista.</p>` : ''}
    </section>
    ${watching.length ? `<h2>Serie in corso</h2><div class="ongoing">${watching.map(ongoingRow).join('')}</div>` : ''}
    ${recent.length ? `<h2>Visti di recente</h2>${grid(recent)}` : ''}
    ${titles.size ? '' : `<div class="empty-state"><h2>Il diario è vuoto</h2><p>Cerca un film o una serie con il pulsante in basso:
      segnalo come visto (con i vostri voti) o mettilo nella lista da vedere.</p><a class="primary" href="#/cerca">Cerca un titolo</a></div>`}`;
}

/** Riga di una serie in corso: locandina, punto in cui siete e +1 episodio. */
function ongoingRow(t) {
  const p = t.progress ?? { s: 1, e: 0 };
  const season = t.seasons?.find(s => s.n === p.s);
  return `<div class="ongoing-row"><button class="mini" data-open="${t.type}:${t.id}">${posterImg(t, 'w154')}</button>
    <span class="ongoing-info"><b>${esc(t.title)}</b><small>Stagione ${p.s} · episodio ${p.e}${season ? ` di ${season.episodes}` : ''}</small>
      ${season ? `<span class="bar"><i style="width:${Math.min(100, (p.e / season.episodes) * 100)}%"></i></span>` : ''}</span>
    <button class="plus" data-next-ep="${t.key}" aria-label="Episodio visto">+1</button></div>`;
}

/** Candidati dalla lista "Da vedere" secondo i filtri. */
function listCandidates() {
  const moodGenres = MOODS.filter(m => pick.moods.includes(m[0])).flatMap(m => m[2]);
  return [...titles.values()].filter(t => {
    if (t.status === 'watched' || t.status === 'dropped') return false;
    const wanted = pick.who === 'insieme' ? isTogether(t) || (t.status === 'watching' && isWanted(t)) : t.want?.[pick.who];
    if (!wanted && t.status !== 'watching') return false;
    if (pick.type !== 'any' && t.type !== pick.type) return false;
    if (pick.time !== 'any' && t.type === 'movie' && t.runtime && t.runtime > +pick.time) return false;
    if (moodGenres.length && !t.genres?.some(g => moodGenres.includes(g))) return false;
    if (pick.where === 'mine' && myPlatforms.length && t.providerIds && !t.providerIds.some(p => myPlatforms.includes(p))) return false;
    return true;
  });
}

async function suggest() {
  const out = $('#suggestion');
  out.innerHTML = '<p class="note">Cerco…</p>';
  let pool = shuffle(listCandidates()).filter(t => !seen.has(t.key));
  let fromList = true;
  if (!pool.length || pick.fresh && Math.random() < 0.5) {
    try {
      const moodGenres = MOODS.filter(m => pick.moods.includes(m[0])).flatMap(m => m[2]);
      const types = pick.type === 'any' ? ['movie', 'tv'] : [pick.type];
      const lists = await Promise.all(types.map(type => discover(type, {
        platforms: pick.where === 'mine' ? myPlatforms : [], genres: moodGenres,
        maxRuntime: pick.time === 'any' ? null : +pick.time, page: 1 + Math.floor(Math.random() * 3),
      })));
      const fresh = shuffle(lists.flat()).filter(t => !seen.has(t.key) && !titles.has(t.key));
      if (fresh.length) { pool = fresh; fromList = false; }
    } catch {
      if (!pool.length) { out.innerHTML = '<p class="note">Senza connessione posso scegliere solo dalla lista "Da vedere".</p>'; return; }
    }
  }
  if (!pool.length) {
    seen.clear();
    out.innerHTML = `<p class="note">Niente che corrisponda ai filtri. Prova a toglierne qualcuno${pick.fresh ? '' : ' o attiva "Proponi anche titoli nuovi"'}.</p>`;
    return;
  }
  suggestion = pool[0];
  seen.add(suggestion.key);
  out.innerHTML = '<p class="note">Un attimo…</p>';
  let d = null;
  try { d = await details(suggestion.type, suggestion.id); } catch { /* offline: si mostra quello che c'è */ }
  const t = d ?? suggestion;
  const stream = d?.providers.stream ?? [];
  const mine = stream.filter(p => myPlatforms.includes(p.id));
  out.innerHTML = `<div class="suggest">
    <button class="suggest-poster" data-open="${t.type}:${t.id}">${posterImg(t, 'w342')}</button>
    <div class="suggest-body">
      <small class="from">${fromList ? 'Dalla vostra lista' : 'Proposta nuova'}</small>
      <b>${esc(t.title)}</b>
      <small>${esc([t.year, t.type === 'tv' ? (d?.seasons.length ? plural(d.seasons.length, 'stagione', 'stagioni') : 'serie') : d?.runtime ? hours(d.runtime) : '',
        (d?.genreNames ?? []).slice(0, 2).join(', ')].filter(Boolean).join(' · '))}</small>
      ${t.vote ? `<small class="vote">${STAR} ${fmt(t.vote)} su TMDB</small>` : ''}
      <p>${esc((t.overview || '').slice(0, 220))}${(t.overview || '').length > 220 ? '…' : ''}</p>
      ${stream.length ? `<small>${mine.length ? 'Su' : 'Disponibile su'}</small>${logoRow(mine.length ? mine : stream.slice(0, 4))}` : ''}
    </div></div>
    <div class="actions"><button class="primary" data-open="${t.type}:${t.id}">Questo!</button><button class="secondary" data-suggest>Un altro</button></div>`;
}

// ---------------------------------------------------------------------------
// Da vedere
// ---------------------------------------------------------------------------
let listWho = 'insieme', listType = 'any', listSort = 'added';

function listPage() {
  const all = [...titles.values()].filter(t => isWanted(t) && t.status !== 'watched' && t.status !== 'dropped');
  const shown = all.filter(t => (listWho === 'insieme' ? isTogether(t) : listWho === 'tutti' ? true : t.want[listWho] && !isTogether(t)))
    .filter(t => listType === 'any' || t.type === listType)
    .sort(listSort === 'title' ? (a, b) => a.title.localeCompare(b.title) : listSort === 'short' ? (a, b) => (a.runtime ?? 999) - (b.runtime ?? 999)
      : (a, b) => (b.added ?? '').localeCompare(a.added ?? ''));
  const count = w => all.filter(t => (w === 'insieme' ? isTogether(t) : w === 'tutti' ? true : t.want[w] && !isTogether(t))).length;
  const chip = (key, cur, v, label) => `<button class="chip ${cur === v ? 'on' : ''}" data-${key}="${v}">${esc(label)}</button>`;
  view.innerHTML = `<header class="top"><h1>Da vedere</h1></header>
    <div class="chips scroll">${[['insieme', 'Insieme'], ['me', 'Io'], ['tutti', 'Tutti']]
      .map(([v, l]) => chip('list-who', listWho, v, `${l} ${count(v)}`)).join('')}</div>
    <div class="chips scroll">${chip('list-type', listType, 'any', 'Film e serie')}${chip('list-type', listType, 'movie', 'Film')}${chip('list-type', listType, 'tv', 'Serie')}
      <select id="listSort" aria-label="Ordina"><option value="added" ${listSort === 'added' ? 'selected' : ''}>Ultimi aggiunti</option>
        <option value="title" ${listSort === 'title' ? 'selected' : ''}>Per titolo</option><option value="short" ${listSort === 'short' ? 'selected' : ''}>Più corti</option></select></div>
    ${grid(shown) || `<p class="empty">${all.length ? 'Niente in questa lista.' : 'La lista è vuota: cerca un titolo e tocca "Da vedere".'}</p>`}`;
}

// ---------------------------------------------------------------------------
// Cerca
// ---------------------------------------------------------------------------
let lastQuery = '', lastResults = [];

function searchPage() {
  view.innerHTML = `<header class="top"><h1>Cerca</h1></header>
    <form id="searchForm"><input type="search" id="q" value="${esc(lastQuery)}" placeholder="Film o serie (es. Inception, Mare fuori)" autocomplete="off" enterkeyhint="search"></form>
    <div id="results">${lastResults.length ? grid(lastResults) : '<p class="note">Scrivi il titolo, anche in inglese: i risultati sono in italiano.</p>'}</div>`;
  if (!lastQuery) $('#q').focus();
}

let searchSeq = 0;
async function runSearch(q) {
  lastQuery = q;
  const seq = ++searchSeq;
  if (q.length < 2) { $('#results').innerHTML = ''; return; }
  $('#results').innerHTML = '<p class="note">Cerco…</p>';
  try {
    const res = await search(q);
    if (seq !== searchSeq) return;
    lastResults = res;
    $('#results').innerHTML = grid(res) || '<p class="note">Nessun risultato.</p>';
  } catch {
    if (seq === searchSeq) $('#results').innerHTML = '<p class="note">Serve la connessione per cercare nel catalogo.</p>';
  }
}

// ---------------------------------------------------------------------------
// Scheda del titolo
// ---------------------------------------------------------------------------
let openKey = null;

async function openTitle(type, id) {
  const key = `${type}:${id}`;
  openKey = key;
  const saved = titles.get(key);
  sheet.innerHTML = `<div class="sheet-head"><h2>${esc(saved?.title ?? '…')}</h2><button class="icon" data-close aria-label="Chiudi">✕</button></div><p class="note">Carico…</p>`;
  if (!sheet.open) sheet.showModal();
  let d = null;
  try { d = await details(type, id); } catch { /* offline */ }
  if (openKey !== key) return;
  if (d && saved) { refreshFrom(saved, d); saveTitle(saved); }
  renderTitle(key, d);
}

function renderTitle(key, d) {
  const t = titles.get(key);
  const base = d ?? t;
  if (!base) { sheet.innerHTML = '<p class="note">Titolo non disponibile senza connessione.</p>'; return; }
  const [type] = key.split(':');
  const info = [base.year, type === 'tv' ? (d?.seasons?.length ? plural(d.seasons.length, 'stagione', 'stagioni') : 'serie') : d?.runtime ? hours(d.runtime) : '',
    (d?.genreNames ?? (base.genres ?? []).map(g => genreNames[g]).filter(Boolean)).slice(0, 3).join(', ')].filter(Boolean).join(' · ');
  const want = t?.want ?? {};
  sheet.innerHTML = `<div class="hero" style="${base.backdrop ? `background-image:url('${poster(base.backdrop, 'w780')}')` : ''}">
      <button class="icon close" data-close aria-label="Chiudi">✕</button>
      <div class="hero-poster">${posterImg(base, 'w342')}</div></div>
    <h2 class="title">${esc(base.title)}</h2>
    ${base.original && base.original !== base.title ? `<p class="orig">${esc(base.original)}</p>` : ''}
    <p class="info">${esc(info)}${base.vote ? ` · <span class="vote">${STAR} ${fmt(base.vote)}</span>` : ''}</p>

    ${t?.status === 'watched' ? watchedBox(t) : ''}
    ${t?.status === 'watching' ? progressBox(t) : ''}

    <div class="want">
      <span>Da vedere</span>
      <button class="chip ${want.me && !want.partner ? 'on' : ''}" data-want="me">Io</button>
      <button class="chip ${want.me && want.partner ? 'on' : ''}" data-want="insieme">Insieme</button>
    </div>
    <div class="actions">
      <button class="primary" data-watched>${t?.status === 'watched' ? 'Visto di nuovo' : "L'abbiamo visto"}</button>
      ${type === 'tv' && t?.status !== 'watching' ? '<button class="secondary" data-start-tv>Stiamo guardando</button>' : ''}
    </div>

    ${d?.tagline ? `<p class="tagline">${esc(d.tagline)}</p>` : ''}
    ${base.overview ? `<p class="overview">${esc(base.overview)}</p>` : ''}
    ${d ? `<p class="credits">${d.director.length ? `<b>Regia</b> ${esc(d.director.join(', '))}<br>` : ''}${d.creators.length ? `<b>Ideata da</b> ${esc(d.creators.join(', '))}<br>` : ''}${d.cast.length ? `<b>Con</b> ${esc(d.cast.join(', '))}` : ''}</p>` : ''}
    ${d ? `<h3>Dove vederlo</h3>${d.providers.stream.length ? `<small>In abbonamento</small>${logoRow(d.providers.stream)}` : ''}
      ${d.providers.free.length ? `<small>Gratis</small>${logoRow(d.providers.free)}` : ''}
      ${d.providers.rent.length ? `<small>A noleggio</small>${logoRow(d.providers.rent.slice(0, 6))}` : ''}
      ${!d.providers.stream.length && !d.providers.free.length && !d.providers.rent.length ? '<p class="note">Al momento non risulta su nessuna piattaforma in Italia.</p>' : ''}
      <p class="note small">Dati delle piattaforme forniti da JustWatch.</p>` : ''}
    ${d?.trailer ? `<a class="video" href="${d.trailer}" target="_blank" rel="noopener">▶ Guarda il trailer</a>` : ''}
    ${t ? `<label class="field stack"><span>Note</span><textarea id="titleNote" rows="2" placeholder="es. consigliato da Marco">${esc(t.note)}</textarea></label>` : ''}
    ${d?.similar.length ? `<h3>Se vi piace, provate anche</h3><div class="hscroll">${d.similar.map(s => card(s)).join('')}</div>` : ''}
    ${t ? '<button class="link danger" data-remove>Togli dal diario</button>' : ''}`;
  sheet.dataset.key = key;
  sheet.scrollTop = 0;
}

function watchedBox(t) {
  const r = t.ratings ?? {};
  const diff = r.me != null && r.partner != null ? Math.abs(r.me - r.partner) : null;
  return `<div class="watched-box">
    <div class="votes">${['me', 'partner'].map(w => `<div><small>${esc(nameOf(w))}</small><b>${r[w] != null ? r[w] : '—'}</b></div>`).join('')}</div>
    ${diff != null ? `<p class="note">${diff === 0 ? 'Stesso voto: perfettamente d\'accordo!' : diff >= 3 ? 'Qui non siete proprio d\'accordo.' : ''}</p>` : ''}
    <small>${t.views.map(v => `${shortDate(v.date)} · ${v.who.length === 2 ? 'insieme' : esc(nameOf(v.who[0]))}`).join('<br>')}</small>
    <button class="link" data-rate>Cambia voti o data</button></div>`;
}

function progressBox(t) {
  const p = t.progress ?? { s: 1, e: 0 };
  const seasons = t.seasons?.length ? t.seasons : [{ n: p.s, episodes: 99 }];
  const season = seasons.find(s => s.n === p.s) ?? seasons[0];
  return `<div class="progress-box">
    <b>Siete arrivati a</b>
    <div class="ep-row">
      <select id="seasonSel">${seasons.map(s => `<option value="${s.n}" ${s.n === p.s ? 'selected' : ''}>Stagione ${s.n}</option>`).join('')}</select>
      <div class="stepper"><button data-ep="-1" aria-label="Episodio precedente">−</button><b>Ep. ${p.e}</b><button data-ep="1" aria-label="Episodio successivo">+</button></div>
    </div>
    <small>${season.episodes < 99 ? `${season.episodes} episodi in questa stagione` : ''}</small>
    <div class="actions"><button class="secondary" data-finish-tv>Finita</button><button class="secondary" data-drop>L'abbiamo lasciata</button></div></div>`;
}

/** Il titolo nel diario (lo crea se serve, prendendo i dati dal catalogo). */
async function ensureTitle(key) {
  if (titles.has(key)) return titles.get(key);
  const [type, id] = key.split(':');
  let d = null;
  try { d = await details(type, +id); } catch { /* offline */ }
  const base = d ?? briefs.get(key);
  if (!base) throw new Error('Serve la connessione per aggiungere questo titolo.');
  const t = newTitle(base);
  if (d) refreshFrom(t, d);
  return t;
}

// Voti: chi l'ha visto, quando, e un voto da 1 a 10 per ognuno.
let rateDraft = null;
async function rateSheet(key) {
  const t = await ensureTitle(key);
  const last = t.views.at(-1);
  rateDraft = {
    key, date: today(),
    who: last?.who ?? (t.want.me && !t.want.partner ? ['me'] : !t.want.me && t.want.partner ? ['partner'] : ['me', 'partner']),
    ratings: { ...t.ratings }, editLast: t.status === 'watched' && sheet.dataset.mode === 'edit',
  };
  renderRate(t);
}

function renderRate(t) {
  const r = rateDraft;
  sheet.innerHTML = `<div class="sheet-head"><div><h2>${esc(t.title)}</h2><small>${r.editLast ? 'Cambia voti o data' : 'Com\'è stato?'}</small></div>
      <button class="icon" data-close aria-label="Chiudi">✕</button></div>
    <label class="field stack"><span>Quando</span><input type="date" id="rateDate" value="${r.date}" max="${today()}"></label>
    <div class="field stack"><span>Chi l'ha visto</span><div class="chips">
      <button class="chip ${r.who.length === 1 && r.who[0] === 'me' ? 'on' : ''}" data-who="me">Io</button>
      <button class="chip ${r.who.length === 2 ? 'on' : ''}" data-who="insieme">Insieme</button></div></div>
    ${['me', 'partner'].filter(w => r.who.includes(w)).map(w => `<div class="field stack"><span>Voto di ${esc(nameOf(w))}</span>
      <div class="rate">${Array.from({ length: 10 }, (_, i) => `<button class="${r.ratings[w] === i + 1 ? 'on' : ''} ${r.ratings[w] >= i + 1 ? 'fill' : ''}" data-rate-val="${w}:${i + 1}">${i + 1}</button>`).join('')}</div></div>`).join('')}
    <button class="primary" data-save-rate>Salva</button>`;
}

async function saveRate() {
  const r = rateDraft;
  const t = await ensureTitle(r.key);
  r.date = $('#rateDate').value || today();
  if (!r.who.length) return toast('Scegli chi l\'ha visto.');
  if (r.editLast && t.views.length) t.views[t.views.length - 1] = { date: r.date, who: r.who };
  else t.views.push({ date: r.date, who: r.who });
  t.views.sort((a, b) => a.date.localeCompare(b.date));
  t.ratings = { ...t.ratings };
  for (const w of ['me', 'partner']) if (r.who.includes(w) && r.ratings[w] != null) t.ratings[w] = r.ratings[w];
  t.status = 'watched';
  for (const w of r.who) t.want[w] = false;   // chi l'ha visto non lo ha più "da vedere"
  await saveTitle(t);
  toast('Salvato nel diario');
  sheet.dataset.mode = '';
  openTitle(t.type, t.id);
  route();
}

// ---------------------------------------------------------------------------
// Diario: visti, in corso, statistiche
// ---------------------------------------------------------------------------
let diaryWho = 'tutti', diaryTab = 'visti';

function diaryPage() {
  const watched = [...titles.values()].filter(t => t.status === 'watched' && t.views.length);
  const filtered = watched.filter(t => diaryWho === 'tutti' || (diaryWho === 'insieme'
    ? t.views.some(v => v.who.length === 2) : t.views.some(v => v.who.length === 1 && v.who[0] === diaryWho)));
  const views = filtered.flatMap(t => t.views.map(v => ({ t, v }))).sort((a, b) => b.v.date.localeCompare(a.v.date));
  const byMonth = new Map();
  for (const x of views) {
    const k = x.v.date.slice(0, 7);
    if (!byMonth.has(k)) byMonth.set(k, []);
    byMonth.get(k).push(x);
  }
  const ongoing = [...titles.values()].filter(t => t.status === 'watching');
  const dropped = [...titles.values()].filter(t => t.status === 'dropped');
  const chip = (key, cur, v, label) => `<button class="chip ${cur === v ? 'on' : ''}" data-${key}="${v}">${esc(label)}</button>`;
  view.innerHTML = `<header class="top"><h1>Diario</h1></header>
    <div class="chips scroll">${chip('diary-tab', diaryTab, 'visti', 'Visti')}${chip('diary-tab', diaryTab, 'corso', `In corso ${ongoing.length}`)}${chip('diary-tab', diaryTab, 'stats', 'Statistiche')}</div>
    ${diaryTab === 'visti' ? `<div class="chips scroll">${[['tutti', 'Tutti'], ['insieme', 'Insieme'], ['me', 'Io']].map(([v, l]) => chip('diary-who', diaryWho, v, l)).join('')}</div>
      ${[...byMonth].map(([k, list]) => `<h2>${esc(monthName(k))} <small>${list.length}</small></h2>${list.map(({ t, v }) => diaryRow(t, v)).join('')}`).join('')
        || '<p class="empty">Ancora niente: quando finite un film o una serie, toccate "L\'abbiamo visto".</p>'}` : ''}
    ${diaryTab === 'corso' ? `${ongoing.length ? `<div class="ongoing">${ongoing.map(ongoingRow).join('')}</div>` : '<p class="empty">Nessuna serie in corso.</p>'}
      ${dropped.length ? `<h2>Lasciate a metà</h2>${grid(dropped)}` : ''}` : ''}
    ${diaryTab === 'stats' ? statsBlock(watched) : ''}`;
}

function diaryRow(t, v) {
  const r = t.ratings ?? {};
  return `<button class="row" data-open="${t.type}:${t.id}"><span class="mini">${posterImg(t, 'w154')}</span>
    <span class="row-body"><b>${esc(t.title)}</b><small>${shortDate(v.date)} · ${v.who.length === 2 ? 'insieme' : esc(nameOf(v.who[0]))}${t.type === 'tv' ? ' · serie' : ''}</small></span>
    <span class="row-votes">${['me', 'partner'].filter(w => r[w] != null).map(w => `<span><small>${esc(nameOf(w)[0])}</small>${r[w]}</span>`).join('')}</span></button>`;
}

function statsBlock(watched) {
  if (!watched.length) return '<p class="empty">Le statistiche arrivano con i primi titoli visti.</p>';
  const films = watched.filter(t => t.type === 'movie'), series = watched.filter(t => t.type === 'tv');
  const minutes = films.reduce((a, t) => a + (t.runtime ?? 110) * t.views.length, 0)
    + series.reduce((a, t) => a + (t.runtime ?? 45) * (t.seasons?.reduce((s, x) => s + x.episodes, 0) || 8), 0);
  const avg = w => { const v = watched.map(t => t.ratings?.[w]).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
  const pairs = watched.filter(t => t.ratings?.me != null && t.ratings?.partner != null);
  const agree = pairs.filter(t => Math.abs(t.ratings.me - t.ratings.partner) <= 1).length;
  const disagree = [...pairs].sort((a, b) => Math.abs(b.ratings.me - b.ratings.partner) - Math.abs(a.ratings.me - a.ratings.partner)).filter(t => Math.abs(t.ratings.me - t.ratings.partner) >= 3).slice(0, 5);
  const top = [...pairs].sort((a, b) => (b.ratings.me + b.ratings.partner) - (a.ratings.me + a.ratings.partner)).slice(0, 5);
  const genreCount = new Map();
  for (const t of watched) for (const g of t.genres ?? []) if (genreNames[g]) genreCount.set(genreNames[g], (genreCount.get(genreNames[g]) ?? 0) + 1);
  const topGenres = [...genreCount].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value).slice(0, 8);
  const months = [];
  const now = new Date();
  for (let i = 11; i >= 0; i--) months.push(new Date(now.getFullYear(), now.getMonth() - i, 15).toISOString().slice(0, 7));
  const perMonth = months.map(m => watched.reduce((a, t) => a + t.views.filter(v => v.date.startsWith(m)).length, 0));
  return `<div class="kpis">
      <div><b>${films.length}</b><small>film visti</small></div>
      <div><b>${series.length}</b><small>serie finite</small></div>
      <div><b>${hours(minutes).replace(/ \d+$/, '')}</b><small>davanti allo schermo (circa)</small></div>
      <div><b>${pairs.length ? Math.round((agree / pairs.length) * 100) + '%' : '—'}</b><small>titoli su cui siete d'accordo (±1)</small></div>
      <div><b>${fmt(avg('me'))}</b><small>voto medio di ${esc(nameOf('me'))}</small></div>
      <div><b>${fmt(avg('partner'))}</b><small>voto medio di ${esc(nameOf('partner'))}</small></div></div>
    <h2>Visti per mese</h2>
    ${bars({ labels: months.map(m => new Date(m + '-15').toLocaleDateString('it-IT', { month: 'short' })), series: [{ name: 'Visti', color: '#d7263d', values: perMonth }], fmt: v => plural(v, 'titolo', 'titoli') })}
    ${topGenres.length ? `<h2>Generi preferiti</h2>${hbars(topGenres, v => v, '#d7263d')}` : ''}
    ${top.length ? `<h2>I vostri preferiti</h2>${top.map(t => `<button class="row" data-open="${t.type}:${t.id}"><span class="mini">${posterImg(t, 'w154')}</span>
      <span class="row-body"><b>${esc(t.title)}</b><small>${esc(nameOf('me'))} ${t.ratings.me} · ${esc(nameOf('partner'))} ${t.ratings.partner}</small></span></button>`).join('')}` : ''}
    ${disagree.length ? `<h2>Dove non siete d'accordo</h2>${disagree.map(t => `<button class="row" data-open="${t.type}:${t.id}"><span class="mini">${posterImg(t, 'w154')}</span>
      <span class="row-body"><b>${esc(t.title)}</b><small>${esc(nameOf('me'))} ${t.ratings.me} · ${esc(nameOf('partner'))} ${t.ratings.partner}</small></span></button>`).join('')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Altro: nomi, piattaforme, condivisione, backup, aggiornamenti
// ---------------------------------------------------------------------------
async function morePage() {
  view.innerHTML = `<header class="top"><h1>Altro</h1></header>
    <h2>Voi due</h2>
    <label class="field"><span>Il tuo nome</span><input id="nameMe" value="${esc(profile.me)}" placeholder="es. Giuseppe" autocomplete="off"></label>
    <label class="field"><span>L'altra persona</span><input id="namePartner" value="${esc(profile.partner)}" placeholder="es. Martina" autocomplete="off"></label>
    <p class="note">Sull'altro telefono scrivete gli stessi nomi al contrario: così le liste che vi mandate finiscono al posto giusto.</p>
    <h2>Le vostre piattaforme</h2>
    <p class="note">Servono per "stasera cosa guardiamo": propongo prima quello che potete vedere davvero.</p>
    <div class="platforms" id="platforms"><p class="note">Carico…</p></div>
    <h2>Mandare titoli all'altro telefono</h2>
    <div class="list">
      <button class="row" data-share="want"><span class="row-body"><b>Manda la lista "Da vedere"</b><small>l'altro la importa e se la ritrova</small></span></button>
      <button class="row" data-share="all"><span class="row-body"><b>Manda tutto il diario</b><small>visti, voti, liste e serie in corso</small></span></button>
      <button class="row" data-import><span class="row-body"><b>Importa una lista ricevuta</b><small>si aggiunge a quello che hai, senza cancellare niente</small></span></button>
    </div>
    <h2>Backup</h2>
    <p class="note">I dati restano solo su questo telefono. ${lastBackup ? `Ultimo backup: ${shortDate(lastBackup)}.` : 'Non hai ancora fatto un backup.'}</p>
    <div class="list">
      <button class="row" data-backup><span class="row-body"><b>Salva il backup</b><small>su Drive, email, iCloud o dove preferisci</small></span></button>
      <button class="row" data-restore><span class="row-body"><b>Ripristina da un backup</b><small>sostituisce i dati di questo telefono</small></span></button>
    </div>
    <input type="file" id="restoreFile" accept=".json,application/json,text/plain" hidden>
    <h2>App</h2>
    <p class="note">Versione ${esc(APP_VERSION)}${native ? ` · app Android ${esc(apkVersion())}` : ''}</p>
    ${native ? '<div class="list"><button class="row" data-checkupdate><span class="row-body"><b>Controlla aggiornamenti</b></span></button></div><p class="note" id="updateMsg"></p>' : ''}
    ${!native ? `<p class="note">Su iPhone: apri questa pagina in Safari, tocca Condividi e poi "Aggiungi alla schermata Home".</p>` : ''}
    <div class="tmdb"><img src="icons/tmdb.svg" alt="TMDB"><p>Questa app usa il catalogo di TMDB ma non è approvata né certificata da TMDB.
      Le piattaforme dove vedere i titoli sono fornite da JustWatch.</p></div>`;
  try {
    allProviders = await loadProviders();
    renderPlatforms();
  } catch {
    $('#platforms').innerHTML = '<p class="note">Serve la connessione per caricare le piattaforme.</p>';
  }
}

// Le principali in Italia in cima; le altre si vedono con "Mostra tutte".
const MAIN_PLATFORMS = [8, 119, 337, 39, 350, 531, 359, 222, 109, 384, 283];
let showAllPlatforms = false;
function renderPlatforms() {
  const main = allProviders.filter(p => MAIN_PLATFORMS.includes(p.id) || myPlatforms.includes(p.id));
  const list = showAllPlatforms ? allProviders : main.length ? main : allProviders.slice(0, 12);
  $('#platforms').innerHTML = `${list.map(p => `<button class="platform ${myPlatforms.includes(p.id) ? 'on' : ''}" data-platform="${p.id}">
      <img src="${poster(p.logo, 'w92')}" alt=""><span>${esc(p.name)}</span></button>`).join('')}
    ${showAllPlatforms ? '' : '<button class="link" data-allplatforms>Mostra tutte</button>'}`;
}

// Condivisione: un testo con i titoli, che l'altro telefono importa. I ruoli si scambiano: il "me" di chi
// manda diventa il "partner" di chi riceve.
function exportText(onlyWant) {
  const list = [...titles.values()].filter(t => !onlyWant || (isWanted(t) && t.status !== 'watched'));
  return JSON.stringify({ app: 'prima-fila', kind: onlyWant ? 'lista' : 'diario', date: today(), from: profile, titles: list });
}

async function shareText(text, title) {
  if (native?.shareText) return native.shareText(title, text);
  if (navigator.share) { try { await navigator.share({ title, text }); return; } catch (err) { if (err.name === 'AbortError') return; } }
  try { await navigator.clipboard.writeText(text); toast('Copiato: incollalo nel messaggio'); } catch { toast('Condivisione non disponibile'); }
}

function importSheet() {
  sheet.innerHTML = `<div class="sheet-head"><h2>Importa una lista</h2><button class="icon" data-close>✕</button></div>
    <p class="note">Incolla il testo che ti hanno mandato (inizia con <code>{"app":"prima-fila"</code>).</p>
    <textarea id="importText" rows="8" placeholder="Incolla qui…"></textarea>
    <div class="actions"><button class="secondary" data-paste>Incolla</button>
      <label class="secondary">Scegli file<input type="file" id="importFile" accept=".json,application/json,text/plain" hidden></label></div>
    <p class="error" id="importMsg"></p>
    <button class="primary" data-doimport>Importa</button>`;
  sheet.showModal();
}

async function doImport(text) {
  try {
    const data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (data.app !== 'prima-fila' || !Array.isArray(data.titles)) throw new Error('non è una lista di Prima Fila');
    // Chi l'ha mandata: se è l'altra persona, i suoi "me" diventano i nostri "partner".
    const norm = s => String(s ?? '').trim().toLowerCase();
    // (Se a mandarla sei stato tu da un altro telefono, con lo stesso nome, i ruoli restano.)
    const swap = !(norm(data.from?.me) && norm(data.from.me) === norm(profile.me));
    const role = w => (swap ? (w === 'me' ? 'partner' : 'me') : w);
    let added = 0, merged = 0;
    for (const inc of data.titles) {
      const t = titles.get(inc.key) ?? (added++, { ...inc, want: { me: false, partner: false }, views: [], ratings: {}, status: null, progress: null, note: inc.note ?? '' });
      if (titles.has(inc.key)) merged++;
      for (const w of ['me', 'partner']) {
        // Da vedere: arrivano solo i titoli "insieme" (quelli che l'altro vuole vedere da solo restano suoi).
        if (inc.want?.me && inc.want?.partner) t.want[role(w)] = true;
        // Il voto che chi manda ha dato a sé stesso vale più di quello segnato qui; gli altri riempiono solo i vuoti.
        if (inc.ratings?.[w] != null && (w === 'me' || t.ratings[role(w)] == null)) t.ratings[role(w)] = inc.ratings[w];
      }
      for (const v of inc.views ?? []) {
        const who = v.who.map(role).sort();
        if (!t.views.some(x => x.date === v.date && x.who.join() === who.join())) t.views.push({ date: v.date, who });
      }
      t.views.sort((a, b) => a.date.localeCompare(b.date));
      const rank = s => ({ watched: 3, watching: 2, dropped: 1 }[s] ?? 0);
      if (rank(inc.status) > rank(t.status)) t.status = inc.status;
      if (inc.progress && (!t.progress || inc.progress.s > t.progress.s || (inc.progress.s === t.progress.s && inc.progress.e > t.progress.e))) t.progress = inc.progress;
      for (const w of ['me', 'partner']) if (t.status === 'watched' && t.views.some(v => v.who.includes(w))) t.want[w] = false;
      await saveTitle(t);
    }
    sheet.close();
    toast(`Importati: ${plural(added, 'titolo nuovo', 'titoli nuovi')}${merged ? `, ${merged} aggiornati` : ''}`);
    route();
  } catch (err) {
    $('#importMsg').textContent = err instanceof SyntaxError
      ? 'Il testo non è completo: copia tutto il messaggio ricevuto, dall\'inizio alla fine.'
      : 'Non riesco a leggerla: ' + err.message;
  }
}

async function saveBackup() {
  const json = JSON.stringify({ app: 'prima-fila', kind: 'backup', version: 1, date: today(), profile, myPlatforms, titles: [...titles.values()] });
  const name = `prima-fila-backup-${today()}.json`;
  lastBackup = today();
  setSetting('lastBackup', lastBackup);
  if (native?.shareBackup) { if (!native.shareBackup(json)) toast('Backup non riuscito'); return; }
  const file = new File([json], name, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'Backup Prima Fila' }); return; } catch (err) { if (err.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function restoreBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'prima-fila' || data.kind !== 'backup') throw new Error('non è un backup di Prima Fila (per le liste usa "Importa una lista")');
    if (!confirm(`Ripristinare il backup del ${shortDate(data.date)}? I dati di questo telefono vengono sostituiti.`)) return;
    await db.clear('titles');
    titles = new Map();
    for (const t of data.titles) { titles.set(t.key, t); await db.put('titles', t); }
    profile = data.profile ?? profile;
    myPlatforms = data.myPlatforms ?? [];
    await Promise.all([setSetting('profile', profile), setSetting('platforms', myPlatforms)]);
    toast(`Ripristinati ${plural(titles.size, 'titolo', 'titoli')}`);
    route();
  } catch (err) {
    toast('Ripristino non riuscito: ' + err.message);
  }
}

function backupReminder() {
  const watched = [...titles.values()].filter(t => t.status === 'watched').length;
  if (watched < 5) return '';
  const days = lastBackup ? (new Date(today()) - new Date(lastBackup)) / 86400000 : Infinity;
  if (days < 30) return '';
  return `<a class="hint" href="#/altro"><b>Fai un backup</b><span>${lastBackup ? `L'ultimo è del ${shortDate(lastBackup)}` : 'Non ne hai ancora fatto uno'}: così non perdi il diario se cambi telefono.</span></a>`;
}

// Aggiornamenti dell'APK (il contenuto dell'app si aggiorna da solo da GitHub Pages).
const RELEASES = 'https://api.github.com/repos/Gavao/prima-fila/releases/latest';
let apkUpdate = null;
const apkVersion = () => native?.appVersion?.() ?? '';
const newer = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};
async function checkApkUpdate() {
  if (!native) return;
  try {
    const rel = await (await fetch(RELEASES)).json();
    const version = rel.tag_name?.replace(/^v/, '');
    const asset = rel.assets?.find(a => a.name.endsWith('.apk'));
    apkUpdate = version && asset && newer(version, apkVersion()) ? { version, url: asset.browser_download_url } : null;
  } catch { /* offline */ }
}
const updateBanner = () => (apkUpdate ? `<button class="warn" data-update>È disponibile la versione ${esc(apkUpdate.version)} dell'app. Tocca per aggiornare.</button>` : '');

async function checkWebUpdate() {
  if (APP_VERSION === 'dev' || sheet.open) return;
  try {
    const latest = (await (await fetch('version.txt', { cache: 'no-store' })).text()).trim();
    if (!latest || latest === APP_VERSION || sessionStorage.getItem('reloadedFor') === latest) return;
    sessionStorage.setItem('reloadedFor', latest);
    location.reload();
  } catch { /* offline */ }
}

// ---------------------------------------------------------------------------
// Tocchi e modifiche
// ---------------------------------------------------------------------------
sheet.addEventListener('click', e => {
  if (e.target === sheet || e.target.closest('[data-close]')) { sheet.close(); openKey = null; }
});

document.addEventListener('click', async e => {
  const t = e.target;
  const open = t.closest('[data-open]');
  if (open) { const [type, id] = open.dataset.open.split(':'); openTitle(type, +id); return; }

  // Stasera
  for (const key of ['who', 'type', 'time', 'where']) {
    const b = t.closest(`[data-pick-${key}]`);
    if (b) { pick[key] = b.dataset[`pick${key[0].toUpperCase()}${key.slice(1)}`]; seen.clear(); tonightPage(); return; }
  }
  const mood = t.closest('[data-mood]');
  if (mood) {
    const m = mood.dataset.mood;
    pick.moods = pick.moods.includes(m) ? pick.moods.filter(x => x !== m) : [...pick.moods, m];
    seen.clear();
    tonightPage();
    return;
  }
  if (t.closest('[data-suggest]')) { pick.fresh = $('#pickFresh')?.checked ?? pick.fresh; if (sheet.open) sheet.close(); return suggest(); }
  const nextEp = t.closest('[data-next-ep]');
  if (nextEp) return nextEpisode(nextEp.dataset.nextEp);

  // Liste
  const lw = t.closest('[data-list-who]');
  if (lw) { listWho = lw.dataset.listWho; listPage(); return; }
  const lt = t.closest('[data-list-type]');
  if (lt) { listType = lt.dataset.listType; listPage(); return; }
  const dw = t.closest('[data-diary-who]');
  if (dw) { diaryWho = dw.dataset.diaryWho; diaryPage(); return; }
  const dt = t.closest('[data-diary-tab]');
  if (dt) { diaryTab = dt.dataset.diaryTab; diaryPage(); return; }

  // Scheda del titolo
  const key = sheet.dataset.key;
  const want = t.closest('[data-want]');
  if (want && key) {
    const title = await ensureTitle(key);
    const w = want.dataset.want;
    if (w === 'insieme') { const on = !(title.want.me && title.want.partner); title.want.me = on; title.want.partner = on; }
    else { const on = !(title.want.me && !title.want.partner); title.want.me = on; title.want.partner = false; }   // "Io": solo per me
    if (!isWanted(title) && !title.status && !title.views.length) { titles.delete(key); await db.del('titles', key); toast('Tolto dalla lista'); }
    else { await saveTitle(title); toast(isTogether(title) ? 'Da vedere insieme' : isWanted(title) ? 'Da vedere: io' : 'Tolto dalla lista'); }
    renderTitle(key, await details(...splitKey(key)).catch(() => null));
    route();
    return;
  }
  if (t.closest('[data-watched]') && key) { sheet.dataset.mode = ''; return rateSheet(key); }
  if (t.closest('[data-rate]') && key) { sheet.dataset.mode = 'edit'; rateDraft = null; await rateSheet(key); rateDraft.date = titles.get(key).views.at(-1)?.date ?? today(); return renderRate(titles.get(key)); }
  const whoB = t.closest('[data-who]');
  if (whoB && rateDraft) {
    readRateDate();
    const w = whoB.dataset.who;
    rateDraft.who = w === 'insieme' ? ['me', 'partner'] : ['me'];
    return renderRate(await ensureTitle(rateDraft.key));
  }
  const rv = t.closest('[data-rate-val]');
  if (rv && rateDraft) {
    readRateDate();
    const [w, v] = rv.dataset.rateVal.split(':');
    rateDraft.ratings[w] = rateDraft.ratings[w] === +v ? null : +v;
    return renderRate(await ensureTitle(rateDraft.key));
  }
  if (t.closest('[data-save-rate]')) return saveRate();
  if (t.closest('[data-start-tv]') && key) {
    const title = await ensureTitle(key);
    title.status = 'watching';
    title.progress ??= { s: 1, e: 0 };
    await saveTitle(title);
    toast('Aggiunta alle serie in corso');
    renderTitle(key, await details(...splitKey(key)).catch(() => null));
    route();
    return;
  }
  const ep = t.closest('[data-ep]');
  if (ep && key) {
    const title = titles.get(key);
    const p = title.progress ?? { s: 1, e: 0 };
    p.s = +$('#seasonSel').value;
    p.e = Math.max(0, p.e + +ep.dataset.ep);
    title.progress = p;
    await saveTitle(title);
    renderTitle(key, await details(...splitKey(key)).catch(() => null));
    route();
    return;
  }
  if (t.closest('[data-finish-tv]') && key) { sheet.dataset.mode = ''; return rateSheet(key); }
  if (t.closest('[data-drop]') && key) {
    const title = titles.get(key);
    title.status = 'dropped';
    await saveTitle(title);
    toast('Spostata tra le lasciate a metà');
    renderTitle(key, await details(...splitKey(key)).catch(() => null));
    route();
    return;
  }
  if (t.closest('[data-remove]') && key) {
    if (!confirm('Togliere questo titolo dal diario? Voti e date si perdono.')) return;
    titles.delete(key);
    await db.del('titles', key);
    sheet.close();
    toast('Tolto dal diario');
    route();
    return;
  }

  // Altro
  const plat = t.closest('[data-platform]');
  if (plat) {
    const id = +plat.dataset.platform;
    myPlatforms = myPlatforms.includes(id) ? myPlatforms.filter(x => x !== id) : [...myPlatforms, id];
    await setSetting('platforms', myPlatforms);
    renderPlatforms();
    return;
  }
  if (t.closest('[data-allplatforms]')) { showAllPlatforms = true; renderPlatforms(); return; }
  const share = t.closest('[data-share]');
  if (share) {
    const onlyWant = share.dataset.share === 'want';
    return shareText(exportText(onlyWant), onlyWant ? 'Da vedere — Prima Fila' : 'Diario — Prima Fila');
  }
  if (t.closest('[data-import]')) return importSheet();
  if (t.closest('[data-paste]')) {
    try { $('#importText').value = await navigator.clipboard.readText(); } catch { toast('Tieni premuto nel riquadro e scegli Incolla'); }
    return;
  }
  if (t.closest('[data-doimport]')) return doImport($('#importText').value);
  if (t.closest('[data-backup]')) return saveBackup();
  if (t.closest('[data-restore]')) return $('#restoreFile').click();
  if (t.closest('[data-update]')) { native.installUpdate(apkUpdate.url); toast('Download in corso: al termine si apre l\'installazione'); return; }
  if (t.closest('[data-checkupdate]')) {
    $('#updateMsg').textContent = 'Controllo…';
    await checkApkUpdate();
    $('#updateMsg').innerHTML = apkUpdate ? updateBanner() : 'Hai già l\'ultima versione.';
    return;
  }
  const tip = t.closest('[data-tip]');
  if (tip) tip.closest('.chart').querySelector('.chart-read').textContent = tip.dataset.tip;
});

const splitKey = key => { const [type, id] = key.split(':'); return [type, +id]; };
const readRateDate = () => { if ($('#rateDate') && rateDraft) rateDraft.date = $('#rateDate').value || rateDraft.date; };

/** +1 episodio: a fine stagione si passa alla successiva; a fine serie si chiede il voto. */
async function nextEpisode(key) {
  const t = titles.get(key);
  const p = t.progress ?? { s: 1, e: 0 };
  const season = t.seasons?.find(s => s.n === p.s);
  if (season && p.e >= season.episodes) {
    const next = t.seasons.find(s => s.n === p.s + 1);
    if (next) { p.s = next.n; p.e = 1; } else { t.progress = p; await saveTitle(t); toast('Serie finita: com\'è stata?'); openTitle(t.type, t.id); return rateSheet(key); }
  } else {
    p.e++;
  }
  t.progress = p;
  await saveTitle(t);
  toast(`${t.title}: stagione ${p.s}, episodio ${p.e}`);
  route();
}

document.addEventListener('input', e => {
  const el = e.target;
  if (el.id === 'q') { clearTimeout(runSearch.timer); runSearch.timer = setTimeout(() => runSearch(el.value.trim()), 350); }
  if (el.id === 'nameMe' || el.id === 'namePartner') {
    profile[el.id === 'nameMe' ? 'me' : 'partner'] = el.value.trim();
    clearTimeout(morePage.timer);
    morePage.timer = setTimeout(() => setSetting('profile', profile), 400);
  }
});

document.addEventListener('change', async e => {
  const el = e.target;
  if (el.id === 'listSort') { listSort = el.value; listPage(); return; }
  if (el.id === 'pickFresh') { pick.fresh = el.checked; return; }
  if (el.id === 'titleNote' && sheet.dataset.key) {
    const t = titles.get(sheet.dataset.key) ?? await ensureTitle(sheet.dataset.key);
    t.note = el.value.trim();
    await saveTitle(t);
    return;
  }
  if (el.id === 'seasonSel' && sheet.dataset.key) {
    const t = titles.get(sheet.dataset.key);
    t.progress = { s: +el.value, e: 0 };
    await saveTitle(t);
    return;
  }
  const file = el.files?.[0];
  if (!file) return;
  if (el.id === 'restoreFile') restoreBackup(file);
  if (el.id === 'importFile') { $('#importText').value = await file.text(); doImport($('#importText').value); }
  el.value = '';
});

document.addEventListener('submit', e => {
  if (e.target.id !== 'searchForm') return;
  e.preventDefault();
  $('#q').blur();
  runSearch($('#q').value.trim());
});

// Tasto Indietro di Android: prima chiude la finestra aperta, poi torna alla pagina precedente.
window.appBack = () => {
  if (sheet.open) { sheet.close(); openKey = null; return true; }
  if (location.hash && location.hash !== '#/') { history.back(); return true; }
  return false;
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route() {
  const page = location.hash.replace(/^#\/?/, '').split('/')[0];
  const tab = { '': 'tonight', lista: 'list', cerca: 'search', diario: 'diary', altro: 'more' }[page] ?? 'tonight';
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('on', a.dataset.tab === tab);
  if (page === 'lista') listPage();
  else if (page === 'cerca') searchPage();
  else if (page === 'diario') diaryPage();
  else if (page === 'altro') morePage();
  else tonightPage();
}

addEventListener('hashchange', () => { route(); scrollTo(0, 0); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) checkWebUpdate(); });

// Avvio
for (const t of await db.all('titles')) titles.set(t.key, t);
profile = await getSetting('profile', { me: '', partner: '' });
myPlatforms = await getSetting('platforms', []);
lastBackup = await getSetting('lastBackup', null);
route();
navigator.storage?.persist?.().catch(() => {});
loadGenres().then(g => { genreNames = g; }).catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
checkWebUpdate();
checkApkUpdate().then(() => { if (apkUpdate && !location.hash.replace(/^#\/?/, '')) tonightPage(); });

// Errori non gestiti (es. aggiungere un titolo senza rete): un avviso invece del silenzio.
addEventListener('unhandledrejection', e => toast(e.reason?.message ?? 'Qualcosa non è andato'));
