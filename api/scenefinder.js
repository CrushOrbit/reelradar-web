
const MODEL = "gemini-3.5-flash-lite";

const API_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;
const COOLDOWN_MS = 60000;
const MAX_IMAGE_LENGTH = 6000000;
const AMODB_TIMEOUT_MS = 6000;

let cooldownUntil = 0;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

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
    data: base64,
  };
}

function createPrompt(clues) {
  return `
You are ReelRadar SceneFinder.

Identify the movie or television series shown
in the uploaded image.

Carefully examine:
- Visible titles and written text
- Actors and characters
- Clothing and costumes
- Locations and scenery
- Subtitles and dialogue
- Distinctive visual details

Distinguish promotional posters from screenshots.

Do not invent titles, actors, years, or plots.

If uncertain, say so.

Return ONLY valid JSON in this format:

{
  "candidates": [
    {
      "title": "Possible title",
      "year": 2024,
      "type": "movie",
      "reason": "Specific visible evidence"
    }
  ],
  "confidence": "Low",
  "visualEvidence": "What is visible in the image"
}

Rules:
- Suggest at most three candidates.
- Type must be "movie" or "tv".
- Year may be null.
- Confidence must be High, Medium, or Low.
- Do not claim external verification.
- Visible poster text identifies the poster,
  not necessarily a scene from the production.

Additional clues: ${clues || "None"}
`;
}

function extractText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) =>
      candidate?.content?.parts || []
    )
    .filter((part) =>
      typeof part?.text === "string"
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function parseRecognition(text) {
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "")
      .trim();

    const data = JSON.parse(cleaned);

    const candidates = (
      Array.isArray(data.candidates)
        ? data.candidates
        : []
    )
      .filter(
        (candidate) =>
          candidate &&
          typeof candidate.title === "string" &&
          candidate.title.trim()
      )
      .slice(0, 3)
      .map((candidate) => ({
        title: candidate.title.trim().slice(0, 150),
        year:
          Number.isInteger(candidate.year) &&
          candidate.year >= 1880 &&
          candidate.year <= 2100
            ? candidate.year
            : null,
        type:
          candidate.type === "tv"
            ? "tv"
            : "movie",
        reason:
          typeof candidate.reason === "string"
            ? candidate.reason.slice(0, 350)
            : "",
      }));

    return {
      candidates,
      confidence:
        ["High", "Medium", "Low"].includes(
          data.confidence
        )
          ? data.confidence
          : "Low",
      visualEvidence:
        typeof data.visualEvidence === "string"
          ? data.visualEvidence.slice(0, 500)
          : "",
    };
  } catch {
    return null;
  }
}

