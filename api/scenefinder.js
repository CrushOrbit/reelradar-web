
/*
 * ReelRadar SceneFinder V6.0
 * Google Lens + Gemini + AMODB
 *
 * Preserves V5.9 candidate recovery, metadata,
 * posters, synopsis and fallback models.
 *
 * V6.0:
 * - Always attempts verification for validated scenes
 * - Adds strong possible match classification
 * - Separates scene verification from metadata matching
 * - Preserves existing frontend response fields
 *
 * Environment variables:
 * GEMINI_API_KEY
 * SERPAPI_API_KEY
 * AMODB_API_KEY
 * SCENEFINDER_MODEL (optional)
 * SCENEFINDER_SEARCH_MODEL (optional)
 * SCENEFINDER_FALLBACK_MODELS (optional)
 */

const VERSION = '6.0';

const MODEL =
  process.env.SCENEFINDER_MODEL ||
  'gemini-3.5-flash-lite';

const SEARCH_MODEL =
  process.env.SCENEFINDER_SEARCH_MODEL ||
  'gemini-3.8-flash';

const MODELS = [
  ...new Set([
    MODEL,
    SEARCH_MODEL,
    ...(process.env.SCENEFINDER_FALLBACK_MODELS || '')
      .split(',')
      .map(x => x.trim())
      .filter(Boolean)
  ])
];

const MAX_IMAGE_LENGTH = 6000000;
const LENS_MAX_BYTES = 500000;

const cooldowns = new Map();
let lensCooldown = 0;

const wait = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

const send = (res, status, body) =>
  res.status(status).json(body);

