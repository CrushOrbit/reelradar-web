
/*
 * ReelRadar SceneFinder V5.5
 * Google Lens + Gemini + AMODB
 * Movie / TV disambiguation
 */

const MODEL = process.env.SCENEFINDER_MODEL ||
  "gemini-3.5-flash-lite";

const SEARCH_MODEL =
  process.env.SCENEFINDER_SEARCH_MODEL ||
  "gemini-3.8-flash";

const MODELS = [...new Set([
  MODEL,
  SEARCH_MODEL,
  ...(process.env.SCENEFINDER_FALLBACK_MODELS || "")
    .split(",").map(x => x.trim()).filter(Boolean)
])];

const MAX_IMAGE_LENGTH = 6000000;
const LENS_MAX_BYTES = 500000;
const cooldowns = new Map();
let lensCooldown = 0;

const send = (res, status, body) =>
  res.status(status).json(body);

const wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function formatTitle(s) {
  return String(s || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(s) {
  return formatTitle(s).normalize("NFKD")
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

function sameTitle(a, b) {
  return !!norm(a) && norm(a) === norm(b);
}

function safeUrl(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function parseJSON(text) {
  const s = String(text || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(s);
  } catch {}

  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");

  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {}
  }

  return null;
}

function parseImage(image) {
  if (typeof image !== "string") return null;
  if (image.length > MAX_IMAGE_LENGTH)
    return { tooLarge: true };

  const m = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!m) return null;

  const data = m[2].replace(/\s/g, "");
  if (!data || data.length % 4) return null;

  return {
    mime_type: m[1] === "image/jpg"
      ? "image/jpeg" : m[1],
    data
  };
}

function sanitize(raw) {
  return {
    imageType:
      ["poster", "scene", "unknown"].includes(raw?.imageType)
        ? raw.imageType : "unknown",
    visibleTitle: raw?.visibleTitle
      ? formatTitle(raw.visibleTitle).slice(0, 150)
      : null,
    visualEvidence:
      String(raw?.visualEvidence || "").slice(0, 700),
    dialogue: raw?.dialogue
      ? String(raw.dialogue).slice(0, 250) : null,
    socialContext: raw?.socialContext
      ? String(raw.socialContext).slice(0, 650) : null,
    confidence:
      ["High", "Medium", "Low"].includes(raw?.confidence)
        ? raw.confidence : "Low",
    candidates: (Array.isArray(raw?.candidates)
      ? raw.candidates : [])
      .filter(x => typeof x?.title === "string" && x.title.trim())
      .slice(0, 6)
      .map(x => ({
        title: formatTitle(x.title).slice(0, 150),
        year: Number.isInteger(x.year) &&
          x.year >= 1880 && x.year <= 2100
          ? x.year : null,
        type: x.type === "tv" ? "tv" :
          x.type === "movie" ? "movie" : null,
        reason: String(x.reason || "").slice(0, 350),
        source: "gemini"
      }))
  };
}

// GOOGLE LENS

async function googleLens(image, key) {
  if (!key || Date.now() < lensCooldown) return null;

  try {
    let bytes = Buffer.from(image.data, "base64");
    let mime = image.mime_type;

    if (bytes.length > LENS_MAX_BYTES) {
      const { default: sharp } = await import("sharp");
      let reduced = null;

      for (const width of [900, 700, 520, 380]) {
        const b = await sharp(bytes)
          .resize({ width, withoutEnlargement: true })
          .jpeg({ quality: 65, mozjpeg: true })
          .toBuffer();

        if (b.length <= LENS_MAX_BYTES) {
          reduced = b;
          break;
        }
      }

      if (!reduced) return null;
      bytes = reduced;
      mime = "image/jpeg";
    }

    const form = new FormData();
    form.append("api_key", key);
    form.append("image",
      new Blob([bytes], { type: mime }), "scene.jpg");

    const uploadCtrl = new AbortController();
    const uploadTimer = setTimeout(
      () => uploadCtrl.abort(), 9000
    );

    let uploaded;

    try {
      const r = await fetch("https://serpapi.com/image", {
        method: "POST",
        body: form,
        signal: uploadCtrl.signal
      });

      uploaded = await r.json().catch(() => ({}));

      if (!r.ok || uploaded.error || !uploaded.image_id) {
        if (r.status === 429 ||
            /quota|limit|credits|exhaust/i.test(
              String(uploaded.error || ""))) {
          lensCooldown = Date.now() + 3600000;
        }
        console.warn("Lens upload failed", r.status);
        return null;
      }
    } finally {
      clearTimeout(uploadTimer);
    }

    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_lens");
    url.searchParams.set("image_id", uploaded.image_id);
    url.searchParams.set("type", "all");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", key);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 16000);

    try {
      const r = await fetch(url, { signal: ctrl.signal });
      const data = await r.json().catch(() => ({}));

      if (!r.ok || data.error) {
        if (r.status === 429 ||
            /quota|limit|credits|exhaust/i.test(
              String(data.error || ""))) {
          lensCooldown = Date.now() + 3600000;
        }
        console.warn("Lens search failed", r.status);
        return null;
      }

      const matches = [
        ...(data.exact_matches || []).map(x => ({
          ...x, matchKind: "exact"
        })),
        ...(data.visual_matches || []).map(x => ({
          ...x, matchKind: "visual"
        }))
      ].slice(0, 12).map(x => ({
        title: String(x.title || "").slice(0, 180),
        source: String(x.source || "").slice(0, 100),
        link: safeUrl(x.link),
        thumbnail: safeUrl(x.thumbnail),
        matchKind: x.matchKind
      }));

      console.log("SceneFinder Lens results", matches.length);
      return { matches, status: "ok" };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn("Lens unavailable", e.message);
    return null;
  }
}

// GEMINI

async function callGemini(model, parts, key, search = false) {
  if (!key) return { ok: false, status: 503 };

  if (Date.now() < (cooldowns.get(model) || 0))
    return { ok: false, status: 429 };

  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);

    try {
      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1600
        }
      };

      if (search) {
        body.tools = [{ google_search: {} }];
      } else {
        body.generationConfig.responseMimeType =
          "application/json";
      }

      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key
          },
          body: JSON.stringify(body),
          signal: ctrl.signal
        }
      );

      const data = await r.json().catch(() => ({}));

      if (r.ok) {
        const c = data.candidates?.[0];
        return {
          ok: true,
          status: 200,
          model,
          text: (c?.content?.parts || [])
            .map(p => p.text || "").join("\n"),
          grounding: c?.groundingMetadata || null
        };
      }

      console.warn("Gemini", model, r.status);

      if (r.status === 429) {
        const exhausted =
          /quota exceeded|free.tier|per.day|per day/i.test(
            JSON.stringify(data.error || {})
          );

        let ms = exhausted ? 3600000 : 60000;
        const retry = Number(r.headers.get("retry-after"));
        if (retry > 0) ms = Math.max(ms, retry * 1000);

        for (const d of data.error?.details || []) {
          if (/^\d+(\.\d+)?s$/.test(d.retryDelay || "")) {
            ms = Math.max(ms, parseFloat(d.retryDelay) * 1000);
          }
        }

        cooldowns.set(model, Date.now() + ms);
        return { ok: false, status: 429 };
      }

      if ([500, 503].includes(r.status) && attempt === 0) {
        await wait(700);
        continue;
      }

      return { ok: false, status: r.status };
    } catch (e) {
      console.warn("Gemini unavailable", e.message);
      if (attempt === 0) {
        await wait(500);
        continue;
      }
      return { ok: false, status: 503 };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 503 };
}

