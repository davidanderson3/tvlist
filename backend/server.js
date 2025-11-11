const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

dotenv.config();

const backendEnvPath = path.resolve(__dirname, '.env');
if (fs.existsSync(backendEnvPath)) {
  dotenv.config({ path: backendEnvPath, override: false });
}

const express = require('express');
const { Configuration, PlaidApi, PlaidEnvironments } = require('plaid');
const cors = require('cors');
const { readCachedResponse, writeCachedResponse } = require('../shared/cache');
const movieCatalog = require('./movie-catalog');
let nodemailer;
try {
  nodemailer = require('nodemailer');
} catch {
  nodemailer = null;
}

const app = express();

movieCatalog
  .init()
  .catch(err => {
    console.error('Initial movie catalog load failed', err);
  });
const PORT = Number(process.env.PORT) || 3003;
const HOST = process.env.HOST || (process.env.VITEST ? '127.0.0.1' : '0.0.0.0');
const FOURSQUARE_SEARCH_URL = 'https://api.foursquare.com/v3/places/search';
const FOURSQUARE_PLACE_URL = 'https://api.foursquare.com/v3/places';
const FOURSQUARE_CACHE_COLLECTION = 'foursquareCache';
const FOURSQUARE_CACHE_TTL_MS = 1000 * 60 * 30; // 30 minutes
const FOURSQUARE_MAX_LIMIT = 50;
const FOURSQUARE_DETAILS_MAX = 15;
const FOURSQUARE_DETAILS_CONCURRENCY = 4;
const FOURSQUARE_CATEGORY_RESTAURANTS = '13065';
const FOURSQUARE_SEARCH_FIELDS =
  'fsq_id,name,location,geocodes,distance,link,website,tel,categories,price,rating,rating_signals';
const FOURSQUARE_DETAIL_FIELDS =
  'fsq_id,name,location,geocodes,distance,link,website,tel,categories,price,rating,rating_signals,photos,popularity,hours,social_media';
const METERS_PER_MILE = 1609.34;
const MOVIE_STATS_BUCKETS = [
  { label: '9-10', min: 9, max: Infinity },
  { label: '8-8.9', min: 8, max: 9 },
  { label: '7-7.9', min: 7, max: 8 },
  { label: '6-6.9', min: 6, max: 7 },
  { label: '< 6', min: -Infinity, max: 6 }
];
const SPOONACULAR_CACHE_COLLECTION = 'recipeCache';
const SPOONACULAR_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours
const DEFAULT_MOVIE_LIMIT = 20;
const OMDB_BASE_URL = 'https://www.omdbapi.com/';
const OMDB_API_KEY =
  process.env.OMDB_API_KEY ||
  process.env.OMDB_KEY ||
  process.env.OMDB_TOKEN ||
  '';
const OMDB_CACHE_COLLECTION = 'omdbRatings';
const OMDB_CACHE_TTL_MS = 1000 * 60 * 60 * 12; // 12 hours
const YOUTUBE_SEARCH_BASE_URL = 'https://www.googleapis.com/youtube/v3/search';
const YOUTUBE_API_KEY =
  process.env.YOUTUBE_API_KEY ||
  process.env.YOUTUBE_KEY ||
  process.env.GOOGLE_API_KEY ||
  '';
const YOUTUBE_SEARCH_CACHE_COLLECTION = 'youtubeSearchCache';
const YOUTUBE_SEARCH_CACHE_TTL_MS = 1000 * 60 * 60 * 6; // 6 hours

const DEFAULT_REMOTE_API_BASE = 'https://narrow-down.web.app/api';
const DEFAULT_REMOTE_TMDB_PROXY_URL = `${DEFAULT_REMOTE_API_BASE}/tmdbProxy`;
const TMDB_BASE_URL = 'https://api.themoviedb.org';
const TV_DISCOVER_CACHE_COLLECTION = 'tvDiscoverCache';
const TV_DISCOVER_CACHE_TTL_MS = 1000 * 60 * 10;
const TV_DISCOVER_DEFAULT_LIMIT = 20;
const TV_DISCOVER_MAX_LIMIT = 60;
const TV_DISCOVER_MAX_PAGES = 5;
const TV_GENRE_CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour
let cachedTvGenres = null;
let cachedTvGenresFetchedAt = 0;

async function safeReadCachedResponse(collection, keyParts, ttlMs) {
  try {
    return await readCachedResponse(collection, keyParts, ttlMs);
  } catch (err) {
    console.warn('Cache read failed', err?.message || err);
    return null;
  }
}

async function safeWriteCachedResponse(collection, keyParts, payload) {
  try {
    await writeCachedResponse(collection, keyParts, payload);
  } catch (err) {
    console.warn('Cache write failed', err?.message || err);
  }
}

function resolveTmdbApiKey() {
  return (
    process.env.TMDB_API_KEY ||
    process.env.TMDB_KEY ||
    process.env.TMDB_TOKEN ||
    ''
  );
}

function resolveSelfOrigin(req) {
  if (!req) return null;
  const host = req.get('host');
  if (!host) return null;
  const protocolHeader = req.headers['x-forwarded-proto'];
  const forwardedProtocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader;
  const protocol = req.protocol || (forwardedProtocol ? String(forwardedProtocol).split(',')[0].trim() : null) || 'http';
  return `${protocol}://${host}`;
}

function resolveTmdbProxyEndpoint(req) {
  const explicit = process.env.TMDB_PROXY_ENDPOINT;
  if (explicit) {
    return explicit;
  }
  const origin = resolveSelfOrigin(req);
  if (origin) {
    return `${origin.replace(/\/+$/, '')}/tmdbProxy`;
  }
  const base =
    (process.env.API_BASE_URL && process.env.API_BASE_URL.replace(/\/+$/, '')) || '';
  if (base) {
    return `${base}/tmdbProxy`;
  }
  return '';
}

function resolveTmdbProxyUpstreamUrl() {
  const explicit = process.env.TMDB_PROXY_UPSTREAM || process.env.TMDB_REMOTE_PROXY_URL;
  if (explicit) {
    return explicit;
  }
  const endpoint = process.env.TMDB_PROXY_ENDPOINT;
  if (endpoint && /^https?:\/\//i.test(endpoint)) {
    const lowered = endpoint.toLowerCase();
    if (
      !lowered.includes('localhost') &&
      !lowered.includes('127.0.0.1') &&
      !lowered.includes('::1')
    ) {
      return endpoint;
    }
  }
  return DEFAULT_REMOTE_TMDB_PROXY_URL;
}

const TMDB_ALLOWED_ENDPOINTS = {
  discover: { path: '/3/discover/movie' },
  discover_tv: { path: '/3/discover/tv' },
  genres: { path: '/3/genre/movie/list' },
  tv_genres: { path: '/3/genre/tv/list' },
  credits: {
    path: query => {
      const rawId = query?.movie_id ?? query?.id ?? query?.movieId;
      const value = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!value && value !== 0) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      return `/3/movie/${encodeURIComponent(trimmed)}/credits`;
    },
    omitParams: ['movie_id', 'movieId', 'id']
  },
  tv_credits: {
    path: query => {
      const rawId = query?.tv_id ?? query?.id;
      const value = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!value && value !== 0) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      return `/3/tv/${encodeURIComponent(trimmed)}/credits`;
    },
    omitParams: ['tv_id', 'id']
  },
  movie_details: {
    path: query => {
      const rawId = query?.movie_id ?? query?.id ?? query?.movieId;
      const value = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!value && value !== 0) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      return `/3/movie/${encodeURIComponent(trimmed)}`;
    },
    omitParams: ['movie_id', 'movieId', 'id']
  },
  tv_details: {
    path: query => {
      const rawId = query?.tv_id ?? query?.id;
      const value = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!value && value !== 0) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      return `/3/tv/${encodeURIComponent(trimmed)}`;
    },
    omitParams: ['tv_id', 'id']
  },
  person_details: {
    path: query => {
      const rawId = query?.person_id ?? query?.id;
      const value = Array.isArray(rawId) ? rawId[0] : rawId;
      if (!value && value !== 0) return null;
      const trimmed = String(value).trim();
      if (!trimmed) return null;
      return `/3/person/${encodeURIComponent(trimmed)}`;
    },
    omitParams: ['person_id', 'id']
  },
  search_multi: { path: '/3/search/multi' },
  search_movie: { path: '/3/search/movie' },
  search_tv: { path: '/3/search/tv' },
  trending_all: { path: '/3/trending/all/day' },
  trending_movies: { path: '/3/trending/movie/day' },
  trending_tv: { path: '/3/trending/tv/day' },
  popular_movies: { path: '/3/movie/popular' },
  popular_tv: { path: '/3/tv/popular' },
  upcoming_movies: { path: '/3/movie/upcoming' }
};

