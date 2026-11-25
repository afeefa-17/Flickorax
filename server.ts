import 'dotenv/config';
import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  addLocalWatchlistItem,
  authenticateBearerToken,
  getLocalUserData,
  loginLocalUser,
  logoutLocalSession,
  removeLocalWatchlistItem,
  saveLocalUserPreferences,
  signupLocalUser,
} from './server/authStore.ts';
import {
  generateBecauseYouLikedCandidates,
  generateSoloCandidates,
  generateSurpriseCandidates,
  generateWatchPartyCandidates,
  isQuotaExhaustedError,
  isTransientHighDemandError,
} from './server/geminiService.ts';
import {
  discoverFallbackFromDatabases,
  getCatalogOptions,
  getGuaranteedPopularFallback,
  getMediaDetails,
  getTrendingMedia,
  isTmdbConfigured,
  verifyCandidateInDatabases,
} from './server/mediaServices.ts';
import {
  beginPartyRoomMatch,
  completePartyRoomMatch,
  createPartyRoom,
  getPartyRoomState,
  joinPartyRoom,
  submitPartyMemberPicks,
} from './server/watchPartyStore.ts';
import {
  createEmptyPreferences,
  type MediaRecommendation,
  type MediaTypeChoice,
  type MoodChoice,
  type PreferencesInput,
  type SavedPreferencesDoc,
} from './src/types/flickorax.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json({ limit: '1mb' }));

function sanitizePreferences(raw: unknown): PreferencesInput {
  const base = createEmptyPreferences();
  if (!raw || typeof raw !== 'object') return base;
  const r = raw as Record<string, unknown>;

  const validTypes: MediaTypeChoice[] = ['Movies', 'Anime', 'Series', 'Dramas', 'Anything'];
  if (typeof r.type === 'string' && validTypes.includes(r.type as MediaTypeChoice)) {
    base.type = r.type as MediaTypeChoice;
  }
  if (Array.isArray(r.languages)) {
    base.languages = r.languages.filter((x): x is string => typeof x === 'string').slice(0, 30);
  }
  if (typeof r.subtitlesFine === 'boolean') {
    base.subtitlesFine = r.subtitlesFine;
  }
  if (Array.isArray(r.genres)) {
    base.genres = r.genres.filter((x): x is string => typeof x === 'string').slice(0, 40);
  }
  const validMoods: MoodChoice[] = ['Happy', 'Sad', 'Romantic', 'Thrilling', 'Relaxed', 'Surprise me'];
  if (Array.isArray(r.moods)) {
    base.moods = r.moods.filter(
      (x): x is MoodChoice => typeof x === 'string' && validMoods.includes(x as MoodChoice)
    );
  }
  if (r.releasePeriod && typeof r.releasePeriod === 'object') {
    const rp = r.releasePeriod as Record<string, unknown>;
    base.releasePeriod = {
      anyYear: typeof rp.anyYear === 'boolean' ? rp.anyYear : true,
      fromYear: typeof rp.fromYear === 'number' ? Math.max(1920, Math.min(2030, rp.fromYear)) : 1990,
      toYear: typeof rp.toYear === 'number' ? Math.max(1920, Math.min(2030, rp.toYear)) : new Date().getFullYear(),
    };
  }
  if (r.duration === 'Short' || r.duration === 'Medium' || r.duration === 'Long') {
    base.duration = r.duration;
  }
  if (typeof r.minRating === 'number' && r.minRating >= 1 && r.minRating <= 10) {
    base.minRating = r.minRating;
  }
  if (Array.isArray(r.countries)) {
    base.countries = r.countries.filter((x): x is string => typeof x === 'string').slice(0, 30);
  }
  if (typeof r.storyPreference === 'string') {
    base.storyPreference = r.storyPreference.slice(0, 500);
  }
  return base;
}

function matchesRequestedType(item: MediaRecommendation, requested: MediaTypeChoice): boolean {
  if (requested === 'Anything') return true;
  if (requested === 'Movies') return item.mediaType === 'movie';
  if (requested === 'Anime') return item.mediaType === 'anime';
  if (requested === 'Series') return item.mediaType === 'series' || item.mediaType === 'drama';
  if (requested === 'Dramas') {
    return item.mediaType === 'drama' || (item.mediaType === 'series' && item.genres.includes('Drama'));
  }
  return true;
}

