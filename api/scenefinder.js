
const MODEL = "gemini-3.8-flash";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

const MAX_ATTEMPTS = 3;
const REQUEST_TIMEOUT_MS = 20000;

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function callGemini(apiKey, payload) {
  let lastStatus = 503;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS
    );

    try {
      const response = await fetch(GEMINI_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      const raw = await response.text();

      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        data = {};
      }

      if (response.ok) {
        return { success: true, data };
      }

      lastStatus = response.status;

      console.error(
        "SceneFinder Gemini error:",
        response.status,
        data?.error?.status || "UNKNOWN",
        data?.error?.message || "No details",
        `Attempt ${attempt}/${MAX_ATTEMPTS}`
      );

      const retryable = [429, 500, 502, 503, 504]
        .includes(response.status);

      if (!retryable) {
        return {
          success: false,
          status: response.status
        };
      }

    } catch (error) {
      lastStatus = 503;

      console.error(
        "SceneFinder network error:",
        error?.message || "Unknown error",
        `Attempt ${attempt}/${MAX_ATTEMPTS}`
      );
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < MAX_ATTEMPTS) {
      const delay = 1000 * Math.pow(2, attempt - 1);

      console.log(
        `SceneFinder retrying in ${delay}ms`
      );

      await sleep(delay);
    }
  }

  return {
    success: false,
    status: lastStatus
  };
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "SceneFinder Gemini API is not configured."
      });
    }

    const { image, clues = "" } = req.body || {};

    const match =
      typeof image === "string" &&
      image.match(
        /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/
      );

    if (!match) {
      return res.status(400).json({
        error: "Please upload a JPEG, PNG or WebP screenshot."
      });
    }

    if (image.length > 11_000_000) {
      return res.status(413).json({
        error: "Image is too large. Maximum size is 8 MB."
      });
    }

    const mimeType = `image/${match[1]}`;
    const base64Image = match[2];

    const payload = {
      systemInstruction: {
        parts: [{
          text:
            "You are ReelRadar SceneFinder. " +
            "Analyze screenshots from movies and television " +
            "shows worldwide. Suggest up to three possible " +
            "titles. Do not identify real people from faces. " +
            "Use visual clues including costumes, locations, " +
            "subtitles, dialogue, text and objects. " +
            "Consider Hollywood, Bollywood, Korean dramas, " +
            "Chinese dramas, African cinema and other " +
            "international productions. " +
            "Never claim certainty without sufficient evidence. " +
            "If evidence is insufficient, say so. " +
            "Respond concisely."
        }]
      },

      contents: [{
        role: "user",
        parts: [
          {
            text:
              "Identify possible movie or TV show matches " +
              "for this screenshot. Include international " +
              "films and series when relevant. Clues: " +
              String(clues).slice(0, 1000)
          },
          {
            inline_data: {
              mime_type: mimeType,
              data: base64Image
            }
          }
        ]
      }],

      generationConfig: {
        maxOutputTokens: 450,
        temperature: 0.2
      }
    };

    const result = await callGemini(apiKey, payload);

    if (!result.success) {
      const status = result.status;

      if ([429, 500, 502, 503, 504].includes(status)) {
        return res.status(503).json({
          error:
            "SceneFinder AI is currently busy. " +
            "Automatic retries were unsuccessful. " +
            "Please try again shortly."
        });
      }

      return res.status(502).json({
        error:
          "SceneFinder AI could not process this request. " +
          "Please try again later."
      });
    }

    const data = result.data;

    const answer = (data.candidates || [])
      .flatMap(candidate => candidate.content?.parts || [])
      .filter(part => typeof part.text === "string")
      .map(part => part.text)
      .join("\n")
      .trim();

    return res.status(200).json({
      success: true,
      answer: answer || "No confident match found.",
      verified: false
    });

  } catch (error) {
    console.error(
      "SceneFinder error:",
      error?.message || "Unknown error"
    );

    return res.status(500).json({
      error: "Unable to analyze this screenshot."
    });
  }
}
