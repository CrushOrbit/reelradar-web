
const MODEL = "gemini-3.5-flash-lite";

const API_TIMEOUT_MS = 20000;
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;
const COOLDOWN_MS = 60000;
const MAX_IMAGE_LENGTH = 6000000;

// Best-effort cooldown within a warm Vercel instance.
// This is not shared across instances or deployments.
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

  const mimeType =
    match[1] === "image/jpg"
      ? "image/jpeg"
      : match[1];

  const base64 = match[2].replace(/\s/g, "");

  if (!base64 || base64.length % 4 !== 0) {
    return null;
  }

  return {
    mime_type: mimeType,
    data: base64,
  };
}

function extractAnswer(data) {
  const candidates = data?.candidates || [];

  return candidates
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

function createPrompt(clues) {
  return [
    "You are ReelRadar SceneFinder.",
    "Your task is to identify the movie, television",
    "series, or drama shown in the supplied screenshot.",
    "",
    "Carefully examine:",
    "- Visible actors and characters",
    "- Clothing and costumes",
    "- Location and scenery",
    "- Objects and distinctive visual details",
    "- Subtitles, dialogue, and visible text",
    "- Cinematography and production style",
    "",
    "Important rules:",
    "- Do not invent movie or television titles.",
    "- Do not invent actors, release years, or plots.",
    "- Distinguish screenshots from promotional art.",
    "- If the identification is uncertain, say so.",
    "- If useful, suggest up to three possible matches.",
    "- Do not claim external verification.",
    "",
    "Provide:",
    "Title: Most likely title",
    "Year: Release year if reasonably known",
    "Confidence: High, Medium, or Low",
    "Explanation: Brief reasoning based on the image",
    "",
    clues ? `Additional user clues: ${clues}` : "",
  ].join("\n");
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
                {
                  text: createPrompt(clues),
                },
                {
                  inline_data: imageData,
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 800,
          },
        }),
      }
    );

    const data = await response
      .json()
      .catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message ||
        "Unknown Gemini API error";

      console.error(
        `SceneFinder ${MODEL}: ${response.status} ${message.slice(0, 350)}`
      );

      return {
        success: false,
        status: response.status,
        retryable: [
          500, 502, 503, 504,
        ].includes(response.status),
        error: message,
      };
    }

    const answer = extractAnswer(data);

    if (!answer) {
      console.warn(
        `SceneFinder ${MODEL}: empty response`
      );

      return {
        success: false,
        status: 502,
        retryable: false,
        error: "No identification returned",
      };
    }

    return {
      success: true,
      answer,
    };
  } catch (error) {
    const timedOut =
      error?.name === "AbortError";

    console.error(
      `SceneFinder ${MODEL}:`,
      timedOut
        ? "Request timed out"
        : error?.message
    );

    return {
      success: false,
      status: timedOut ? 504 : 502,
      retryable: true,
      error: timedOut
        ? "AI request timed out"
        : "AI connection failed",
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
    console.log(
      `SceneFinder ${MODEL} attempt ${attempt}/${MAX_ATTEMPTS}`
    );

    const result = await callGemini(
      imageData,
      clues,
      apiKey
    );

    if (result.success) {
      console.log(
        `SceneFinder ${MODEL} succeeded`
      );

      return result;
    }

    // Quota errors must not trigger more requests.
    if (result.status === 429) {
      cooldownUntil =
        Date.now() + COOLDOWN_MS;

      console.warn(
        "SceneFinder quota/rate limit detected; cooldown activated"
      );

      return {
        success: false,
        status: 429,
        error:
          "SceneFinder has reached a temporary AI usage limit. Please try again later.",
      };
    }

    if (!result.retryable) {
      return result;
    }

    if (attempt < MAX_ATTEMPTS) {
      console.log(
        `SceneFinder retrying in ${RETRY_DELAY_MS}ms`
      );

      await sleep(RETRY_DELAY_MS);
    } else {
      return result;
    }
  }

  return {
    success: false,
    status: 503,
    error: "SceneFinder is temporarily unavailable",
  };
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
      error: "Method not allowed",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error(
      "SceneFinder GEMINI_API_KEY missing"
    );

    return send(res, 503, {
      error: "SceneFinder is not configured",
    });
  }

  // Avoid additional Gemini requests during cooldown.
  if (Date.now() < cooldownUntil) {
    const seconds = Math.ceil(
      (cooldownUntil - Date.now()) / 1000
    );

    res.setHeader(
      "Retry-After",
      String(seconds)
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

    const { image, clues = "" } = body || {};

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
      apiKey
    );

    if (result.success) {
      return send(res, 200, {
        success: true,
        answer: result.answer,
        verified: false,
        model: MODEL,
        fallbackUsed: false,
        searchGrounded: false,
        sources: [],
      });
    }

    return send(
      res,
      result.status === 429
        ? 429
        : 503,
      {
        error:
          result.status === 429
            ? result.error
            : "SceneFinder AI is temporarily unavailable. Please try again shortly.",
      }
    );
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