function mergeWatchPartyPreferencesForFallback(
  memberPreferences: { name: string; preferences: PreferencesInput | null }[]
): PreferencesInput {
  const merged = createEmptyPreferences();
  const submitted = memberPreferences
    .map((m) => m.preferences)
    .filter((p): p is PreferencesInput => Boolean(p));

  if (submitted.length === 0) return merged;

  const typeCounts = new Map<MediaTypeChoice, number>();
  const genreCounts = new Map<string, number>();
  const moodSet = new Set<MoodChoice>();
  const langSet = new Set<string>();
  const countrySet = new Set<string>();

  for (const p of submitted) {
    if (p.type && p.type !== 'Anything') {
      typeCounts.set(p.type, (typeCounts.get(p.type) || 0) + 1);
    }
    for (const g of p.genres) {
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
    }
    for (const m of p.moods) {
      if (m !== 'Surprise me') moodSet.add(m);
    }
    for (const l of p.languages) langSet.add(l);
    for (const c of p.countries) {
      if (c !== 'ANY') countrySet.add(c);
    }
  }

  const topType = Array.from(typeCounts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0];
  if (topType) merged.type = topType;
  merged.genres = Array.from(genreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([g]) => g);
  merged.moods = Array.from(moodSet);
  merged.languages = Array.from(langSet).slice(0, 8);
  merged.subtitlesFine = submitted.some((p) => p.subtitlesFine);
  merged.countries = Array.from(countrySet).slice(0, 8);
  return merged;
}

async function runGroupMatch(
  memberPreferences: { name: string; preferences: PreferencesInput | null }[],
  excludeTitles: string[]
): Promise<MediaRecommendation[]> {
  const animeOnly = !isTmdbConfigured();
  const verified: MediaRecommendation[] = [];
  const seen = new Set<string>(excludeTitles.map((t: string) => t.toLowerCase()));
  const mergedPrefs = mergeWatchPartyPreferencesForFallback(memberPreferences);

  try {
    const candidates = await generateWatchPartyCandidates(memberPreferences, excludeTitles, animeOnly);
    const checked = await Promise.all(
      candidates.map((c) =>
        verifyCandidateInDatabases(c, mergedPrefs, {
          checkLanguage: false,
          checkCountry: false,
          checkYear: false,
          checkGenres: false,
        })
      )
    );
    for (const item of checked) {
      if (!item) continue;
      if (seen.has(item.title.toLowerCase())) continue;
      seen.add(item.title.toLowerCase());
      verified.push(item);
      if (verified.length >= 5) break;
    }
  } catch (aiErr) {
    console.info('Watch Party using TMDB/AniList discovery:', aiErr instanceof Error ? aiErr.message : 'fallback');
  }

  if (verified.length < 5) {
    const seenIds = new Set(verified.map((v) => v.externalId));
    const fallback = await discoverFallbackFromDatabases(
      mergedPrefs,
      { useDuration: false, useYear: false, useCountry: true, useLanguage: true, useGenres: true },
      seenIds,
      5 - verified.length
    );
    for (const item of fallback) {
      if (!seen.has(item.title.toLowerCase())) {
        seen.add(item.title.toLowerCase());
        verified.push({ ...item, reason: 'Matched for your Watch Party tastes from TMDB & AniList.' });
        if (verified.length >= 5) break;
      }
    }
  }

  if (verified.length < 5) {
    const seenIds = new Set(verified.map((v) => v.externalId));
    const broad = await discoverFallbackFromDatabases(
      { ...createEmptyPreferences(), type: mergedPrefs.type },
      { useDuration: false, useYear: false, useCountry: false, useLanguage: false, useGenres: false },
      seenIds,
      5 - verified.length
    );
    for (const item of broad) {
      if (!seen.has(item.title.toLowerCase())) {
        seen.add(item.title.toLowerCase());
        verified.push({ ...item, reason: 'Crowd-pleasing verified pick selected for your group.' });
        if (verified.length >= 5) break;
      }
    }
  }

  if (verified.length < 5) {
    const seenIds = new Set(verified.map((v) => v.externalId));
    const popular = await getGuaranteedPopularFallback(mergedPrefs.type, seenIds, 5 - verified.length);
    for (const item of popular) {
      if (!seen.has(item.title.toLowerCase())) {
        seen.add(item.title.toLowerCase());
        verified.push({ ...item, reason: 'Popular verified pick selected for your Watch Party.' });
        if (verified.length >= 5) break;
      }
    }
  }

  return verified.slice(0, 5);
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    tmdbConfigured: isTmdbConfigured(),
    geminiConfigured: Boolean(
      (process.env.GEMINI_API_KEY || '').trim() && process.env.GEMINI_API_KEY !== 'MY_GEMINI_API_KEY'
    ),
  });
});