async function callGemini(imageData, clues, apiKey) {
  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    API_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: createPrompt(clues) },
                { inline_data: imageData },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 1100,
            responseMimeType: "application/json",
          },
        }),
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      console.error(
        `SceneFinder Gemini ${response.status}:`,
        String(
          data?.error?.message || "API error"
        ).slice(0, 250)
      );

      return {
        success: false,
        status: response.status,
        retryable: [
          500, 502, 503, 504,
        ].includes(response.status),
      };
    }

    const recognition = parseRecognition(
      extractText(data)
    );

    if (!recognition) {
      return {
        success: false,
        status: 502,
        retryable: false,
      };
    }

    return {
      success: true,
      recognition,
    };
  } catch (error) {
    const timedOut =
      error?.name === "AbortError";

    console.error(
      "SceneFinder Gemini connection:",
      timedOut
        ? "timeout"
        : error?.message
    );

    return {
      success: false,
      status: timedOut ? 504 : 502,
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function identifyScene(imageData, clues, apiKey) {
  for (
    let attempt = 1;
    attempt <= MAX_ATTEMPTS;
    attempt++
  ) {
    const result = await callGemini(
      imageData,
      clues,
      apiKey
    );

    if (result.success) {
      return result;
    }

    if (result.status === 429) {
      cooldownUntil =
        Date.now() + COOLDOWN_MS;

      return {
        success: false,
        status: 429,
      };
    }

    if (
      !result.retryable ||
      attempt === MAX_ATTEMPTS
    ) {
      return result;
    }

    await sleep(RETRY_DELAY_MS);
  }

  return {
    success: false,
    status: 503,
  };
}

function normalize(value) {
  return String(value || "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

async function lookupAmodb(candidate, apiKey) {
  if (!apiKey) return null;

  const url = new URL(
    `https://api.amodb.dev/3/search/${candidate.type}`
  );

  url.searchParams.set(
    "query",
    candidate.title
  );

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    AMODB_TIMEOUT_MS
  );

  try {
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(
        `SceneFinder AMODB ${candidate.type}: HTTP ${response.status}`
      );
      return null;
    }

    const data = await response.json();

    const results = Array.isArray(data?.results)
      ? data.results.slice(0, 20)
      : [];

    const exact = results.filter((item) =>
      [
        item.title,
        item.name,
        item.original_title,
        item.original_name,
      ].some(
        (name) =>
          normalize(name) ===
          normalize(candidate.title)
      )
    );

    if (!exact.length) return null;

    const scored = exact
      .map((item) => {
        const releaseDate =
          item.release_date ||
          item.first_air_date ||
          "";

        const year = /^\d{4}/.test(releaseDate)
          ? Number(releaseDate.slice(0, 4))
          : null;

        const difference =
          candidate.year && year
            ? Math.abs(candidate.year - year)
            : null;

        return {
          item,
          year,
          difference,
          score:
            difference === null
              ? 1
              : difference === 0
                ? 4
                : difference === 1
                  ? 2
                  : 0,
        };
      })
      .sort((a, b) => b.score - a.score)[0];

    if (
      scored.difference !== null &&
      scored.difference > 1
    ) {
      return null;
    }

    return {
      id: scored.item.id,
      title:
        scored.item.title ||
        scored.item.name ||
        candidate.title,
      year: scored.year,
      type: candidate.type,
      overview: String(
        scored.item.overview || ""
      ).slice(0, 280),
      poster_path:
        scored.item.poster_path || null,
    };
  } catch (error) {
    console.warn(
      "SceneFinder AMODB lookup failed:",
      error?.name === "AbortError"
        ? "timeout"
        : error?.message
    );

    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function formatAnswer(
  recognition,
  matches,
  metadataEnabled
) {
  const lines = [];

  const best = recognition.candidates[0];

  if (!best) {
    return (
      "No reliable title could be identified " +
      "from this image. Try a clearer screenshot " +
      "or add a scene clue."
    );
  }

  const matched = matches[0];

  lines.push(
    `Title: ${matched?.title || best.title}`
  );

  lines.push(
    `Year: ${matched?.year || best.year || "Unknown"}`
  );

  lines.push(
    `Confidence: ${recognition.confidence} (AI visual estimate)`
  );

  lines.push(
    `Database check: ${
      matched
        ? "Matching title found in AMODB; scene not verified"
        : metadataEnabled
          ? "No matching title confirmed; scene not verified"
          : "Unavailable; scene not verified"
    }`
  );

  if (recognition.visualEvidence) {
    lines.push(
      `Visible evidence: ${recognition.visualEvidence}`
    );
  }

  if (best.reason) {
    lines.push(
      `Explanation: ${best.reason}`
    );
  }

  if (recognition.candidates.length > 1) {
    lines.push(
      "Other possibilities: " +
      recognition.candidates
        .slice(1)
        .map((candidate) => candidate.title)
        .join("; ")
    );
  }

  return lines.join("\n");
}

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
      error: "Method not allowed",
    });
  }

  const geminiKey =
    process.env.GEMINI_API_KEY;

  if (!geminiKey) {
    return send(res, 503, {
      error: "SceneFinder is not configured",
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
        "SceneFinder is temporarily rate-limited. Please try again shortly.",
    });
  }

  try {
    let body = req.body;

    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, {
          error: "Invalid request body",
        });
      }
    }

    const {
      image,
      clues = "",
    } = body || {};

    if (typeof clues !== "string") {
      return send(res, 400, {
        error: "Invalid scene clues",
      });
    }

    if (clues.length > 1000) {
      return send(res, 400, {
        error: "Scene clues are too long",
      });
    }

    const imageData = parseImage(image);

    if (imageData?.tooLarge) {
      return send(res, 413, {
        error:
          "Screenshot is too large. Please use a smaller image.",
      });
    }

    if (!imageData) {
      return send(res, 400, {
        error:
          "Please upload a valid JPG, PNG, or WebP screenshot.",
      });
    }

    const result = await identifyScene(
      imageData,
      clues,
      geminiKey
    );

    if (!result.success) {
      return send(
        res,
        result.status === 429 ? 429 : 503,
        {
          error:
            result.status === 429
              ? "SceneFinder has reached a temporary AI usage limit. Please try again later."
              : "SceneFinder AI is temporarily unavailable. Please try again shortly.",
        }
      );
    }

    const candidates =
      result.recognition.candidates;

    const amodbKey =
      process.env.AMODB_API_KEY;

    const matches = await Promise.all(
      candidates.map((candidate) =>
        lookupAmodb(candidate, amodbKey)
      )
    );

    const answer = formatAnswer(
      result.recognition,
      matches,
      Boolean(amodbKey)
    );

    return send(res, 200, {
      success: true,
      answer,
      verified: false,
      model: MODEL,
      fallbackUsed: false,
      searchGrounded: false,
      sources: [],
      metadataMatches:
        matches.filter(Boolean),
      metadataProvider:
        amodbKey ? "AMODB" : null,
    });
  } catch (error) {
    console.error(
      "SceneFinder unexpected error:",
      error?.message
    );

    return send(res, 500, {
      error:
        "SceneFinder encountered an unexpected error.",
    });
  }
}
