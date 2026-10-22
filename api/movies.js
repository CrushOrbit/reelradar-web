
export default async function handler(req, res) {
  const apiKey = process.env.AMODB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured" });
  }

  const query = String(req.query.query || "").trim();

  if (!query) {
    return res.status(400).json({ error: "Search query required" });
  }

  try {
    const url = new URL("https://api.amodb.dev/3/search/multi");
    url.searchParams.set("query", query);
    url.searchParams.set("language", "en-US");

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    return res.status(500).json({ error: "Movie search failed" });
  }
}