// --- Local Email/Password Authentication & User Data API ---

app.post('/api/auth/signup', (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name : '';
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = signupLocalUser(name, email, password);
    res.status(201).json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Sign up failed.';
    res.status(400).json({ error: msg });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = loginLocalUser(email, password);
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Login failed.';
    res.status(401).json({ error: msg });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logoutLocalSession(req.headers.authorization);
  res.json({ ok: true });
});

app.get('/api/user/data', (req, res) => {
  const user = authenticateBearerToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  res.json(getLocalUserData(user.uid));
});

app.put('/api/user/preferences', (req, res) => {
  const user = authenticateBearerToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  const prefs = sanitizePreferences(req.body?.preferences);
  const saved = saveLocalUserPreferences(user.uid, prefs);
  res.json({ savedPreferences: saved });
});

app.post('/api/user/watchlist', (req, res) => {
  const user = authenticateBearerToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  const item = req.body?.item as MediaRecommendation | undefined;
  if (!item || typeof item !== 'object' || !item.externalId) {
    return res.status(400).json({ error: 'Invalid watchlist item.' });
  }
  const watchlist = addLocalWatchlistItem(user.uid, item);
  res.json({ watchlist });
});

app.delete('/api/user/watchlist/:externalId', (req, res) => {
  const user = authenticateBearerToken(req.headers.authorization);
  if (!user) return res.status(401).json({ error: 'Authentication required.' });
  const watchlist = removeLocalWatchlistItem(user.uid, req.params.externalId);
  res.json({ watchlist });
});

// --- Watch Party Guest-Friendly Rooms API ---

app.post('/api/watch-party/rooms', (req, res) => {
  try {
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname : '';
    const created = createPartyRoom(nickname);
    res.status(201).json(created);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : 'Failed to create room.' });
  }
});

app.post('/api/watch-party/rooms/:code/join', (req, res) => {
  try {
    const nickname = typeof req.body?.nickname === 'string' ? req.body.nickname : '';
    const existingToken = typeof req.body?.existingToken === 'string' ? req.body.existingToken : undefined;
    const joined = joinPartyRoom(req.params.code, nickname, existingToken);
    res.json(joined);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Failed to join room.';
    const status = msg.includes('full') ? 409 : msg.includes('expired') ? 410 : msg.includes('not found') ? 404 : 400;
    res.status(status).json({ error: msg });
  }
});

app.get('/api/watch-party/rooms/:code', (req, res) => {
  try {
    const state = getPartyRoomState(req.params.code, req.headers.authorization);
    res.json(state);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode || 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Failed to load room.' });
  }
});

app.post('/api/watch-party/rooms/:code/picks', (req, res) => {
  try {
    const prefs = sanitizePreferences(req.body?.preferences);
    const updated = submitPartyMemberPicks(req.params.code, req.headers.authorization, prefs);
    res.json(updated);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode || 400;
    res.status(status).json({ error: err instanceof Error ? err.message : 'Failed to submit picks.' });
  }
});

