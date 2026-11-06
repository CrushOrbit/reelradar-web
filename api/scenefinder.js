
const MODEL = process.env.SCENEFINDER_MODEL || "gemini-3.5-flash-lite";
const SEARCH_MODEL = process.env.SCENEFINDER_SEARCH_MODEL || "gemini-3.8-flash";
const FALLBACKS = [...new Set([
  MODEL,
  ...(process.env.SCENEFINDER_FALLBACK_MODELS || SEARCH_MODEL)
    .split(",").map(x => x.trim()).filter(Boolean)
])].slice(0, 3);

const MAX_IMAGE_LENGTH = 6000000;
let cooldownUntil = 0;

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
  try {
    return JSON.parse(
      String(t || "")
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
    );
  } catch {
    return null;
  }
}

async function callGemini(model, parts, key, search = false) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 18000);

  try {
    const body = {
      contents: [{ role: "user", parts }],
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
      return { ok: false, status: r.status };
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
    return { ok: false, status: 503 };
  } finally {
    clearTimeout(timer);
  }
}

async function vision(parts, key) {
  let last = { ok: false, status: 503 };

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

        last = { ok: false, status: 502 };
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
Identify a movie or TV screenshot using actual frame evidence,
not social-media captions, usernames, hashtags, or suggested titles.

Dialogue subtitles can be searched but are not production titles.
Do not assume an actor's identity from resemblance.
Read a clearly printed poster or title-card title when present.
Describe distinctive scene details.
Suggest at most three productions and abstain when evidence is weak.

Return JSON only:
{
  "imageType": "scene",
  "visibleTitle": null,
  "visualEvidence": "specific visible details",
  "dialogue": "exact visible dialogue or null",
  "candidates": [
    {
      "title": "title",
      "year": null,
      "type": "movie",
      "reason": "specific evidence"
    }
  ],
  "confidence": "Low"
}

imageType: poster, scene, unknown.
confidence: High, Medium, Low.
type: movie or tv.

User clues: ${clues || "None"}
`;

function sanitize(raw) {
  const seen = new Set();

  const candidates = (
    Array.isArray(raw?.candidates) ? raw.candidates : []
  )
    .filter(x => x && typeof x.title === "string" && x.title.trim())
    .map(x => ({
      title: x.title.trim().slice(0, 150),
      year:
        Number.isInteger(x.year) && x.year >= 1880 && x.year <= 2100
          ? x.year
          : null,
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
    imageType: ["poster", "scene", "unknown"].includes(raw?.imageType)
      ? raw.imageType
      : "unknown",
    visibleTitle:
      typeof raw?.visibleTitle === "string"
        ? raw.visibleTitle.trim().slice(0, 150)
        : null,
    visualEvidence: String(raw?.visualEvidence || "").slice(0, 700),
    dialogue:
      typeof raw?.dialogue === "string"
        ? raw.dialogue.slice(0, 250)
        : null,
    confidence: ["High", "Medium", "Low"].includes(raw?.confidence)
      ? raw.confidence
      : "Low",
    candidates
  };
}

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
        [x.title, x.name, x.original_title, x.original_name]
          .some(n => norm(n) === norm(title))
      )
      .map(item => {
        const date = item.release_date || item.first_air_date || "";
        const y = /^\d{4}/.test(date)
          ? Number(date.slice(0, 4))
          : null;

        return {
          item,
          y,
          diff: year && y ? Math.abs(year - y) : null
        };
      })
      .filter(x => x.diff === null || x.diff <= 1)
      .sort((a, b) => (a.diff ?? 2) - (b.diff ?? 2));

    if (!rows.length) return null;

    const { item, y } = rows[0];

    return {
      id: item.id,
      title: item.title || item.name || title,
      year: y,
      type,
      poster_path: item.poster_path || null,
      posterUrl: posterUrl(item.poster_path),
      overview: String(item.overview || "").slice(0, 350)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function matchCandidate(c, key) {
  let match = await amodb(c.title, c.type, key, c.year);

  if (!match) {
    match = await amodb(
      c.title,
      c.type === "tv" ? "movie" : "tv",
      key,
      c.year
    );
  }

  return { ...c, match };
}

async function discover(rec, clues, key) {
  const prompt = `
Use Google Search to discover the identity of a movie or TV scene.

Start from exact dialogue and distinctive visual details.
Do NOT start from candidate movie guesses.

Screenshot description: ${rec.visualEvidence}
Dialogue: ${rec.dialogue || "none"}
Additional clues: ${clues || "none"}

Search distinctive dialogue quotations and scene descriptions,
including productions not initially guessed.

Social-media captions, account names and hashtags are not proof.

Return only JSON in plain text:
{
  "candidates": [
    {
      "title": "exact production title",
      "year": null,
      "type": "movie",
      "reason": "what search evidence actually supports"
    }
  ],
  "notes": "uncertainties"
}

Return 0-3 candidates.
Do not invent search evidence.
`;

  const r = await callGemini(
    SEARCH_MODEL,
    [{ text: prompt }],
    key,
    true
  );

  if (!r.ok) {
    return {
      candidates: [],
      sources: [],
      status: r.status
    };
  }

  const parsed = parseJSON(r.text);

  const candidates = sanitize(parsed || {}).candidates;

  const sources = (r.grounding?.groundingChunks || [])
    .map(x => x?.web?.uri)
    .filter(x => typeof x === "string" && /^https:\/\//.test(x))
    .slice(0, 5);

  return {
    candidates,
    sources,
    notes: String(parsed?.notes || "").slice(0, 350)
  };
}

async function verify(rec, items, clues, key) {
  if (!items.length) return null;

  const prompt = `
Research whether a specific film or TV screenshot matches
one of these productions:

${items.map(x =>
    `${x.title} (${x.year || "year unknown"})`
  ).join("; ")}

Visual details: ${rec.visualEvidence}
Exact dialogue: ${rec.dialogue || "none"}
User clues: ${clues || "none"}

Use Google Search.

A title listing, actor resemblance, cast credit, generic plot,
social-media caption, or search query is NOT scene verification.

Only identify a production if search evidence explicitly connects
distinctive dialogue or visual scene details to that title.

If evidence is inadequate, say UNKNOWN.

Reply exactly:
TITLE: title or UNKNOWN
STATUS: SUPPORTED or UNCERTAIN
EVIDENCE: short specific evidence
LIMITATIONS: short explanation.
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

  const sources = (r.grounding?.groundingChunks || [])
    .map(x => x?.web?.uri)
    .filter(x => typeof x === "string" && /^https:\/\//.test(x))
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

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
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

    const { image, clues = "" } = body || {};

    if (typeof clues !== "string" || clues.length > 1000) {
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

    const first = await vision([
      { text: visionPrompt(clues) },
      { inline_data: imageData }
    ], key);

    if (!first.ok) {
      if (first.status === 429) {
        cooldownUntil = Date.now() + 60000;
      }

      return send(res, first.status === 429 ? 429 : 503, {
        error: "SceneFinder AI is temporarily unavailable. Please retry shortly."
      });
    }

    const rec = sanitize(first.data);

    const discovery = await discover(rec, clues, key);

    const all = [
      ...rec.candidates,
      ...discovery.candidates
    ];

    if (rec.imageType === "poster" && rec.visibleTitle) {
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
        unique.map(c => matchCandidate(c, amodbKey))
      ),
      verify(rec, unique, clues, key)
    ]);

    let selected = null;

    if (rec.imageType === "poster" && rec.visibleTitle) {
      selected = results.find(
        x => norm(x.title) === norm(rec.visibleTitle)
      ) || null;
    } else if (verification?.supported) {
      selected = results.find(
        x =>
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

      confidence: uncertain ? "Low" : rec.confidence,
      identificationUncertain: uncertain,

      visualEvidence: rec.visualEvidence,
      dialogue: rec.dialogue,

      verificationEvidence: verification?.evidence || null,
      verificationLimitations: verification?.limitations || null,

      possibleMatches,

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

      metadataProvider: amodbKey ? "AMODB" : null,
      metadataMatches: results
        .map(x => x.match)
        .filter(Boolean)
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
