
export default async function handler(req, res) {
  const apiKey = process.env.AMODB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "AMODB API key not configured"
    });
  }

  const type = String(req.query.type || "now_playing");
  const allowed = ["now_playing", "upcoming"];

  if (!allowed.includes(type)) {
    return res.status(400).json({
      error: "Invalid type"
    });
  }

  try {
    const url = new URL(
      `https://api.amodb.dev/3/movie/${type}`
    );

    url.searchParams.set("language", "en-US");
    url.searchParams.set("page", "1");
    url.searchParams.set("region", "US");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({
      error: "Unable to load movie listings"
    });
  }
}