async function geminiFallback(parts, key, search = false) {
  const order = search
    ? [...new Set([SEARCH_MODEL, ...MODELS])]
    : MODELS;

  let last = { ok: false, status: 503 };

  for (const model of order) {
    last = await callGemini(model, parts, key, search);
    if (last.ok) return last;
    if ([400, 401, 403].includes(last.status)) break;
  }

  return last;
}

async function recognize(image, clues, key) {
  const prompt = `
You are ReelRadar SceneFinder.

Identify movie or television scenes from screenshots.
Distinguish actual scene details from social overlays.
Captions and hashtags are leads, not proof.

IMPORTANT:
Distinguish movies from TV series.
Season, episode, S01E01, and television-series
references are strong TV clues.

Do not invent titles or actor identities.

Return ONLY JSON:
{
 "imageType": "scene",
 "visibleTitle": null,
 "visualEvidence": "specific scene details",
 "dialogue": null,
 "socialContext": null,
 "confidence": "Low",
 "candidates": [
   {
     "title": "production title",
     "year": null,
     "type": "tv",
     "reason": "specific evidence"
   }
 ]
}

imageType: scene, poster, unknown.
type: movie, tv, or null.
confidence: High, Medium, Low.
Candidates may be empty.

User clues: ${clues || "none"}
`;

  const r = await geminiFallback([
    { text: prompt },
    { inline_data: image }
  ], key);

  if (!r.ok) {
    return {
      ok: false,
      status: r.status,
      data: sanitize({})
    };
  }

  const parsed = parseJSON(r.text);

  return parsed ? {
    ok: true,
    status: 200,
    data: sanitize(parsed),
    model: r.model,
    fallbackUsed: r.model !== MODEL
  } : {
    ok: false,
    status: 502,
    data: sanitize({})
  };
}