function buildTmdbPath(endpointKey, query) {
  const config = TMDB_ALLOWED_ENDPOINTS[endpointKey];
  if (!config) {
    const error = new Error('unsupported_endpoint');
    error.status = 400;
    throw error;
  }
  if (typeof config.path === 'function') {
    const resolved = config.path(query);
    if (!resolved) {
      const error = new Error('invalid_endpoint_params');
      error.status = 400;
      throw error;
    }
    return resolved;
  }
  return config.path;
}

function buildTmdbSearchParams(query, omit = []) {
  const params = new URLSearchParams();
  const omitSet = new Set(omit);
  Object.entries(query).forEach(([key, value]) => {
    if (omitSet.has(key)) return;
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (item === undefined || item === null) return;
        params.append(key, String(item));
      });
      return;
    }
    params.append(key, String(value));
  });
  return params;
}

async function fetchTmdbDirect(endpointKey, query, apiKey) {
  const path = buildTmdbPath(endpointKey, query);
  const config = TMDB_ALLOWED_ENDPOINTS[endpointKey] || {};
  const params = buildTmdbSearchParams(query, config.omitParams || []);
  params.set('api_key', apiKey);
  const url = new URL(path, TMDB_BASE_URL);
  url.search = params.toString();
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'narrow-down-local-proxy'
    }
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`TMDB request failed (${response.status})`);
    error.status = response.status;
    error.body = text;
    throw error;
  }
  return text ? JSON.parse(text) : {};
}

async function forwardTmdbProxy(endpointKey, query) {
  const upstream = resolveTmdbProxyUpstreamUrl();
  if (!upstream) {
    const error = new Error('tmdb_proxy_upstream_unavailable');
    error.status = 502;
    throw error;
  }
  const url = new URL(upstream);
  url.searchParams.set('endpoint', endpointKey);
  Object.entries(query).forEach(([key, value]) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach(item => {
        if (item === undefined || item === null) return;
        url.searchParams.append(key, String(item));
      });
      return;
    }
    url.searchParams.append(key, String(value));
  });
  const response = await fetch(url.toString(), {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'narrow-down-local-proxy'
    }
  });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    body
  };
}

async function requestTmdbData(endpointKey, query = {}) {
  const apiKey = resolveTmdbApiKey();
  if (apiKey) {
    try {
      return await fetchTmdbDirect(endpointKey, query, apiKey);
    } catch (err) {
      console.warn(`Direct TMDB request failed for ${endpointKey}`, err?.message || err);
    }
  }
  const forwarded = await forwardTmdbProxy(endpointKey, query);
  if (forwarded.status >= 400) {
    const error = new Error('tmdb_proxy_forward_failed');
    error.status = forwarded.status;
    error.body = forwarded.body;
    throw error;
  }
  if (!forwarded.body) {
    return {};
  }
  try {
    return JSON.parse(forwarded.body);
  } catch (err) {
    const parseError = new Error('invalid_tmdb_proxy_response');
    parseError.status = 502;
    throw parseError;
  }
}

// Enable CORS for all routes so the frontend can reach the API
app.use(cors());

