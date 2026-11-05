
const MODEL = process.env.SCENEFINDER_MODEL || "gemini-3.5-flash-lite";
const SEARCH_MODEL = process.env.SCENEFINDER_SEARCH_MODEL || "gemini-3.8-flash";
// Optional comma-separated alternatives in Vercel, e.g. gemini-3.8-flash.
// Models must be enabled for your Gemini API key.
const FALLBACK_MODELS = (process.env.SCENEFINDER_FALLBACK_MODELS || SEARCH_MODEL)
  .split(",")
  .map(name => name.trim())
  .filter(Boolean)
  .filter(name => name !== MODEL);

const API_TIMEOUT_MS = 12000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 700;
const COOLDOWN_MS = 60000;
const MAX_IMAGE_LENGTH = 6000000;

let cooldownUntil = 0;
let searchCooldownUntil = 0;

const sleep = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function send(res, status, data) {
  return res.status(status).json(data);
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

  const base64 = match[2].replace(/\s/g, "");

  if (!base64 || base64.length % 4 !== 0) {
    return null;
  }

  return {
    mime_type:
      match[1] === "image/jpg"
        ? "image/jpeg"
        : match[1],
    data: base64
  };
}

function cleanJSON(text) {
  try {
    return JSON.parse(
      text
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim()
    );
  } catch {
    return null;
  }
}

function extractText(data) {
  return (data?.candidates || [])
    .flatMap(c => c?.content?.parts || [])
    .filter(p => typeof p?.text === "string")
    .map(p => p.text)
    .join("\n")
    .trim();
}

