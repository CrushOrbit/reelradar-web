
const MODEL = process.env.SCENEFINDER_MODEL || "gemini-3.5-flash-lite";
const SEARCH_MODEL = process.env.SCENEFINDER_SEARCH_MODEL || "gemini-3.8-flash";
const FALLBACKS = (process.env.SCENEFINDER_FALLBACK_MODELS || SEARCH_MODEL)
  .split(",").map(x => x.trim()).filter(Boolean);

const MAX_IMAGE_LENGTH = 6000000;
const TIMEOUT = 15000;
let cooldownUntil = 0;

function send(res, status, data) {
  return res.status(status).json(data);
}

function norm(s) {
  return String(s || "").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseImage(image) {
  if (typeof image !== "string") return null;
  if (image.length > MAX_IMAGE_LENGTH) return { tooLarge: true };
  const m = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );
  if (!m) return null;
  const data = m[2].replace(/\s/g, "");
  if (!data || data.length % 4) return null;
  return {
    mime_type: m[1] === "image/jpg" ? "image/jpeg" : m[1],
    data
  };
}

function json(text) {
  try {
    return JSON.parse(String(text || "")
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "").trim());
  } catch {
    return null;
  }
}

async function gemini(model, parts, key, search = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1600
      }
    };
    if (search) {
      body.tools = [{ google_search: {} }];
    } else {
      body.generationConfig.responseMimeType = "application/json";
    }

    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.warn("SceneFinder Gemini:", model, r.status);
      return { ok: false, status: r.status };
    }
    const candidate = data.candidates?.[0];
    return {
      ok: true,
      text: (candidate?.content?.parts || [])
        .map(p => p.text || "").join("\n").trim(),
      grounding: candidate?.groundingMetadata || null
    };
  } catch (e) {
    console.warn("SceneFinder Gemini:", e?.message);
    return { ok: false, status: 503 };
  } finally {
    clearTimeout(timer);
  }
}

async function recognize(parts, key) {
  let last = { ok: false, status: 503 };
  for (const model of [...new Set([MODEL, ...FALLBACKS])].slice(0, 3)) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await gemini(model, parts, key);
      if (r.ok) {
        const data = json(r.text);
        if (data) return {
          ok: true, data, model, fallbackUsed: model !== MODEL
        };
        break;
      }
      last = r;
      if ([400, 401, 403, 404, 429, 503].includes(r.status)) break;
      if (attempt === 0)
        await new Promise(resolve => setTimeout(resolve, 700));
    }
    if ([400, 401, 403, 429].includes(last.status)) break;
  }
  return last;
}

function prompt(clues) {
  return `You are ReelRadar SceneFinder, an expert at identifying
movies and TV shows from screenshots.

Analyze the actual film or television frame.

IMPORTANT:
- Ignore Instagram captions, hashtags, usernames and account names
  when deciding what production the scene belongs to.
- A social-media caption may mention an unrelated movie.
- Dialogue subtitles are clues, not movie titles.
- If this is a real movie poster, prioritize its printed title.
- Never invent actors, years, titles, plots or scenes.
- Generic costumes and locations are not enough for a confident match.
- Suggest up to three plausible productions.
- If uncertain, return no candidates rather than forcing a match.

Return ONLY JSON:
{
 "imageType":"scene",
 "visibleTitle":null,
 "candidates":[
  {
   "title":"Exact movie or TV title",
   "year":null,
   "type":"movie",
   "reason":"Specific evidence visible in the scene"
  }
 ],
 "confidence":"Low",
 "visualEvidence":"Detailed description of the actual scene",
 "dialogue":"Visible dialogue, or null"
}

imageType: poster, scene or unknown.
confidence: High, Medium or Low.
type: movie or tv.
visibleTitle: only a production title clearly printed on a
poster or title card; otherwise null.

User clues: ${clues || "None"}`;
}