const CONTACT_EMAIL = Buffer.from('ZHZkbmRyc25AZ21haWwuY29t', 'base64').toString('utf8');
const mailer = (() => {
  if (!nodemailer || !process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
})();

app.use(express.json());

async function handleTmdbProxyRequest(req, res) {
  const endpointKey = String(req.query.endpoint || 'discover');
  const query = { ...req.query };
  delete query.endpoint;

  const apiKey = resolveTmdbApiKey();
  if (apiKey) {
    try {
      const data = await fetchTmdbDirect(endpointKey, query, apiKey);
      res.type('application/json').send(JSON.stringify(data));
      return;
    } catch (err) {
      console.warn('Direct TMDB request failed, attempting upstream proxy', err);
    }
  }

  try {
    const forwarded = await forwardTmdbProxy(endpointKey, query);
    res.status(forwarded.status);
    if (forwarded.contentType) {
      res.set('content-type', forwarded.contentType);
    } else {
      res.type('application/json');
    }
    if (forwarded.body) {
      res.send(forwarded.body);
    } else {
      res.send('');
    }
  } catch (err) {
    console.error('TMDB proxy request failed', err);
    const status =
      err && typeof err.status === 'number' && err.status >= 400 ? err.status : 502;
    res.status(status).json({
      error: 'tmdb_proxy_failed',
      message: (err && err.message) || 'TMDB proxy request failed'
    });
  }
}

app.get('/tmdbProxy', handleTmdbProxyRequest);
app.get('/api/tmdbProxy', handleTmdbProxyRequest);

function sendCachedResponse(res, cached) {
  if (!cached || typeof cached.body !== 'string') return false;
  res.status(typeof cached.status === 'number' ? cached.status : 200);
  res.type(cached.contentType || 'application/json');
  res.send(cached.body);
  return true;
}

function parseBooleanQuery(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return false;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return Boolean(normalized);
}

function parseNumberQuery(value) {
  if (value === undefined || value === null || value === '') return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function normalizeCoordinate(value, digits = 3) {
  const num = Number.parseFloat(value);
  if (!Number.isFinite(num)) return null;
  const factor = Math.pow(10, Math.max(0, digits));
  return Math.round(num * factor) / factor;
}

function clampDays(value) {
  if (value === undefined || value === null || value === '') {
    return TICKETMASTER_DEFAULT_DAYS;
  }
  const num = Number.parseInt(value, 10);
  if (!Number.isFinite(num)) return TICKETMASTER_DEFAULT_DAYS;
  return Math.min(Math.max(num, 1), 31);
}

function normalizePositiveInteger(value, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  const clamped = Math.min(Math.max(parsed, min), max);
  return clamped;
}

function normalizeYouTubeQuery(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeYouTubeThumbnails(thumbnails) {
  if (!thumbnails || typeof thumbnails !== 'object') return undefined;
  const normalized = {};
  Object.entries(thumbnails).forEach(([key, value]) => {
    if (!value || typeof value !== 'object') return;
    const url = typeof value.url === 'string' ? value.url : null;
    if (!url) return;
    const width = Number.isFinite(value.width) ? Number(value.width) : null;
    const height = Number.isFinite(value.height) ? Number(value.height) : null;
    normalized[key] = {
      url,
      width: width === null ? undefined : width,
      height: height === null ? undefined : height
    };
  });
  return Object.keys(normalized).length ? normalized : undefined;
}

function youtubeSearchCacheKey(query) {
  const normalized = normalizeYouTubeQuery(query).toLowerCase();
  return ['youtubeSearch', normalized];
}

function parseOmdbPercent(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const normalized = raw.endsWith('%') ? raw.slice(0, -1) : raw;
  const num = Number.parseFloat(normalized);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function extractYear(value) {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  return Number.isFinite(year) ? year : null;
}

function parseIdSet(raw) {
  const set = new Set();
  const addParts = value => {
    if (!value && value !== 0) return;
    String(value)
      .split(/[,|\s]+/)
      .map(part => part.trim())
      .filter(Boolean)
      .forEach(part => set.add(part));
  };
  if (Array.isArray(raw)) {
    raw.forEach(addParts);
  } else if (typeof raw === 'string') {
    addParts(raw);
  }
  return set;
}

function buildTvDiscoverQuery({ minRating, minVotes, startYear, endYear }) {
  const query = {
    sort_by: 'vote_average.desc',
    include_adult: 'false',
    include_null_first_air_dates: 'false',
    language: 'en-US'
  };
  if (Number.isFinite(minRating)) {
    const clamped = Math.max(0, Math.min(10, minRating));
    query['vote_average.gte'] = clamped;
  }
  if (Number.isFinite(minVotes)) {
    const normalizedVotes = Math.max(0, Math.floor(minVotes));
    query['vote_count.gte'] = normalizedVotes;
  }
  if (Number.isFinite(startYear)) {
    query['first_air_date.gte'] = `${startYear}-01-01`;
  }
  if (Number.isFinite(endYear)) {
    query['first_air_date.lte'] = `${endYear}-12-31`;
  }
  return query;
}

async function fetchTvGenresWithCache() {
  if (
    Array.isArray(cachedTvGenres) &&
    cachedTvGenres.length &&
    Date.now() - cachedTvGenresFetchedAt < TV_GENRE_CACHE_TTL_MS
  ) {
    return cachedTvGenres;
  }
  try {
    const data = await requestTmdbData('tv_genres', { language: 'en-US' });
    const genres = Array.isArray(data?.genres) ? data.genres : [];
    cachedTvGenres = genres;
    cachedTvGenresFetchedAt = Date.now();
    return genres;
  } catch (err) {
    console.warn('Unable to refresh TV genre list', err?.message || err);
    return Array.isArray(cachedTvGenres) ? cachedTvGenres : [];
  }
}

async function discoverTvShows({
  limit,
  minRating,
  minVotes,
  startYear,
  endYear,
  excludeSet = new Set()
}) {
  const queryBase = buildTvDiscoverQuery({ minRating, minVotes, startYear, endYear });
  const collected = [];
  const seen = new Set();
  let page = 1;
  let totalPages = 1;
  let totalResults = 0;

  while (collected.length < limit && page <= TV_DISCOVER_MAX_PAGES) {
    const pageData = await requestTmdbData('discover_tv', { ...queryBase, page });
    const pageResults = Array.isArray(pageData?.results) ? pageData.results : [];
    const pageTotalPages = Number(pageData?.total_pages);
    const pageTotalResults = Number(pageData?.total_results);
    if (Number.isFinite(pageTotalPages) && pageTotalPages > 0) {
      totalPages = pageTotalPages;
    }
    if (Number.isFinite(pageTotalResults) && pageTotalResults >= 0) {
      totalResults = pageTotalResults;
    }
    pageResults.forEach(show => {
      if (!show || show.id == null) return;
      const id = String(show.id);
      if (excludeSet.has(id) || seen.has(id)) return;
      const voteAverage = Number(show.vote_average);
      if (Number.isFinite(minRating) && Number.isFinite(voteAverage) && voteAverage < minRating) {
        return;
      }
      const voteCount = Number(show.vote_count);
      if (Number.isFinite(minVotes) && Number.isFinite(voteCount) && voteCount < minVotes) {
        return;
      }
      if (Number.isFinite(startYear) || Number.isFinite(endYear)) {
        const releaseYear =
          extractYear(show.first_air_date) ||
          extractYear(show.release_date) ||
          extractYear(show.last_air_date);
        if (Number.isFinite(startYear) && Number.isFinite(releaseYear) && releaseYear < startYear) {
          return;
        }
        if (Number.isFinite(endYear) && Number.isFinite(releaseYear) && releaseYear > endYear) {
          return;
        }
      }
      seen.add(id);
      collected.push(show);
    });

    if (pageResults.length === 0 || page >= totalPages) {
      break;
    }
    page += 1;
  }

  return {
    results: collected.slice(0, limit),
    totalPages,
    totalResults,
    pagesFetched: page
  };
}

function parseOmdbScore(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === 'n/a') return null;
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function parseOmdbImdbRating(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw || raw.toLowerCase() === 'n/a') return null;
  const num = Number.parseFloat(raw);
  if (!Number.isFinite(num)) return null;
  const clamped = Math.max(0, Math.min(10, num));
  return Math.round(clamped * 10) / 10;
}

function sanitizeOmdbString(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed;
}

function buildOmdbCacheKeyParts({ imdbId, title, year, type }) {
  const parts = ['omdb'];
  const normalizedType = typeof type === 'string' && type ? type.toLowerCase() : 'any';
  parts.push(`type:${normalizedType}`);
  if (imdbId) {
    parts.push(`imdb:${imdbId.toLowerCase()}`);
  } else if (title) {
    parts.push(`title:${title.toLowerCase()}`);
  } else {
    parts.push('title:');
  }
  if (year) {
    parts.push(`year:${year}`);
  } else {
    parts.push('year:');
  }
  return parts;
}

function normalizeOmdbPayload(data, { type, requestedTitle, requestedYear }) {
  if (!data || typeof data !== 'object') return null;
  const ratingsArray = Array.isArray(data.Ratings) ? data.Ratings : [];
  const ratingMap = new Map();
  ratingsArray.forEach(entry => {
    if (!entry || typeof entry.Source !== 'string') return;
    const key = entry.Source.trim().toLowerCase();
    if (!key) return;
    ratingMap.set(key, entry.Value);
  });

  const rottenTomatoes = parseOmdbPercent(
    ratingMap.get('rotten tomatoes') ?? ratingMap.get('rottentomatoes')
  );
  const metacritic = parseOmdbScore(data.Metascore ?? ratingMap.get('metacritic'));
  const imdb = parseOmdbImdbRating(
    data.imdbRating ?? ratingMap.get('internet movie database') ?? ratingMap.get('imdb')
  );

  const imdbId = sanitizeOmdbString(data.imdbID);
  const title = sanitizeOmdbString(data.Title) || sanitizeOmdbString(requestedTitle);
  const year = sanitizeOmdbString(data.Year) || sanitizeOmdbString(requestedYear);

  const payload = {
    source: 'omdb',
    ratings: {
      rottenTomatoes: rottenTomatoes ?? null,
      metacritic: metacritic ?? null,
      imdb: imdb ?? null
    },
    imdbId: imdbId || null,
    title: title || null,
    year: year || null,
    type: typeof type === 'string' && type ? type : null,
    fetchedAt: new Date().toISOString()
  };

  return payload;
}

function foursquareCacheKeyParts({ city, latitude, longitude, cuisine, limit, radiusMeters }) {
  const normalizedCity = typeof city === 'string' ? city.trim().toLowerCase() : '';
  const normalizedCuisine = typeof cuisine === 'string' ? cuisine.trim().toLowerCase() : '';
  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude);
  const parts = ['foursquare', 'v1'];
  if (hasCoords) {
    const lat = Number(latitude);
    const lon = Number(longitude);
    parts.push(`coords:${lat.toFixed(4)},${lon.toFixed(4)}`);
  } else {
    parts.push('coords:none');
  }
  if (normalizedCity) {
    parts.push(`city:${normalizedCity}`);
  }
  if (normalizedCuisine) {
    parts.push(`cuisine:${normalizedCuisine}`);
  }
  if (Number.isFinite(limit) && limit > 0) {
    const clampedLimit = Math.min(Math.max(1, Math.floor(limit)), FOURSQUARE_MAX_LIMIT);
    parts.push(`limit:${clampedLimit}`);
  } else {
    parts.push('limit:default');
  }
  if (Number.isFinite(radiusMeters) && radiusMeters > 0) {
    parts.push(`radius:${Math.round(radiusMeters)}`);
  } else {
    parts.push('radius:none');
  }
  return parts;
}

function formatFoursquarePrice(level) {
  if (!Number.isFinite(level) || level <= 0) return '';
  const clamped = Math.max(1, Math.min(4, Math.round(level)));
  return '$'.repeat(clamped);
}

function buildFoursquareAddress(location) {
  if (!location || typeof location !== 'object') return '';
  if (typeof location.formatted_address === 'string' && location.formatted_address.trim()) {
    return location.formatted_address.trim();
  }
  const locality =
    [location.locality || location.city || '', location.region || location.state || '']
      .filter(Boolean)
      .join(', ');
  const parts = [
    location.address || location.address_line1 || '',
    locality,
    location.postcode || '',
    location.country || ''
  ]
    .map(part => (typeof part === 'string' ? part.trim() : ''))
    .filter(Boolean);
  return parts.join(', ');
}

function extractBestPhotoUrl(detail) {
  const photos = detail && Array.isArray(detail.photos) ? detail.photos : [];
  if (!photos.length) return '';
  const preferred =
    photos.find(photo => photo && photo.prefix && photo.suffix && photo.width && photo.height) ||
    photos.find(photo => photo && photo.prefix && photo.suffix);
  if (!preferred || !preferred.prefix || !preferred.suffix) {
    return '';
  }
  const size =
    Number.isFinite(preferred.width) && Number.isFinite(preferred.height)
      ? `${preferred.width}x${preferred.height}`
      : 'original';
  return `${preferred.prefix}${size}${preferred.suffix}`;
}

function simplifyFoursquareCategories(categories) {
  if (!Array.isArray(categories)) return [];
  return categories
    .map(category => {
      if (!category) return '';
      if (typeof category === 'string') return category.trim();
      if (typeof category.name === 'string' && category.name.trim()) return category.name.trim();
      if (typeof category.short_name === 'string' && category.short_name.trim()) {
        return category.short_name.trim();
      }
      return '';
    })
    .filter(Boolean);
}

async function fetchFoursquareSearch(params, apiKey) {
  const url = `${FOURSQUARE_SEARCH_URL}?${params.toString()}`;
  const response = await fetch(url, {
    headers: {
      Authorization: apiKey,
      Accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw Object.assign(
      new Error(`Foursquare request failed: ${response.status} ${text.slice(0, 200)}`),
      { status: response.status }
    );
  }
  return response.json();
}

async function fetchFoursquareDetails(
  places,
  apiKey,
  { limit = FOURSQUARE_DETAILS_MAX, concurrency = FOURSQUARE_DETAILS_CONCURRENCY } = {}
) {
  if (!Array.isArray(places) || !places.length) return new Map();
  const ids = [];
  const seen = new Set();
  for (const place of places) {
    const id = place?.fsq_id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (Number.isFinite(limit) && limit > 0 && ids.length >= limit) break;
  }
  if (!ids.length) return new Map();

  const results = new Map();
  const workerCount = Math.max(1, Math.min(concurrency || 1, ids.length));
  let index = 0;

  async function runWorker() {
    while (index < ids.length) {
      const currentIndex = index++;
      const id = ids[currentIndex];
      const detailUrl = `${FOURSQUARE_PLACE_URL}/${encodeURIComponent(
        id
      )}?fields=${encodeURIComponent(FOURSQUARE_DETAIL_FIELDS)}`;
      try {
        const response = await fetch(detailUrl, {
          headers: {
            Authorization: apiKey,
            Accept: 'application/json'
          }
        });
        if (!response.ok) {
          continue;
        }
        const data = await response.json().catch(() => null);
        if (data && typeof data === 'object') {
          results.set(id, data);
        }
      } catch (err) {
        console.error('Foursquare detail fetch failed', err);
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function simplifyFoursquarePlace(place, detail) {
  if (!place || typeof place !== 'object') return null;
  const location = detail?.location || place.location || {};
  const geocodes = detail?.geocodes || place.geocodes || {};
  const mainGeo = geocodes.main || geocodes.roof || geocodes.display || {};
  const latitude = Number.isFinite(mainGeo.latitude) ? mainGeo.latitude : null;
  const longitude = Number.isFinite(mainGeo.longitude) ? mainGeo.longitude : null;

  const rawRating =
    Number.isFinite(detail?.rating) && detail.rating > 0
      ? detail.rating
      : Number.isFinite(place.rating) && place.rating > 0
      ? place.rating
      : null;
  const normalizedRating =
    Number.isFinite(rawRating) && rawRating > 0 ? Math.round((rawRating / 2) * 10) / 10 : null;

  const ratingSignals =
    Number.isFinite(detail?.rating_signals) && detail.rating_signals >= 0
      ? detail.rating_signals
      : Number.isFinite(place.rating_signals) && place.rating_signals >= 0
      ? place.rating_signals
      : null;

  const priceLevel =
    Number.isFinite(detail?.price) && detail.price > 0
      ? detail.price
      : Number.isFinite(place.price) && place.price > 0
      ? place.price
      : null;

  const address = buildFoursquareAddress(location);
  const categories = simplifyFoursquareCategories(detail?.categories || place.categories);
  const phone = detail?.tel || place.tel || '';
  const website = detail?.website || place.website || '';
  const link = detail?.link || place.link || '';
  const url = website || link || (place.fsq_id ? `https://foursquare.com/v/${place.fsq_id}` : '');
  const distance = Number.isFinite(place.distance) ? place.distance : null;
  const imageUrl = extractBestPhotoUrl(detail);

  return {
    id: place.fsq_id || detail?.fsq_id || null,
    name: detail?.name || place.name || 'Unnamed Venue',
    address,
    city: location.locality || location.city || '',
    state: location.region || location.state || '',
    zip: location.postcode || '',
    country: location.country || '',
    phone,
    rating: normalizedRating,
    reviewCount: Number.isFinite(ratingSignals) ? ratingSignals : null,
    price: formatFoursquarePrice(priceLevel),
    categories,
    latitude,
    longitude,
    url,
    website: website || undefined,
    imageUrl: imageUrl || undefined,
    distance
  };
}

const plaidClient = (() => {
  const clientID = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;
  const env = process.env.PLAID_ENV || 'sandbox';
  if (!clientID || !secret) return null;
  const config = new Configuration({
    basePath: PlaidEnvironments[env],
    baseOptions: {
      headers: {
        'PLAID-CLIENT-ID': clientID,
        'PLAID-SECRET': secret
      }
    }
  });
  return new PlaidApi(config);
})();

// Serve static files (like index.html, style.css, script.js)
// Allow API routes (like /api/eventbrite) to continue past the static middleware
// when no matching asset is found. Express 5 changes the default `fallthrough`
// behavior, so we explicitly enable it to avoid returning a 404 before our API
// handlers get a chance to run.
app.use(
  express.static(path.resolve(__dirname, '../'), {
    fallthrough: true
  })
);

app.post('/contact', async (req, res) => {
  const { name, from, message } = req.body || {};
  if (!from || !message) {
    return res.status(400).json({ error: 'invalid' });
  }
  if (!mailer) {
    return res.status(500).json({ error: 'mail disabled' });
  }
  try {
    await mailer.sendMail({
      to: CONTACT_EMAIL,
      from: process.env.SMTP_USER,
      replyTo: from,
      subject: `Dashboard contact from ${name || 'Anonymous'}`,
      text: message
    });
    res.json({ status: 'ok' });
  } catch (err) {
    console.error('Contact email failed', err);
    res.status(500).json({ error: 'failed' });
  }
});

// --- Description persistence ---
const descFile = path.join(__dirname, 'descriptions.json');

function readDescriptions() {
  try {
    const text = fs.readFileSync(descFile, 'utf8');
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function writeDescriptions(data) {
  fs.writeFileSync(descFile, JSON.stringify(data, null, 2));
}

app.get('/api/descriptions', (req, res) => {
  res.json(readDescriptions());
});

app.post('/api/description', (req, res) => {
  const { panelId, position, text } = req.body || {};
  if (!panelId || !['top', 'bottom'].includes(position) || typeof text !== 'string') {
    return res.status(400).json({ error: 'invalid' });
  }
  const data = readDescriptions();
  data[panelId] = data[panelId] || {};
  data[panelId][position] = text;
  writeDescriptions(data);
  res.json({ status: 'ok' });
});

// --- Saved movies persistence ---
const savedFile = path.join(__dirname, 'saved-movies.json');

function readSavedMovies() {
  try {
    const txt = fs.readFileSync(savedFile, 'utf8');
    return JSON.parse(txt);
  } catch {
    return [];
  }
}

function writeSavedMovies(data) {
  fs.writeFileSync(savedFile, JSON.stringify(data, null, 2));
}

app.get('/api/saved-movies', (req, res) => {
  res.json(readSavedMovies());
});

app.post('/api/saved-movies', (req, res) => {
  const movie = req.body || {};
  if (!movie || !movie.id) {
    return res.status(400).json({ error: 'invalid' });
  }
  const data = readSavedMovies();
  if (!data.some(m => String(m.id) === String(movie.id))) {
    data.push(movie);
    writeSavedMovies(data);
  }
  res.json({ status: 'ok' });
});

// --- Spotify client ID ---
app.get('/api/spotify-client-id', (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'missing' });
  }
  const hasEventbriteToken = Boolean(
    process.env.EVENTBRITE_TOKEN ||
    process.env.EVENTBRITE_API_TOKEN ||
    process.env.EVENTBRITE_OAUTH_TOKEN
  );
  res.json({ clientId, hasEventbriteToken });
});

app.get('/api/tmdb-config', (req, res) => {
  const apiKey = resolveTmdbApiKey();
  const proxyEndpoint = resolveTmdbProxyEndpoint(req);

  if (!apiKey && !proxyEndpoint) {
    return res.status(404).json({ error: 'tmdb_config_unavailable' });
  }

  const payload = {
    hasKey: Boolean(apiKey),
    hasProxy: Boolean(proxyEndpoint)
  };

  if (apiKey) {
    payload.apiKey = apiKey;
  }
  if (proxyEndpoint) {
    payload.proxyEndpoint = proxyEndpoint;
  }

  res.json(payload);
});

app.get('/api/restaurants', async (req, res) => {
  const { city, cuisine = '' } = req.query || {};
  const latitude = Number.parseFloat(req.query?.latitude);
  const longitude = Number.parseFloat(req.query?.longitude);
  const foursquareKey =
    req.get('x-api-key') || req.query.apiKey || process.env.FOURSQUARE_API_KEY;
  if (!foursquareKey) {
    return res.status(500).json({ error: 'missing foursquare api key' });
  }
  const hasCoords = Number.isFinite(latitude) && Number.isFinite(longitude);
  if (!hasCoords && !city) {
    return res.status(400).json({ error: 'missing location' });
  }

  const rawLimitParam = req.query?.limit ?? req.query?.maxResults;
  const requestedLimit = normalizePositiveInteger(rawLimitParam, {
    min: 1,
    max: FOURSQUARE_MAX_LIMIT
  });
  const limit = requestedLimit || FOURSQUARE_MAX_LIMIT;

  const parsedRadius = parseNumberQuery(req.query?.radius);
  const radiusMiles =
    Number.isFinite(parsedRadius) && parsedRadius > 0 ? Math.min(parsedRadius, 25) : null;
  const radiusMeters =
    Number.isFinite(radiusMiles) && radiusMiles > 0 ? Math.round(radiusMiles * METERS_PER_MILE) : null;

  const cacheKeyParts = foursquareCacheKeyParts({
    city,
    latitude,
    longitude,
    cuisine,
    limit,
    radiusMeters
  });

  const cached = await safeReadCachedResponse(
    FOURSQUARE_CACHE_COLLECTION,
    cacheKeyParts,
    FOURSQUARE_CACHE_TTL_MS
  );
  if (sendCachedResponse(res, cached)) {
    return;
  }

  try {
    const searchLimit = Math.min(
      FOURSQUARE_MAX_LIMIT,
      Math.max(limit, FOURSQUARE_DETAILS_MAX)
    );
    const params = new URLSearchParams();
    params.set('limit', String(searchLimit));
    params.set('categories', FOURSQUARE_CATEGORY_RESTAURANTS);
    params.set('fields', FOURSQUARE_SEARCH_FIELDS);
    if (hasCoords) {
      params.set('ll', `${latitude},${longitude}`);
      if (Number.isFinite(radiusMeters) && radiusMeters > 0) {
        params.set('radius', String(radiusMeters));
      }
      params.set('sort', 'DISTANCE');
    } else if (city) {
      params.set('near', String(city));
      params.set('sort', 'RELEVANCE');
    }
    if (cuisine) {
      params.set('query', String(cuisine));
    }

    const data = await fetchFoursquareSearch(params, foursquareKey);
    const results = Array.isArray(data?.results) ? data.results : [];
    if (!results.length) {
      const emptyPayload = JSON.stringify([]);
      await safeWriteCachedResponse(FOURSQUARE_CACHE_COLLECTION, cacheKeyParts, {
        status: 200,
        contentType: 'application/json',
        body: emptyPayload,
        metadata: {
          city: typeof city === 'string' ? city : '',
          hasCoords,
          latitude: hasCoords ? latitude : null,
          longitude: hasCoords ? longitude : null,
          cuisine: typeof cuisine === 'string' ? cuisine : '',
          limit,
          returned: 0,
          totalResults: Array.isArray(data?.results) ? data.results.length : 0,
          radiusMeters: Number.isFinite(radiusMeters) ? radiusMeters : null
        }
      });
      res.type('application/json').send(emptyPayload);
      return;
    }

    const details = await fetchFoursquareDetails(results, foursquareKey);
    const simplified = results
      .slice(0, limit)
      .map(place => simplifyFoursquarePlace(place, details.get(place.fsq_id)))
      .filter(Boolean);

    const payload = JSON.stringify(simplified);

    await safeWriteCachedResponse(FOURSQUARE_CACHE_COLLECTION, cacheKeyParts, {
      status: 200,
      contentType: 'application/json',
      body: payload,
      metadata: {
        city: typeof city === 'string' ? city : '',
        hasCoords,
        latitude: hasCoords ? latitude : null,
        longitude: hasCoords ? longitude : null,
        cuisine: typeof cuisine === 'string' ? cuisine : '',
        limit,
        returned: simplified.length,
        totalResults: Array.isArray(data?.results) ? data.results.length : null,
        radiusMeters: Number.isFinite(radiusMeters) ? radiusMeters : null
      }
    });

    res.type('application/json').send(payload);
  } catch (err) {
    console.error('Foursquare restaurant search failed', err);
    const status =
      err && typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
    const message =
      err && typeof err.message === 'string' && err.message ? err.message : 'failed';
    res.status(status).json({ error: message });
  }
});

app.get('/api/tv', async (req, res) => {
  const limit =
    normalizePositiveInteger(req.query.limit, {
      min: 1,
      max: TV_DISCOVER_MAX_LIMIT
    }) || TV_DISCOVER_DEFAULT_LIMIT;
  let minRating = parseNumberQuery(req.query.minRating);
  let minVotes = parseNumberQuery(req.query.minVotes);
  let startYear = parseNumberQuery(req.query.startYear);
  let endYear = parseNumberQuery(req.query.endYear);
  if (!Number.isFinite(minRating)) minRating = null;
  if (!Number.isFinite(minVotes)) minVotes = null;
  if (!Number.isFinite(startYear)) startYear = null;
  if (!Number.isFinite(endYear)) endYear = null;
  if (Number.isFinite(startYear) && Number.isFinite(endYear) && endYear < startYear) {
    const temp = startYear;
    startYear = endYear;
    endYear = temp;
  }
  const excludeSet = parseIdSet(req.query.excludeIds);

  const cacheKeyParts = [
    TV_DISCOVER_CACHE_COLLECTION,
    `limit:${limit}`,
    `minRating:${minRating ?? 'any'}`,
    `minVotes:${minVotes ?? 'any'}`,
    `startYear:${startYear ?? 'any'}`,
    `endYear:${endYear ?? 'any'}`,
    excludeSet.size ? Array.from(excludeSet).slice(0, 200) : 'no-excludes'
  ];

  const cached = await safeReadCachedResponse(
    TV_DISCOVER_CACHE_COLLECTION,
    cacheKeyParts,
    TV_DISCOVER_CACHE_TTL_MS
  );
  if (sendCachedResponse(res, cached)) {
    return;
  }

  try {
    const [discoverResult, genres] = await Promise.all([
      discoverTvShows({ limit, minRating, minVotes, startYear, endYear, excludeSet }),
      fetchTvGenresWithCache()
    ]);

    const genreEntries = Array.isArray(genres) ? genres : [];
    const genreMap = genreEntries.reduce((acc, entry) => {
      if (!entry || entry.id == null) return acc;
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      if (!name) return acc;
      acc[entry.id] = name;
      return acc;
    }, {});

    const response = {
      results: discoverResult.results,
      metadata: {
        limit,
        minRating: minRating ?? null,
        minVotes: minVotes ?? null,
        startYear: startYear ?? null,
        endYear: endYear ?? null,
        totalResults: discoverResult.totalResults,
        totalPages: discoverResult.totalPages,
        source: 'tmdb_discover',
        excludeCount: excludeSet.size,
        fetchedAt: new Date().toISOString()
      },
      genres: genreEntries,
      genreMap,
      credits: null
    };

    const payload = {
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
      metadata: response.metadata
    };

    await safeWriteCachedResponse(TV_DISCOVER_CACHE_COLLECTION, cacheKeyParts, payload);
    res.type('application/json').send(payload.body);
  } catch (err) {
    console.error('Failed to load TV catalog', err);
    const status =
      err && typeof err.status === 'number' && err.status >= 400 ? err.status : 500;
    res.status(status).json({
      error: 'tv_discover_failed',
      message: err?.message || 'Unable to load TV shows from TMDB'
    });
  }
});

// --- Ticketmaster shows proxy ---
const TICKETMASTER_API_KEY =
  process.env.TICKETMASTER_API_KEY ||
  process.env.TICKETMASTER_KEY ||
  process.env.TICKETMASTER_CONSUMER_KEY ||
  '';
const TICKETMASTER_API_URL = 'https://app.ticketmaster.com/discovery/v2/events.json';
const TICKETMASTER_CACHE_COLLECTION = 'ticketmasterCache';
const TICKETMASTER_CACHE_TTL_MS = 1000 * 60 * 15; // 15 minutes
const TICKETMASTER_CACHE_VERSION = 'v1';
const TICKETMASTER_MAX_RADIUS_MILES = 150;
const TICKETMASTER_DEFAULT_RADIUS = 100;
const TICKETMASTER_DEFAULT_DAYS = 14;
const TICKETMASTER_PAGE_SIZE = 100;
const TICKETMASTER_SEGMENTS = [
  { key: 'music', description: 'Live music', params: { classificationName: 'Music' } },
  { key: 'comedy', description: 'Comedy', params: { classificationName: 'Comedy' } }
];

function ticketmasterCacheKeyParts({ latitude, longitude, radiusMiles, startDateTime, endDateTime }) {
  const lat = Number.isFinite(latitude) ? latitude.toFixed(4) : 'lat:none';
  const lon = Number.isFinite(longitude) ? longitude.toFixed(4) : 'lon:none';
  const radius = Number.isFinite(radiusMiles) ? radiusMiles.toFixed(1) : 'radius:none';
  return [
    'ticketmaster',
    TICKETMASTER_CACHE_VERSION,
    `lat:${lat}`,
    `lon:${lon}`,
    `radius:${radius}`,
    `start:${startDateTime || ''}`,
    `end:${endDateTime || ''}`
  ];
}

function formatTicketmasterEvent(event, segmentKey) {
  if (!event || event.id == null) return null;
  const id = String(event.id);
  const start = event.dates && event.dates.start ? event.dates.start : {};
  const embeddedVenue = event._embedded && Array.isArray(event._embedded.venues)
    ? event._embedded.venues[0]
    : null;
  const venue = embeddedVenue || {};
  const city = venue.city && venue.city.name ? venue.city.name : '';
  const region =
    (venue.state && (venue.state.stateCode || venue.state.name)) ||
    '';
  const country =
    (venue.country && (venue.country.countryCode || venue.country.name)) ||
    '';
  const localDateTime = start.dateTime || (start.localDate ? `${start.localDate}${start.localTime ? 'T' + start.localTime : 'T00:00:00'}` : null);
  let localIso = null;
  if (localDateTime) {
    const parsed = new Date(localDateTime);
    if (!Number.isNaN(parsed.getTime())) {
      localIso = parsed.toISOString();
    }
  }
  const utcIso = start.dateTime ? new Date(start.dateTime).toISOString() : null;
  const distance = Number.isFinite(event.distance) ? Number(event.distance) : null;
  const classificationNameSet = new Set();
  const classifications = Array.isArray(event.classifications)
    ? event.classifications.map(cls => {
        const normalized = {
          primary: Boolean(cls?.primary),
          segment: cls?.segment || null,
          genre: cls?.genre || null,
          subGenre: cls?.subGenre || null,
          type: cls?.type || null,
          subType: cls?.subType || null
        };
        [
          normalized.segment?.name,
          normalized.genre?.name,
          normalized.subGenre?.name,
          normalized.type?.name,
          normalized.subType?.name
        ]
          .map(name => (typeof name === 'string' ? name.trim() : ''))
          .filter(Boolean)
          .forEach(name => classificationNameSet.add(name));
        return normalized;
      })
    : [];

  const attractions = Array.isArray(event?._embedded?.attractions)
    ? event._embedded.attractions.map(attraction => {
        const homepage =
          Array.isArray(attraction?.externalLinks?.homepage) &&
          attraction.externalLinks.homepage.length
            ? attraction.externalLinks.homepage[0].url
            : null;
        return {
          id: attraction?.id || null,
          name: attraction?.name || '',
          type: attraction?.type || null,
          url: attraction?.url || homepage || null,
          locale: attraction?.locale || null,
          classifications: Array.isArray(attraction?.classifications)
            ? attraction.classifications
            : null
        };
      })
    : [];

  const images = Array.isArray(event?.images)
    ? event.images.map(image => ({
        url: image?.url || null,
        ratio: image?.ratio || null,
        width: Number.isFinite(image?.width) ? image.width : null,
        height: Number.isFinite(image?.height) ? image.height : null,
        fallback: Boolean(image?.fallback)
      }))
    : [];

  const ticketmasterDetails = {
    raw: event,
    classifications: classifications.length ? classifications : undefined,
    priceRanges: Array.isArray(event.priceRanges) && event.priceRanges.length ? event.priceRanges : undefined,
    products: Array.isArray(event.products) && event.products.length ? event.products : undefined,
    promoter: event.promoter || undefined,
    promoters: Array.isArray(event.promoters) && event.promoters.length ? event.promoters : undefined,
    promotions: Array.isArray(event.promotions) && event.promotions.length ? event.promotions : undefined,
    sales: event.sales || undefined,
    seatmap: event.seatmap || undefined,
    ticketLimit: event.ticketLimit || undefined,
    outlets: Array.isArray(event.outlets) && event.outlets.length ? event.outlets : undefined,
    accessibility: event.accessibility || undefined,
    ageRestrictions: event.ageRestrictions || undefined,
    images: images.length ? images : undefined,
    attractions: attractions.length ? attractions : undefined,
    info: event.info || undefined,
    pleaseNote: event.pleaseNote || undefined
  };

  Object.keys(ticketmasterDetails).forEach(key => {
    const value = ticketmasterDetails[key];
    if (
      value === undefined ||
      (Array.isArray(value) && value.length === 0) ||
      (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0)
    ) {
      delete ticketmasterDetails[key];
    }
  });

  const formatted = {
    id,
    name: { text: event.name || '' },
    start: { local: localIso, utc: utcIso },
    url: event.url || '',
    venue: {
      name: venue.name || '',
      address: {
        city,
        region,
        country
      }
    },
    segment: segmentKey || null,
    distance,
    summary: event.info || event.pleaseNote || '',
    source: 'ticketmaster',
    genres: Array.from(classificationNameSet)
  };

  if (Object.keys(ticketmasterDetails).length) {
    formatted.ticketmaster = ticketmasterDetails;
  }

  return formatted;
}

async function fetchTicketmasterSegment({ latitude, longitude, radiusMiles, startDateTime, endDateTime, segment }) {
  const params = new URLSearchParams({
    apikey: TICKETMASTER_API_KEY,
    latlong: `${latitude},${longitude}`,
    radius: String(radiusMiles),
    unit: 'miles',
    size: String(TICKETMASTER_PAGE_SIZE),
    sort: 'date,asc',
    startDateTime,
    endDateTime
  });
  Object.entries(segment.params || {}).forEach(([key, value]) => {
    if (value != null) params.set(key, value);
  });
  const url = `${TICKETMASTER_API_URL}?${params.toString()}`;
  const response = await fetch(url);
  const text = await response.text();
  if (!response.ok) {
    const err = new Error(text || `Ticketmaster request failed: ${response.status}`);
    err.status = response.status;
    err.requestUrl = url;
    err.responseText = text;
    throw err;
  }
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    const err = new Error('Ticketmaster response was not valid JSON');
    err.status = response.status;
    err.requestUrl = url;
    err.responseText = text;
    throw err;
  }
  const events = Array.isArray(data?._embedded?.events) ? data._embedded.events : [];
  const formatted = events.map(event => formatTicketmasterEvent(event, segment.key)).filter(Boolean);
  return {
    events: formatted,
    summary: {
      key: segment.key,
      description: segment.description,
      status: response.status,
      total: formatted.length,
      requestUrl: url,
      rawTotal: typeof data?.page?.totalElements === 'number' ? data.page.totalElements : null
    }
  };
}

app.get('/api/shows', async (req, res) => {
  const rawLat = req.query.lat ?? req.query.latitude;
  const rawLon = req.query.lon ?? req.query.longitude;
  const latitude = normalizeCoordinate(rawLat, 4);
  const longitude = normalizeCoordinate(rawLon, 4);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return res.status(400).json({ error: 'missing_coordinates' });
  }

  if (!TICKETMASTER_API_KEY) {
    return res.status(500).json({ error: 'ticketmaster_api_key_missing' });
  }

  const parsedRadius = parseNumberQuery(req.query.radius);
  const radiusMiles = Number.isFinite(parsedRadius) && parsedRadius > 0
    ? Math.min(Math.max(parsedRadius, 1), TICKETMASTER_MAX_RADIUS_MILES)
    : TICKETMASTER_DEFAULT_RADIUS;

  const lookaheadDays = clampDays(req.query.days) || TICKETMASTER_DEFAULT_DAYS;

  const startDate = new Date();
  const startDateTime = startDate.toISOString().split('.')[0] + 'Z';
  const endDate = new Date(startDate);
  endDate.setUTCDate(endDate.getUTCDate() + lookaheadDays);
  const endDateTime = endDate.toISOString().split('.')[0] + 'Z';

  const cacheKey = ticketmasterCacheKeyParts({
    latitude,
    longitude,
    radiusMiles,
    startDateTime,
    endDateTime
  });

  const cached = await safeReadCachedResponse(
    TICKETMASTER_CACHE_COLLECTION,
    cacheKey,
    TICKETMASTER_CACHE_TTL_MS
  );
  if (sendCachedResponse(res, cached)) {
    return;
  }

  const segmentResults = await Promise.all(
    TICKETMASTER_SEGMENTS.map(segment =>
      fetchTicketmasterSegment({
        latitude,
        longitude,
        radiusMiles,
        startDateTime,
        endDateTime,
        segment
      }).catch(error => ({ error, segment }))
    )
  );

  const combined = new Map();
  const segmentSummaries = [];
  let successful = false;

  for (const result of segmentResults) {
    if (result.error) {
      const { error, segment } = result;
      console.error('Ticketmaster segment fetch failed', segment.description || segment.key, error);
      segmentSummaries.push({
        key: segment.key,
        description: segment.description,
        ok: false,
        status: typeof error.status === 'number' ? error.status : null,
        error: error.message || 'Request failed',
        requestUrl: error.requestUrl || null
      });
      continue;
    }

    successful = true;
    segmentSummaries.push({
      key: result.summary.key,
      description: result.summary.description,
      ok: true,
      status: result.summary.status,
      total: result.summary.total,
      requestUrl: result.summary.requestUrl,
      rawTotal: result.summary.rawTotal
    });

    for (const event of result.events) {
      if (!event || event.id == null) continue;
      const key = String(event.id);
      if (!combined.has(key)) {
        combined.set(key, event);
      }
    }
  }

  if (!successful) {
    return res.status(502).json({
      error: 'ticketmaster_fetch_failed',
      segments: segmentSummaries
    });
  }

  const events = Array.from(combined.values()).sort((a, b) => {
    const aTime = a.start && a.start.utc ? Date.parse(a.start.utc) : (a.start && a.start.local ? Date.parse(a.start.local) : Infinity);
    const bTime = b.start && b.start.utc ? Date.parse(b.start.utc) : (b.start && b.start.local ? Date.parse(b.start.local) : Infinity);
    if (Number.isFinite(aTime) && Number.isFinite(bTime)) {
      if (aTime !== bTime) return aTime - bTime;
    } else if (Number.isFinite(aTime)) {
      return -1;
    } else if (Number.isFinite(bTime)) {
      return 1;
    }
    const aDistance = Number.isFinite(a.distance) ? a.distance : Infinity;
    const bDistance = Number.isFinite(b.distance) ? b.distance : Infinity;
    return aDistance - bDistance;
  });

  const payload = {
    source: 'ticketmaster',
    generatedAt: new Date().toISOString(),
    cached: false,
    radiusMiles,
    lookaheadDays,
    events,
    segments: segmentSummaries
  };

  await safeWriteCachedResponse(TICKETMASTER_CACHE_COLLECTION, cacheKey, {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(payload),
    metadata: {
      radiusMiles,
      lookaheadDays,
      cachedAt: new Date().toISOString(),
      segments: segmentSummaries
    }
  });

  res.json(payload);
});

app.get('/api/youtube/search', async (req, res) => {
  const rawQuery =
    req.query.q ?? req.query.query ?? req.query.term ?? req.query.artist ?? req.query.name ?? '';
  const query = normalizeYouTubeQuery(rawQuery);

  if (!query) {
    return res.status(400).json({ error: 'missing_query' });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(501).json({ error: 'youtube_api_key_missing' });
  }

  const cacheKey = youtubeSearchCacheKey(query);
  const cached = await safeReadCachedResponse(
    YOUTUBE_SEARCH_CACHE_COLLECTION,
    cacheKey,
    YOUTUBE_SEARCH_CACHE_TTL_MS
  );
  if (sendCachedResponse(res, cached)) {
    return;
  }

  const params = new URLSearchParams({
    key: YOUTUBE_API_KEY,
    part: 'snippet',
    type: 'video',
    maxResults: '1',
    videoEmbeddable: 'true',
    videoSyndicated: 'true',
    safeSearch: 'moderate',
    q: query
  });

  const url = `${YOUTUBE_SEARCH_BASE_URL}?${params.toString()}`;

  let response;
  let text;

  try {
    response = await fetch(url);
    text = await response.text();
  } catch (err) {
    console.error('YouTube search request failed', { query, err });
    return res.status(502).json({ error: 'youtube_search_failed' });
  }

  if (!response.ok) {
    console.error(
      'YouTube search responded with error',
      response.status,
      text ? text.slice(0, 200) : ''
    );
    return res.status(response.status).json({ error: 'youtube_search_error' });
  }

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (err) {
    console.error('Failed to parse YouTube search response as JSON', err);
    return res.status(502).json({ error: 'youtube_response_invalid' });
  }

  const items = Array.isArray(data?.items) ? data.items : [];
  const bestItem = items.find(item => item?.id?.videoId);

  const snippet = bestItem?.snippet && typeof bestItem.snippet === 'object' ? bestItem.snippet : {};
  const videoId = typeof bestItem?.id?.videoId === 'string' ? bestItem.id.videoId.trim() : '';

  const payload = {
    query,
    video: videoId
      ? {
          id: videoId,
          title: typeof snippet.title === 'string' ? snippet.title : '',
          description: typeof snippet.description === 'string' ? snippet.description : '',
          channel: {
            id: typeof snippet.channelId === 'string' ? snippet.channelId : '',
            title: typeof snippet.channelTitle === 'string' ? snippet.channelTitle : ''
          },
          publishedAt: typeof snippet.publishedAt === 'string' ? snippet.publishedAt : '',
          thumbnails: normalizeYouTubeThumbnails(snippet.thumbnails),
          url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          embedUrl: `https://www.youtube.com/embed/${encodeURIComponent(videoId)}`
        }
      : null
  };

  const body = JSON.stringify(payload);

  await safeWriteCachedResponse(YOUTUBE_SEARCH_CACHE_COLLECTION, cacheKey, {
    status: 200,
    contentType: 'application/json',
    body,
    metadata: { query, fetchedAt: new Date().toISOString() }
  });

  res.set('Cache-Control', 'public, max-age=1800');
  res.type('application/json').send(body);
});

// --- GeoLayers game endpoints ---
const layerOrder = ['rivers','lakes','elevation','roads','outline','cities','label'];
const countriesPath = path.join(__dirname, '../geolayers-game/public/countries.json');
let countryData = [];
try {
  countryData = JSON.parse(fs.readFileSync(countriesPath, 'utf8'));
} catch {
  countryData = [];
}
const locations = countryData.map(c => c.code);
const leaderboard = [];
const countryNames = Object.fromEntries(countryData.map(c => [c.code, c.name]));

async function fetchCitiesForCountry(iso3) {
  const endpoint = 'https://query.wikidata.org/sparql';
  const query = `
SELECT ?city ?cityLabel ?population ?coord WHERE {
  ?country wdt:P298 "${iso3}".
  ?city (wdt:P31/wdt:P279*) wd:Q515;
        wdt:P17 ?country;
        wdt:P625 ?coord.
  OPTIONAL { ?city wdt:P1082 ?population. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY DESC(?population)
LIMIT 10`;
  const url = endpoint + '?format=json&query=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/sparql-results+json',
      'User-Agent': 'dashboard-app/1.0'
    }
  });
  if (!res.ok) throw new Error('SPARQL query failed');
  const data = await res.json();
  const features = data.results.bindings
    .map(b => {
      const m = /Point\(([-\d\.eE]+)\s+([-\d\.eE]+)\)/.exec(b.coord.value);
      if (!m) return null;
      const lon = Number(m[1]);
      const lat = Number(m[2]);
      if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
      return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
          name: b.cityLabel?.value || '',
          population: b.population ? Number(b.population.value) : null
        }
      };
    })
    .filter(Boolean);
  return { type: 'FeatureCollection', features };
}

