
const MODEL = process.env.SCENEFINDER_MODEL || "gemini-3.5-flash-lite";
const SEARCH_MODEL = process.env.SCENEFINDER_SEARCH_MODEL || "gemini-3.8-flash";
const FALLBACK_MODELS = (process.env.SCENEFINDER_FALLBACK_MODELS || SEARCH_MODEL)
  .split(",").map(x => x.trim()).filter(Boolean);

const TIMEOUT = 12000;
const MAX_IMAGE_LENGTH = 6000000;
let cooldownUntil = 0;

function respond(res, status, data) {
  return res.status(status).json(data);
}

function normalize(s) {
  return String(s || "").normalize("NFKD").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function parseImage(image) {
  if (typeof image !== "string") return null;
  if (image.length > MAX_IMAGE_LENGTH) return { tooLarge: true };
  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );
  if (!match) return null;
  const data = match[2].replace(/\s/g, "");
  if (!data || data.length % 4) return null;
  return {
    mime_type: match[1] === "image/jpg" ? "image/jpeg" : match[1],
    data
  };
}

function parseJSON(s) {
  try {
    return JSON.parse(String(s || "").replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/, "").trim());
  } catch {
    return null;
  }
}

function candidatesFrom(data) {
  return (Array.isArray(data?.candidates) ? data.candidates : [])
    .filter(x => x && typeof x.title === "string" && x.title.trim())
    .slice(0, 3).map(x => ({
      title: x.title.trim().slice(0, 150),
      year: Number.isInteger(x.year) && x.year >= 1880 &&
        x.year <= 2100 ? x.year : null,
      type: x.type === "tv" ? "tv" : "movie",
      reason: String(x.reason || "").slice(0, 350)
    }));
}

async function gemini(model, parts, key, search = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const body = {
      contents: [{ role: "user", parts }],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 1200
      }
    };
    if (search) body.tools = [{ google_search: {} }];
    else body.generationConfig.responseMimeType = "application/json";

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
      console.warn("SceneFinder Gemini", model, r.status);
      return { ok: false, status: r.status };
    }
    return {
      ok: true,
      text: (data.candidates || [])
        .flatMap(c => c?.content?.parts || [])
        .map(p => p.text || "").join("\n").trim(),
      grounding: data.candidates?.[0]?.groundingMetadata || null
    };
  } catch (e) {
    console.warn("SceneFinder request:", e?.message);
    return { ok: false, status: 503 };
  } finally {
    clearTimeout(timer);
  }
}

const models = () =>
  [...new Set([MODEL, ...FALLBACK_MODELS, SEARCH_MODEL])].slice(0, 3);

async function askWithFallback(parts, key) {
  let last = { ok: false, status: 503 };
  for (const model of models()) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await gemini(model, parts, key);
      if (r.ok) {
        const json = parseJSON(r.text);
        if (json) return { ok: true, json, model, fallbackUsed: model !== MODEL };
        break;
      }
      last = r;
      if ([400, 401, 403, 404, 429, 503].includes(r.status)) break;
      if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700));
    }
    if ([400, 401, 403, 429].includes(last.status)) break;
  }
  return last;
}

function firstPrompt(clues) {
  return `You identify movies and TV shows from screenshots.
Analyze the actual film or TV frame, not the surrounding social-media interface.

IMPORTANT:
- Instagram captions, hashtags, account names and suggested movie names
  are NOT evidence that a screenshot comes from those productions.
- A subtitle or line of dialogue is a clue, NOT a production title.
- If the screenshot is an actual poster or title card, read its title.
- Do not invent actors, plots, characters or years.
- Do not force a match when evidence is weak.
- Prefer an empty candidate list when no specific production is identifiable.
- Provide up to three distinct possibilities, not three variations of one guess.
- Confidence High requires distinctive visual evidence.
- A generic romantic, school, hospital or street scene is not enough.

Return ONLY JSON:
{
 "imageType":"scene",
 "visibleTitle":null,
 "candidates":[
  {"title":"Production name","year":null,"type":"movie","reason":"Specific visual evidence"}
 ],
 "confidence":"Low",
 "visualEvidence":"Describe the visible film frame and distinctive clues"
}

imageType: poster, scene or unknown.
type: movie or tv.
confidence: High, Medium or Low.
visibleTitle: production title actually printed on poster/title card, otherwise null.
User clues: ${clues || "None"}`;
}

function secondPrompt(first, clues) {
  return `Independently check a movie or television screenshot.

Ignore surrounding social media captions, hashtags, usernames,
recommendations and promotional text as evidence.

A first AI suggested:
${first.candidates.map(c => c.title).join("; ") || "No candidates"}.

Do NOT assume those guesses are correct.
Examine the actual scene for distinctive identifying details.
Do not claim to recognize an actor without reliable evidence.

If you can independently identify the production from the frame,
return its exact title. Otherwise abstain.

Return ONLY JSON:
{
 "supportedTitle":null,
 "confidence":"Low",
 "reason":"Explain distinctive evidence or why identification is uncertain"
}

supportedTitle must be a production title or null.
confidence must be High, Medium or Low.
User clues: ${clues || "None"}`;
}

