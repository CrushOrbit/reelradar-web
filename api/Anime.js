
const JIKAN = "https://api.jikan.moe/v4";
const ANILIST = "https://graphql.anilist.co";

const categories = {
  trending: { jikan: "/seasons/now", sort: "TRENDING_DESC" },
  popular: { jikan: "/top/anime?filter=bypopularity", sort: "POPULARITY_DESC" },
  top: { jikan: "/top/anime", sort: "SCORE_DESC" },
  movies: { jikan: "/top/anime?type=movie", sort: "SCORE_DESC", format: "MOVIE" },
  upcoming: { jikan: "/seasons/upcoming", sort: "POPULARITY_DESC", status: "NOT_YET_RELEASED" },
  romance: { jikan: "/anime?genres=22&order_by=popularity", sort: "POPULARITY_DESC", genre: "Romance" },
  action: { jikan: "/anime?genres=1&order_by=popularity", sort: "POPULARITY_DESC", genre: "Action" },
  fantasy: { jikan: "/anime?genres=10&order_by=popularity", sort: "POPULARITY_DESC", genre: "Fantasy" }
};

async function fetchJSON(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(9000)
  });

  if (!response.ok) {
    throw new Error(`Provider HTTP ${response.status}`);
  }

  return response.json();
}

function fromJikan(item) {
  return {
    id: `jikan:${item.mal_id}`,
    provider: "jikan",
    providerId: item.mal_id,
    title: item.title_english || item.title || "",
    originalTitle: item.title_japanese || "",
    year: item.year || item.aired?.prop?.from?.year || null,
    type: item.type === "Movie" ? "movie" : "tv",
    posterUrl: item.images?.jpg?.large_image_url ||
      item.images?.jpg?.image_url || null,
    overview: item.synopsis || "",
    rating: item.score || null,
    episodes: item.episodes || null,
    genres: (item.genres || []).map(g => g.name),
    sourceUrl: item.url || null
  };
}

function fromAniList(item) {
  return {
    id: `anilist:${item.id}`,
    provider: "anilist",
    providerId: item.id,
    title: item.title?.english || item.title?.romaji || "",
    originalTitle: item.title?.native || "",
    year: item.seasonYear || item.startDate?.year || null,
    type: item.format === "MOVIE" ? "movie" : "tv",
    posterUrl: item.coverImage?.extraLarge ||
      item.coverImage?.large || null,
    overview: (item.description || "")
      .replace(/<[^>]*>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
    rating: item.averageScore
      ? item.averageScore / 10
      : null,
    episodes: item.episodes || null,
    genres: item.genres || [],
    sourceUrl: item.siteUrl || null
  };
}

async function loadJikan(category, page) {
  const spec = categories[category];
  const separator = spec.jikan.includes("?") ? "&" : "?";
  const url = `${JIKAN}${spec.jikan}${separator}page=${page}&limit=24&sfw=true`;

  const data = await fetchJSON(url);
  return (data.data || [])
    .filter(item => !item.explicit_genres?.length)
    .map(fromJikan);
}

async function loadAniList(category, page) {
  const spec = categories[category];

  const query = `
    query ($page: Int, $sort: [MediaSort],
           $format: MediaFormat, $status: MediaStatus,
           $genre: String) {
      Page(page: $page, perPage: 24) {
        media(
          type: ANIME,
          sort: $sort,
          format: $format,
          status: $status,
          genre: $genre,
          isAdult: false
        ) {
          id
          title { english romaji native }
          coverImage { extraLarge large }
          seasonYear
          startDate { year }
          format
          episodes
          averageScore
          genres
          description(asHtml: false)
          siteUrl
        }
      }
    }
  `;

  const data = await fetchJSON(ANILIST, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      query,
      variables: {
        page,
        sort: [spec.sort],
        format: spec.format || null,
        status: spec.status || null,
        genre: spec.genre || null
      }
    })
  });

  if (data.errors?.length) {
    throw new Error("AniList query failed");
  }

  return (data.data?.Page?.media || [])
    .map(fromAniList);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const category = String(
    req.query.category || "trending"
  ).toLowerCase();

  if (!categories[category]) {
    return res.status(400).json({
      error: "Unsupported anime category",
      available: Object.keys(categories)
    });
  }

  const page = Math.min(
    20,
    Math.max(1, parseInt(req.query.page, 10) || 1)
  );

  const providers = await Promise.allSettled([
    loadJikan(category, page),
    loadAniList(category, page)
  ]);

  const items = [];
  const activeProviders = [];

  providers.forEach((result, index) => {
    if (result.status === "fulfilled") {
      items.push(...result.value);
      activeProviders.push(index === 0 ? "Jikan" : "AniList");
    } else {
      console.warn(
        "Anime provider failed:",
        index === 0 ? "Jikan" : "AniList",
        result.reason?.message
      );
    }
  });

  if (!activeProviders.length) {
    return res.status(503).json({
      error: "Anime providers temporarily unavailable"
    });
  }

  const seen = new Set();

  const results = items.filter(item => {
    if (!item.title || !item.posterUrl) return false;

    const key = item.title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]/g, "") +
      ":" + (item.year || "");

    if (seen.has(key)) return false;

    seen.add(key);
    return true;
  });

  res.setHeader(
    "Cache-Control",
    "public, s-maxage=1800, stale-while-revalidate=3600"
  );

  return res.status(200).json({
    category,
    page,
    providers: activeProviders,
    count: results.length,
    results
  });
}