async function ensureCitiesForCountry(code) {
  const dir = path.join(__dirname, '../geolayers-game/public/data', code);
  const file = path.join(dir, 'cities.geojson');
  if (!fs.existsSync(file)) {
    const geo = await fetchCitiesForCountry(code);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(geo));
    console.log('Fetched cities for', code);
  }
  return file;
}

async function ensureAllCities() {
  for (const code of locations) {
    try {
      await ensureCitiesForCountry(code);
    } catch (err) {
      console.error('Failed to fetch cities for', code, err);
    }
  }
}

function dailySeed() {
  const today = new Date().toISOString().slice(0,10);
  let seed = 0;
  for (const c of today) {
    seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  }
  return seed;
}

function pickLocation() {
  const seed = dailySeed();
  return locations[seed % locations.length];
}

app.get('/daily', (req, res) => {
  const loc = pickLocation();
  res.json({
    locationId: loc,
    layers: layerOrder.map(l => `/layer/${loc}/${l}`)
  });
});

app.get('/countries', (req, res) => {
  const list = Object.entries(countryNames).map(([code, name]) => ({ code, name }));
  res.json(list);
});

app.get('/layer/:loc/:name', async (req, res) => {
  const { loc, name } = req.params;
  const file = path.join(__dirname, '../geolayers-game/public/data', loc, `${name}.geojson`);
  if (name === 'cities' && !fs.existsSync(file)) {
    try {
      await ensureCitiesForCountry(loc);
    } catch (err) {
      console.error('ensureCitiesForCountry failed', err);
    }
  }
  fs.readFile(file, 'utf8', (err, data) => {
    if (err) return res.status(404).send('Layer not found');
    res.type('application/json').send(data);
  });
});