app.post('/api/watch-party/rooms/:code/match', async (req, res) => {
  try {
    const { memberPreferences } = beginPartyRoomMatch(req.params.code, req.headers.authorization);
    const excludeTitles = Array.isArray(req.body?.excludeTitles)
      ? req.body.excludeTitles.filter((x: unknown): x is string => typeof x === 'string').slice(0, 30)
      : [];

    const items = await runGroupMatch(memberPreferences, excludeTitles);
    const completed = completePartyRoomMatch(req.params.code, items, '');
    res.json(completed);
  } catch (err) {
    const status = (err as Error & { statusCode?: number }).statusCode || 500;
    const msg = err instanceof Error ? err.message : 'Watch Party matching failed.';
    if (status >= 500) {
      try {
        completePartyRoomMatch(req.params.code, [], msg);
      } catch {
        // ignore if room expired
      }
    }
    res.status(status).json({ error: msg });
  }
});

// --- Catalog, Trending & Recommendations ---

app.get('/api/options', async (_req, res) => {
  try {
    const data = await getCatalogOptions();
    res.json(data);
  } catch (err) {
    console.error('/api/options error:', err);
    res.status(500).json({ error: 'Failed to load catalog options.' });
  }
});

app.get('/api/trending', async (_req, res) => {
  try {
    const data = await getTrendingMedia();
    res.json(data);
  } catch (err) {
    console.error('/api/trending error:', err);
    res.status(500).json({ error: 'Failed to load trending titles.' });
  }
});