// GOOGLE LENS TITLE EXTRACTION

function extractLensHints(lens) {
  if (!lens?.matches?.length) return [];

  const hints = [];
  const patterns = [
    /(?:movie|film|series|drama)\s*:\s*([^|–—#]{3,70})/i,
    /(?:title|name)\s*:\s*([^|–—#]{3,70})/i,
    /🎬\s*([^|–—#]{3,70})/u
  ];

  for (const item of lens.matches) {
    const text = String(item.title || "");
    const tv = /\b(?:season|episode|s\d{1,2}e\d{1,2}|tv series|television series|tv show)\b/i
      .test(text);

    const extracted = [];

    for (const p of patterns) {
      const m = text.match(p);
      if (m) extracted.push(m[1]);
    }

    if (/\b(?:movie|film|series|drama|trailer)\b/i.test(text)) {
      for (const m of text.matchAll(
        /["“‘']([^"”’']{3,70})["”’']/g
      )) {
        extracted.push(m[1]);
      }
    }

    for (let title of extracted) {
      title = formatTitle(title)
        .replace(/\s*\((?:19|20)\d{2}\).*$/, "")
        .replace(/\s+(?:official trailer|movie clip|film scene|review|explained).*$/i, "")
        .trim();

      if (title.length < 3 || title.length > 65) continue;

      hints.push({
        title,
        year: null,
        type: tv ? "tv" : null,
        reason: "Production title lead from Google Lens",
        source: "lens"
      });
      break;
    }
  }

  return hints.slice(0, 8);
}

async function interpretLens(lens, rec, key) {
  if (!lens?.matches?.length || !key) return [];

  const prompt = `
Extract real movie or TV production titles
from these Google Lens results.

Reject dialogue fragments, captions, hashtags,
usernames, and incomplete sentences.

Identify TV shows from season/episode clues.
Do not automatically label everything a movie.

Screenshot: ${rec.visualEvidence || "unknown"}

Results:
${JSON.stringify(lens.matches.map(x => ({
  title: x.title,
  source: x.source,
  matchKind: x.matchKind
})))}

Return ONLY JSON:
{
 "candidates": [
   {
     "title": "production title",
     "year": null,
     "type": "tv",
     "reason": "Lens evidence"
   }
 ]
}

type: movie, tv, or null.
An empty array is acceptable.
`;

  const r = await geminiFallback(
    [{ text: prompt }], key
  );

  return r.ok
    ? sanitize(parseJSON(r.text) || {}).candidates
        .map(x => ({ ...x, source: "lens_ai" }))
    : [];
}

// TV / MOVIE EVIDENCE

function typeEvidence(title, lens) {
  const rows = (lens?.matches || []).filter(x =>
    norm(x.title).includes(norm(title)) &&
    norm(title).length >= 4
  );

  let tv = 0;
  let movie = 0;

  for (const row of rows) {
    const s = row.title;

    if (/\b(?:season\s*\d+|episode\s*\d+|s\d{1,2}e\d{1,2}|tv series|television series|tv show)\b/i.test(s))
      tv += 2;

    if (/\b(?:movie|feature film|theatrical film)\b/i.test(s))
      movie += 1;
  }

  return { tv, movie };
}

function lensEvidence(title, lens) {
  const rows = (lens?.matches || []).filter(x =>
    norm(title).length >= 4 &&
    norm(x.title).includes(norm(title))
  );

  const domains = new Set();
  let exact = 0;

  for (const row of rows) {
    if (row.matchKind === "exact") exact++;
    try {
      if (row.link)
        domains.add(new URL(row.link).hostname);
    } catch {}
  }

  return {
    count: rows.length,
    exact,
    score:
      Math.min(rows.length, 4) +
      Math.min(domains.size, 2) +
      Math.min(exact, 2)
  };
}

// AMODB METADATA

function posterUrl(path) {
  if (typeof path !== "string") return null;
  if (path.startsWith("https://")) return path;
  if (path.startsWith("/"))
    return "https://image.tmdb.org/t/p/w500" + path;
  return null;
}

async function amodb(title, type, key, year) {
  if (!key || !title) return null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6500);

  try {
    const url = new URL(
      `https://api.amodb.dev/3/search/${type}`
    );
    url.searchParams.set("query", formatTitle(title));

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: ctrl.signal
    });

    if (!r.ok) {
      console.warn("AMODB", type, r.status);
      return null;
    }

    const data = await r.json();

    const rows = (Array.isArray(data.results)
      ? data.results : [])
      .filter(x => [
        x.title, x.name,
        x.original_title, x.original_name
      ].some(n => sameTitle(n, title)))
      .map(item => {
        const date = item.release_date ||
          item.first_air_date || "";

        const y = /^\d{4}/.test(date)
          ? Number(date.slice(0, 4)) : null;

        return {
          item,
          year: y,
          diff: year && y ? Math.abs(year - y) : 0
        };
      })
      .filter(x => x.diff <= 1)
      .sort((a, b) => a.diff - b.diff);

    if (!rows.length) return null;

    const { item, year: y } = rows[0];

    return {
      id: item.id,
      title: formatTitle(
        item.title || item.name || title
      ),
      year: y,
      type,
      poster_path: item.poster_path || null,
      posterUrl: posterUrl(item.poster_path),
      overview: String(item.overview || "").slice(0, 350)
    };
  } catch (e) {
    console.warn("AMODB unavailable", e.message);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validateCandidate(candidate, key, lens) {
  const title = formatTitle(candidate.title);
  const evidence = typeEvidence(title, lens);

  const tvStrong = evidence.tv >= 2 &&
    evidence.tv > evidence.movie;

  // A strong TV signal must not be replaced
  // by an unrelated film with the same title.
  const preferred = tvStrong
    ? "tv"
    : candidate.type || null;

  const types = preferred
    ? [preferred, preferred === "tv" ? "movie" : "tv"]
    : ["movie", "tv"];

  const matches = await Promise.all(
    types.map(type =>
      amodb(title, type, key, candidate.year)
    )
  );

  const available = matches.filter(Boolean);
  if (!available.length) return null;

  let eligible = available;

  if (tvStrong) {
    eligible = available.filter(x => x.type === "tv");
    if (!eligible.length) return null;
  }

  if (candidate.type === "tv" && !tvStrong) {
    const tv = eligible.filter(x => x.type === "tv");
    if (tv.length) eligible = tv;
  }

  if (candidate.type === "movie" && !tvStrong) {
    const films = eligible.filter(x => x.type === "movie");
    if (films.length) eligible = films;
  }

  const match = eligible.sort((a, b) => {
    const yearScore = x => candidate.year && x.year
      ? Math.abs(candidate.year - x.year) : 2;

    return yearScore(a) - yearScore(b);
  })[0];

  return {
    ...candidate,
    title: match.title,
    year: match.year || candidate.year || null,
    type: match.type,
    match,
    typeEvidence: evidence
  };
}

// OPTIONAL GROUNDED VERIFICATION

async function verifyScene(rec, candidates, clues, key) {
  if (!key || !rec.visualEvidence ||
      !candidates.length) return null;

  const prompt = `
Use Google Search to investigate which
production matches this screenshot.

Candidates:
${candidates.map(x =>
  `${x.title} (${x.year || "unknown"}, ${x.type})`
).join("; ")}

Scene: ${rec.visualEvidence}
Dialogue: ${rec.dialogue || "none"}
Overlay: ${rec.socialContext || "none"}
User clues: ${clues || "none"}

Do not treat a cast credit, film title,
caption, or generic plot as scene proof.

Return:
TITLE: title or UNKNOWN
STATUS: SUPPORTED or UNCERTAIN
EVIDENCE: specific evidence
LIMITATIONS: uncertainty
`;

  const r = await geminiFallback(
    [{ text: prompt }], key, true
  );

  if (!r.ok) return null;

  const fields = {};

  for (const line of r.text.split("\n")) {
    const m = line.match(
      /^\s*(TITLE|STATUS|EVIDENCE|LIMITATIONS)\s*:\s*(.*)$/i
    );
    if (m) fields[m[1].toUpperCase()] = m[2].trim();
  }

  const sources = (r.grounding?.groundingChunks || [])
    .map(x => safeUrl(x?.web?.uri))
    .filter(Boolean).slice(0, 5);

  return {
    title: fields.TITLE || null,
    supported:
      fields.STATUS?.toUpperCase() === "SUPPORTED" &&
      !!fields.TITLE &&
      norm(fields.TITLE) !== "unknown" &&
      sources.length > 0,
    evidence: fields.EVIDENCE || "",
    limitations: fields.LIMITATIONS || "",
    sources
  };
}

// MAIN API

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods",
    "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization");

  if (req.method === "OPTIONS")
    return res.status(204).end();

  if (req.method !== "POST")
    return send(res, 405, {
      error: "Method not allowed"
    });

  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, {
          error: "Invalid JSON"
        });
      }
    }

    const { image, clues = "" } = body || {};

    if (typeof clues !== "string" || clues.length > 1000)
      return send(res, 400, { error: "Invalid clues" });

    const imageData = parseImage(image);

    if (imageData?.tooLarge)
      return send(res, 413, {
        error: "Screenshot is too large"
      });

    if (!imageData)
      return send(res, 400, {
        error: "Upload a valid JPG, PNG or WebP screenshot"
      });

    const geminiKey = process.env.GEMINI_API_KEY;
    const lensKey = process.env.SERPAPI_API_KEY;
    const amodbKey = process.env.AMODB_API_KEY;

    if (!geminiKey && !lensKey)
      return send(res, 503, {
        error: "SceneFinder is not configured"
      });

    console.log("SceneFinder V5.5 started");

    const lens = await googleLens(imageData, lensKey);
    const lensHints = extractLensHints(lens);

    const first = geminiKey
      ? await recognize(imageData, clues, geminiKey)
      : {
          ok: false,
          status: 503,
          data: sanitize({})
        };

    const rec = first.data;

    let lensAI = [];

    if (geminiKey && lens?.matches?.length &&
        (!lensHints.length || !rec.candidates.length)) {
      lensAI = await interpretLens(lens, rec, geminiKey);
    }

    const candidates = [
      ...lensAI,
      ...rec.candidates,
      ...lensHints
    ];

    if (rec.imageType === "poster" && rec.visibleTitle) {
      candidates.unshift({
        title: rec.visibleTitle,
        year: null,
        type: null,
        reason: "Title printed on poster",
        source: "poster"
      });
    }

    // Merge title leads without discarding TV evidence.
    const grouped = new Map();

    for (const c of candidates) {
      const id = norm(c.title);
      if (!id) continue;

      const existing = grouped.get(id);

      if (!existing) {
        grouped.set(id, { ...c });
      } else {
        if (c.type === "tv") existing.type = "tv";
        if (!existing.year && c.year)
          existing.year = c.year;
        if (c.source === "lens_ai" &&
            existing.source === "lens")
          existing.source = "lens_ai";
      }
    }

    const rawCandidates =
      [...grouped.values()].slice(0, 8);

    const validated = amodbKey
      ? await Promise.all(
          rawCandidates.map(c =>
            validateCandidate(c, amodbKey, lens)
          )
        )
      : [];

    const results = validated.filter(Boolean)
      .map(x => ({
        ...x,
        lensEvidence: lensEvidence(x.title, lens)
      }))
      .sort((a, b) => {
        const score = x =>
          x.lensEvidence.score +
          (x.source === "lens_ai" ? 2 : 0) +
          (x.source === "poster" ? 3 : 0) +
          (x.typeEvidence?.tv >= 2 &&
           x.type === "tv" ? 2 : 0);

        return score(b) - score(a);
      });

    let verification = null;

    if (geminiKey && first.ok && results.length &&
        (results[0].lensEvidence.score >= 2 ||
         rec.dialogue || rec.imageType === "poster")) {
      verification = await verifyScene(
        rec, results.slice(0, 3), clues, geminiKey
      );
    }

    const verifiedCandidate = verification?.supported
      ? results.find(x =>
          sameTitle(x.title, verification.title))
      : null;

    const posterCandidate =
      rec.imageType === "poster" && rec.visibleTitle
        ? results.find(x =>
            sameTitle(x.title, rec.visibleTitle))
        : null;

    const selected =
      verifiedCandidate ||
      posterCandidate ||
      results.find(x => x.lensEvidence.count > 0) ||
      results[0] ||
      null;

    const supported = Boolean(
      verifiedCandidate || posterCandidate
    );

    const confidence = supported
      ? selected?.lensEvidence.score >= 4
        ? "High" : "Medium"
      : selected?.lensEvidence.score >= 3
        ? "Medium" : "Low";

    const primary = selected?.match || null;

    const possibleMatches = results.map(x => ({
      title: x.title,
      year: x.year,
      type: x.type,
      reason: x.reason,
      overview: x.match?.overview || null,
      posterUrl: x.match?.posterUrl || null,
      verified: supported && x === selected,
      confidence: x === selected
        ? confidence : "Low",
      lensEvidenceCount: x.lensEvidence.count
    }));

    const sources = [
      ...new Set(verification?.sources || [])
    ].slice(0, 5);

    const answer = supported
      ? `Possible identification: ${selected.title}. Scene evidence may still require confirmation.`
      : selected
        ? `Possible match: ${selected.title}. The production exists, but this screenshot remains unverified.`
        : lens?.matches?.length
          ? "Google Lens found results, but no production could be validated."
          : "No reliable title found. Try another screenshot.";

    const diagnostics = {
      version: "5.5",
      lensStatus: lens ? "ok" :
        lensKey ? "unavailable" : "not_configured",
      lensResults: lens?.matches?.length || 0,
      geminiStatus: first.ok
        ? "ok" : `unavailable_${first.status}`,
      rawCandidates: rawCandidates.length,
      validatedCandidates: results.length,
      metadataStatus: amodbKey
        ? "configured" : "not_configured",
      verificationStatus: verification
        ? "completed" : "not_completed"
    };

    console.log(
      "SceneFinder V5.5 diagnostics",
      JSON.stringify(diagnostics)
    );

    return send(res, 200, {
      success: true,
      answer,
      title: selected?.title || null,
      year: selected?.year || null,
      type: selected?.type || null,
      confidence,
      identificationUncertain: !supported,
      visualEvidence: rec.visualEvidence,
      dialogue: rec.dialogue,
      socialContext: rec.socialContext,
      discoveryStatus: first.ok
        ? "ok" : "gemini_unavailable",
      verificationEvidence:
        verification?.evidence || null,
      verificationLimitations:
        verification?.limitations || null,
      possibleMatches,
      visualMatches: lens?.matches || [],
      visualSearchUsed: Boolean(lens),
      visualSearchProvider: lens
        ? "SerpApi Google Lens" : null,
      posterUrl: primary?.posterUrl || null,
      poster: primary?.posterUrl || null,
      poster_path: primary?.poster_path || null,
      overview: primary?.overview || null,
      movieId: primary?.id || null,
      verified: supported,
      verificationMethod: verifiedCandidate
        ? "grounded_search"
        : posterCandidate
          ? "visible_poster_title" : null,
      model: first.model || null,
      fallbackUsed: Boolean(first.fallbackUsed),
      searchGrounded: sources.length > 0,
      sources,
      metadataProvider: amodbKey ? "AMODB" : null,
      metadataMatches:
        results.map(x => x.match).filter(Boolean),
      diagnostics
    });
  } catch (e) {
    console.error("SceneFinder V5.5 error", e.message);
    return send(res, 500, {
      error: "SceneFinder encountered an unexpected error"
    });
  }
}
