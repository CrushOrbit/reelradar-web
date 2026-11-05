
const groups = {
  korean: { type: "multi", language: "ko" },
  chinese: { type: "multi", language: "zh" },
  japanese: { type: "multi", language: "ja" },
  filipino: { type: "multi", language: "tl" },

  indian: { type: "movie", language: "hi" },
  hollywood: { type: "movie", language: "en" },

  african: {
    type: "movie",
    countries: ["NG", "KE", "GH", "ZA"]
  },

  asian: {
    type: "movie",
    languages: ["th", "id", "vi"]
  },

  classics: {
    type: "movie",
    from: "1990-01-01",
    to: "1999-12-31"
  },

  mature: {
    type: "movie",
    genres: "27|53",
    adult: false
  },

  kids: {
    type: "movie",
    genres: "16|10751",
    adult: false
  },

  teens: {
    type: "movie",
    genres: "10749|12",
    adult: false
  },

  halloween: {
    type: "movie",
    genres: "27|14",
    adult: false
  },

  holiday: {
    type: "movie",
    genres: "10751|35",
    adult: false
  },

  romance: {
    type: "movie",
    genres: "10749",
    adult: false
  },

  family: {
    type: "movie",
    genres: "10751",
    adult: false
  },

  action: {
    type: "movie",
    genres: "28|12",
    adult: false
  },

  thriller: {
    type: "movie",
    genres: "53",
    adult: false
  },

  comedy: {
    type: "movie",
    genres: "35",
    adult: false
  },

  winter: {
    type: "movie",
    genres: "18|10749",
    adult: false
  },

  animation: {
    type: "movie",
    genres: "16",
    adult: false
  },

  preschool: {
    type: "tv",
    genres: "16|10762",
    adult: false
  },

  pride: {
    type: "multi",
    keywords: "158718|264427",
    adult: false
  },

  lgbtq: {
    type: "multi",
    keywords: "158718|264427",
    adult: false
  }
};

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      error: "Method not allowed"
    });
  }

  const key = process.env.AMODB_API_KEY;

  if (!key) {
    return res.status(500).json({
      error: "API key not configured"
    });
  }

  const category = String(
    req.query.category || ""
  ).toLowerCase();

  const spec = groups[category];

  if (!spec) {
    return res.status(400).json({
      error: "Unsupported discovery category"
    });
  }

  try {
    const page = Math.min(
      20,
      Math.max(
        1,
        parseInt(req.query.page, 10) || 1
      )
    );

    const lang = spec.language
      ? [spec.language]
      : spec.languages || [];

    const countries = spec.countries || [];

    const variants =
      spec.type === "multi"
        ? ["movie", "tv"]
        : [spec.type];

    const requests = [];

    for (const type of variants) {
      const selectors = countries
        .map(country => ({ country }))
        .concat(
          lang.map(language => ({ language }))
        );

      if (!selectors.length) {
        selectors.push({});
      }

      for (const selector of selectors) {
        const url = new URL(
          `https://api.amodb.dev/3/discover/${type}`
        );

        url.searchParams.set(
          "language",
          "en-US"
        );

        url.searchParams.set(
          "sort_by",
          "popularity.desc"
        );

        url.searchParams.set(
          "include_adult",
          "false"
        );

        url.searchParams.set(
          "vote_count.gte",
          "8"
        );

        url.searchParams.set(
          "page",
          String(page)
        );

        if (selector.country) {
          url.searchParams.set(
            "with_origin_country",
            selector.country
          );
        }

        if (selector.language) {
          url.searchParams.set(
            "with_original_language",
            selector.language
          );
        }

        if (spec.genres) {
          url.searchParams.set(
            "with_genres",
            spec.genres
          );
        }

        if (spec.keywords) {
          url.searchParams.set(
            "with_keywords",
            spec.keywords
          );
        }

        if (spec.from) {
          url.searchParams.set(
            "primary_release_date.gte",
            spec.from
          );
        }

        if (spec.to) {
          url.searchParams.set(
            "primary_release_date.lte",
            spec.to
          );
        }

        requests.push({
          type,
          selector,
          url
        });
      }
    }

    const failures = [];

    const responses = await Promise.all(
      requests.map(
        async ({ type, selector, url }) => {
          try {
            const response = await fetch(url, {
              headers: {
                Authorization: `Bearer ${key}`,
                Accept: "application/json"
              }
            });

            if (!response.ok) {
              failures.push(response.status);
              return [];
            }

            const data = await response.json();

            return (
              Array.isArray(data.results)
                ? data.results
                : []
            )
              .filter(item => {
                if (
                  selector.language &&
                  item.original_language !==
                    selector.language
                ) {
                  return false;
                }

                if (
                  selector.country &&
                  Array.isArray(
                    item.origin_country
                  ) &&
                  item.origin_country.length &&
                  !item.origin_country.includes(
                    selector.country
                  )
                ) {
                  return false;
                }

                if (
                  spec.from &&
                  (
                    !item.release_date ||
                    item.release_date < spec.from ||
                    item.release_date > spec.to
                  )
                ) {
                  return false;
                }

                return true;
              })
              .map(item => ({
                ...item,
                media_type: type
              }));
          } catch (error) {
            console.error(
              "ReelRadar discovery request failed:",
              error.message
            );

            failures.push(502);
            return [];
          }
        }
      )
    );

    const seen = new Set();

    const results = responses
      .flat()
      .filter(item => {
        if (
          !item.id ||
          !item.poster_path ||
          seen.has(
            item.media_type + ":" + item.id
          )
        ) {
          return false;
        }

        seen.add(
          item.media_type + ":" + item.id
        );

        return true;
      })
      .sort(
        (a, b) =>
          (b.popularity || 0) -
          (a.popularity || 0)
      )
      .slice(0, 24);

    if (
      failures.length === requests.length
    ) {
      return res.status(502).json({
        error:
          "Movie provider returned an error",
        upstreamStatus: failures[0]
      });
    }

    res.setHeader(
      "Cache-Control",
      "public, s-maxage=1800, stale-while-revalidate=3600"
    );

    return res.status(200).json({
      category,
      page,
      results,
      partial: failures.length > 0
    });
  } catch (error) {
    console.error(
      "ReelRadar discovery error:",
      error.message
    );

    return res.status(502).json({
      error:
        "Discovery service temporarily unavailable"
    });
  }
}
