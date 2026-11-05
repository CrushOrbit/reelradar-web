
const PRIMARY_MODEL = "gemini-3.5-flash-lite";
const BACKUP_MODEL = "gemini-3.8-flash";

const TIMEOUT_MS = 18000;
const RETRY_DELAYS = [1000, 2000];

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

function getText(data) {
  return (data?.candidates || [])
    .flatMap((c) => c?.content?.parts || [])
    .filter((p) => typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function getSources(data) {
  const chunks =
    data?.candidates?.[0]?.groundingMetadata
      ?.groundingChunks || [];

  return chunks
    .map((chunk) => ({
      title: chunk?.web?.title || "",
      url: chunk?.web?.uri || "",
    }))
    .filter((source) =>
      /^https?:\/\//.test(source.url)
    )
    .slice(0, 5);
}

function getImage(image) {
  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!match) return null;

  return {
    mime_type:
      match[1] === "image/jpg"
        ? "image/jpeg"
        : match[1],
    data: match[2].replace(/\s/g, ""),
  };
}

async function callModel(model, imageData, clues, key) {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    TIMEOUT_MS
  );

  const prompt = [
    "You are SceneFinder for ReelRadar.",
    "Identify the movie, television series, or drama",
    "shown in the supplied screenshot.",
    "",
    "Analyze visible actors, characters, setting,",
    "costumes, objects, subtitles, and other clues.",
    "",
    "Use Google Search when helpful to check the",
    "proposed title, release year, cast, or production.",
    "",
    "Important rules:",
    "- Never invent a movie title or release year.",
    "- Do not claim a visual match is confirmed",
    "  merely because a title exists online.",
    "- Distinguish real scenes from promotional art.",
    "- If uncertain, explain the uncertainty.",
    "- Give alternative candidates when appropriate.",
    "- Keep the answer concise and useful.",
    "",
    "Respond with:",
    "Title: most likely title",
    "Year: release year if known",
    "Explanation: brief reasoning",
    "Confidence: high, medium, or low",
    "",
    clues ? `User clues: ${clues}` : "",
  ].join("\n");

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key,
        },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                { inline_data: imageData },
              ],
            },
          ],
          tools: [
            { google_search: {} },
          ],
          generationConfig: {
            temperature: 0.2,
            maxOutputTokens: 1000,
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
        "Unknown Gemini error";

      console.error(
        `SceneFinder ${model}: ${response.status} ${message.slice(0, 300)}`
      );

      return {
        success: false,
        status: response.status,
        retryable: [
          429, 500, 502, 503, 504,
        ].includes(response.status),
      };
    }

    const answer = getText(data);

    if (!answer) {
      console.warn(
        `SceneFinder ${model}: empty response`
      );

      return {
        success: false,
        retryable: true,
      };
    }

    const metadata =
      data?.candidates?.[0]?.groundingMetadata;

    return {
      success: true,
      answer,
      model,
      sources: getSources(data),
      searchGrounded: Boolean(
        metadata?.webSearchQueries?.length ||
        metadata?.groundingChunks?.length
      ),
      searchEntryPoint:
        metadata?.searchEntryPoint?.renderedContent ||
        null,
    };
  } catch (error) {
    console.error(
      `SceneFinder ${model} exception:`,
      error?.message
    );

    return {
      success: false,
      retryable: true,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function tryModel(model, imageData, clues, key) {
  for (
    let attempt = 0;
    attempt <= RETRY_DELAYS.length;
    attempt++
  ) {
    console.log(
      `SceneFinder ${model} attempt ${attempt + 1}`
    );

    const result = await callModel(
      model,
      imageData,
      clues,
      key
    );

    if (result.success) return result;

    // Do not repeatedly retry exhausted quotas.
    if (result.status === 429) {
      console.warn(
        `SceneFinder ${model}: quota/rate limit`
      );
      return result;
    }

    if (!result.retryable) return result;

    if (attempt < RETRY_DELAYS.length) {
      await sleep(RETRY_DELAYS[attempt]);
    }
  }

  return {
    success: false,
    retryable: true,
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
    return res.status(405).json({
      error: "Method not allowed",
    });
  }

  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: "SceneFinder API key missing",
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
        error: "Screenshot required",
      });
    }

    if (typeof clues !== "string") {
      return res.status(400).json({
        error: "Invalid clues",
      });
    }

    if (
      image.length > 6000000 ||
      clues.length > 1000
    ) {
      return res.status(413).json({
        error: "Screenshot or clues too large",
      });
    }

    const imageData = getImage(image);

    if (!imageData) {
      return res.status(400).json({
        error: "Unsupported screenshot format",
      });
    }

    // Primary: Gemini Flash-Lite.
    const primary = await tryModel(
      PRIMARY_MODEL,
      imageData,
      clues,
      key
    );

    if (primary.success) {
      console.log(
        "SceneFinder primary succeeded",
        PRIMARY_MODEL,
        "grounded:",
        primary.searchGrounded
      );

      return res.status(200).json({
        success: true,
        answer: primary.answer,
        verified: false,
        model: primary.model,
        fallbackUsed: false,
        searchGrounded: primary.searchGrounded,
        sources: primary.sources,
        searchEntryPoint: primary.searchEntryPoint,
      });
    }

    if (!primary.retryable) {
      return res.status(502).json({
        error: "SceneFinder request failed",
      });
    }

    console.warn(
      "SceneFinder switching to backup model"
    );

    // Backup: Gemini 3.8 Flash.
    const backup = await tryModel(
      BACKUP_MODEL,
      imageData,
      clues,
      key
    );

    if (backup.success) {
      console.log(
        "SceneFinder backup succeeded",
        BACKUP_MODEL,
        "grounded:",
        backup.searchGrounded
      );

      return res.status(200).json({
        success: true,
        answer: backup.answer,
        verified: false,
        model: backup.model,
        fallbackUsed: true,
        searchGrounded: backup.searchGrounded,
        sources: backup.sources,
        searchEntryPoint: backup.searchEntryPoint,
      });
    }

    console.error(
      "SceneFinder both models failed",
      primary.status,
      backup.status
    );

    return res.status(503).json({
      error:
        "SceneFinder AI is currently busy. Please try again shortly.",
    });
  } catch (error) {
    console.error(
      "SceneFinder handler error:",
      error?.message
    );

    return res.status(500).json({
      error: "SceneFinder encountered an error",
    });
  }
}
