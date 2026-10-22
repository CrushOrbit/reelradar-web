
export default async function handler(req, res) {
  const apiKey = process.env.AMODB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "API key not configured" });
  }

  const type = String(req.query.type || "movie");
  const id = String(req.query.id || "");
  const country = String(req.query.country || "US").toUpperCase();

  if (!["movie", "tv"].includes(type) || !/^\d+$/.test(id)) {
    return res.status(400).json({ error: "Invalid movie or TV ID" });
  }

  if (!/^[A-Z]{2}$/.test(country)) {
    return res.status(400).json({ error: "Invalid country code" });
  }

  try {
    const url = `https://api.amodb.dev/3/${type}/${id}/watch/providers`;

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "Provider lookup failed"
      });
    }

    return res.status(200).json({
      id,
      country,
      providers: data.results?.[country] || null
    });
  } catch (error) {
    return res.status(500).json({
      error: "Unable to retrieve streaming providers"
    });
  }
}
