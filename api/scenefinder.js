
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "POST") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  try {
    const apiKey = process.env.OPENAI_API_KEY;

    if (!apiKey) {
      return res.status(503).json({
        error: "SceneFinder AI is not configured."
      });
    }

    const { image, clues = "" } = req.body || {};

    if (
      typeof image !== "string" ||
      !/^data:image\/(jpeg|png|webp);base64,/.test(image)
    ) {
      return res.status(400).json({
        error: "Please upload a JPEG, PNG or WebP screenshot."
      });
    }

    if (image.length > 11_000_000) {
      return res.status(413).json({
        error: "Image is too large. Maximum size is 8 MB."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/responses",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          max_output_tokens: 450,
          input: [
            {
              role: "system",
              content:
                "You are ReelRadar SceneFinder. Analyze screenshots from movies and television shows. Suggest up to three possible titles. Do not claim certainty when uncertain. Do not identify real people from their faces. Use visual clues such as setting, costumes, text and objects, together with the user's written clues. If evidence is insufficient, say so. Respond concisely."
            },
            {
              role: "user",
              content: [
                {
                  type: "input_text",
                  text:
                    "Find possible movie or TV series matches. Clues: " +
                    String(clues).slice(0, 1000)
                },
                {
                  type: "input_image",
                  image_url: image,
                  detail: "low"
                }
              ]
            }
          ]
        })
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error(
        "SceneFinder OpenAI error:",
        response.status,
        data?.error?.code
      );

      return res.status(502).json({
        error: "SceneFinder AI is temporarily unavailable."
      });
    }

    const answer =
      data.output_text ||
      (data.output || [])
        .flatMap(item => item.content || [])
        .filter(item => item.type === "output_text")
        .map(item => item.text)
        .join("\n");

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
