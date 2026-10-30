import apiRequestRawHtml from "./apiRequest.js";
import { parse } from "node-html-parser";
import seriesFetcher from "./seriesFetcher.js";

const isoToSeconds = (d) => {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || "");
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
};

const fmtRuntime = (sec) => {
  if (!sec) return "";
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
};

// Fallback 1: schema.org JSON-LD block on the title page (present even when __NEXT_DATA__ is not)
async function fromJsonLd(id, dom) {
  for (const el of dom.querySelectorAll('script[type="application/ld+json"]')) {
    let ld;
    try { ld = JSON.parse(el.text); } catch { continue; }
    if (!ld || !ld.name) continue;
    const type = String(ld["@type"] || "");
    const isSeries = /TVSeries|TVMiniSeries/i.test(type);
    const date = ld.datePublished ? new Date(ld.datePublished) : null;
    const secs = isoToSeconds(ld.duration);
    return {
      id,
      review_api_path: `/reviews/${id}`,
      imdb: `https://www.imdb.com/title/${id}`,
      contentType: type,
      contentRating: ld.contentRating ?? "N/A",
      isSeries,
      productionStatus: "released",
      isReleased: true,
      title: ld.name,
      image: ld.image || "",
      images: ld.image ? [ld.image] : [],
      plot: ld.description || "",
      runtime: fmtRuntime(secs),
      runtimeSeconds: secs,
      rating: {
        count: ld.aggregateRating?.ratingCount ?? 0,
        star: Number(ld.aggregateRating?.ratingValue) || 0,
      },
      genre: Array.isArray(ld.genre) ? ld.genre : ld.genre ? [ld.genre] : [],
      releaseDetailed: {
        date: date ? date.toISOString() : null,
        day: date ? date.getUTCDate() : 0,
        month: date ? date.getUTCMonth() + 1 : 0,
        year: date ? date.getUTCFullYear() : 0,
      },
      year: date ? date.getUTCFullYear() : 0,
      ...(isSeries ? await seriesFetcher(id) : {}),
    };
  }
  return null;
}

// Fallback 2: public imdbapi.dev JSON API
async function fromImdbApiDev(id) {
  const res = await fetch(`https://api.imdbapi.dev/titles/${id}`, { headers: { accept: "application/json" } });
  if (!res.ok) return null;
  const t = await res.json();
  if (!t || !(t.primaryTitle || t.originalTitle)) return null;
  const isSeries = /tvSeries|tvMiniSeries/i.test(t.type || "");
  const secs = t.runtimeSeconds || 0;
  return {
    id,
    review_api_path: `/reviews/${id}`,
    imdb: `https://www.imdb.com/title/${id}`,
    contentType: t.type || "",
    contentRating: "N/A",
    isSeries,
    productionStatus: "released",
    isReleased: true,
    title: t.primaryTitle || t.originalTitle,
    image: t.primaryImage?.url || "",
    images: t.primaryImage?.url ? [t.primaryImage.url] : [],
    plot: t.plot || "",
    runtime: fmtRuntime(secs),
    runtimeSeconds: secs,
    rating: { count: t.rating?.voteCount ?? 0, star: t.rating?.aggregateRating ?? 0 },
    genre: t.genres || [],
    releaseDetailed: { date: null, day: 0, month: 0, year: t.startYear || 0 },
    year: t.startYear || 0,
    ...(isSeries ? await seriesFetcher(id) : {}),
  };
}

export default async function getTitle(id) {
  let dom = null;
  try {
    dom = parse(await apiRequestRawHtml(`https://www.imdb.com/title/${id}`));
    const nextData = dom.querySelector("#__NEXT_DATA__");
    if (nextData) return await fromNextData(id, JSON.parse(nextData.text));
  } catch (e) {
    console.log("NEXT_DATA parse failed:", e.message);
  }
  try {
    if (dom) {
      const r = await fromJsonLd(id, dom);
      if (r) return r;
    }
  } catch (e) {
    console.log("JSON-LD fallback failed:", e.message);
  }
  const r = await fromImdbApiDev(id);
  if (r) return r;
  throw new Error(`Unable to read IMDb title ${id} (page had no usable data)`);
}

async function fromNextData(id, json) {
  const props = json.props.pageProps;

  return {
    id: id,
    review_api_path: `/reviews/${id}`,
    imdb: `https://www.imdb.com/title/${id}`,
    contentType: props.aboveTheFoldData.titleType.id,
    contentRating: props.aboveTheFoldData?.certificate?.rating ?? "N/A",
    isSeries: props.aboveTheFoldData.titleType.isSeries,
    productionStatus: (props.aboveTheFoldData.productionStatus?.currentProductionStage?.id ?? "released"),
    isReleased: (props.aboveTheFoldData.productionStatus?.currentProductionStage?.id ?? "released") === "released",
    title: props.aboveTheFoldData.titleText.text,
    image: props.aboveTheFoldData.primaryImage?.url ?? "",
    images: (props.mainColumnData?.titleMainImages?.edges ?? [])
      .filter((e) => e.__typename === "ImageEdge")
      .map((e) => e.node.url),
    plot: props.aboveTheFoldData.plot?.plotText?.plainText ?? "",
    runtime: props.aboveTheFoldData.runtime?.displayableProperty?.value?.plainText ?? "",
    runtimeSeconds: props.aboveTheFoldData.runtime?.seconds ?? 0,
    rating: {
      count: props.aboveTheFoldData.ratingsSummary?.voteCount ?? 0,
      star: props.aboveTheFoldData.ratingsSummary?.aggregateRating ?? 0,
    },
    genre: (props.aboveTheFoldData.genres?.genres ?? []).map((e) => e.id),
    releaseDetailed: {
      date: new Date(
        props.aboveTheFoldData.releaseDate.year,
        props.aboveTheFoldData.releaseDate.month - 1,
        props.aboveTheFoldData.releaseDate.day
      ).toISOString(),
      day: props.aboveTheFoldData.releaseDate.day,
      month: props.aboveTheFoldData.releaseDate.month,
      year: props.aboveTheFoldData.releaseDate.year,
    },
    year: props.aboveTheFoldData.releaseDate.year,
    ...(props.aboveTheFoldData.titleType.isSeries ? await seriesFetcher(id) : {})
  };
}