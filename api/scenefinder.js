
const MODEL = process.env.SCENEFINDER_MODEL || "gemini-3.5-flash-lite";
const SEARCH_MODEL = process.env.SCENEFINDER_SEARCH_MODEL || "gemini-3.8-flash";

const FALLBACKS = [...new Set([
  MODEL,
  ...(process.env.SCENEFINDER_FALLBACK_MODELS || SEARCH_MODEL)
    .split(",").map(x => x.trim()).filter(Boolean)
])].slice(0, 3);

const MAX_IMAGE_LENGTH = 6000000;
const LENS_MAX_BYTES = 500000;

let cooldownUntil = 0;
let lensPauseUntil = 0;

const norm = s => String(s || "")
  .normalize("NFKD")
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

const send = (res, status, body) => res.status(status).json(body);

function parseImage(image) {
  if (typeof image !== "string") return null;
  if (image.length > MAX_IMAGE_LENGTH) return { tooLarge: true };

  const m = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!m) return null;

  const data = m[2].replace(/\s/g, "");
  if (!data || data.length % 4) return null;

  return {
    mime_type: m[1] === "image/jpg" ? "image/jpeg" : m[1],
    data
  };
}

function parseJSON(t) {
  const raw = String(t || "").trim();
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  if (start < 0) return null;

  for (let i = cleaned.length - 1; i > start; i--) {
    if (cleaned[i] !== "}") continue;
    try {
      return JSON.parse(cleaned.slice(start, i + 1));
    } catch {}
  }

  return null;
}

// -------------------------------------------------
// SERPAPI GOOGLE LENS
// -------------------------------------------------

