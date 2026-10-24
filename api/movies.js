
export default async function handler(req, res) {
  const apiKey = process.env.AMODB_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      error: "AMODB API key not configured"
    });
  }

  const query = String(req.query.query || "").trim();
  const action = String(req.query.action || "search").toLowerCase();
  const id = String(req.query.id || "").trim();
  const type = String(req.query.type || "movie").toLowerCase();
  const season = String(req.query.season || "1").trim();

  const baseURL = "https://api.amodb.dev/3";

  let endpoint;

  if (action === "search") {
    if (!query) {
      return res.status(400).json({
        error: "Search query required"
      });
    }

    endpoint = "/search/multi";
  } else if (action === "details" || action === "credits") {
    if (!/^\d+$/.test(id)) {
      return res.status(400).json({
        error: "Valid title ID required"
      });
    }

    if (!["movie", "tv"].includes(type)) {
      return res.status(400).json({
        error: "Invalid media type"
      });
    }

    endpoint = `/${type}/${id}`;
  } else if (action === "season") {
    if (!/^\d+$/.test(id) || !/^\d+$/.test(season)) {
      return res.status(400).json({
        error: "Valid series ID and season required"
      });
    }

    endpoint = `/tv/${id}/season/${season}`;
  } else {
    return res.status(400).json({
      error: "Unsupported action"
    });
  }

  try {
    const url = new URL(baseURL + endpoint);

    url.searchParams.set("language", "en-US");

    if (action === "search") {
      url.searchParams.set("query", query);
    }

    if (action === "details" || action === "credits") {
      url.searchParams.set(
        "append_to_response",
        "credits,videos,external_ids,release_dates,content_ratings"
      );
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json"
      }
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: "AMODB request failed",
        details: data?.status_message || data?.error || null
      });
    }

    if (action === "credits") {
      return res.status(200).json({
        id: data.id,
        cast: data.credits?.cast || [],
        crew: data.credits?.crew || []
      });
    }

    return res.status(200).json(data);
  } catch (error) {
    console.error("ReelRadar AMODB error:", error.message);

    return res.status(500).json({
      error: "Unable to retrieve movie information"
    });
  }
}