app.post('/score', (req, res) => {
  const { playerName, score } = req.body || {};
  if (typeof playerName === 'string' && typeof score === 'number') {
    leaderboard.push({ playerName, score });
    leaderboard.sort((a, b) => b.score - a.score);
    res.json({ status: 'ok' });
  } else {
    res.status(400).json({ error: 'invalid' });
  }
});

app.get('/leaderboard', (req, res) => {
  res.json(leaderboard.slice(0, 10));
});

app.get('/api/movies', async (req, res) => {
  try {
    const query = typeof req.query.q === 'string' ? req.query.q : '';
    const limit = parseNumberQuery(req.query.limit) ?? DEFAULT_MOVIE_LIMIT;
    const freshLimit = parseNumberQuery(req.query.freshLimit);
    const minScore = parseNumberQuery(req.query.minScore);
    const includeFresh = parseBooleanQuery(
      req.query.includeFresh ?? req.query.fresh ?? req.query.includeNew
    );
    const freshOnly =
      parseBooleanQuery(req.query.freshOnly ?? req.query.onlyFresh ?? req.query.newOnly) ||
      (typeof req.query.scope === 'string' && req.query.scope.toLowerCase() === 'new');
    const forceRefresh = parseBooleanQuery(req.query.refresh);

    const curatedLimit = Math.max(1, Number(limit) || 20);
    const fallbackFreshLimit = Math.max(1, Math.min(curatedLimit, 10));
    const effectiveFreshLimit = Math.max(1, Number(freshLimit) || fallbackFreshLimit);

    const catalogState = await movieCatalog.ensureCatalog({ forceRefresh });
    const hasCredentials = movieCatalog.hasTmdbCredentials();
    const curatedSearch = movieCatalog.searchCatalogWithStats(query, {
      limit: curatedLimit,
      minScore: minScore == null ? undefined : minScore
    });
    const curatedResults = freshOnly ? [] : curatedSearch.results;
    const curatedTotalMatches = Math.max(
      0,
      Number.isFinite(curatedSearch?.totalMatches)
        ? Number(curatedSearch.totalMatches)
        : Array.isArray(curatedSearch?.results)
        ? curatedSearch.results.length
        : 0
    );
    const curatedReturnedCount = freshOnly
      ? 0
      : Array.isArray(curatedResults)
      ? curatedResults.length
      : 0;

    let freshResults = [];
    let freshError = null;
    const shouldFetchFresh =
      freshOnly ||
      includeFresh ||
      (!curatedResults.length && Boolean(query));

    if (shouldFetchFresh) {
      if (hasCredentials) {
        try {
          freshResults = await movieCatalog.fetchNewReleases({
            query,
            limit: freshOnly ? curatedLimit : effectiveFreshLimit,
            excludeIds: curatedResults.map(movie => movie.id)
          });
        } catch (err) {
          console.error('Failed to fetch new release movies', err);
          freshError = 'failed';
        }
      } else {
        freshError = 'credentials missing';
      }
    }

    const response = {
      results: freshOnly ? freshResults : curatedResults,
      curated: curatedResults,
      fresh: freshResults,
      metadata: {
        query: query || null,
        curatedCount: curatedTotalMatches,
        curatedReturnedCount,
        freshCount: freshResults.length,
        totalCatalogSize:
          catalogState?.metadata?.total ?? catalogState?.movies?.length ?? 0,
        catalogUpdatedAt:
          catalogState?.metadata?.updatedAt ||
          (catalogState?.updatedAt
            ? new Date(catalogState.updatedAt).toISOString()
            : null),
        minScore: minScore == null ? movieCatalog.MIN_SCORE : minScore,
        includeFresh: Boolean(shouldFetchFresh && hasCredentials),
        freshOnly: Boolean(freshOnly),
        curatedLimit,
        source: catalogState?.metadata?.source || null,
        freshRequested: Boolean(shouldFetchFresh)
      }
    };

    if (freshOnly) {
      response.curated = curatedResults;
      response.metadata.curatedCount = curatedResults.length;
    }

    if (freshError) {
      response.metadata.freshError = freshError;
    }

    res.json(response);
  } catch (err) {
    console.error('Failed to fetch movies', err);
    res.status(500).json({ error: 'Failed to fetch movies' });
  }
});