app.post('/api/recommendations', async (req, res) => {
  try {
    const prefs = sanitizePreferences(req.body?.preferences);
    const excludeTitles = Array.isArray(req.body?.excludeTitles)
      ? req.body.excludeTitles.filter((x: unknown): x is string => typeof x === 'string').slice(0, 30)
      : [];

    const tmdbReady = isTmdbConfigured();
    if (!tmdbReady && (prefs.type === 'Movies' || prefs.type === 'Series' || prefs.type === 'Dramas')) {
      return res.status(400).json({
        error:
          'TMDB_API_KEY is not configured on the server yet. Add TMDB_API_KEY to your environment secrets to search Movies, Series, and Dramas (Anime via AniList works without a key).',
        tmdbConfigured: false,
      });
    }

    const collected: MediaRecommendation[] = [];
    const seenIds = new Set<string>();
    const seenTitles = new Set<string>(excludeTitles.map((t: string) => t.toLowerCase()));
    const relaxedFilters: string[] = [];
    const animeOnly = !tmdbReady && prefs.type === 'Anything';

    const addVerified = (item: MediaRecommendation | null) => {
      if (!item) return;
      if (!matchesRequestedType(item, prefs.type)) return;
      if (seenIds.has(item.externalId) || seenTitles.has(item.title.toLowerCase())) return;
      seenIds.add(item.externalId);
      seenTitles.add(item.title.toLowerCase());
      collected.push(item);
    };

    const flags = {
      useDuration: true,
      useYear: true,
      useCountry: true,
      useLanguage: true,
      useGenres: true,
    };

    let aiFallbackUsed = false;
    let aiHighDemand = false;
    let aiQuotaExhausted = false;
    let aiCandidates: Awaited<ReturnType<typeof generateSoloCandidates>> = [];
    try {
      aiCandidates = await generateSoloCandidates(
        prefs,
        flags,
        Array.from(seenTitles),
        10,
        animeOnly
      );
      const verifiedList = await Promise.all(
        aiCandidates.map((c) =>
          verifyCandidateInDatabases(c, prefs, {
            checkLanguage: flags.useLanguage,
            checkCountry: flags.useCountry,
            checkYear: flags.useYear,
            checkGenres: true,
          })
        )
      );
      for (const v of verifiedList) {
        addVerified(v);
        if (collected.length >= 5) break;
      }

      // If Gemini candidates were filtered out solely by missing cross-medium genre tags on TMDB TV,
      // re-check remaining Gemini candidates keeping Language/Country/Year strict before touching DB relaxation.
      if (collected.length < 5 && aiCandidates.length > 0 && prefs.genres.length > 0) {
        const remainingCandidates = aiCandidates.filter(
          (c) => !seenTitles.has(c.title.toLowerCase())
        );
        if (remainingCandidates.length > 0) {
          const softGenreList = await Promise.all(
            remainingCandidates.map((c) =>
              verifyCandidateInDatabases(c, prefs, {
                checkLanguage: flags.useLanguage,
                checkCountry: flags.useCountry,
                checkYear: flags.useYear,
                checkGenres: false,
              })
            )
          );
          for (const v of softGenreList) {
            addVerified(v);
            if (collected.length >= 5) break;
          }
        }
      }
    } catch (aiErr) {
      aiFallbackUsed = true;
      aiQuotaExhausted = isQuotaExhaustedError(aiErr);
      aiHighDemand = !aiQuotaExhausted && isTransientHighDemandError(aiErr);
      console.info('/api/recommendations using TMDB/AniList discovery:', aiErr instanceof Error ? aiErr.message : 'fallback');
    }

    // Fast DB discovery supplement + progressive filter relaxation (only record a filter if relaxing it yielded results)
    const fillFromDiscovery = async (workingPrefs: PreferencesInput = prefs): Promise<number> => {
      if (collected.length >= 5) return 0;
      const before = collected.length;
      const fallback = await discoverFallbackFromDatabases(
        workingPrefs,
        flags,
        seenIds,
        5 - collected.length
      );
      for (const item of fallback) {
        addVerified(item);
        if (collected.length >= 5) break;
      }
      return collected.length - before;
    };

    await fillFromDiscovery();

    if (collected.length < 5 && prefs.duration) {
      flags.useDuration = false;
      if ((await fillFromDiscovery()) > 0) relaxedFilters.push('Duration');
    }

    if (collected.length < 5 && !prefs.releasePeriod.anyYear) {
      flags.useYear = false;
      if ((await fillFromDiscovery()) > 0) relaxedFilters.push('Release period');
    }

    if (collected.length < 5 && prefs.countries.some((c) => c !== 'ANY')) {
      flags.useCountry = false;
      if ((await fillFromDiscovery()) > 0) relaxedFilters.push('Made in');
    }

    if (collected.length < 5 && prefs.minRating && prefs.minRating > 1) {
      if ((await fillFromDiscovery({ ...prefs, minRating: null })) > 0) {
        relaxedFilters.push('Minimum rating');
      }
    }

    if (collected.length < 5 && prefs.languages.length > 0 && !prefs.subtitlesFine) {
      flags.useLanguage = false;
      if ((await fillFromDiscovery({ ...prefs, minRating: null })) > 0) {
        relaxedFilters.push('Language');
      }
    }

    if (collected.length < 5 && prefs.genres.length > 0) {
      flags.useGenres = false;
      if ((await fillFromDiscovery({ ...prefs, minRating: null })) > 0) {
        relaxedFilters.push('Genres');
      }
    }

    // Ultimate guarantee: always fill up to 5 verified titles matching requested Type from TMDB trending/top_rated & AniList
    if (collected.length < 5) {
      const guaranteed = await getGuaranteedPopularFallback(prefs.type, seenIds, 5 - collected.length);
      for (const item of guaranteed) {
        addVerified(item);
        if (collected.length >= 5) break;
      }
    }

    let notice: string | undefined;
    if (aiFallbackUsed) {
      if (aiQuotaExhausted) {
        notice =
          'Gemini free-tier daily quota was reached—showing verified matches directly from TMDB & AniList. Select a billing-enabled key in Settings -> Secrets to restore AI curation immediately.';
      } else if (aiHighDemand) {
        notice =
          'Gemini AI is temporarily busy due to high demand—showing verified matches directly from TMDB & AniList.';
      } else {
        notice = 'Showing verified matches directly from TMDB & AniList.';
      }
    } else if (!tmdbReady && prefs.type === 'Anything') {
      notice = 'Showing verified AniList anime. Add TMDB_API_KEY in server secrets to include Movies, Series, and Dramas.';
    }

    res.json({
      items: collected.slice(0, 5),
      relaxedFilters,
      notice,
      tmdbConfigured: tmdbReady,
    });
  } catch (err) {
    console.error('/api/recommendations error:', err);
    const msg = err instanceof Error ? err.message : 'Failed to generate recommendations.';
    res.status(503).json({ error: msg });
  }
});

