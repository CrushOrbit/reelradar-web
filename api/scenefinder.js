
/*
 ReelRadar SceneFinder V5.4
 Validated movie candidates
 Google Lens-first discovery
 Gemini fallback with rate-limit handling
 AMODB metadata verification

 IMPORTANT:
 Database validation confirms a production exists.
 It does NOT prove that a screenshot belongs to it.
*/

const MODEL =
  process.env.SCENEFINDER_MODEL ||
  "gemini-3.5-flash-lite";

const SEARCH_MODEL =
  process.env.SCENEFINDER_SEARCH_MODEL ||
  "gemini-3.8-flash";

const MODELS = [...new Set([
  MODEL,
  SEARCH_MODEL,
  ...(process.env.SCENEFINDER_FALLBACK_MODELS || "")
    .split(",")
    .map(x => x.trim())
    .filter(Boolean)
])];

const MAX_IMAGE_LENGTH = 6000000;
const LENS_MAX_BYTES = 500000;

const modelCooldowns = new Map();
let lensCooldownUntil = 0;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const send = (res, status, body) =>
  res.status(status).json(body);

// ------------------------------------------
// TEXT AND TITLE UTILITIES
// ------------------------------------------

function formatTitle(value) {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function norm(value) {
  return formatTitle(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function compact(value) {
  return norm(value).replace(/\s/g, "");
}

function sameTitle(a, b) {
  const x = compact(a);
  const y = compact(b);

  return Boolean(x && y && x === y);
}

function safeUrl(value) {
  if (typeof value !== "string") return null;

  try {
    const url = new URL(value);
    return url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function unique(items, limit = 8) {
  const seen = new Set();

  return items.filter(item => {
    const key = compact(item?.title);

    if (!key || seen.has(key)) return false;

    seen.add(key);
    return true;
  }).slice(0, limit);
}

function parseJSON(text) {
  const cleaned = String(text || "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");

  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(
        cleaned.slice(start, end + 1)
      );
    } catch {}
  }

  return null;
}

function parseImage(image) {
  if (typeof image !== "string") return null;

  if (image.length > MAX_IMAGE_LENGTH) {
    return { tooLarge: true };
  }

  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!match) return null;

  const data = match[2].replace(/\s/g, "");

  if (!data || data.length % 4 !== 0) {
    return null;
  }

  return {
    mime_type:
      match[1] === "image/jpg"
        ? "image/jpeg"
        : match[1],
    data
  };
}

function sanitize(raw) {
  const candidates = (
    Array.isArray(raw?.candidates)
      ? raw.candidates
      : []
  )
    .filter(x =>
      x &&
      typeof x.title === "string" &&
      x.title.trim()
    )
    .map(x => ({
      title: formatTitle(x.title).slice(0, 150),
      year:
        Number.isInteger(x.year) &&
        x.year >= 1880 &&
        x.year <= 2100
          ? x.year
          : null,
      type: x.type === "tv" ? "tv" : "movie",
      reason: String(x.reason || "").slice(0, 350),
      source: "gemini"
    }));

  return {
    imageType:
      ["poster", "scene", "unknown"].includes(
        raw?.imageType
      )
        ? raw.imageType
        : "unknown",

    visibleTitle:
      typeof raw?.visibleTitle === "string"
        ? formatTitle(raw.visibleTitle).slice(0, 150)
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
      ["High", "Medium", "Low"].includes(
        raw?.confidence
      )
        ? raw.confidence
        : "Low",

    candidates: unique(candidates, 5)
  };
}

// ------------------------------------------
// GOOGLE LENS
// ------------------------------------------

async function googleLens(imageData, key) {
  if (!key) {
    console.log("SceneFinder Lens not configured");
    return null;
  }

  if (Date.now() < lensCooldownUntil) {
    console.log("SceneFinder Lens cooldown");
    return null;
  }

  try {
    let bytes = Buffer.from(
      imageData.data,
      "base64"
    );

    let mime = imageData.mime_type;

    if (bytes.length > LENS_MAX_BYTES) {
      const { default: sharp } =
        await import("sharp");

      let compressed = null;

      for (const width of [900, 700, 520, 380]) {
        const result = await sharp(bytes)
          .resize({
            width,
            withoutEnlargement: true
          })
          .jpeg({
            quality: 65,
            mozjpeg: true
          })
          .toBuffer();

        if (result.length <= LENS_MAX_BYTES) {
          compressed = result;
          break;
        }
      }

      if (!compressed) {
        console.warn("Lens compression failed");
        return null;
      }

      bytes = compressed;
      mime = "image/jpeg";
    }

    const form = new FormData();

    form.append("api_key", key);

    form.append(
      "image",
      new Blob([bytes], { type: mime }),
      "scene.jpg"
    );

    const uploadController =
      new AbortController();

    const uploadTimer = setTimeout(
      () => uploadController.abort(),
      9000
    );

    let uploaded;

    try {
      const response = await fetch(
        "https://serpapi.com/image",
        {
          method: "POST",
          body: form,
          signal: uploadController.signal
        }
      );

      uploaded = await response.json()
        .catch(() => ({}));

      if (
        !response.ok ||
        uploaded.error ||
        !uploaded.image_id
      ) {
        const message = String(
          uploaded.error || ""
        );

        console.warn(
          "SceneFinder Lens upload failed",
          response.status,
          message.slice(0, 100)
        );

        if (
          response.status === 429 ||
          /quota|limit|credits|exhaust/i.test(
            message
          )
        ) {
          lensCooldownUntil =
            Date.now() + 3600000;
        }

        return null;
      }
    } finally {
      clearTimeout(uploadTimer);
    }

    const url = new URL(
      "https://serpapi.com/search.json"
    );

    url.searchParams.set(
      "engine",
      "google_lens"
    );

    url.searchParams.set(
      "image_id",
      uploaded.image_id
    );

    url.searchParams.set("type", "all");
    url.searchParams.set("hl", "en");
    url.searchParams.set("api_key", key);

    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      16000
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal
      });

      const data = await response.json()
        .catch(() => ({}));

      if (!response.ok || data.error) {
        const message = String(data.error || "");

        console.warn(
          "SceneFinder Lens search failed",
          response.status,
          message.slice(0, 120)
        );

        if (
          response.status === 429 ||
          /quota|limit|credits|exhaust/i.test(
            message
          )
        ) {
          lensCooldownUntil =
            Date.now() + 3600000;
        }

        return null;
      }

      const exact = Array.isArray(
        data.exact_matches
      )
        ? data.exact_matches
        : [];

      const visual = Array.isArray(
        data.visual_matches
      )
        ? data.visual_matches
        : [];

      const matches = [
        ...exact.map(x => ({
          ...x,
          matchKind: "exact"
        })),

        ...visual.map(x => ({
          ...x,
          matchKind: "visual"
        }))
      ]
        .slice(0, 12)
        .map(x => ({
          title:
            String(x.title || "").slice(0, 180),
          source:
            String(x.source || "").slice(0, 100),
          link: safeUrl(x.link),
          thumbnail: safeUrl(x.thumbnail),
          matchKind: x.matchKind
        }));

      console.log(
        "SceneFinder Lens success",
        matches.length
      );

      return {
        matches,
        status: "ok"
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn(
      "SceneFinder Lens unavailable",
      error.message
    );

    return null;
  }
}

// ------------------------------------------
// GEMINI RATE LIMIT HANDLING
// ------------------------------------------

async function callGemini(
  model,
  parts,
  key,
  search = false
) {
  if (!key) {
    return {
      ok: false,
      status: 503
    };
  }

  if (
    Date.now() <
    (modelCooldowns.get(model) || 0)
  ) {
    return {
      ok: false,
      status: 429
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      12000
    );

    try {
      const body = {
        contents: [{
          role: "user",
          parts
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1600
        }
      };

      if (search) {
        body.tools = [{
          google_search: {}
        }];
      } else {
        body.generationConfig.responseMimeType =
          "application/json";
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": key
          },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );

      const data = await response.json()
        .catch(() => ({}));

      if (response.ok) {
        const candidate =
          data.candidates?.[0];

        return {
          ok: true,
          status: 200,
          text: (
            candidate?.content?.parts || []
          )
            .map(x => x.text || "")
            .join("\n"),
          grounding:
            candidate?.groundingMetadata || null,
          model
        };
      }

      console.warn(
        "SceneFinder Gemini",
        model,
        response.status
      );

      if (response.status === 429) {
        const quotaExhausted =
          /quota exceeded|free.tier|per.day|per day/i
            .test(
              JSON.stringify(data.error || {})
            );

        let cooldownMs = quotaExhausted
          ? 3600000
          : 60000;

        const retryAfter =
          response.headers.get("retry-after");

        if (retryAfter) {
          const seconds = Number(retryAfter);

          if (Number.isFinite(seconds)) {
            cooldownMs = Math.max(
              cooldownMs,
              seconds * 1000
            );
          }
        }

        for (const detail of (
          data.error?.details || []
        )) {
          const delay = detail?.retryDelay;

          if (
            typeof delay === "string" &&
            /^\d+(\.\d+)?s$/.test(delay)
          ) {
            cooldownMs = Math.max(
              cooldownMs,
              parseFloat(delay) * 1000
            );
          }
        }

        modelCooldowns.set(
          model,
          Date.now() + cooldownMs
        );

        return {
          ok: false,
          status: 429
        };
      }

      if (
        response.status === 503 ||
        response.status === 500
      ) {
        if (attempt === 0) {
          await sleep(700);
          continue;
        }

        modelCooldowns.set(
          model,
          Date.now() + 30000
        );
      }

      return {
        ok: false,
        status: response.status
      };
    } catch (error) {
      console.warn(
        "SceneFinder Gemini unavailable",
        error.message
      );

      if (attempt === 0) {
        await sleep(500);
        continue;
      }

      return {
        ok: false,
        status: 503
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: 503
  };
}

async function geminiFallback(
  parts,
  key,
  search = false
) {
  let last = {
    ok: false,
    status: 503
  };

  const order = search
    ? [...new Set([SEARCH_MODEL, ...MODELS])]
    : MODELS;

  for (const model of order) {
    const result = await callGemini(
      model,
      parts,
      key,
      search
    );

    if (result.ok) return result;

    last = result;

    if ([400, 401, 403].includes(result.status)) {
      break;
    }
  }

  return last;
}

// ------------------------------------------
// SCREENSHOT RECOGNITION
// ------------------------------------------

async function recognize(imageData, clues, key) {
  const prompt = `
You are ReelRadar SceneFinder.

Describe the screenshot and identify possible
movie or television productions.

Separate the actual scene from Instagram,
TikTok, and other overlays.

Social captions are leads, not proof.

Do not invent movie titles or actor identities.

Return ONLY JSON:

{
  "imageType": "scene",
  "visibleTitle": null,
  "visualEvidence": "actual frame details",
  "dialogue": null,
  "socialContext": null,
  "confidence": "Low",
  "candidates": [
    {
      "title": "production title",
      "year": null,
      "type": "movie",
      "reason": "specific evidence"
    }
  ]
}

imageType: poster, scene, unknown.
type: movie, tv.
confidence: High, Medium, Low.

Candidates may be empty.

User clues: ${clues || "none"}
`;

  const result = await geminiFallback([
    { text: prompt },
    { inline_data: imageData }
  ], key);

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      data: sanitize({})
    };
  }

  const parsed = parseJSON(result.text);

  if (!parsed) {
    return {
      ok: false,
      status: 502,
      data: sanitize({})
    };
  }

  return {
    ok: true,
    status: 200,
    data: sanitize(parsed),
    model: result.model,
    fallbackUsed: result.model !== MODEL
  };
}

// ------------------------------------------
// STRICTER LENS TITLE EXTRACTION
// ------------------------------------------

function extractLensHints(lens) {
  if (!lens?.matches?.length) return [];

  const hints = [];

  const labelPattern =
    /(?:movie|film|series|tv show|drama|trailer|official clip)/i;

  for (const match of lens.matches) {
    const original = String(
      match.title || ""
    ).trim();

    if (!original) continue;

    const quoted = [
      ...original.matchAll(
        /["“‘']([^"”’']{3,70})["”’']/g
      )
    ].map(x => x[1]);

    const titled = [];

    // Explicit production-title labels.
    const patterns = [
      /(?:movie|film|series|drama)\s*:\s*([^|–—#]{3,70})/i,
      /(?:title|name)\s*:\s*([^|–—#]{3,70})/i,
      /🎬\s*([^|–—#]{3,70})/u
    ];

    for (const pattern of patterns) {
      const result = original.match(pattern);

      if (result) {
        titled.push(result[1]);
      }
    }

    // Quoted titles are leads, not proof.
    if (labelPattern.test(original)) {
      titled.push(...quoted);
    }

    for (const raw of titled) {
      const title = formatTitle(raw)
        .replace(/\s*\((?:19|20)\d{2}\).*$/, "")
        .replace(/\s+(?:official trailer|movie clip|full movie|film scene|explained|review).*$/i, "")
        .trim();

      if (
        title.length < 3 ||
        title.length > 65 ||
        /^(instagram|tiktok|youtube|facebook|pinterest)$/i.test(title)
      ) {
        continue;
      }

      hints.push({
        title,
        year: null,
        type: "movie",
        reason:
          "Possible production title from Google Lens",
        source: "lens"
      });

      break;
    }
  }

  return unique(hints, 8);
}

// ------------------------------------------
// OPTIONAL AI LENS INTERPRETATION
// ------------------------------------------

async function interpretLens(lens, rec, key) {
  if (!lens?.matches?.length || !key) {
    return [];
  }

  const prompt = `
Extract real movie or TV production titles
from these Google Lens search results.

Do not output dialogue fragments,
captions, hashtags, usernames, or sentences.

Examples of INVALID titles:
"Adam didn"
"Watch till the end"
"She loves him"
"Best scene ever"

Do not invent a production title.

Screenshot:
${rec.visualEvidence || "Unknown"}

Lens results:
${JSON.stringify(lens.matches.map(x => ({
    title: x.title,
    source: x.source
  })))}

Return ONLY JSON:
{
  "candidates": [
    {
      "title": "actual production title",
      "year": null,
      "type": "movie",
      "reason": "specific result evidence"
    }
  ]
}

Return an empty array when uncertain.
`;

  const result = await geminiFallback(
    [{ text: prompt }],
    key
  );

  if (!result.ok) return [];

  return sanitize(
    parseJSON(result.text) || {}
  ).candidates.map(x => ({
    ...x,
    source: "lens_ai"
  }));
}

// ------------------------------------------
// AMODB METADATA VALIDATION
// ------------------------------------------

function posterUrl(path) {
  if (typeof path !== "string") return null;

  if (path.startsWith("https://")) {
    return path;
  }

  if (path.startsWith("/")) {
    return (
      "https://image.tmdb.org/t/p/w500" +
      path
    );
  }

  return null;
}

async function amodb(title, type, key, year) {
  if (!key || !title) return null;

  const controller = new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    6500
  );

  try {
    const url = new URL(
      `https://api.amodb.dev/3/search/${type}`
    );

    url.searchParams.set(
      "query",
      formatTitle(title)
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(
        "SceneFinder AMODB",
        response.status
      );

      return null;
    }

    const data = await response.json();

    const rows = (
      Array.isArray(data.results)
        ? data.results
        : []
    )
      .filter(item =>
        [
          item.title,
          item.name,
          item.original_title,
          item.original_name
        ].some(name =>
          sameTitle(name, title)
        )
      )
      .map(item => {
        const date =
          item.release_date ||
          item.first_air_date ||
          "";

        const itemYear =
          /^\d{4}/.test(date)
            ? Number(date.slice(0, 4))
            : null;

        return {
          item,
          year: itemYear,
          diff:
            year && itemYear
              ? Math.abs(year - itemYear)
              : 0
        };
      })
      .filter(x => x.diff <= 1)
      .sort((a, b) => a.diff - b.diff);

    if (!rows.length) return null;

    const { item, year: itemYear } = rows[0];

    return {
      id: item.id,
      title: formatTitle(
        item.title ||
        item.name ||
        title
      ),
      year: itemYear,
      type,
      poster_path:
        item.poster_path || null,
      posterUrl:
        posterUrl(item.poster_path),
      overview:
        String(item.overview || "").slice(0, 350)
    };
  } catch (error) {
    console.warn(
      "SceneFinder AMODB unavailable",
      error.message
    );

    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validateCandidate(candidate, key) {
  const title = formatTitle(candidate.title);

  let match = await amodb(
    title,
    candidate.type,
    key,
    candidate.year
  );

  if (!match) {
    match = await amodb(
      title,
      candidate.type === "tv"
        ? "movie"
        : "tv",
      key,
      candidate.year
    );
  }

  if (!match) return null;

  return {
    ...candidate,
    title: match.title,
    year: match.year || candidate.year || null,
    type: match.type,
    match
  };
}

// ------------------------------------------
// LENS EVIDENCE SCORING
// ------------------------------------------

function lensEvidence(candidate, lens) {
  if (!lens?.matches?.length) {
    return {
      count: 0,
      exact: 0,
      score: 0
    };
  }

  const title = compact(candidate.title);

  if (title.length < 3) {
    return {
      count: 0,
      exact: 0,
      score: 0
    };
  }

  const matches = lens.matches.filter(x => {
    const text = compact(x.title);

    return text === title ||
      (
        title.length >= 8 &&
        text.includes(title)
      );
  });

  const exact = matches.filter(
    x => x.matchKind === "exact"
  ).length;

  const domains = new Set();

  for (const item of matches) {
    try {
      if (item.link) {
        domains.add(
          new URL(item.link).hostname
        );
      }
    } catch {}
  }

  return {
    count: matches.length,
    exact,
    score:
      Math.min(matches.length, 4) +
      Math.min(domains.size, 2) +
      Math.min(exact, 2)
  };
}

// ------------------------------------------
// OPTIONAL SEARCH VERIFICATION
// ------------------------------------------

async function verifyScene(
  rec,
  candidates,
  clues,
  key
) {
  if (
    !key ||
    !candidates.length ||
    !rec.visualEvidence
  ) {
    return null;
  }

  const prompt = `
Use Google Search to research whether
the screenshot belongs to one of these
movie or television productions:

${candidates.map(x => x.title).join("; ")}

Actual scene:
${rec.visualEvidence}

Dialogue:
${rec.dialogue || "none"}

Social-media context:
${rec.socialContext || "none"}

User clues:
${clues || "none"}

A title listing, cast credit, hashtag,
caption, or generic plot is NOT
verification of the exact scene.

Only support a production if specific
scene details or dialogue are connected
to it by search evidence.

Return exactly:
TITLE: title or UNKNOWN
STATUS: SUPPORTED or UNCERTAIN
EVIDENCE: specific evidence
LIMITATIONS: uncertainty
`;

  const result = await geminiFallback(
    [{ text: prompt }],
    key,
    true
  );

  if (!result.ok) return null;

  const fields = {};

  for (const line of result.text.split("\n")) {
    const match = line.match(
      /^\s*(TITLE|STATUS|EVIDENCE|LIMITATIONS)\s*:\s*(.*)$/i
    );

    if (match) {
      fields[match[1].toUpperCase()] =
        match[2].trim();
    }
  }

  const sources = (
    result.grounding?.groundingChunks || []
  )
    .map(x => safeUrl(x?.web?.uri))
    .filter(Boolean)
    .slice(0, 5);

  return {
    title: fields.TITLE || null,
    supported:
      fields.STATUS?.toUpperCase() ===
        "SUPPORTED" &&
      !!fields.TITLE &&
      norm(fields.TITLE) !== "unknown" &&
      sources.length > 0,
    evidence: fields.EVIDENCE || "",
    limitations:
      fields.LIMITATIONS || "",
    sources
  };
}

// ------------------------------------------
// MAIN API
// ------------------------------------------

export default async function handler(req, res) {
  res.setHeader(
    "Cache-Control",
    "no-store"
  );

  res.setHeader(
    "Access-Control-Allow-Origin",
    "*"
  );

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
        error:
          "Please upload a valid JPG, PNG or WebP screenshot"
      });
    }

    const geminiKey =
      process.env.GEMINI_API_KEY;

    const lensKey =
      process.env.SERPAPI_API_KEY;

    const amodbKey =
      process.env.AMODB_API_KEY;

    if (!geminiKey && !lensKey) {
      return send(res, 503, {
        error:
          "SceneFinder is not configured"
      });
    }

    console.log(
      "SceneFinder V5.4 request started"
    );

    // Google Lens runs independently.
    const lens = await googleLens(
      imageData,
      lensKey
    );

    const lensHints = extractLensHints(lens);

    // Gemini failures do not end the request.
    const first = geminiKey
      ? await recognize(
          imageData,
          clues,
          geminiKey
        )
      : {
          ok: false,
          status: 503,
          data: sanitize({})
        };

    const rec = first.data;

    let lensAI = [];

    if (
      geminiKey &&
      lens?.matches?.length &&
      (
        !lensHints.length ||
        !rec.candidates.length
      )
    ) {
      lensAI = await interpretLens(
        lens,
        rec,
        geminiKey
      );
    }

    const candidates = [
      ...lensAI,
      ...rec.candidates,
      ...lensHints
    ];

    if (
      rec.imageType === "poster" &&
      rec.visibleTitle
    ) {
      candidates.unshift({
        title: rec.visibleTitle,
        year: null,
        type: "movie",
        reason:
          "Title printed on uploaded poster",
        source: "poster"
      });
    }

    const rawCandidates = unique(
      candidates,
      8
    );

    // Validate every candidate against AMODB.
    // Invalid fragments are never displayed
    // as movie recommendations.
    const validated = amodbKey
      ? await Promise.all(
          rawCandidates.map(candidate =>
            validateCandidate(
              candidate,
              amodbKey
            )
          )
        )
      : [];

    const results = validated
      .filter(Boolean)
      .map(candidate => ({
        ...candidate,
        lensEvidence:
          lensEvidence(candidate, lens)
      }))
      .sort((a, b) => {
        const scoreA =
          a.lensEvidence.score +
          (a.source === "lens_ai" ? 2 : 0) +
          (a.source === "poster" ? 3 : 0);

        const scoreB =
          b.lensEvidence.score +
          (b.source === "lens_ai" ? 2 : 0) +
          (b.source === "poster" ? 3 : 0);

        return scoreB - scoreA;
      });

    let verification = null;

    if (
      geminiKey &&
      first.ok &&
      results.length &&
      (
        results[0].lensEvidence.score >= 2 ||
        rec.dialogue ||
        rec.imageType === "poster"
      )
    ) {
      verification = await verifyScene(
        rec,
        results.slice(0, 3),
        clues,
        geminiKey
      );
    }

    const verifiedCandidate =
      verification?.supported
        ? results.find(x =>
            sameTitle(
              x.title,
              verification.title
            )
          )
        : null;

    const posterCandidate =
      rec.imageType === "poster" &&
      rec.visibleTitle
        ? results.find(x =>
            sameTitle(
              x.title,
              rec.visibleTitle
            )
          )
        : null;

    const selected =
      verifiedCandidate ||
      posterCandidate ||
      results.find(x =>
        x.lensEvidence.count > 0
      ) ||
      results[0] ||
      null;

    // Metadata validation alone is not
    // scene verification.
    const supported = Boolean(
      verifiedCandidate ||
      posterCandidate
    );

    const confidence = supported
      ? (
          selected?.lensEvidence.score >= 4
            ? "High"
            : "Medium"
        )
      : selected?.lensEvidence.score >= 3
        ? "Medium"
        : "Low";

    const primary = selected?.match || null;

    const possibleMatches = results.map(x => ({
      title: x.title,
      year: x.year,
      type: x.type,
      reason: x.reason,
      overview:
        x.match?.overview || null,
      posterUrl:
        x.match?.posterUrl || null,
      verified:
        supported && x === selected,
      confidence:
        x === selected
          ? confidence
          : "Low",
      lensEvidenceCount:
        x.lensEvidence.count
    }));

    const sources = [
      ...new Set(
        verification?.sources || []
      )
    ].slice(0, 5);

    const answer = supported
      ? `Possible identification: ${selected.title}. Supporting evidence was found, but the exact frame may still require confirmation.`
      : selected
        ? `Possible match: ${selected.title}. This production exists in the movie database, but the screenshot is not verified.`
        : lens?.matches?.length
          ? "Google Lens found visual-search results, but no movie titles could be validated."
          : "No reliable movie title identified. Try another screenshot or provide dialogue.";

    const diagnostics = {
      version: "5.4",
      lensStatus: lens
        ? "ok"
        : lensKey
          ? "unavailable"
          : "not_configured",
      lensResults:
        lens?.matches?.length || 0,
      geminiStatus: first.ok
        ? "ok"
        : `unavailable_${first.status}`,
      rawCandidates:
        rawCandidates.length,
      validatedCandidates:
        results.length,
      metadataStatus:
        amodbKey
          ? "configured"
          : "not_configured",
      verificationStatus:
        verification
          ? "completed"
          : "not_completed"
    };

    console.log(
      "SceneFinder V5.4 diagnostics",
      JSON.stringify(diagnostics)
    );

    return send(res, 200, {
      success: true,
      answer,

      title:
        selected?.title || null,

      year:
        selected?.year || null,

      type:
        selected?.type || null,

      confidence,
      identificationUncertain: !supported,

      visualEvidence:
        rec.visualEvidence,

      dialogue:
        rec.dialogue,

      socialContext:
        rec.socialContext,

      discoveryStatus:
        first.ok
          ? "ok"
          : "gemini_unavailable",

      verificationEvidence:
        verification?.evidence || null,

      verificationLimitations:
        verification?.limitations || null,

      possibleMatches,

      visualMatches:
        lens?.matches || [],

      visualSearchUsed:
        Boolean(lens),

      visualSearchProvider:
        lens
          ? "SerpApi Google Lens"
          : null,

      posterUrl:
        primary?.posterUrl || null,

      poster:
        primary?.posterUrl || null,

      poster_path:
        primary?.poster_path || null,

      overview:
        primary?.overview || null,

      movieId:
        primary?.id || null,

      verified: supported,

      verificationMethod:
        verifiedCandidate
          ? "grounded_search"
          : posterCandidate
            ? "visible_poster_title"
            : null,

      model:
        first.model || null,

      fallbackUsed:
        Boolean(first.fallbackUsed),

      searchGrounded:
        sources.length > 0,

      sources,

      metadataProvider:
        amodbKey
          ? "AMODB"
          : null,

      metadataMatches:
        results
          .map(x => x.match)
          .filter(Boolean),

      diagnostics
    });
  } catch (error) {
    console.error(
      "SceneFinder V5.4 unexpected error",
      error?.message
    );

    return send(res, 500, {
      error:
        "SceneFinder encountered an unexpected error"
    });
  }
}
