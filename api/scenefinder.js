
const PRIMARY_MODEL = "gemini-3.8-flash";
const BACKUP_MODEL = "gemini-3.5-flash-lite";

const RETRY_DELAYS = [1000, 2000];
const REQUEST_TIMEOUT_MS = 18000;

const wait = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function extractText(data) {
  return (data?.candidates || [])
    .flatMap((candidate) => candidate?.content?.parts || [])
    .filter((part) => typeof part?.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

async function callGemini(model, image, clues, apiKey) {
  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!match) {
    return {
      success: false,
      retryable: false,
      status: 400,
      error: "Invalid image format",
    };
  }

  const mimeType =
    match[1] === "image/jpg" ? "image/jpeg" : match[1];

  const prompt = [
    "You are SceneFinder, a movie and television scene identification assistant.",
    "Analyze this screenshot and identify the most likely movie or TV show.",
    "Use actors, clothing, setting, visual clues, and any visible text.",
    "Do not claim certainty when the image is ambiguous.",
    "If you cannot identify it reliably, provide plausible candidates.",
    "Respond clearly with the likely title, year if known, and a short explanation.",
    clues ? `Additional user clues: ${clues}` : "",
  ].filter(Boolean).join("\n");

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: mimeType,
                    data: match[2].replace(/\s/g, ""),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 700,
          },
        }),
        signal: controller.signal,
      }
    );

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      const message =
        data?.error?.message || "Unknown Gemini error";

      console.error(
        `SceneFinder ${model}: ${response.status} ${message.slice(0, 400)}`
      );

      return {
        success: false,
        status: response.status,
        retryable: [429, 500, 502, 503, 504].includes(
          response.status
        ),
        error: message,
      };
    }

    const answer = extractText(data);

    if (!answer) {
      console.error(`SceneFinder ${model}: Empty response`);
      return {
        success: false,
        retryable: true,
        error: "No identification returned",
      };
    }

    return {
      success: true,
      answer,
      model,
    };
  } catch (error) {
    console.error(
      `SceneFinder ${model} request failed:`,
      error?.message
    );

    return {
      success: false,
      retryable: true,
      error:
        error?.name === "AbortError"
          ? "AI request timed out"
          : "AI connection failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function tryModel(model, image, clues, apiKey) {
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    console.log(
      `SceneFinder ${model} attempt ${attempt + 1}`
    );

    const result = await callGemini(
      model,
      image,
      clues,
      apiKey
    );

    if (result.success) return result;

    if (!result.retryable) return result;

    // Quota exhaustion: switch models rather than retrying
    // the same model repeatedly.
    if (result.status === 429) {
      console.warn(
        `SceneFinder ${model}: quota/rate limit; switching`
      );
      return result;
    }

    if (attempt < RETRY_DELAYS.length) {
      const delay = RETRY_DELAYS[attempt];
      console.log(
        `SceneFinder ${model} retrying in ${delay}ms`
      );
      await wait(delay);
    }
  }

  return {
    success: false,
    retryable: true,
    error: "Model unavailable after retries",
  };
}

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
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    console.error("SceneFinder: GEMINI_API_KEY missing");
    return res.status(503).json({
      error: "SceneFinder is not configured",
    });
  }

  try {
    let body = req.body;

    if (typeof body === "string") {
      body = JSON.parse(body);
    }

    const { image, clues = "" } = body || {};

    if (typeof image !== "string") {
      return res.status(400).json({
        error: "Please upload a screenshot",
      });
    }

    if (typeof clues !== "string") {
      return res.status(400).json({
        error: "Invalid clues",
      });
    }

    if (image.length > 6_000_000) {
      return res.status(413).json({
        error: "Image too large. Use a smaller screenshot.",
      });
    }

    if (clues.length > 1000) {
      return res.status(400).json({
        error: "Clues are too long",
      });
    }

    if (
      !/^data:image\/(?:jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/.test(
        image
      )
    ) {
      return res.status(400).json({
        error: "Unsupported image format",
      });
    }

    // First try Gemini 3.8 Flash.
    const primary = await tryModel(
      PRIMARY_MODEL,
      image,
      clues,
      apiKey
    );

    if (primary.success) {
      console.log("SceneFinder primary succeeded");
      return res.status(200).json({
        success: true,
        answer: primary.answer,
        verified: false,
        model: primary.model,
        fallbackUsed: false,
      });
    }

    // Do not use a fallback for permanent request errors.
    if (!primary.retryable) {
      return res.status(502).json({
        error: "SceneFinder AI request failed",
      });
    }

    console.warn("SceneFinder switching to backup model");

    // Try the cheaper Gemini 3.5 Flash-Lite.
    const backup = await tryModel(
      BACKUP_MODEL,
      image,
      clues,
      apiKey
    );

    if (backup.success) {
      console.log("SceneFinder backup succeeded");
      return res.status(200).json({
        success: true,
        answer: backup.answer,
        verified: false,
        model: backup.model,
        fallbackUsed: true,
      });
    }

    console.error(
      "SceneFinder: both models unavailable",
      primary.status,
      backup.status
    );

    return res.status(503).json({
      error:
        "SceneFinder AI is currently unavailable. Please try again shortly.",
    });
  } catch (error) {
    console.error("SceneFinder handler error:", error?.message);

    return res.status(500).json({
      error: "SceneFinder encountered an unexpected error",
    });
  }
}