function formatTitle(value) {
  return String(value || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function norm(value) {
  return formatTitle(value)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function sameTitle(a, b) {
  return Boolean(norm(a)) && norm(a) === norm(b);
}

function validYear(value) {
  if (
    value === null ||
    value === undefined ||
    value === ''
  ) {
    return null;
  }

  const year = Number(value);

  return Number.isInteger(year) &&
    year >= 1880 &&
    year <= 2100
    ? year
    : null;
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function parseJSON(text) {
  const value = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');

  try {
    return JSON.parse(value);
  } catch {}

  const start = value.indexOf('{');
  const end = value.lastIndexOf('}');

  if (start >= 0 && end > start) {
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {}
  }

  return null;
}

function parseImage(image) {
  if (typeof image !== 'string') return null;

  if (image.length > MAX_IMAGE_LENGTH) {
    return { tooLarge: true };
  }

  const match = image.match(
    /^data:(image\/(?:jpeg|jpg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/
  );

  if (!match) return null;

  const data = match[2].replace(/\s/g, '');

  if (!data || data.length % 4 !== 0) {
    return null;
  }

  return {
    mime_type:
      match[1] === 'image/jpg'
        ? 'image/jpeg'
        : match[1],
    data
  };
}

function sanitize(raw) {
  return {
    imageType:
      ['poster', 'scene', 'unknown'].includes(raw?.imageType)
        ? raw.imageType
        : 'unknown',

    visibleTitle: raw?.visibleTitle
      ? formatTitle(raw.visibleTitle).slice(0, 150)
      : null,

    visualEvidence:
      String(raw?.visualEvidence || '').slice(0, 700),

    dialogue: raw?.dialogue
      ? String(raw.dialogue).slice(0, 250)
      : null,

    socialContext: raw?.socialContext
      ? String(raw.socialContext).slice(0, 650)
      : null,

    confidence:
      ['High', 'Medium', 'Low'].includes(raw?.confidence)
        ? raw.confidence
        : 'Low',

    candidates:
      (Array.isArray(raw?.candidates)
        ? raw.candidates
        : [])
        .filter(x =>
          typeof x?.title === 'string' &&
          x.title.trim()
        )
        .slice(0, 8)
        .map(x => ({
          title: formatTitle(x.title).slice(0, 150),
          year: validYear(x.year),
          type:
            x.type === 'tv'
              ? 'tv'
              : x.type === 'movie'
                ? 'movie'
                : null,
          reason: String(x.reason || '').slice(0, 350),
          source: 'gemini'
        }))
  };
}

function isQuotaError(status, error) {
  return status === 429 ||
    /quota|limit|credits|exhaust|insufficient balance/i
      .test(JSON.stringify(error || ''));
}

/* ---------- Google Lens ---------- */

async function googleLens(image, key) {
  if (!key || Date.now() < lensCooldown) {
    return null;
  }

  try {
    let bytes = Buffer.from(image.data, 'base64');
    let mime = image.mime_type;

    if (bytes.length > LENS_MAX_BYTES) {
      const { default: sharp } = await import('sharp');

      let reduced = null;

      for (const width of [900, 700, 520, 380]) {
        const output = await sharp(bytes)
          .resize({
            width,
            withoutEnlargement: true
          })
          .jpeg({
            quality: 65,
            mozjpeg: true
          })
          .toBuffer();

        if (output.length <= LENS_MAX_BYTES) {
          reduced = output;
          break;
        }
      }

      if (!reduced) return null;

      bytes = reduced;
      mime = 'image/jpeg';
    }

    const form = new FormData();

    form.append('api_key', key);
    form.append(
      'image',
      new Blob([bytes], { type: mime }),
      'scene.jpg'
    );

    const uploadController = new AbortController();
    const uploadTimer = setTimeout(
      () => uploadController.abort(),
      9000
    );

    let uploaded;

    try {
      const response = await fetch(
        'https://serpapi.com/image',
        {
          method: 'POST',
          body: form,
          signal: uploadController.signal
        }
      );

      uploaded = await response.json().catch(() => ({}));

      if (
        !response.ok ||
        uploaded.error ||
        !uploaded.image_id
      ) {
        if (isQuotaError(response.status, uploaded.error)) {
          lensCooldown = Date.now() + 3600000;
        }

        console.warn(
          'Lens upload failed',
          response.status
        );

        return null;
      }
    } finally {
      clearTimeout(uploadTimer);
    }

    const url = new URL(
      'https://serpapi.com/search.json'
    );

    for (const [keyName, value] of Object.entries({
      engine: 'google_lens',
      image_id: uploaded.image_id,
      type: 'all',
      hl: 'en',
      api_key: key
    })) {
      url.searchParams.set(keyName, value);
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      16000
    );

    try {
      const response = await fetch(url, {
        signal: controller.signal
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || data.error) {
        if (isQuotaError(response.status, data.error)) {
          lensCooldown = Date.now() + 3600000;
        }

        console.warn(
          'Lens search failed',
          response.status
        );

        return null;
      }

      const matches = [
        ...(data.exact_matches || []).map(x => ({
          ...x,
          matchKind: 'exact'
        })),
        ...(data.visual_matches || []).map(x => ({
          ...x,
          matchKind: 'visual'
        }))
      ]
        .slice(0, 15)
        .map(x => ({
          title: String(x.title || '').slice(0, 180),
          source: String(x.source || '').slice(0, 100),
          link: safeUrl(x.link),
          thumbnail: safeUrl(x.thumbnail),
          matchKind: x.matchKind
        }));

      return {
        matches,
        status: 'ok'
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    console.warn(
      'Lens unavailable',
      error.message
    );

    return null;
  }
}

/* ---------- Gemini ---------- */

async function callGemini(
  model,
  parts,
  key,
  search = false
) {
  if (!key) {
    return { ok: false, status: 503 };
  }

  if (Date.now() < (cooldowns.get(model) || 0)) {
    return { ok: false, status: 429 };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      12000
    );

    try {
      const body = {
        contents: [{
          role: 'user',
          parts
        }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1800
        }
      };

      if (search) {
        body.tools = [{ google_search: {} }];
      } else {
        body.generationConfig.responseMimeType =
          'application/json';
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': key
          },
          body: JSON.stringify(body),
          signal: controller.signal
        }
      );

      const data = await response.json().catch(() => ({}));

      if (response.ok) {
        const candidate = data.candidates?.[0];

        const text = (candidate?.content?.parts || [])
          .map(part => part.text || '')
          .join('\n');

        if (text.trim()) {
          return {
            ok: true,
            status: 200,
            model,
            text,
            grounding:
              candidate?.groundingMetadata || null
          };
        }

        return {
          ok: false,
          status: 502
        };
      }

      console.warn(
        'Gemini',
        model,
        response.status
      );

      if (response.status === 429) {
        const exhausted =
          /quota exceeded|free.tier|per.day|per day/i
            .test(JSON.stringify(data.error || {}));

        let cooldown = exhausted
          ? 3600000
          : 60000;

        const retry = Number(
          response.headers.get('retry-after')
        );

        if (retry > 0) {
          cooldown = Math.max(
            cooldown,
            retry * 1000
          );
        }

        for (const detail of data.error?.details || []) {
          const delay = detail.retryDelay || '';

          if (/^\d+(\.\d+)?s$/.test(delay)) {
            cooldown = Math.max(
              cooldown,
              parseFloat(delay) * 1000
            );
          }
        }

        cooldowns.set(
          model,
          Date.now() + cooldown
        );

        return {
          ok: false,
          status: 429
        };
      }

      if (
        [500, 503].includes(response.status) &&
        attempt === 0
      ) {
        await wait(500);
        continue;
      }

      return {
        ok: false,
        status: response.status
      };
    } catch (error) {
      console.warn(
        'Gemini unavailable',
        error.message
      );

      if (attempt === 0) {
        await wait(350);
        continue;
      }

      return {
        ok: false,
        status: 503
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    ok: false,
    status: 503
  };
}

async function geminiFallback(
  parts,
  key,
  search = false
) {
  const order = search
    ? [...new Set([SEARCH_MODEL, ...MODELS])]
    : MODELS;

  let last = {
    ok: false,
    status: 503
  };

  for (const model of order) {
    last = await callGemini(
      model,
      parts,
      key,
      search
    );

    if (last.ok) return last;

    if ([401, 403].includes(last.status)) {
      break;
    }
  }

  return last;
}

async function recognize(image, clues, key) {
  const prompt = `
You are ReelRadar SceneFinder.

Identify the movie or television series in a screenshot.

Rules:
- Focus on the actual scene.
- Ignore social-media interface elements.
- Captions and hashtags are weak clues, not proof.
- Recognize season and episode references as TV clues.
- Do not invent actors or production titles.
- If uncertain, provide plausible candidates only when
  you have a recognizable visual or contextual basis.
- Otherwise return an empty candidates array.

Return JSON:
{
  "imageType": "scene",
  "visibleTitle": null,
  "visualEvidence": "",
  "dialogue": null,
  "socialContext": null,
  "confidence": "Low",
  "candidates": [
    {
      "title": "",
      "year": null,
      "type": "movie",
      "reason": ""
    }
  ]
}

Valid types: movie, tv, null.

User clues: ${clues || 'none'}
`;

  const result = await geminiFallback(
    [
      { text: prompt },
      { inline_data: image }
    ],
    key
  );

  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      data: sanitize({})
    };
  }

  const parsed = parseJSON(result.text);

  return parsed
    ? {
        ok: true,
        status: 200,
        data: sanitize(parsed),
        model: result.model,
        fallbackUsed: result.model !== MODEL
      }
    : {
        ok: false,
        status: 502,
        data: sanitize({})
      };
}

/* ---------- Lens candidate extraction ---------- */

function extractLensHints(lens) {
  if (!lens?.matches?.length) return [];

  const hints = [];

  const patterns = [
    /(?:movie|film|series|drama)\s*:\s*([^|–—#]{3,70})/i,
    /(?:title|name)\s*:\s*([^|–—#]{3,70})/i,
    /🎬\s*([^|–—#]{3,70})/u
  ];

  for (const item of lens.matches) {
    const text = String(item.title || '');

    const tv =
      /\b(?:season|episode|s\d{1,2}e\d{1,2}|tv series|television series|tv show)\b/i
        .test(text);

    const extracted = [];

    for (const pattern of patterns) {
      const match = text.match(pattern);

      if (match) extracted.push(match[1]);
    }

    if (
      /\b(?:movie|film|series|drama|trailer)\b/i
        .test(text)
    ) {
      for (const match of text.matchAll(
        /["“‘']([^"”’']{3,70})["”’']/g
      )) {
        extracted.push(match[1]);
      }
    }

    for (let title of extracted) {
      title = formatTitle(title)
        .replace(/\s*\((?:19|20)\d{2}\).*$/, '')
        .replace(
          /\s+(?:official trailer|movie clip|film scene|review|explained).*$/i,
          ''
        )
        .trim();

      if (
        title.length < 3 ||
        title.length > 65
      ) {
        continue;
      }

      hints.push({
        title,
        year: null,
        type: tv ? 'tv' : null,
        reason:
          'Production title lead from Google Lens',
        source: 'lens'
      });

      break;
    }
  }

  return hints.slice(0, 8);
}

async function interpretLens(lens, rec, key) {
  if (!lens?.matches?.length || !key) {
    return [];
  }

  const prompt = `
Extract actual movie or TV production titles from these
Google Lens results.

Reject:
- Dialogue
- Social-media captions
- Usernames
- Hashtags
- Incomplete sentences
- Unrelated page headings

TV season or episode references suggest television.

Screenshot:
${rec.visualEvidence || 'unknown'}

Lens:
${JSON.stringify(lens.matches.map(x => ({
  title: x.title,
  source: x.source,
  matchKind: x.matchKind
})))}

Return JSON:
{
  "candidates": [
    {
      "title": "",
      "year": null,
      "type": null,
      "reason": ""
    }
  ]
}

Use movie, tv, or null for type.
An empty candidates array is allowed.
`;

  const result = await geminiFallback(
    [{ text: prompt }],
    key
  );

  return result.ok
    ? sanitize(parseJSON(result.text) || {})
        .candidates.map(x => ({
          ...x,
          source: 'lens_ai'
        }))
    : [];
}

/* ---------- V5.9 candidate recovery ---------- */

async function recoverCandidates(
  image,
  rec,
  lens,
  clues,
  key
) {
  if (!key) return [];

  const prompt = `
You are performing a SECOND-PASS movie/TV identification.

The first identification attempt found no usable title.

Analyze the actual screenshot again, considering:
- Recognizable performers, only if visually identifiable
- Clothing, scenery and production design
- Dialogue or subtitles
- Known movie or TV scenes
- Google Lens results as supporting clues
- Differences between films and TV episodes

Do NOT assume the first guess was correct.
Do NOT invent production names.
Do NOT treat a caption as scene proof.
Do NOT list unrelated productions merely because
an actor may appear in them.

Earlier visual description:
${rec.visualEvidence || 'unknown'}

Dialogue:
${rec.dialogue || 'none'}

User clues:
${clues || 'none'}

Google Lens results:
${JSON.stringify((lens?.matches || []).slice(0, 10).map(x => ({
  title: x.title,
  source: x.source,
  matchKind: x.matchKind
})))}

Return ONLY JSON:
{
  "candidates": [
    {
      "title": "Actual production title",
      "year": null,
      "type": "movie",
      "reason": "Specific supporting evidence"
    }
  ]
}

Return up to 4 candidates.
If none are sufficiently plausible, return an empty array.
`;

  const result = await geminiFallback(
    [
      { text: prompt },
      { inline_data: image }
    ],
    key
  );

  if (!result.ok) return [];

  return sanitize(parseJSON(result.text) || {})
    .candidates.map(x => ({
      ...x,
      source: 'recovery'
    }));
}

async function groundedRecovery(
  rec,
  lens,
  clues,
  key
) {
  if (!key) return [];

  const description = [
    rec.visualEvidence,
    rec.dialogue,
    clues
  ].filter(Boolean).join(' ');

  if (
    !description &&
    !lens?.matches?.length
  ) {
    return [];
  }

  const prompt = `
Use Google Search to investigate possible movie or TV
titles for this scene.

Description:
${description || 'No visual description'}

Lens page titles:
${JSON.stringify((lens?.matches || []).slice(0, 8).map(x => x.title))}

Find productions supported by specific searchable evidence.
Do not guess from generic actor filmographies.
Do not assume a social caption is correct.

Return JSON only:
{
  "candidates": [
    {
      "title": "",
      "year": null,
      "type": null,
      "reason": ""
    }
  ]
}

Maximum 3 candidates.
Return an empty array when evidence is insufficient.
`;

  const result = await geminiFallback(
    [{ text: prompt }],
    key,
    true
  );

  if (!result.ok) return [];

  return sanitize(parseJSON(result.text) || {})
    .candidates.map(x => ({
      ...x,
      source: 'grounded_recovery'
    }));
}

/* ---------- Evidence ---------- */

function typeEvidence(title, lens) {
  const rows = (lens?.matches || []).filter(x =>
    norm(title).length >= 4 &&
    norm(x.title).includes(norm(title))
  );

  let tv = 0;
  let movie = 0;

  for (const row of rows) {
    if (
      /\b(?:season\s*\d+|episode\s*\d+|s\d{1,2}e\d{1,2}|tv series|television series|tv show)\b/i
        .test(row.title)
    ) {
      tv += 2;
    }

    if (
      /\b(?:movie|feature film|theatrical film)\b/i
        .test(row.title)
    ) {
      movie++;
    }
  }

  return { tv, movie };
}

function lensEvidence(title, lens) {
  const rows = (lens?.matches || []).filter(x =>
    norm(title).length >= 4 &&
    norm(x.title).includes(norm(title))
  );

  const domains = new Set();
  let exact = 0;

  for (const row of rows) {
    if (row.matchKind === 'exact') {
      exact++;
    }

    try {
      if (row.link) {
        domains.add(
          new URL(row.link).hostname
        );
      }
    } catch {}
  }

  return {
    count: rows.length,
    exact,
    score:
      Math.min(rows.length, 4) +
      Math.min(domains.size, 2) +
      Math.min(exact, 2)
  };
}

function sceneEvidence(title, lens) {
  const rows = (lens?.matches || []).filter(x =>
    x.matchKind === 'exact' &&
    norm(title).length >= 4 &&
    norm(x.title).includes(norm(title)) &&
    x.link
  );

  const domains = new Set();

  for (const row of rows) {
    try {
      domains.add(
        new URL(row.link)
          .hostname
          .replace(/^www\./, '')
      );
    } catch {}
  }

  return {
    exactTitleMatches: rows.length,
    independentDomains: domains.size
  };
}

/* ---------- AMODB ---------- */

function posterUrl(path) {
  if (typeof path !== 'string') {
    return null;
  }

  if (path.startsWith('https://')) {
    return path;
  }

  if (path.startsWith('/')) {
    return (
      'https://image.tmdb.org/t/p/w500' +
      path
    );
  }

  return null;
}

function movieMetadata(item, title, type) {
  const date = type === 'tv'
    ? item.first_air_date ||
      item.release_date ||
      ''
    : item.release_date ||
      item.first_air_date ||
      '';

  const year = /^\d{4}/.test(date)
    ? Number(date.slice(0, 4))
    : null;

  return {
    id: item.id,

    title: formatTitle(
      item.title ||
      item.name ||
      title
    ),

    year,
    type,

    poster_path:
      item.poster_path || null,

    posterUrl:
      posterUrl(item.poster_path),

    overview:
      String(item.overview || '').slice(0, 350),

    popularity:
      Number(item.popularity) || 0,

    vote_count:
      Number(item.vote_count) || 0
  };
}

function metadataScore(
  meta,
  expectedYear,
  context = ''
) {
  let score = 0;

  if (expectedYear && meta.year) {
    const difference =
      Math.abs(expectedYear - meta.year);

    if (difference > 1) {
      return -Infinity;
    }

    score += difference === 0
      ? 100
      : 35;
  } else if (
    expectedYear &&
    !meta.year
  ) {
    score -= 30;
  }

  if (meta.posterUrl) score += 10;
  if (meta.overview) score += 5;

  score += Math.min(
    15,
    Math.log1p(
      Math.max(0, meta.popularity)
    ) * 2
  );

  score += Math.min(
    8,
    Math.log1p(
      Math.max(0, meta.vote_count)
    )
  );

  const words =
    String(context)
      .toLowerCase()
      .match(/[a-z]{5,}/g) || [];

  const unique =
    [...new Set(words)].slice(0, 35);

  const overview =
    meta.overview.toLowerCase();

  score += Math.min(
    6,
    unique.filter(word =>
      overview.includes(word)
    ).length * 2
  );

  return score;
}

async function amodb(
  title,
  type,
  key,
  year,
  context = ''
) {
  if (!key || !title) {
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    6500
  );

  try {
    const url = new URL(
      `https://api.amodb.dev/3/search/${type}`
    );

    url.searchParams.set(
      'query',
      formatTitle(title)
    );

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: 'application/json'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      console.warn(
        'AMODB',
        type,
        response.status
      );

      return null;
    }

    const data = await response.json();

    const rows = (
      Array.isArray(data.results)
        ? data.results
        : []
    )
      .filter(item =>
        [
          item.title,
          item.name,
          item.original_title,
          item.original_name
        ].some(name =>
          sameTitle(name, title)
        )
      )
      .map(item =>
        movieMetadata(
          item,
          title,
          type
        )
      )
      .map(item => ({
        ...item,
        metadataScore: metadataScore(
          item,
          year,
          context
        )
      }))
      .filter(item =>
        Number.isFinite(
          item.metadataScore
        )
      )
      .sort((a, b) =>
        b.metadataScore -
        a.metadataScore
      );

    return rows[0] || null;
  } catch (error) {
    console.warn(
      'AMODB unavailable',
      error.message
    );

    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function validateCandidate(
  candidate,
  key,
  lens,
  context = ''
) {
  const title =
    formatTitle(candidate.title);

  const evidence =
    typeEvidence(title, lens);

  const tvStrong =
    evidence.tv >= 2 &&
    evidence.tv > evidence.movie;

  const preferred = tvStrong
    ? 'tv'
    : candidate.type || null;

  const types = preferred
    ? [
        preferred,
        preferred === 'tv'
          ? 'movie'
          : 'tv'
      ]
    : ['movie', 'tv'];

  const matches = await Promise.all(
    types.map(type =>
      amodb(
        title,
        type,
        key,
        candidate.year,
        context
      )
    )
  );

  let eligible =
    matches.filter(Boolean);

  if (tvStrong) {
    eligible = eligible.filter(x =>
      x.type === 'tv'
    );
  } else if (
    candidate.type &&
    eligible.some(x =>
      x.type === candidate.type
    )
  ) {
    eligible = eligible.filter(x =>
      x.type === candidate.type
    );
  }

  if (!eligible.length) {
    return null;
  }

  const match = eligible.sort(
    (a, b) =>
      b.metadataScore -
      a.metadataScore
  )[0];

  return {
    ...candidate,
    title: match.title,
    year:
      match.year ||
      candidate.year ||
      null,
    type: match.type,
    match,
    typeEvidence: evidence
  };
}

/* ---------- V6.0 grounded verification ---------- */

async function verifyScene(
  rec,
  candidates,
  clues,
  key
) {
  if (
    !key ||
    !rec.visualEvidence ||
    !candidates.length
  ) {
    return null;
  }

  const prompt = `
You are ReelRadar's independent scene-verification researcher.

Use Google Search to investigate whether the
described screenshot belongs to a candidate production.

CANDIDATES:
${candidates.map(x =>
  `${x.title} (${x.year || 'unknown year'}, ${x.type})`
).join('\n')}

SCREENSHOT DESCRIPTION:
${rec.visualEvidence}

VISIBLE DIALOGUE:
${rec.dialogue || 'none'}

SOCIAL MEDIA CONTEXT:
${rec.socialContext || 'none'}

USER CLUES:
${clues || 'none'}

VERIFICATION RULES:

1. A matching title, poster, cast list or generic
   synopsis does not prove the exact scene.

2. Look for specific scene-level evidence:
   matching dialogue, documented scene descriptions,
   official clips, stills or detailed scene breakdowns.

3. Actor appearance alone is not proof.

4. Social captions may be misleading.

5. VERIFIED requires direct, specific scene evidence
   corroborated by independently identifiable sources.

6. STRONG means distinctive details support a title,
   but direct scene confirmation is missing.

7. UNCERTAIN means evidence is insufficient.

8. If sources disagree, use UNCERTAIN.

9. Do not claim VERIFIED merely because a movie's
   storyline resembles the screenshot.

Return exactly these lines:

TITLE: production title or UNKNOWN
STATUS: VERIFIED or STRONG or UNCERTAIN
EVIDENCE: specific supporting evidence
LIMITATIONS: what remains unconfirmed
`;

  const result = await geminiFallback(
    [{ text: prompt }],
    key,
    true
  );

  if (!result.ok) {
    return null;
  }

  const fields = {};

  for (const line of result.text.split('\n')) {
    const match = line.match(
      /^\s*(TITLE|STATUS|EVIDENCE|LIMITATIONS)\s*:\s*(.*)$/i
    );

    if (match) {
      fields[match[1].toUpperCase()] =
        match[2].trim();
    }
  }

  const chunks =
    result.grounding?.groundingChunks || [];

  const sources = [
    ...new Set(
      chunks
        .map(x => safeUrl(x?.web?.uri))
        .filter(Boolean)
    )
  ].slice(0, 8);

  const domains = new Set();

  for (const url of sources) {
    try {
      domains.add(
        new URL(url)
          .hostname
          .replace(/^www\./, '')
      );
    } catch {}
  }

  const title =
    fields.TITLE || null;

  const titleMatches =
    candidates.some(candidate =>
      sameTitle(
        candidate.title,
        title
      )
    );

  const reportedStatus =
    (fields.STATUS || 'UNCERTAIN')
      .toUpperCase();

  const evidence =
    fields.EVIDENCE || '';

  const limitations =
    fields.LIMITATIONS || '';

  const specificEvidence =
    evidence.length >= 35 &&
    !/^(unknown|none|not available|no evidence)$/i
      .test(evidence.trim());

  /*
   * Source counts provide a corroboration threshold,
   * not a guarantee that the sources are independent.
   *
   * Keep the classification conservative.
   */
  const verified =
    titleMatches &&
    reportedStatus === 'VERIFIED' &&
    specificEvidence &&
    domains.size >= 2;

  const strong =
    titleMatches &&
    specificEvidence &&
    (
      verified ||
      reportedStatus === 'STRONG' ||
      (
        reportedStatus === 'VERIFIED' &&
        domains.size >= 1
      )
    );

  return {
    title:
      titleMatches
        ? title
        : null,

    supported: verified,
    strong,

    evidence,
    limitations,
    sources,

    independentDomains:
      domains.size,

    reportedStatus,

    status: verified
      ? 'verified'
      : strong
        ? 'strong'
        : 'uncertain'
  };
}

/* ---------- Candidate management ---------- */

function mergeCandidates(candidates) {
  const grouped = new Map();

  for (const candidate of candidates) {
    const id = norm(candidate.title);

    if (!id) continue;

    const existing =
      grouped.get(id);

    if (!existing) {
      grouped.set(id, {
        ...candidate
      });

      continue;
    }

    if (
      candidate.type === 'tv' &&
      !existing.type
    ) {
      existing.type = 'tv';
    }

    if (
      !existing.year &&
      candidate.year
    ) {
      existing.year =
        candidate.year;
    }

    const priority = {
      poster: 6,
      lens_ai: 5,
      gemini: 4,
      recovery: 3,
      grounded_recovery: 2,
      lens: 1
    };

    if (
      (priority[candidate.source] || 0) >
      (priority[existing.source] || 0)
    ) {
      existing.source =
        candidate.source;

      existing.reason =
        candidate.reason;
    }
  }

  return [...grouped.values()]
    .slice(0, 10);
}

function rankResults(results) {
  return results.sort((a, b) => {
    const score = item =>
      item.lensEvidence.score +
      (item.source === 'lens_ai' ? 2 : 0) +
      (item.source === 'poster' ? 3 : 0) +
      (item.source === 'gemini' ? 1 : 0) +
      (
        item.typeEvidence?.tv >= 2 &&
        item.type === 'tv'
          ? 2
          : 0
      );

    return score(b) - score(a);
  });
}

/* ---------- API handler ---------- */

export default async function handler(req, res) {
  res.setHeader(
    'Cache-Control',
    'no-store'
  );

  res.setHeader(
    'Access-Control-Allow-Origin',
    '*'
  );

  res.setHeader(
    'Access-Control-Allow-Methods',
    'POST, OPTIONS'
  );

  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return send(res, 405, {
      error: 'Method not allowed'
    });
  }

  try {
    let body = req.body;

    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        return send(res, 400, {
          error: 'Invalid JSON'
        });
      }
    }

    const {
      image,
      clues = ''
    } = body || {};

    if (
      typeof clues !== 'string' ||
      clues.length > 1000
    ) {
      return send(res, 400, {
        error: 'Invalid clues'
      });
    }

    const imageData =
      parseImage(image);

    if (imageData?.tooLarge) {
      return send(res, 413, {
        error:
          'Screenshot is too large'
      });
    }

    if (!imageData) {
      return send(res, 400, {
        error:
          'Upload a valid JPG, PNG or WebP screenshot'
      });
    }

    const geminiKey =
      process.env.GEMINI_API_KEY;

    const lensKey =
      process.env.SERPAPI_API_KEY;

    const amodbKey =
      process.env.AMODB_API_KEY;

    if (!geminiKey && !lensKey) {
      return send(res, 503, {
        error:
          'SceneFinder is not configured'
      });
    }

    console.log(
      `SceneFinder V${VERSION} started`
    );

    /* First-pass discovery */

    const [lens, first] = await Promise.all([
      googleLens(
        imageData,
        lensKey
      ),

      geminiKey
        ? recognize(
            imageData,
            clues,
            geminiKey
          )
        : Promise.resolve({
            ok: false,
            status: 503,
            data: sanitize({})
          })
    ]);

    const rec = first.data;

    const lensHints =
      extractLensHints(lens);

    let lensAI = [];

    if (
      geminiKey &&
      lens?.matches?.length &&
      (
        !lensHints.length ||
        !rec.candidates.length
      )
    ) {
      lensAI = await interpretLens(
        lens,
        rec,
        geminiKey
      );
    }

    const candidates = [
      ...lensAI,
      ...rec.candidates,
      ...lensHints
    ];

    if (
      rec.imageType === 'poster' &&
      rec.visibleTitle
    ) {
      candidates.unshift({
        title: rec.visibleTitle,
        year: null,
        type: null,
        reason:
          'Title printed on poster',
        source: 'poster'
      });
    }

    const context = [
      rec.visualEvidence,
      rec.dialogue,
      clues
    ]
      .filter(Boolean)
      .join(' ');

    async function validateAll(input) {
      if (!amodbKey) {
        return [];
      }

      const checked = await Promise.all(
        input.map(candidate =>
          validateCandidate(
            candidate,
            amodbKey,
            lens,
            context
          )
        )
      );

      return rankResults(
        checked
          .filter(Boolean)
          .map(item => ({
            ...item,

            lensEvidence:
              lensEvidence(
                item.title,
                lens
              )
          }))
      );
    }

    let rawCandidates =
      mergeCandidates(candidates);

    let results =
      await validateAll(
        rawCandidates
      );

    /* Preserve V5.9 candidate recovery */

    let recoveryUsed = false;
    let recoveryCount = 0;
    let recoveryMethod = null;

    if (
      !results.length &&
      geminiKey
    ) {
      recoveryUsed = true;

      const recovered =
        await recoverCandidates(
          imageData,
          rec,
          lens,
          clues,
          geminiKey
        );

      recoveryCount +=
        recovered.length;

      if (recovered.length) {
        recoveryMethod =
          'visual_second_pass';
      }

      rawCandidates =
        mergeCandidates([
          ...rawCandidates,
          ...recovered
        ]);

      results = await validateAll(
        rawCandidates
      );

      if (!results.length) {
        const grounded =
          await groundedRecovery(
            rec,
            lens,
            clues,
            geminiKey
          );

        recoveryCount +=
          grounded.length;

        if (grounded.length) {
          recoveryMethod =
            'grounded_candidate_recovery';
        }

        rawCandidates =
          mergeCandidates([
            ...rawCandidates,
            ...grounded
          ]);

        results =
          await validateAll(
            rawCandidates
          );
      }
    }

    /* V6.0: Verify all validated scene candidates */

    let verification = null;

    if (
      geminiKey &&
      results.length > 0 &&
      rec.visualEvidence
    ) {
      verification = await verifyScene(
        rec,
        results.slice(0, 3),
        clues,
        geminiKey
      );
    }

    const groundedCandidate =
      verification?.title
        ? results.find(item =>
            sameTitle(
              item.title,
              verification.title
            )
          )
        : null;

    const posterCandidate =
      rec.imageType === 'poster' &&
      rec.visibleTitle
        ? results.find(item =>
            sameTitle(
              item.title,
              rec.visibleTitle
            )
          )
        : null;

    const selected =
      groundedCandidate ||
      posterCandidate ||
      results.find(item =>
        item.lensEvidence.count > 0
      ) ||
      results[0] ||
      null;

    const sceneProof = selected
      ? sceneEvidence(
          selected.title,
          lens
        )
      : {
          exactTitleMatches: 0,
          independentDomains: 0
        };

    /*
     * Verification route A:
     * Exact-image matches from multiple domains.
     *
     * Verification route B:
     * Grounded research with scene-specific evidence.
     *
     * AMODB title, poster and synopsis are not
     * sufficient for scene verification.
     */

    const lensVerified = Boolean(
      selected &&
      rec.imageType !== 'poster' &&
      sceneProof.exactTitleMatches >= 2 &&
      sceneProof.independentDomains >= 2
    );

    const researchVerified = Boolean(
      selected &&
      rec.imageType !== 'poster' &&
      groundedCandidate === selected &&
      verification?.supported &&
      verification?.independentDomains >= 2
    );

    const supported =
      lensVerified ||
      researchVerified;

    const strongMatch = Boolean(
      selected &&
      !supported &&
      (
        (
          groundedCandidate === selected &&
          verification?.strong
        ) ||
        (
          sceneProof.exactTitleMatches >= 1 &&
          selected.lensEvidence.score >= 3
        )
      )
    );

    const confidence = supported
      ? 'High'
      : strongMatch
        ? 'Medium'
        : 'Low';

    const verificationLevel = supported
      ? 'verified'
      : strongMatch
        ? 'strong'
        : 'unverified';

    const primary =
      selected?.match || null;

    const possibleMatches =
      results.map(item => ({
        title: item.title,
        year: item.year,
        type: item.type,
        reason: item.reason,

        overview:
          item.match?.overview || null,

        posterUrl:
          item.match?.posterUrl || null,

        verified:
          supported &&
          item === selected,

        confidence:
          item === selected
            ? confidence
            : 'Low',

        verificationLevel:
          item === selected
            ? verificationLevel
            : 'unverified',

        lensEvidenceCount:
          item.lensEvidence.count
      }));

    const sources = [
      ...new Set(
        verification?.sources || []
      )
    ].slice(0, 8);

    let answer;

    if (supported) {
      answer =
        `Verified scene: ${selected.title}. Independent evidence supports this identification.`;
    } else if (strongMatch) {
      answer =
        `Strong possible match: ${selected.title}. Distinctive evidence supports this identification, but the exact scene is not fully verified.`;
    } else if (selected) {
      answer =
        `Possible match: ${selected.title}. The production was identified, but the screenshot remains unverified.`;
    } else if (lens?.matches?.length) {
      answer =
        'Google Lens found results, but no production could be validated.';
    } else {
      answer =
        'No reliable title found. Try another screenshot.';
    }

    const diagnostics = {
      version: VERSION,

      lensStatus: lens
        ? 'ok'
        : lensKey
          ? Date.now() < lensCooldown
            ? 'quota_cooldown'
            : 'unavailable'
          : 'not_configured',

      lensResults:
        lens?.matches?.length || 0,

      geminiStatus: first.ok
        ? 'ok'
        : `unavailable_${first.status}`,

      rawCandidates:
        rawCandidates.length,

      validatedCandidates:
        results.length,

      metadataStatus: amodbKey
        ? 'configured'
        : 'not_configured',

      verificationStatus: verification
        ? 'completed'
        : 'not_completed',

      verificationLevel,

      verificationReportedStatus:
        verification?.reportedStatus || null,

      verificationSourceDomains:
        verification?.independentDomains || 0,

      parallelDiscovery: true,

      metadataSelection:
        'title_type_year_popularity_poster_context',

      sceneExactTitleMatches:
        sceneProof.exactTitleMatches,

      sceneIndependentDomains:
        sceneProof.independentDomains,

      recoveryUsed,
      recoveryCount,
      recoveryMethod
    };

    console.log(
      `SceneFinder V${VERSION} diagnostics`,
      JSON.stringify(diagnostics)
    );

    return send(res, 200, {
      success: true,

      answer,

      title:
        selected?.title || null,

      year:
        selected?.year || null,

      type:
        selected?.type || null,

      confidence,

      verificationLevel,

      identificationUncertain:
        !supported,

      visualEvidence:
        rec.visualEvidence,

      dialogue:
        rec.dialogue,

      socialContext:
        rec.socialContext,

      discoveryStatus: first.ok
        ? 'ok'
        : 'gemini_unavailable',

      verificationEvidence: supported
        ? (
            `Google Lens exact-image matches: ` +
            `${sceneProof.exactTitleMatches}; ` +
            `independent Lens domains: ` +
            `${sceneProof.independentDomains}. ` +
            `${verification?.evidence || ''}`
          ).trim()
        : verification?.evidence || null,

      verificationLimitations:
        verification?.limitations || null,

      possibleMatches,

      visualMatches:
        lens?.matches || [],

      visualSearchUsed:
        Boolean(lens),

      visualSearchProvider: lens
        ? 'SerpApi Google Lens'
        : null,

      posterUrl:
        primary?.posterUrl || null,

      poster:
        primary?.posterUrl || null,

      poster_path:
        primary?.poster_path || null,

      overview:
        primary?.overview || null,

      movieId:
        primary?.id || null,

      verified:
        supported,

      verificationMethod: supported
        ? lensVerified
          ? 'lens_exact_image_corroboration'
          : 'grounded_scene_research'
        : null,

      model:
        first.model || null,

      fallbackUsed:
        Boolean(first.fallbackUsed),

      searchGrounded:
        sources.length > 0,

      sources,

      metadataProvider: amodbKey
        ? 'AMODB'
        : null,

      metadataMatches:
        results
          .map(item => item.match)
          .filter(Boolean),

      diagnostics
    });
  } catch (error) {
    console.error(
      `SceneFinder V${VERSION} error`,
      error.message
    );

    return send(res, 500, {
      error:
        'SceneFinder encountered an unexpected error'
    });
  }
}
