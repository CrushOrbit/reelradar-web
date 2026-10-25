
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

    const response = await fetch(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text:
                "You are ReelRadar SceneFinder. Analyze screenshots " +
                "from movies and television shows worldwide. " +
                "Suggest up to three possible titles. " +
                "Do not identify real people from their faces. " +
                "Use visual clues such as setting, costumes, " +
                "subtitles, text and objects. " +
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
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "SceneFinder Gemini error:",
        response.status,
        data?.error?.status,
        data?.error?.message
      );

      return res.status(502).json({
        error:
          response.status === 429
            ? "SceneFinder is busy or has reached its AI usage limit. Please try again later."
            : "SceneFinder AI is temporarily unavailable."
      });
    }

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
    console.error("SceneFinder error:", error.message);

    return res.status(500).json({
      error: "Unable to analyze this screenshot."
    });
  }
}