function normalize(text) {
  return String(text || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function sanitizeCandidates(data) {
  return (
    Array.isArray(data?.candidates)
      ? data.candidates
      : []
  )
    .filter(c =>
      c &&
      typeof c.title === "string" &&
      c.title.trim()
    )
    .slice(0, 3)
    .map(c => ({
      title: c.title.trim().slice(0, 150),
      year:
        Number.isInteger(c.year) &&
        c.year >= 1880 &&
        c.year <= 2100
          ? c.year
          : null,
      type: c.type === "tv" ? "tv" : "movie",
      reason: String(c.reason || "").slice(0, 350)
    }));
}

function recognitionPrompt(clues) {
  return `
You are ReelRadar SceneFinder, a careful
movie and television identification assistant.

Analyze the uploaded image.

CRITICAL RULE:
If this is a poster, cover, advertisement,
or title card, prioritize clearly visible
title text.

Do not replace a visible title with a
different production because actors,
costumes, or scenery look similar.

Read visible words carefully.
Distinguish titles from slogans and logos.

Consider:
- Visible title text
- Actors and characters
- Subtitles and dialogue
- Clothing and locations
- Objects and scenery
- Production style

Never invent actors, titles, years, or plots.

Return ONLY JSON:

{
  "imageType": "poster",
  "visibleTitle": null,
  "candidates": [
    {
      "title": "Movie or series title",
      "year": null,
      "type": "movie",
      "reason": "Visible evidence"
    }
  ],
  "confidence": "Low",
  "visualEvidence": "Description"
}

imageType must be poster, scene, or unknown.
visibleTitle must be a string or null.
confidence must be High, Medium, or Low.
Return at most three candidates.
Use an empty candidate list if uncertain.

If visibleTitle is clearly a production title,
put it first among candidates.

User clues: ${clues || "None"}
`;
}

async function geminiRequest(
  model,
  parts,
  apiKey,
  useSearch = false
) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS
  );

  try {
    const body = {
      contents: [
        {
          role: "user",
          parts
        }
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200
      }
    };

    if (useSearch) {
      body.tools = [{ google_search: {} }];
    } else {
      body.generationConfig.responseMimeType =
        "application/json";
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      console.warn(
        `SceneFinder ${model}: HTTP ${response.status}`,
        String(data?.error?.message || "")
          .slice(0, 200)
      );

      return {
        success: false,
        status: response.status,
        retryable: [
          500, 502, 503, 504
        ].includes(response.status)
      };
    }

    return {
      success: true,
      text: extractText(data),
      groundingMetadata:
        data?.candidates?.[0]?.groundingMetadata ||
        null
    };
  } catch (error) {
    console.warn(
      `SceneFinder ${model}:`,
      error?.name === "AbortError"
        ? "Timeout"
        : error?.message
    );

    return {
      success: false,
      status: 503,
      retryable: true
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function recognize(imageData, clues, apiKey) {
  const models = [...new Set([MODEL, ...FALLBACK_MODELS])].slice(0, 3);
  let lastFailure = { success: false, status: 503, retryable: true };

  for (const [index, model] of models.entries()) {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const result = await geminiRequest(
        model,
        [
          { text: recognitionPrompt(clues) },
          { inline_data: imageData }
        ],
        apiKey
      );

      if (result.success) {
        const data = cleanJSON(result.text);

        if (!data) {
          lastFailure = {
            success: false,
            status: 502,
            retryable: true
          };
          break;
        }

        return {
          success: true,
          model,
          fallbackUsed: index > 0,
          imageType:
            ["poster", "scene", "unknown"].includes(data.imageType)
              ? data.imageType
              : "unknown",
          visibleTitle:
            typeof data.visibleTitle === "string"
              ? data.visibleTitle.trim().slice(0, 150)
              : null,
          candidates: sanitizeCandidates(data),
          confidence:
            ["High", "Medium", "Low"].includes(data.confidence)
              ? data.confidence
              : "Low",
          visualEvidence:
            String(data.visualEvidence || "").slice(0, 500)
        };
      }

      lastFailure = result;

      if (result.status === 429) {
        cooldownUntil = Date.now() + COOLDOWN_MS;
        return result;
      }

      if ([400, 401, 403].includes(result.status)) {
        return result;
      }

      // A missing/retired model can be skipped.
      if (result.status === 404) break;

      if (!result.retryable) break;

      // Move to the fallback quickly after model overload.
      if (result.status === 503) break;

      if (attempt < MAX_ATTEMPTS) {
        await sleep(RETRY_DELAY_MS * attempt);
      }
    }
  }

  return lastFailure;
}

function getPosterUrl(posterPath) {
  if (
    typeof posterPath !== "string" ||
    !posterPath.trim()
  ) {
    return null;
  }

  const path = posterPath.trim();

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

async function lookupAmodb(
  title,
  type,
  apiKey,
  year
) {
  if (!apiKey || !title) return null;

  const url = new URL(
    `https://api.amodb.dev/3/search/${type}`
  );

  url.searchParams.set("query", title);

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    6000
  );

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(
        "SceneFinder AMODB:",
        response.status
      );
      return null;
    }

    const data = await response.json();

    const results = (data.results || [])
      .filter(item =>
        [
          item.title,
          item.name,
          item.original_title,
          item.original_name
        ].some(name =>
          normalize(name) === normalize(title)
        )
      );

    if (!results.length) return null;

    const ranked = results
      .map(item => {
        const date =
          item.release_date ||
          item.first_air_date ||
          "";

        const releaseYear =
          /^\d{4}/.test(date)
            ? Number(date.slice(0, 4))
            : null;

        const difference =
          year && releaseYear
            ? Math.abs(year - releaseYear)
            : null;

        return {
          item,
          releaseYear,
          difference,
          score:
            difference === 0 ? 4 :
            difference === 1 ? 2 :
            difference === null ? 1 : 0
        };
      })
      .sort((a, b) => b.score - a.score);

    const best = ranked[0];

    if (
      best.difference !== null &&
      best.difference > 1
    ) {
      return null;
    }

    const posterPath =
      typeof best.item.poster_path === "string"
        ? best.item.poster_path
        : null;

    return {
      id: best.item.id,
      title:
        best.item.title ||
        best.item.name ||
        title,
      year: best.releaseYear,
      type,
      poster_path: posterPath,
      posterUrl: getPosterUrl(posterPath),
      overview:
        String(best.item.overview || "")
          .slice(0, 350)
    };
  } catch (error) {
    console.warn(
      "SceneFinder AMODB:",
      error?.name === "AbortError"
        ? "Timeout"
        : error?.message
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function searchCandidates(
  candidates,
  apiKey
) {
  return Promise.all(
    candidates.slice(0, 3).map(
      async candidate => {
        let match = await lookupAmodb(
          candidate.title,
          candidate.type,
          apiKey,
          candidate.year
        );

        if (!match) {
          match = await lookupAmodb(
            candidate.title,
            candidate.type === "movie"
              ? "tv"
              : "movie",
            apiKey,
            candidate.year
          );
        }

        return {
          candidate,
          match
        };
      }
    )
  );
}

async function googleVerify(
  recognition,
  clues,
  apiKey
) {
  if (Date.now() < searchCooldownUntil) {
    return null;
  }

  const names = recognition.candidates
    .map(c => `${c.title} ${c.year || ""}`)
    .join("; ");

  const prompt = `
You are checking possible movie or TV identities
for ReelRadar SceneFinder.

Possible candidates: ${names || "Unknown"}

Visible poster title:
${recognition.visibleTitle || "None"}

Image description:
${recognition.visualEvidence}

User clues:
${clues || "None"}

Use Google Search to research these candidates.

Give priority to a clearly visible title
on a promotional poster.

Search for evidence about the title,
year, cast, poster, and production.

Do not assume a database listing proves
the image belongs to that production.

Return a concise response in this format:

Title: ...
Year: ...
Evidence: ...
Uncertainty: ...

If evidence is insufficient, say so.
Do not invent sources.
`;

  const result = await geminiRequest(
    SEARCH_MODEL,
    [{ text: prompt }],
    apiKey,
    true
  );

  if (!result.success) {
    if (
      [429, 503, 400, 404].includes(result.status)
    ) {
      searchCooldownUntil =
        Date.now() + COOLDOWN_MS;
    }

    return null;
  }

  const metadata = result.groundingMetadata;

  const sources = (
    metadata?.groundingChunks || []
  )
    .map(chunk => chunk?.web?.uri)
    .filter(url =>
      typeof url === "string" &&
      /^https?:\/\//.test(url)
    )
    .slice(0, 5);

  return {
    text: result.text.slice(0, 1500),
    grounded:
      sources.length > 0 ||
      Boolean(metadata?.webSearchQueries?.length),
    sources
  };
}

function buildAnswer(
  recognition,
  results,
  google,
  amodbEnabled
) {
  const visible = recognition.visibleTitle;
  const ordered = [...results];

  if (
    visible &&
    recognition.imageType === "poster"
  ) {
    ordered.sort((a, b) => {
      const aVisible =
        normalize(a.candidate.title) ===
        normalize(visible);

      const bVisible =
        normalize(b.candidate.title) ===
        normalize(visible);

      return Number(bVisible) - Number(aVisible);
    });
  }

  const best = ordered[0];

  if (!best && !visible) {
    return (
      "No reliable title identified.\n\n" +
      "Try a clearer screenshot or add clues."
    );
  }

  const title =
    best?.match?.title ||
    best?.candidate?.title ||
    visible;

  const year =
    best?.match?.year ||
    best?.candidate?.year ||
    "Unknown";

  const lines = [
    `Title: ${title}`,
    `Year: ${year}`,
    `Confidence: ${recognition.confidence} (AI estimate)`
  ];

  if (
    visible &&
    recognition.imageType === "poster"
  ) {
    lines.push(
      `Visible poster title: ${visible}`
    );
  }

  if (best?.match) {
    lines.push(
      "AMODB: Matching production title found."
    );
  } else {
    lines.push(
      amodbEnabled
        ? "AMODB: No exact matching title confirmed."
        : "AMODB: Unavailable."
    );
  }

  lines.push(
    "Scene verification: Not confirmed."
  );

  if (recognition.visualEvidence) {
    lines.push(
      `Visual evidence: ${recognition.visualEvidence}`
    );
  }

  if (best?.candidate?.reason) {
    lines.push(
      `Explanation: ${best.candidate.reason}`
    );
  }

  if (google?.text) {
    lines.push(
      "\nGoogle Search research:\n" +
      google.text
    );
  }

  if (ordered.length > 1) {
    lines.push(
      "\nOther possible titles: " +
      ordered
        .slice(1)
        .map(x => x.candidate.title)
        .join("; ")
    );
  }

  return lines.join("\n\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

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

  const geminiKey = process.env.GEMINI_API_KEY;
  const amodbKey = process.env.AMODB_API_KEY;

  if (!geminiKey) {
    return send(res, 503, {
      error: "SceneFinder is not configured"
    });
  }

  if (Date.now() < cooldownUntil) {
    res.setHeader(
      "Retry-After",
      String(
        Math.ceil(
          (cooldownUntil - Date.now()) / 1000
        )
      )
    );

    return send(res, 429, {
      error:
        "SceneFinder is temporarily rate-limited. Please try again shortly."
    });
  }

  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, {
          error: "Invalid request body"
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
        error: "Invalid scene clues"
      });
    }

    const imageData = parseImage(image);

    if (imageData?.tooLarge) {
      return send(res, 413, {
        error:
          "Screenshot is too large. Please use a smaller image."
      });
    }

    if (!imageData) {
      return send(res, 400, {
        error:
          "Please upload a valid JPG, PNG, or WebP screenshot."
      });
    }

    const recognition = await recognize(
      imageData,
      clues,
      geminiKey
    );

    if (!recognition.success) {
      return send(
        res,
        recognition.status === 429 ? 429 : 503,
        {
          error:
            recognition.status === 429
              ? "SceneFinder has reached a temporary AI usage limit. Please try again later."
              : "SceneFinder AI is temporarily unavailable. Please try again shortly."
        }
      );
    }

    let candidates = [
      ...recognition.candidates
    ];

    if (
      recognition.imageType === "poster" &&
      recognition.visibleTitle &&
      !candidates.some(c =>
        normalize(c.title) ===
        normalize(recognition.visibleTitle)
      )
    ) {
      candidates.unshift({
        title: recognition.visibleTitle,
        year: null,
        type: "movie",
        reason:
          "Title text visible on the poster."
      });
    }

    candidates = candidates.slice(0, 3);

    const results = await searchCandidates(
      candidates,
      amodbKey
    );

    const best = results[0];

    const visibleMismatch =
      recognition.imageType === "poster" &&
      recognition.visibleTitle &&
      best &&
      normalize(best.candidate.title) !==
        normalize(recognition.visibleTitle);

    const needsResearch =
      recognition.confidence !== "High" ||
      visibleMismatch ||
      !best?.match;

    const google = needsResearch
      ? await googleVerify(
          recognition,
          clues,
          geminiKey
        )
      : null;

    const answer = buildAnswer(
      recognition,
      results,
      google,
      Boolean(amodbKey)
    );

    const primaryMatch =
      results[0]?.match || null;

    const metadataMatches = results
      .map(x => x.match)
      .filter(Boolean);

    const posterUrl =
      primaryMatch?.posterUrl ||
      metadataMatches
        .map(x => x.posterUrl)
        .find(Boolean) ||
      null;

    return send(res, 200, {
      success: true,

      answer,

      title:
        primaryMatch?.title ||
        candidates[0]?.title ||
        recognition.visibleTitle ||
        null,

      year:
        primaryMatch?.year ||
        candidates[0]?.year ||
        null,

      type:
        primaryMatch?.type ||
        candidates[0]?.type ||
        null,

      confidence: recognition.confidence,

      posterUrl,
      poster: posterUrl,
      poster_path:
        primaryMatch?.poster_path || null,

      overview:
        primaryMatch?.overview || null,

      movieId:
        primaryMatch?.id || null,

      verified: false,
      model: recognition.model,
      fallbackUsed: recognition.fallbackUsed,

      searchGrounded:
        Boolean(google?.grounded),

      sources:
        google?.sources || [],

      metadataProvider:
        amodbKey ? "AMODB" : null,

      metadataMatches
    });
  } catch (error) {
    console.error(
      "SceneFinder unexpected error:",
      error?.message
    );

    return send(res, 500, {
      error:
        "SceneFinder encountered an unexpected error."
    });
  }
}