function posterUrl(path) {
  if (typeof path !== "string") return null;
  if (path.startsWith("https://")) return path;
  if (path.startsWith("/")) return "https://image.tmdb.org/t/p/w500" + path;
  return null;
}

async function lookupAmodb(title, type, key, year) {
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
        .some(name => normalize(name) === normalize(title))
    );
    const ranked = matches.map(item => {
      const date = item.release_date || item.first_air_date || "";
      const foundYear = /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null;
      const difference = year && foundYear ? Math.abs(year - foundYear) : null;
      return { item, foundYear, difference };
    }).filter(x => x.difference === null || x.difference <= 1)
      .sort((a, b) => {
        const score = x => x.difference === 0 ? 3 :
          x.difference === 1 ? 2 : 1;
        return score(b) - score(a);
      });

    if (!ranked.length) return null;
    const { item, foundYear } = ranked[0];
    return {
      id: item.id,
      title: item.title || item.name || title,
      year: foundYear,
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

async function findMatches(candidates, key) {
  return Promise.all(candidates.map(async candidate => {
    let match = await lookupAmodb(
      candidate.title, candidate.type, key, candidate.year
    );
    if (!match) {
      match = await lookupAmodb(
        candidate.title,
        candidate.type === "movie" ? "tv" : "movie",
        key,
        candidate.year
      );
    }
    return { candidate, match };
  }));
}

function selectMatch(recognition, results, second) {
  const visible = recognition.visibleTitle;
  if (recognition.imageType === "poster" && visible) {
    return results.find(x =>
      normalize(x.candidate.title) === normalize(visible)
    ) || null;
  }
  if (!second || second.confidence !== "High" || !second.title) return null;
  const chosen = results.find(x =>
    normalize(x.candidate.title) === normalize(second.title) ||
    normalize(x.match?.title) === normalize(second.title)
  );
  if (!chosen) return null;
  if (recognition.confidence === "Low") return null;
  return chosen;
}

async function googleResearch(recognition, clues, key) {
  const prompt = `Research possible film/TV titles:
${recognition.candidates.map(x => x.title).join("; ") || "Unknown"}
Visual evidence: ${recognition.visualEvidence}
User clues: ${clues || "None"}

Search for distinctive scene descriptions, dialogue and cast evidence.
Do not treat social-media captions or database title listings as proof.
If no credible scene match exists, state that verification is unavailable.
Provide concise evidence and uncertainty.`;
  const r = await gemini(SEARCH_MODEL, [{ text: prompt }], key, true);
  if (!r.ok) return null;
  const sources = (r.grounding?.groundingChunks || [])
    .map(x => x?.web?.uri)
    .filter(x => typeof x === "string" && /^https?:\/\//.test(x))
    .slice(0, 5);
  return {
    text: r.text.slice(0, 1500),
    sources,
    grounded: sources.length > 0
  };
}

function buildAnswer(recognition, selected, results, second, research, amodbEnabled) {
  if (!selected) {
    const lines = [
      "No reliable title identified from this screenshot.",
      "Confidence: Low (unverified)",
      "Scene verification: Not confirmed."
    ];
    if (recognition.visualEvidence)
      lines.push("Visual evidence: " + recognition.visualEvidence);
    if (second?.reason)
      lines.push("Independent check: " + second.reason);
    if (results.length)
      lines.push("Possible matches (not verified): " +
        results.map(x => x.candidate.title).join("; "));
    if (research?.text)
      lines.push("Additional research:\n" + research.text);
    lines.push("Try another frame or add distinctive dialogue.");
    return lines.join("\n\n");
  }

  const title = selected.match?.title || selected.candidate.title;
  const year = selected.match?.year || selected.candidate.year || "Unknown";
  const lines = [
    "Title: " + title,
    "Year: " + year,
    "Confidence: " + (second?.confidence || recognition.confidence) +
      " (AI estimate, not independently verified)"
  ];
  if (recognition.imageType === "poster" && recognition.visibleTitle)
    lines.push("Visible poster title: " + recognition.visibleTitle);
  lines.push(selected.match
    ? "AMODB: Matching production title found."
    : amodbEnabled
      ? "AMODB: No exact title metadata found."
      : "AMODB: Unavailable.");
  lines.push("Scene verification: Not confirmed.");
  if (recognition.visualEvidence)
    lines.push("Visual evidence: " + recognition.visualEvidence);
  if (selected.candidate.reason)
    lines.push("Explanation: " + selected.candidate.reason);
  if (second?.reason)
    lines.push("Independent check: " + second.reason);
  const others = results.filter(x => x !== selected);
  if (others.length)
    lines.push("Other possible titles: " +
      others.map(x => x.candidate.title).join("; "));
  if (research?.text) lines.push("Additional research:\n" + research.text);
  return lines.join("\n\n");
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")
    return respond(res, 405, { error: "Method not allowed" });

  const geminiKey = process.env.GEMINI_API_KEY;
  const amodbKey = process.env.AMODB_API_KEY;
  if (!geminiKey)
    return respond(res, 503, { error: "SceneFinder is not configured" });

  if (Date.now() < cooldownUntil) {
    res.setHeader("Retry-After",
      String(Math.ceil((cooldownUntil - Date.now()) / 1000)));
    return respond(res, 429, {
      error: "SceneFinder is temporarily rate-limited. Please try again shortly."
    });
  }

  try {
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); }
      catch { return respond(res, 400, { error: "Invalid request body" }); }
    }
    const { image, clues = "" } = body || {};
    if (typeof clues !== "string" || clues.length > 1000)
      return respond(res, 400, { error: "Invalid scene clues" });

    const imageData = parseImage(image);
    if (imageData?.tooLarge)
      return respond(res, 413, {
        error: "Screenshot is too large. Please use a smaller image."
      });
    if (!imageData)
      return respond(res, 400, {
        error: "Please upload a valid JPG, PNG, or WebP screenshot."
      });

    const first = await askWithFallback([
      { text: firstPrompt(clues) },
      { inline_data: imageData }
    ], geminiKey);

    if (!first.ok) {
      if (first.status === 429) cooldownUntil = Date.now() + 60000;
      return respond(res, first.status === 429 ? 429 : 503, {
        error: first.status === 429
          ? "SceneFinder reached a temporary AI usage limit. Try again later."
          : "SceneFinder AI is temporarily unavailable. Try again shortly."
      });
    }

    const raw = first.json;
    const recognition = {
      imageType: ["poster", "scene", "unknown"].includes(raw.imageType)
        ? raw.imageType : "unknown",
      visibleTitle: typeof raw.visibleTitle === "string"
        ? raw.visibleTitle.trim().slice(0, 150) : null,
      candidates: candidatesFrom(raw),
      confidence: ["High", "Medium", "Low"].includes(raw.confidence)
        ? raw.confidence : "Low",
      visualEvidence: String(raw.visualEvidence || "").slice(0, 500)
    };

    let candidates = [...recognition.candidates];
    if (recognition.imageType === "poster" && recognition.visibleTitle &&
        !candidates.some(x =>
          normalize(x.title) === normalize(recognition.visibleTitle))) {
      candidates.unshift({
        title: recognition.visibleTitle,
        year: null,
        type: "movie",
        reason: "Production title visible on the poster."
      });
    }
    candidates = candidates.slice(0, 3);
    recognition.candidates = candidates;

    const results = await findMatches(candidates, amodbKey);

    let second = null;
    if (!(recognition.imageType === "poster" && recognition.visibleTitle)) {
      const check = await askWithFallback([
        { text: secondPrompt(recognition, clues) },
        { inline_data: imageData }
      ], geminiKey);
      if (check.ok) {
        second = {
          title: typeof check.json.supportedTitle === "string"
            ? check.json.supportedTitle.trim() : null,
          confidence: ["High", "Medium", "Low"].includes(check.json.confidence)
            ? check.json.confidence : "Low",
          reason: String(check.json.reason || "").slice(0, 300)
        };
      }
    }

    const selected = selectMatch(recognition, results, second);
    const primary = selected?.match || null;

    const research = !selected || recognition.confidence !== "High"
      ? await googleResearch(recognition, clues, geminiKey)
      : null;

    const answer = buildAnswer(
      recognition, selected, results, second, research, Boolean(amodbKey)
    );

    const metadataMatches = results.map(x => x.match).filter(Boolean);
    const possibleMatches = results.map(x => ({
      title: x.match?.title || x.candidate.title,
      year: x.match?.year || x.candidate.year || null,
      type: x.match?.type || x.candidate.type,
      reason: x.candidate.reason,
      posterUrl: x.match?.posterUrl || null,
      verified: false
    }));

    return respond(res, 200, {
      success: true,
      answer,
      title: selected ? (primary?.title || selected.candidate.title) : null,
      year: selected
        ? (primary?.year || selected.candidate.year || null) : null,
      type: selected
        ? (primary?.type || selected.candidate.type) : null,
      confidence: selected
        ? (second?.confidence || recognition.confidence) : "Low",
      possibleMatches,
      sceneCrossChecked: Boolean(second),
      identificationUncertain: !selected,
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
    console.error("SceneFinder unexpected error:", error?.message);
    return respond(res, 500, {
      error: "SceneFinder encountered an unexpected error."
    });
  }
}