app.get('/api/movies/stats', async (req, res) => {
  try {
    const catalogState = await movieCatalog.ensureCatalog();
    const movies = Array.isArray(catalogState?.movies) ? catalogState.movies : [];
    const excludeRaw = req.query.excludeIds;
    const excludeSet = new Set();

    const addExclusions = value => {
      if (!value) return;
      const parts = String(value)
        .split(/[,|\s]+/)
        .map(part => part.trim())
        .filter(Boolean);
      parts.forEach(part => excludeSet.add(part));
    };

    if (Array.isArray(excludeRaw)) {
      excludeRaw.forEach(addExclusions);
    } else if (typeof excludeRaw === 'string') {
      addExclusions(excludeRaw);
    }

    const bucketStats = MOVIE_STATS_BUCKETS.map(bucket => ({
      label: bucket.label,
      min: bucket.min,
      max: bucket.max,
      count: 0
    }));

    let total = 0;
    movies.forEach(movie => {
      if (!movie || movie.id == null) return;
      const id = String(movie.id);
      if (excludeSet.has(id)) return;
      total += 1;
      const score = Number(movie.score);
      if (!Number.isFinite(score)) return;
      for (const bucket of bucketStats) {
        const meetsMin = bucket.min === -Infinity ? true : score >= bucket.min;
        const belowMax = bucket.max === Infinity ? true : score < bucket.max;
        if (meetsMin && belowMax) {
          bucket.count += 1;
          break;
        }
      }
    });

    res.json({
      total,
      catalogTotal: movies.length,
      catalogUpdatedAt:
        catalogState?.metadata?.updatedAt ||
        (catalogState?.updatedAt
          ? new Date(catalogState.updatedAt).toISOString()
          : null),
      buckets: bucketStats.map(({ label, count }) => ({ label, count }))
    });
  } catch (err) {
    console.error('Failed to compute movie stats', err);
    res.status(500).json({ error: 'failed_to_compute_movie_stats' });
  }
});

