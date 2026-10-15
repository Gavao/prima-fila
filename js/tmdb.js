// Catalogo di film e serie da TMDB (themoviedb.org), in italiano e con le piattaforme disponibili in Italia.
// "This product uses the TMDB API but is not endorsed or certified by TMDB."
// La chiave è di sola lettura e serve solo per il catalogo. Le risposte si salvano in IndexedDB: senza rete
// si usa l'ultima copia.
import { db } from './db.js';

const KEY = 'a85313fa559506fc48b4e541f957ef99';
const BASE = 'https://api.themoviedb.org/3';
const HOUR = 3600 * 1000, DAY = 24 * HOUR;
export const IMG = 'https://image.tmdb.org/t/p/';

async function get(path, params = {}) {
  const qs = new URLSearchParams({ api_key: KEY, language: 'it-IT', ...params });
  const res = await fetch(`${BASE}${path}?${qs}`);
  if (!res.ok) throw new Error(`Catalogo non raggiungibile (${res.status})`);
  return res.json();
}

async function cached(key, loader, maxAge) {
  const hit = await db.get('cache', key);
  if (hit && Date.now() - hit.ts < maxAge) return hit.data;
  try {
    const data = await loader();
    await db.put('cache', { key, data, ts: Date.now() });
    return data;
  } catch (err) {
    if (hit) return hit.data;
    throw err;
  }
}

/** Riassunto comune per film e serie (quello che si salva nel diario e si mostra nelle liste). */
export function brief(r, type = r.media_type) {
  const date = r.release_date ?? r.first_air_date ?? '';
  return {
    key: `${type}:${r.id}`, type, id: r.id,
    title: r.title ?? r.name ?? '', original: r.original_title ?? r.original_name ?? '',
    year: date.slice(0, 4), poster: r.poster_path ?? null, backdrop: r.backdrop_path ?? null,
    genres: r.genre_ids ?? (r.genres ?? []).map(g => g.id), vote: r.vote_average ?? null, overview: r.overview ?? '',
  };
}

/** Ricerca di film e serie (le persone si scartano). */
export async function search(query) {
  const data = await get('/search/multi', { query, include_adult: 'false' });
  return data.results.filter(r => r.media_type === 'movie' || r.media_type === 'tv').map(r => brief(r));
}

/**
 * Dettaglio completo: durata o stagioni, generi, trama, cast, trailer, dove vederlo in Italia, titoli simili.
 * Si tiene per 3 giorni (le piattaforme cambiano).
 */
export function details(type, id, force = false) {
  return cached(`d:${type}:${id}`, async () => {
    const d = await get(`/${type}/${id}`, { append_to_response: 'videos,credits,recommendations,watch/providers', include_video_language: 'it,en' });
    const it = d['watch/providers']?.results?.IT ?? {};
    const trailer = (d.videos?.results ?? []).filter(v => v.site === 'YouTube' && (v.type === 'Trailer' || v.type === 'Teaser'))
      .sort((a, b) => (b.iso_639_1 === 'it') - (a.iso_639_1 === 'it') || (b.type === 'Trailer') - (a.type === 'Trailer'))[0];
    return {
      ...brief(d, type),
      genres: (d.genres ?? []).map(g => g.id),
      genreNames: (d.genres ?? []).map(g => g.name),
      runtime: type === 'movie' ? d.runtime || null : (d.episode_run_time ?? [])[0] || null,
      seasons: type === 'tv' ? (d.seasons ?? []).filter(s => s.season_number > 0).map(s => ({ n: s.season_number, episodes: s.episode_count, name: s.name })) : [],
      status: d.status ?? '',
      tagline: d.tagline ?? '',
      cast: (d.credits?.cast ?? []).slice(0, 6).map(c => c.name),
      director: (d.credits?.crew ?? []).filter(c => c.job === 'Director').map(c => c.name).slice(0, 2),
      creators: (d.created_by ?? []).map(c => c.name),
      trailer: trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null,
      providers: {
        stream: (it.flatrate ?? []).map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path })),
        rent: (it.rent ?? []).map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path })),
        free: [...(it.free ?? []), ...(it.ads ?? [])].map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path })),
        link: it.link ?? null,
      },
      similar: (d.recommendations?.results ?? []).slice(0, 12).map(r => brief(r, type)),
    };
  }, force ? 0 : 3 * DAY);
}

/** Generi in italiano (id → nome), film e serie insieme. */
export function genres() {
  return cached('genres', async () => {
    const [m, t] = await Promise.all([get('/genre/movie/list'), get('/genre/tv/list')]);
    const map = {};
    for (const g of [...m.genres, ...t.genres]) map[g.id] = g.name;
    return map;
  }, 30 * DAY);
}

/** Piattaforme di streaming disponibili in Italia, le più usate per prime. */
export function providers() {
  return cached('providers', async () => {
    const data = await get('/watch/providers/movie', { watch_region: 'IT' });
    return data.results.sort((a, b) => a.display_priorities?.IT - b.display_priorities?.IT || a.display_priority - b.display_priority)
      .map(p => ({ id: p.provider_id, name: p.provider_name, logo: p.logo_path }));
  }, 7 * DAY);
}

/**
 * Proposte nuove per "stasera": titoli popolari e ben votati, sulle piattaforme scelte, con i generi e la
 * durata indicati. type: 'movie' o 'tv'.
 */
export async function discover(type, { platforms = [], genres: g = [], maxRuntime = null, page = 1 } = {}) {
  const params = {
    sort_by: 'popularity.desc', 'vote_count.gte': type === 'movie' ? '300' : '150', 'vote_average.gte': '6.5',
    watch_region: 'IT', page: String(page),
  };
  if (platforms.length) { params.with_watch_providers = platforms.join('|'); params.with_watch_monetization_types = 'flatrate'; }
  if (g.length) params.with_genres = g.join('|');
  if (maxRuntime && type === 'movie') params['with_runtime.lte'] = String(maxRuntime);
  const key = `disc:${type}:${JSON.stringify(params)}`;
  const data = await cached(key, () => get(`/discover/${type}`, params), 12 * HOUR);
  return data.results.map(r => brief(r, type));
}

export const poster = (path, size = 'w342') => (path ? `${IMG}${size}${path}` : null);