function candidates(data) {
  const seen = new Set();
  return (Array.isArray(data?.candidates) ? data.candidates : [])
    .filter(x => x && typeof x.title === "string" && x.title.trim())
    .map(x => ({
      title: x.title.trim().slice(0, 150),
      year: Number.isInteger(x.year) && x.year >= 1880 &&
        x.year <= 2100 ? x.year : null,
      type: x.type === "tv" ? "tv" : "movie",
      reason: String(x.reason || "").slice(0, 350)
    }))
    .filter(x => {
      const k = norm(x.title);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 3);
}

function posterUrl(path) {
  if (typeof path !== "string") return null;
  if (path.startsWith("https://")) return path;
  if (path.startsWith("/"))
    return "https://image.tmdb.org/t/p/w500" + path;
  return null;
}

async function amodb(title, type, key, year) {
  if (!key || !title) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const url = new URL(`https://api.amodb.dev/3/search/${type}`);
    url.searchParams.set("query", title);
    const r = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json"
      },
      signal: controller.signal
    });
    if (!r.ok) return null;
    const data = await r.json();
    const matches = (data.results || []).filter(item =>
      [item.title, item.name, item.original_title, item.original_name]
        .some(name => norm(name) === norm(title))
    );
    const ranked = matches.map(item => {
      const date = item.release_date || item.first_air_date || "";
      const y = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
      const diff = year && y ? Math.abs(year - y) : null;
      return { item, y, diff };
    }).filter(x => x.diff === null || x.diff <= 1)
      .sort((a, b) =>
        (a.diff === 0 ? -1 : a.diff ?? 2) -
        (b.diff === 0 ? -1 : b.diff ?? 2)
      );

    if (!ranked.length) return null;
    const { item, y } = ranked[0];
    return {
      id: item.id,
      title: item.title || item.name || title,
      year: y,
      type,
      poster_path: item.poster_path || null,
      posterUrl: posterUrl(item.poster_path),
      overview: String(item.overview || "").slice(0, 350)
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findMatches(items, key) {
  return Promise.all(items.map(async candidate => {
    let match = await amodb(
      candidate.title, candidate.type, key, candidate.year
    );
    if (!match) {
      match = await amodb(
        candidate.title,
        candidate.type === "movie" ? "tv" : "movie",
        key,
        candidate.year
      );
    }
    return { candidate, match };
  }));
}

async function verifyWithSearch(rec, clues, key) {
  const titles = rec.candidates
    .map(x => `${x.title} (${x.year || "year unknown"})`)
    .join("; ");

  const p = `You are verifying a film or television scene identification.

Possible productions:
${titles || "None"}

Actual screenshot description:
${rec.visualEvidence}

Visible dialogue:
${rec.dialogue || "None"}

Visible poster title:
${rec.visibleTitle || "None"}

Additional user clues:
${clues || "None"}

Use Google Search to investigate the specific scene.

Search for combinations of distinctive visual clues,
dialogue, scene descriptions, characters, costumes and
candidate production titles.

CRITICAL VERIFICATION RULES:
- Do not trust the first AI's candidate list.
- A movie existing in a database does NOT prove a scene match.
- Instagram captions and hashtags are NOT scene verification.
- A cast member appearing in a film does NOT prove that
  this particular screenshot comes from that film.
- Do not fabricate scene descriptions or citations.
- A source must connect distinctive scene evidence to the
  proposed production.
- If the sources only establish the cast, genre, or plot,
  the specific screenshot remains unverified.
- Do not confuse promotional clips with their caption text.
- Prefer saying unknown to producing a false identification.

Return the following lines:
TITLE: exact verified production title, or UNKNOWN
YEAR: year, or UNKNOWN
STATUS: VERIFIED or UNCERTAIN
EVIDENCE: concise explanation
LIMITATIONS: what is not established

Use VERIFIED only when credible search evidence specifically
supports the production identity for the scene.`;

  const r = await gemini(SEARCH_MODEL, [{ text: p }], key, true);
  if (!r.ok) return null;

  const sources = (r.grounding?.groundingChunks || [])
    .map(x => x?.web?.uri)
    .filter(x => typeof x === "string" && /^https?:\/\//.test(x))
    .slice(0, 5);

  const lines = {};
  for (const line of r.text.split("\n")) {
    const m = line.match(/^\s*(TITLE|YEAR|STATUS|EVIDENCE|LIMITATIONS)\s*:\s*(.*)$/i);
    if (m) lines[m[1].toUpperCase()] = m[2].trim();
  }

  const title = lines.TITLE || null;
  const verified = lines.STATUS?.toUpperCase() === "VERIFIED" &&
    Boolean(title) && norm(title) !== "unknown" &&
    sources.length > 0;

  return {
    title,
    verified,
    evidence: lines.EVIDENCE || "",
    limitations: lines.LIMITATIONS || "",
    text: r.text.slice(0, 1800),
    sources,
    grounded: sources.length > 0
  };
}

function choose(rec, results, research) {
  if (rec.imageType === "poster" && rec.visibleTitle) {
    return results.find(x =>
      norm(x.candidate.title) === norm(rec.visibleTitle)
    ) || null;
  }
  if (!research?.verified || !research.title) return null;
  return results.find(x =>
    norm(x.candidate.title) === norm(research.title) ||
    norm(x.match?.title) === norm(research.title)
  ) || null;
}

function answerText(rec, selected, results, research) {
  const lines = [];
  if (selected) {
    lines.push("Title: " +
      (selected.match?.title || selected.candidate.title));
    lines.push("Year: " +
      (selected.match?.year || selected.candidate.year || "Unknown"));
    lines.push("Confidence: " +
      (research?.verified ? "High (search-supported)" :
        rec.confidence + " (AI estimate)"));
    lines.push(research?.verified
      ? "Scene verification: Search-supported; not independently audited."
      : "Scene verification: Not independently confirmed.");
  } else {
    lines.push("No reliable title identified from this screenshot.");
    lines.push("Confidence: Low (unverified)");
    lines.push("Scene verification: Not confirmed.");
  }

  if (rec.visualEvidence)
    lines.push("Visual evidence: " + rec.visualEvidence);
  if (rec.dialogue)
    lines.push("Visible dialogue: " + rec.dialogue);
  if (research?.evidence)
    lines.push("Search evidence: " + research.evidence);
  if (research?.limitations)
    lines.push("Limitations: " + research.limitations);

  const alternatives = results.filter(x => x !== selected);
  if (alternatives.length)
    lines.push("Possible titles (not verified): " +
      alternatives.map(x => x.candidate.title).join("; "));

  if (!selected)
    lines.push("Try another frame or add distinctive dialogue.");

  return lines.join("\n\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return send(res, 405, { error: "Method not allowed" });

  const geminiKey = process.env.GEMINI_API_KEY;
  const amodbKey = process.env.AMODB_API_KEY;

  if (!geminiKey)
    return send(res, 503, {
      error: "SceneFinder is not configured."
    });

  if (Date.now() < cooldownUntil) {
    res.setHeader("Retry-After",
      String(Math.ceil((cooldownUntil - Date.now()) / 1000)));
    return send(res, 429, {
      error: "SceneFinder is temporarily rate-limited."
    });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, { error: "Invalid request body" });
      }
    }

    const { image, clues = "" } = body || {};

    if (typeof clues !== "string" || clues.length > 1000)
      return send(res, 400, { error: "Invalid scene clues" });

    const imageData = parseImage(image);

    if (imageData?.tooLarge)
      return send(res, 413, {
        error: "Screenshot is too large. Please use a smaller image."
      });

    if (!imageData)
      return send(res, 400, {
        error: "Please upload a valid JPG, PNG, or WebP screenshot."
      });

    const first = await recognize([
      { text: prompt(clues) },
      { inline_data: imageData }
    ], geminiKey);

    if (!first.ok) {
      if (first.status === 429)
        cooldownUntil = Date.now() + 60000;

      return send(res, first.status === 429 ? 429 : 503, {
        error: first.status === 429
          ? "SceneFinder has reached a temporary AI usage limit."
          : "SceneFinder AI is temporarily unavailable. Try again shortly."
      });
    }

    const raw = first.data;
    const rec = {
      imageType: ["poster", "scene", "unknown"].includes(raw.imageType)
        ? raw.imageType : "unknown",
      visibleTitle: typeof raw.visibleTitle === "string"
        ? raw.visibleTitle.trim().slice(0, 150) : null,
      candidates: candidates(raw),
      confidence: ["High", "Medium", "Low"].includes(raw.confidence)
        ? raw.confidence : "Low",
      visualEvidence: String(raw.visualEvidence || "").slice(0, 500),
      dialogue: typeof raw.dialogue === "string"
        ? raw.dialogue.slice(0, 300) : null
    };

    if (rec.imageType === "poster" && rec.visibleTitle &&
        !rec.candidates.some(x =>
          norm(x.title) === norm(rec.visibleTitle))) {
      rec.candidates.unshift({
        title: rec.visibleTitle,
        year: null,
        type: "movie",
        reason: "Production title visible on the poster."
      });
    }

    rec.candidates = rec.candidates.slice(0, 3);

    const [results, research] = await Promise.all([
      findMatches(rec.candidates, amodbKey),
      verifyWithSearch(rec, clues, geminiKey)
    ]);

    const selected = choose(rec, results, research);
    const primary = selected?.match || null;

    const possibleMatches = results.map(x => ({
      title: x.match?.title || x.candidate.title,
      year: x.match?.year || x.candidate.year || null,
      type: x.match?.type || x.candidate.type,
      reason: x.candidate.reason,
      posterUrl: x.match?.posterUrl || null,
      verified: false
    }));

    const metadataMatches = results
      .map(x => x.match).filter(Boolean);

    const answer = answerText(rec, selected, results, research);

    return send(res, 200, {
      success: true,
      answer,
      title: selected
        ? (primary?.title || selected.candidate.title) : null,
      year: selected
        ? (primary?.year || selected.candidate.year || null) : null,
      type: selected
        ? (primary?.type || selected.candidate.type) : null,
      confidence: selected
        ? (research?.verified ? "High" : rec.confidence) : "Low",
      identificationUncertain: !selected,
      possibleMatches,
      posterUrl: primary?.posterUrl || null,
      poster: primary?.posterUrl || null,
      poster_path: primary?.poster_path || null,
      overview: primary?.overview || null,
      movieId: primary?.id || null,
      verified: false,
      model: first.model,
      fallbackUsed: first.fallbackUsed,
      searchGrounded: Boolean(research?.grounded),
      sources: research?.sources || [],
      metadataProvider: amodbKey ? "AMODB" : null,
      metadataMatches
    });
  } catch (error) {
    console.error("SceneFinder error:", error?.message);
    return send(res, 500, {
      error: "SceneFinder encountered an unexpected error."
    });
  }
}