app.post('/api/surprise', async (req, res) => {
  try {
    const validMoods: MoodChoice[] = ['Happy', 'Sad', 'Romantic', 'Thrilling', 'Relaxed', 'Surprise me'];
    const validTypes: MediaTypeChoice[] = ['Movies', 'Anime', 'Series', 'Dramas', 'Anything'];
    const mood: MoodChoice = validMoods.includes(req.body?.mood) ? req.body.mood : 'Surprise me';
    const type: MediaTypeChoice = validTypes.includes(req.body?.type) ? req.body.type : 'Anything';
    const excludeTitles = Array.isArray(req.body?.excludeTitles)
      ? req.body.excludeTitles.filter((x: unknown): x is string => typeof x === 'string').slice(0, 30)
      : [];

    const tmdbReady = isTmdbConfigured();
    if (!tmdbReady && (type === 'Movies' || type === 'Series' || type === 'Dramas')) {
      return res.status(400).json({
        error: 'TMDB_API_KEY is required on the server to verify Movies, Series, and Dramas. Try Anime or add TMDB_API_KEY.',
      });
    }

    const animeOnly = !tmdbReady && type === 'Anything';
    const verified: MediaRecommendation[] = [];
    const seen = new Set<string>(excludeTitles.map((t: string) => t.toLowerCase()));
    let aiHighDemandFallback = false;

    try {
      const candidates = await generateSurpriseCandidates(mood, type, excludeTitles, animeOnly);
      const checked = await Promise.all(
        candidates.map((c) => verifyCandidateInDatabases(c, { type }))
      );
      for (const item of checked) {
        if (!item) continue;
        if (!matchesRequestedType(item, type)) continue;
        if (seen.has(item.title.toLowerCase())) continue;
        seen.add(item.title.toLowerCase());
        verified.push(item);
        if (verified.length >= 5) break;
      }
    } catch (aiErr) {
      aiHighDemandFallback = true;
      console.info('/api/surprise using TMDB/AniList discovery:', aiErr instanceof Error ? aiErr.message : 'fallback');
    }

    if (verified.length < 5) {
      const seenIds = new Set(verified.map((v) => v.externalId));
      const fallbackPrefs: PreferencesInput = {
        ...createEmptyPreferences(),
        type,
        moods: mood === 'Surprise me' ? [] : [mood],
      };
      const fallback = await discoverFallbackFromDatabases(
        fallbackPrefs,
        { useDuration: false, useYear: false, useCountry: false, useLanguage: false, useGenres: false },
        seenIds,
        5 - verified.length
      );
      for (const item of fallback) {
        if (!seen.has(item.title.toLowerCase())) {
          seen.add(item.title.toLowerCase());
          verified.push(item);
          if (verified.length >= 5) break;
        }
      }
    }

    if (verified.length < 5) {
      const seenIds = new Set(verified.map((v) => v.externalId));
      const guaranteed = await getGuaranteedPopularFallback(type, seenIds, 5 - verified.length);
      for (const item of guaranteed) {
        if (!seen.has(item.title.toLowerCase())) {
          seen.add(item.title.toLowerCase());
          verified.push(item);
          if (verified.length >= 5) break;
        }
      }
    }

    res.json({
      items: verified.slice(0, 5),
      relaxedFilters: [],
      notice: aiHighDemandFallback
        ? 'Showing verified surprise picks directly from TMDB & AniList.'
        : undefined,
      tmdbConfigured: tmdbReady,
    });
  } catch (err) {
    console.error('/api/surprise error:', err);
    res.status(503).json({ error: err instanceof Error ? err.message : 'Surprise Me failed.' });
  }
});