app.get('/api/movie-ratings', async (req, res) => {
  const imdbId = sanitizeOmdbString(req.query.imdbId || req.query.imdbID);
  const title = sanitizeOmdbString(req.query.title);
  const year = sanitizeOmdbString(req.query.year);
  const typeParam = sanitizeOmdbString(req.query.type).toLowerCase();
  const allowedTypes = new Set(['movie', 'series', 'episode']);
  const type = allowedTypes.has(typeParam) ? typeParam : '';
  const forceRefresh = parseBooleanQuery(req.query.refresh);
  const queryApiKey = sanitizeOmdbString(req.query.apiKey);
  const apiKey = queryApiKey || OMDB_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      error: 'omdb_key_missing',
      message: 'OMDb API key is not configured on the server.'
    });
  }

  if (!imdbId && !title) {
    return res.status(400).json({
      error: 'missing_lookup',
      message: 'Provide an imdbId or title to look up critic scores.'
    });
  }

  const cacheParts = buildOmdbCacheKeyParts({
    imdbId,
    title,
    year,
    type: type || 'any'
  });

  if (!forceRefresh) {
    const cached = await safeReadCachedResponse(
      OMDB_CACHE_COLLECTION,
      cacheParts,
      OMDB_CACHE_TTL_MS
    );
    if (sendCachedResponse(res, cached)) {
      return;
    }
  }

  const params = new URLSearchParams();
  params.set('apikey', apiKey);
  if (imdbId) {
    params.set('i', imdbId);
  } else if (title) {
    params.set('t', title);
  }
  if (year) params.set('y', year);
  if (type) params.set('type', type);
  params.set('plot', 'short');
  params.set('r', 'json');

  try {
    const response = await fetch(`${OMDB_BASE_URL}?${params.toString()}`);
    if (!response.ok) {
      const status = response.status || 502;
      return res.status(status).json({
        error: 'omdb_request_failed',
        message: `OMDb request failed with status ${status}`
      });
    }

    const data = await response.json();
    if (!data || data.Response === 'False') {
      const message = typeof data?.Error === 'string' ? data.Error : 'OMDb returned no results';
      const normalized = message.toLowerCase();
      if (normalized.includes('api key')) {
        return res.status(401).json({ error: 'omdb_invalid_key', message });
      }
      return res.status(404).json({ error: 'omdb_not_found', message });
    }

    const payload = normalizeOmdbPayload(data, {
      type: type || null,
      requestedTitle: title,
      requestedYear: year
    });

    if (!payload) {
      return res.status(404).json({
        error: 'omdb_not_found',
        message: 'OMDb did not return critic scores for this title.'
      });
    }

    const body = JSON.stringify(payload);
    await safeWriteCachedResponse(OMDB_CACHE_COLLECTION, cacheParts, {
      body,
      metadata: {
        imdbId: payload.imdbId || imdbId || null,
        title: payload.title || title || null,
        year: payload.year || year || null,
        type: payload.type || type || null
      }
    });

    res.json(payload);
  } catch (err) {
    console.error('Failed to fetch critic scores from OMDb', err);
    res.status(500).json({
      error: 'omdb_request_failed',
      message: 'Failed to fetch critic scores.'
    });
  }
});

app.get('/api/transactions', async (req, res) => {
  if (!plaidClient || !process.env.PLAID_ACCESS_TOKEN) {
    res.status(500).json({ error: 'Plaid not configured' });
    return;
  }
  try {
    const start = new Date();
    start.setMonth(start.getMonth() - 1);
    const end = new Date();
    const response = await plaidClient.transactionsGet({
      access_token: process.env.PLAID_ACCESS_TOKEN,
      start_date: start.toISOString().slice(0, 10),
      end_date: end.toISOString().slice(0, 10)
    });
    res.json(response.data);
  } catch (err) {
    console.error('Plaid error', err);
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

if (require.main === module) {
  let server = null;
  server = app
    .listen(PORT, HOST, () => {
      console.log(
        `✅ Serving static files at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`
      );
    })
    .on('error', err => {
      console.error('Failed to start server', err);
      process.exit(1);
    });
  module.exports = server;
  module.exports.app = app;
} else {
  module.exports = app;
}