async function googleLens(imageData, key) {
  if (!key || Date.now() < lensPauseUntil) return null;

  try {
    let bytes = Buffer.from(imageData.data, "base64");
    let mime = imageData.mime_type;

    if (bytes.length > LENS_MAX_BYTES) {
      try {
        const { default: sharp } = await import("sharp");
        let reduced = null;

        for (const width of [900, 700, 520, 380]) {
          const candidate = await sharp(bytes)
            .resize({
              width,
              withoutEnlargement: true
            })
            .jpeg({
              quality: 65,
              mozjpeg: true
            })
            .toBuffer();

          if (candidate.length <= LENS_MAX_BYTES) {
            reduced = candidate;
            break;
          }
        }

        if (!reduced) return null;

        bytes = reduced;
        mime = "image/jpeg";
      } catch (e) {
        console.warn(
          "SceneFinder Lens compression unavailable",
          e.message
        );
        return null;
      }
    }

    const form = new FormData();

    form.append("api_key", key);
    form.append(
      "image",
      new Blob([bytes], { type: mime }),
      "scene.jpg"
    );

    const uploadCtrl = new AbortController();
    const uploadTimer = setTimeout(
      () => uploadCtrl.abort(),
      9000
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
        console.warn(
          "SceneFinder Lens upload failed",
          r.status
        );
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
      const r = await fetch(url, {
        signal: ctrl.signal
      });

      const data = await r.json().catch(() => ({}));

      if (!r.ok || data.error) {
        const message = String(data.error || "");

        if (
          r.status === 429 ||
          /limit|quota|exhaust|credits/i.test(message)
        ) {
          lensPauseUntil = Date.now() + 60 * 60 * 1000;
        }

        console.warn(
          "SceneFinder Lens search failed",
          r.status,
          message.slice(0, 120)
        );

        return null;
      }

      const rows = [
        ...(Array.isArray(data.exact_matches)
          ? data.exact_matches : []),
        ...(Array.isArray(data.visual_matches)
          ? data.visual_matches : [])
      ]
        .slice(0, 12)
        .map(x => ({
          title: String(x.title || "").slice(0, 180),
          source: String(x.source || "").slice(0, 100),
          link:
            typeof x.link === "string" &&
            x.link.startsWith("https://")
              ? x.link : null,
          thumbnail:
            typeof x.thumbnail === "string" &&
            x.thumbnail.startsWith("https://")
              ? x.thumbnail : null
        }));

      return {
        matches: rows,
        status: "ok"
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.warn(
      "SceneFinder Lens unavailable",
      e.message
    );
    return null;
  }
}

// -------------------------------------------------
// GEMINI AI
// -------------------------------------------------

async function callGemini(model, parts, key, search = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);

  try {
    const body = {
      contents: [{
        role: "user",
        parts
      }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1800
      }
    };

    if (search) {
      body.tools = [{ google_search: {} }];
    } else {
      body.generationConfig.responseMimeType = "application/json";
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

    if (!r.ok) {
      console.warn("SceneFinder Gemini", model, r.status);
      return {
        ok: false,
        status: r.status
      };
    }

    const c = data.candidates?.[0];

    return {
      ok: true,
      text: (c?.content?.parts || [])
        .map(p => p.text || "")
        .join("\n"),
      grounding: c?.groundingMetadata || null
    };
  } catch (e) {
    console.warn("SceneFinder Gemini", e?.message);
    return {
      ok: false,
      status: 503
    };
  } finally {
    clearTimeout(timer);
  }
}

async function vision(parts, key) {
  let last = {
    ok: false,
    status: 503
  };

  for (const model of FALLBACKS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await callGemini(model, parts, key);

      if (r.ok) {
        const data = parseJSON(r.text);

        if (data) {
          return {
            ok: true,
            data,
            model,
            fallbackUsed: model !== MODEL
          };
        }

        last = {
          ok: false,
          status: 502
        };

        break;
      }

      last = r;

      if ([400, 401, 403, 404, 429, 503].includes(r.status)) {
        break;
      }

      if (attempt === 0) {
        await new Promise(resolve => setTimeout(resolve, 600));
      }
    }

    if ([400, 401, 403, 429].includes(last.status)) {
      break;
    }
  }

  return last;
}

const visionPrompt = clues => `
You are ReelRadar SceneFinder.

Examine the screenshot carefully.

Distinguish the actual film frame from Instagram,
TikTok, Prime Video, and other social-media overlays.

Extract exact on-screen dialogue, promotional captions,
account names, hashtags, and any explicit production title.

Social-media text is a SEARCH LEAD, not proof.

Do not assume actor identity from resemblance.
Do not force a guess.
Never assume the most recent year.

Return ONLY JSON:

{
  "imageType": "scene",
  "visibleTitle": null,
  "visualEvidence": "distinctive actual frame details",
  "dialogue": null,
  "socialContext": "relevant interface text or null",
  "candidates": [
    {
      "title": "production title",
      "year": null,
      "type": "movie",
      "reason": "specific visual evidence"
    }
  ],
  "confidence": "Low"
}

imageType: poster, scene, unknown.
type: movie, tv.
confidence: High, Medium, Low.

If unsure, candidates may be empty.

User clues: ${clues || "None"}
`;

function sanitize(raw) {
  const seen = new Set();

  const candidates = (
    Array.isArray(raw?.candidates)
      ? raw.candidates : []
  )
    .filter(x =>
      x &&
      typeof x.title === "string" &&
      x.title.trim()
    )
    .map(x => ({
      title: x.title.trim().slice(0, 150),
      year:
        Number.isInteger(x.year) &&
        x.year >= 1880 &&
        x.year <= 2100
          ? x.year : null,
      type: x.type === "tv" ? "tv" : "movie",
      reason: String(x.reason || "").slice(0, 350)
    }))
    .filter(x => {
      const k = norm(x.title);

      if (seen.has(k)) return false;

      seen.add(k);
      return true;
    })
    .slice(0, 3);

  return {
    imageType:
      ["poster", "scene", "unknown"].includes(raw?.imageType)
        ? raw.imageType : "unknown",

    visibleTitle:
      typeof raw?.visibleTitle === "string"
        ? raw.visibleTitle.trim().slice(0, 150)
        : null,

    visualEvidence:
      String(raw?.visualEvidence || "").slice(0, 700),

    dialogue:
      typeof raw?.dialogue === "string"
        ? raw.dialogue.slice(0, 250)
        : null,

    socialContext:
      typeof raw?.socialContext === "string"
        ? raw.socialContext.slice(0, 650)
        : null,

    confidence:
      ["High", "Medium", "Low"].includes(raw?.confidence)
        ? raw.confidence : "Low",

    candidates
  };
}

// -------------------------------------------------
// GOOGLE LENS CANDIDATE ANALYSIS
// -------------------------------------------------

async function lensCandidates(lens, rec, key) {
  if (!lens?.matches?.length || !key) return [];

  const prompt = `
Identify movie or television production titles from
these actual Google Lens visual-search results.

Do not confuse an actor's filmography, page title,
or caption mention with a confirmed scene match.

Screenshot visual details:
${rec.visualEvidence}

Dialogue:
${rec.dialogue || "none"}

Lens results:
${JSON.stringify(
    lens.matches.map(x => ({
      title: x.title,
      source: x.source,
      link: x.link
    }))
  )}

Return ONLY JSON:

{
  "candidates": [
    {
      "title": "film or show",
      "year": null,
      "type": "movie",
      "reason": "specific Lens result evidence"
    }
  ]
}

Only suggest titles explicitly supported by the results.
An empty array is acceptable.
`;

  const r = await callGemini(
    SEARCH_MODEL,
    [{ text: prompt }],
    key,
    false
  );

  return r.ok
    ? sanitize(parseJSON(r.text) || {}).candidates
    : [];
}

// -------------------------------------------------
// MOVIE METADATA
// -------------------------------------------------

function posterUrl(p) {
  if (typeof p !== "string") return null;

  if (p.startsWith("https://")) return p;

  if (p.startsWith("/")) {
    return "https://image.tmdb.org/t/p/w500" + p;
  }

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

    url.searchParams.set("query", title);

    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: ctrl.signal
    });

    if (!r.ok) return null;

    const data = await r.json();

    const rows = (data.results || [])
      .filter(x =>
        [
          x.title,
          x.name,
          x.original_title,
          x.original_name
        ].some(n => norm(n) === norm(title))
      )
      .map(item => {
        const date =
          item.release_date ||
          item.first_air_date ||
          "";

        const y = /^\d{4}/.test(date)
          ? Number(date.slice(0, 4))
          : null;

        return {
          item,
          y,
          diff:
            year && y
              ? Math.abs(year - y)
              : null
        };
      })
      .filter(x =>
        x.diff === null || x.diff <= 1
      )
      .sort((a, b) =>
        (a.diff ?? 2) - (b.diff ?? 2)
      );

    if (!rows.length) return null;

    const { item, y } = rows[0];

    return {
      id: item.id,
      title: item.title || item.name || title,
      year: y,
      type,
      poster_path: item.poster_path || null,
      posterUrl: posterUrl(item.poster_path),
      overview:
        String(item.overview || "").slice(0, 350)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function matchCandidate(c, key) {
  let match = await amodb(
    c.title,
    c.type,
    key,
    c.year
  );

  if (!match) {
    match = await amodb(
      c.title,
      c.type === "tv" ? "movie" : "tv",
      key,
      c.year
    );
  }

  return {
    ...c,
    match
  };
}

// -------------------------------------------------
// GEMINI WEB DISCOVERY
// -------------------------------------------------

async function discover(rec, clues, key) {
  const prompt = `
Find possible movie or television productions for
this screenshot using Google Search.

Search the exact dialogue first.
Then search distinctive visual clues.

Investigate promotional social-media text as a lead,
including captions, accounts, and hashtags.

These clues can suggest productions but do not prove
that the screenshot came from them.

Do not anchor on initial AI guesses.

Visual frame:
${rec.visualEvidence}

Dialogue:
${rec.dialogue || "none"}

Social-media text:
${rec.socialContext || "none"}

User clues:
${clues || "none"}

Return up to five candidate productions.

Never invent citations or claim scene verification.

Return JSON:

{
  "candidates": [
    {
      "title": "exact title",
      "year": null,
      "type": "movie",
      "reason": "specific search lead"
    }
  ],
  "notes": "uncertainties"
}

If JSON is unavailable, return lines in this format:

TITLE: title | TYPE: movie | REASON: explanation
`;

  const r = await callGemini(
    SEARCH_MODEL,
    [{ text: prompt }],
    key,
    true
  );

  if (!r.ok) {
    console.warn(
      "SceneFinder discovery unavailable",
      r.status
    );

    return {
      candidates: [],
      sources: [],
      status: r.status
    };
  }

  const parsed = parseJSON(r.text);

  let found = sanitize(parsed || {}).candidates;

  if (!found.length) {
    found = r.text
      .split("\n")
      .map(line => {
        const m = line.match(
          /^\s*(?:[-*]\s*)?TITLE\s*:\s*([^|\n]+)(?:\|\s*TYPE\s*:\s*(movie|tv))?(?:\s*\|\s*REASON\s*:\s*(.*))?/i
        );

        return m
          ? {
              title: m[1].trim(),
              year: null,
              type: m[2] === "tv" ? "tv" : "movie",
              reason:
                (m[3] || "Search lead; unverified")
                  .slice(0, 350)
            }
          : null;
      })
      .filter(Boolean)
      .slice(0, 5);
  }

  const sources = (
    r.grounding?.groundingChunks || []
  )
    .map(x => x?.web?.uri)
    .filter(x =>
      typeof x === "string" &&
      /^https:\/\//.test(x)
    )
    .slice(0, 5);

  return {
    candidates: found,
    sources,
    notes:
      String(parsed?.notes || "").slice(0, 350)
  };
}

// -------------------------------------------------
// RESULT VERIFICATION
// -------------------------------------------------

async function verify(rec, items, clues, key) {
  if (!items.length) return null;

  const prompt = `
Research whether this film or television screenshot
matches one of these productions:

${items.map(x =>
    `${x.title} (${x.year || "year unknown"})`
  ).join("; ")}

Visual details:
${rec.visualEvidence}

Social-media leads:
${rec.socialContext || "none"}

Dialogue:
${rec.dialogue || "none"}

User clues:
${clues || "none"}

Use Google Search.

A title listing, actor resemblance, cast credit,
generic plot, caption, or search query is not proof.

Only identify a production when evidence connects
distinctive scene details or dialogue to its title.

If evidence is inadequate, say UNKNOWN.

Reply exactly:

TITLE: title or UNKNOWN
STATUS: SUPPORTED or UNCERTAIN
EVIDENCE: short specific evidence
LIMITATIONS: short explanation
`;

  const r = await callGemini(
    SEARCH_MODEL,
    [{ text: prompt }],
    key,
    true
  );

  if (!r.ok) return null;

  const fields = {};

  for (const line of r.text.split("\n")) {
    const m = line.match(
      /^\s*(TITLE|STATUS|EVIDENCE|LIMITATIONS)\s*:\s*(.*)$/i
    );

    if (m) {
      fields[m[1].toUpperCase()] = m[2].trim();
    }
  }

  const sources = (
    r.grounding?.groundingChunks || []
  )
    .map(x => x?.web?.uri)
    .filter(x =>
      typeof x === "string" &&
      /^https:\/\//.test(x)
    )
    .slice(0, 5);

  return {
    title: fields.TITLE || null,

    supported:
      fields.STATUS?.toUpperCase() === "SUPPORTED" &&
      sources.length > 0 &&
      !!fields.TITLE &&
      norm(fields.TITLE) !== "unknown",

    evidence: fields.EVIDENCE || "",
    limitations: fields.LIMITATIONS || "",
    sources
  };
}

// -------------------------------------------------
// MAIN SCENEFINDER ENDPOINT
// -------------------------------------------------

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization"
  );

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return send(res, 405, {
      error: "Method not allowed"
    });
  }

  const key = process.env.GEMINI_API_KEY;
  const amodbKey = process.env.AMODB_API_KEY;

  if (!key) {
    return send(res, 503, {
      error: "SceneFinder is not configured"
    });
  }

  if (Date.now() < cooldownUntil) {
    return send(res, 429, {
      error: "SceneFinder is temporarily rate-limited"
    });
  }

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

    const {
      image,
      clues = ""
    } = body || {};

    if (
      typeof clues !== "string" ||
      clues.length > 1000
    ) {
      return send(res, 400, {
        error: "Invalid clues"
      });
    }

    const imageData = parseImage(image);

    if (imageData?.tooLarge) {
      return send(res, 413, {
        error: "Screenshot is too large"
      });
    }

    if (!imageData) {
      return send(res, 400, {
        error: "Please upload a valid JPG, PNG or WebP screenshot"
      });
    }

    // Existing Gemini visual recognition.
    const first = await vision([
      { text: visionPrompt(clues) },
      { inline_data: imageData }
    ], key);

    if (!first.ok) {
      if (first.status === 429) {
        cooldownUntil = Date.now() + 60000;
      }

      return send(
        res,
        first.status === 429 ? 429 : 503,
        {
          error:
            "SceneFinder AI is temporarily unavailable. Please retry shortly."
        }
      );
    }

    const rec = sanitize(first.data);

    // New Google Lens visual search.
    // Automatically returns null if unavailable.
    const lens = await googleLens(
      imageData,
      process.env.SERPAPI_API_KEY
    );

    const lensFound = await lensCandidates(
      lens,
      rec,
      key
    );

    // Existing Gemini search discovery.
    const discovery = await discover(
      rec,
      clues,
      key
    );

    let all = [
      ...lensFound,
      ...rec.candidates,
      ...discovery.candidates
    ];

    // Second Gemini pass when no candidates exist.
    if (!all.length) {
      const retry = await vision([
        {
          text: `Independently analyze this movie or TV screenshot.

Use actual visual details and social-media
promotional text as search leads, not proof.

Suggest up to three plausible titles.
Do not force a guess.

Return JSON with candidates containing
title, year, type, and reason.

Scene: ${rec.visualEvidence}
Overlay: ${rec.socialContext || "none"}
Dialogue: ${rec.dialogue || "none"}`
        },
        { inline_data: imageData }
      ], key);

      if (retry.ok) {
        all = all.concat(
          sanitize(retry.data).candidates
        );
      }
    }

    if (
      rec.imageType === "poster" &&
      rec.visibleTitle
    ) {
      all.unshift({
        title: rec.visibleTitle,
        year: null,
        type: "movie",
        reason: "Title printed on the poster"
      });
    }

    const seen = new Set();

    const unique = all
      .filter(x => {
        const n = norm(x.title);

        if (!n || seen.has(n)) return false;

        seen.add(n);
        return true;
      })
      .slice(0, 6);

    const [results, verification] = await Promise.all([
      Promise.all(
        unique.map(c =>
          matchCandidate(c, amodbKey)
        )
      ),
      verify(rec, unique, clues, key)
    ]);

    let selected = null;

    if (
      rec.imageType === "poster" &&
      rec.visibleTitle
    ) {
      selected = results.find(x =>
        norm(x.title) === norm(rec.visibleTitle)
      ) || null;
    } else if (verification?.supported) {
      selected = results.find(x =>
        norm(x.title) === norm(verification.title) ||
        norm(x.match?.title) === norm(verification.title)
      ) || null;
    }

    const primary = selected?.match || null;

    const sources = [...new Set([
      ...(discovery.sources || []),
      ...(verification?.sources || [])
    ])].slice(0, 5);

    const possibleMatches = results.map(x => ({
      title: x.match?.title || x.title,
      year: x.match?.year || x.year || null,
      type: x.match?.type || x.type,
      reason: x.reason,
      overview: x.match?.overview || null,
      posterUrl: x.match?.posterUrl || null,
      verified: Boolean(selected && x === selected)
    }));

    const uncertain = !selected;

    const answer = uncertain
      ? "No reliable title identified from this screenshot. Review possible matches or try another frame."
      : `Possible identification: ${primary?.title || selected.title}. Search support is not independent proof.`;

    return send(res, 200, {
      success: true,
      answer,

      title: selected
        ? (primary?.title || selected.title)
        : null,

      year: selected
        ? (primary?.year || selected.year || null)
        : null,

      type: selected
        ? (primary?.type || selected.type)
        : null,

      confidence:
        uncertain ? "Low" : rec.confidence,

      identificationUncertain: uncertain,

      visualEvidence: rec.visualEvidence,
      dialogue: rec.dialogue,
      socialContext: rec.socialContext,

      discoveryStatus:
        discovery.status || "ok",

      verificationEvidence:
        verification?.evidence || null,

      verificationLimitations:
        verification?.limitations || null,

      possibleMatches,

      // New Google Lens visual results.
      visualMatches: lens?.matches || [],
      visualSearchUsed: Boolean(lens),
      visualSearchProvider:
        lens ? "SerpApi Google Lens" : null,

      posterUrl: primary?.posterUrl || null,
      poster: primary?.posterUrl || null,
      poster_path: primary?.poster_path || null,

      overview: primary?.overview || null,
      movieId: primary?.id || null,

      verified: false,

      model: first.model,
      fallbackUsed: first.fallbackUsed,

      searchGrounded: sources.length > 0,
      sources,

      metadataProvider:
        amodbKey ? "AMODB" : null,

      metadataMatches:
        results.map(x => x.match).filter(Boolean)
    });
  } catch (e) {
    console.error(
      "SceneFinder unexpected error:",
      e?.message
    );

    return send(res, 500, {
      error: "SceneFinder encountered an unexpected error"
    });
  }
}