app.post('/api/because-you-liked', async (req, res) => {
  try {
    const rawWatchlist = Array.isArray(req.body?.watchlist) ? req.body.watchlist : [];
    const watchlist = rawWatchlist
      .filter((w: unknown): w is { title: string; mediaType: string; genres: string[] } =>
        Boolean(w && typeof w === 'object' && typeof (w as { title?: unknown }).title === 'string')
      )
      .slice(0, 20);

    if (watchlist.length === 0) {
      return res.json({ items: [] });
    }

    const savedPreferences = (req.body?.savedPreferences || null) as Partial<SavedPreferencesDoc> | null;
    const watchlistTitles = new Set(watchlist.map((w: { title: string }) => w.title.toLowerCase().trim()));
    const verified: MediaRecommendation[] = [];
    const seenIds = new Set<string>();

    try {
      const candidates = await generateBecauseYouLikedCandidates(watchlist, savedPreferences);
      const checked = await Promise.all(candidates.map((c) => verifyCandidateInDatabases(c)));
      for (const item of checked) {
        if (!item) continue;
        if (watchlistTitles.has(item.title.toLowerCase().trim())) continue;
        if (seenIds.has(item.externalId)) continue;
        seenIds.add(item.externalId);
        verified.push(item);
        if (verified.length >= 6) break;
      }
    } catch (aiErr) {
      console.info('/api/because-you-liked using TMDB/AniList discovery:', aiErr instanceof Error ? aiErr.message : 'fallback');
    }

    if (verified.length < 6) {
      const topGenres: string[] = Array.from(
        new Set<string>(
          watchlist
            .flatMap((w: { genres?: unknown[] }) => (Array.isArray(w.genres) ? w.genres : []))
            .filter((g: unknown): g is string => typeof g === 'string')
        )
      ).slice(0, 5);
      const fallbackPrefs: PreferencesInput = {
        ...createEmptyPreferences(),
        genres: topGenres,
        languages: savedPreferences?.languages || [],
        subtitlesFine: savedPreferences?.subtitlesFine ?? true,
        countries: savedPreferences?.countries || [],
      };
      const fallback = await discoverFallbackFromDatabases(
        fallbackPrefs,
        {
          useDuration: false,
          useYear: false,
          useCountry: Boolean(fallbackPrefs.countries.length),
          useLanguage: Boolean(fallbackPrefs.languages.length && !fallbackPrefs.subtitlesFine),
          useGenres: topGenres.length > 0,
        },
        seenIds,
        6 - verified.length
      );
      for (const item of fallback) {
        if (watchlistTitles.has(item.title.toLowerCase().trim())) continue;
        seenIds.add(item.externalId);
        verified.push({
          ...item,
          basedOnTitle: watchlist[0]?.title,
          reason: `Inspired by ${watchlist[0]?.title || 'your watchlist'}.`,
        });
        if (verified.length >= 6) break;
      }
    }

    res.json({ items: verified.slice(0, 6) });
  } catch (err) {
    console.error('/api/because-you-liked error:', err);
    res.json({ items: [] });
  }
});

app.post('/api/watch-party/match', async (req, res) => {
  try {
    const rawMembers = Array.isArray(req.body?.memberPreferences) ? req.body.memberPreferences : [];
    const memberPreferences = rawMembers.slice(0, 10).map((m: unknown) => {
      const obj = (m && typeof m === 'object' ? m : {}) as Record<string, unknown>;
      return {
        name: typeof obj.name === 'string' ? obj.name.slice(0, 60) : 'Guest',
        preferences: obj.preferences ? sanitizePreferences(obj.preferences) : null,
      };
    });

    const excludeTitles = Array.isArray(req.body?.excludeTitles)
      ? req.body.excludeTitles.filter((x: unknown): x is string => typeof x === 'string').slice(0, 30)
      : [];

    const items = await runGroupMatch(memberPreferences, excludeTitles);
    res.json({ items });
  } catch (err) {
    console.error('/api/watch-party/match error:', err);
    res.status(503).json({ error: err instanceof Error ? err.message : 'Watch Party matching failed.' });
  }
});

app.get('/api/details/:source/:mediaType/:id', async (req, res) => {
  try {
    const { source, mediaType, id } = req.params;
    if (source !== 'tmdb' && source !== 'anilist') {
      return res.status(400).json({ error: 'Invalid media source.' });
    }
    const details = await getMediaDetails(source, mediaType, id);
    if (!details) {
      return res.status(404).json({ error: 'Details not found in database.' });
    }
    res.json(details);
  } catch (err) {
    console.error('/api/details error:', err);
    res.status(500).json({ error: 'Failed to load media details.' });
  }
});

async function startServer() {
  const port = Number(process.env.PORT) || 3000;
  const isProd = process.env.NODE_ENV === 'production';

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build output not found. Run npm run build.');
      }
    });
  }

  app.listen(port, '0.0.0.0', () => {
    console.log(`Flickorax server listening on http://0.0.0.0:${port}`);
  });
}

startServer();
