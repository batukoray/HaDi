import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import type {
  HackerNewsItem,
  Story,
  StoryCache,
  StoryFeed,
  StoryLoadOptions,
  StoryLoadProgress,
} from "./types.js";
import { cutoffDaysAgo, extractDomain } from "./utils.js";

const API_ROOT = "https://hacker-news.firebaseio.com/v0";
const CACHE_DIRECTORY = path.join(process.cwd(), ".cache");
const CACHE_VERSION = 2;
const FETCH_BATCH_SIZE = 60;
const REQUEST_HEADERS = {
  "user-agent": "HN Weekline CLI/1.0",
};

const itemCache = new Map<number, HackerNewsItem | null>();

type ProgressHandler = (progress: StoryLoadProgress) => void;

export async function loadRecentStories(options: StoryLoadOptions, onProgress?: ProgressHandler): Promise<Story[]> {
  const cutoffMs = cutoffDaysAgo(options.days);
  const cachePath = getCachePath(options.feed, options.days);
  const cached = await readCache(cachePath, options);

  onProgress?.({
    coverageDays: cached ? Math.min(options.days, ageCoverageDays(cached.stories)) : 0,
    currentId: cached?.maxItem ?? 0,
    examined: 0,
    found: cached ? filterStoriesByCutoff(cached.stories, cutoffMs).length : 0,
    maxItem: cached?.maxItem ?? 0,
    message: cached
      ? "Warming from local cache before ranked-feed sync..."
      : "Requesting the ranked Hacker News story feed...",
    phase: "cache",
  });

  const rankedIds = await fetchJson<number[]>(`${API_ROOT}/${options.feed}.json`);
  const stories: Story[] = [];
  let examined = 0;

  for (let start = 0; start < rankedIds.length; start += FETCH_BATCH_SIZE) {
    const ids = rankedIds.slice(start, start + FETCH_BATCH_SIZE);
    const items = await fetchItems(ids, options.forceRefresh ?? false);

    for (const item of items) {
      examined += 1;

      if (!item || typeof item.time !== "number") {
        continue;
      }

      if ((item.time * 1000) < cutoffMs) {
        continue;
      }

      if (isRenderableStory(item)) {
        stories.push(mapStory(item));
      }
    }

    onProgress?.({
      coverageDays: Math.min(options.days, ageCoverageDays(stories)),
      currentId: Math.max(0, rankedIds.length - examined),
      examined,
      found: stories.length,
      maxItem: rankedIds.length,
      message: `Filtering ${feedLabel(options.feed)} for ${dayLabel(options.days)}...`,
      phase: "network",
    });
  }

  await writeCache(cachePath, {
    days: options.days,
    feed: options.feed,
    generatedAt: new Date().toISOString(),
    maxItem: rankedIds.length,
    stories,
    version: CACHE_VERSION,
  });

  return stories;
}

async function fetchItems(ids: number[], useCache: boolean): Promise<Array<HackerNewsItem | null>> {
  return Promise.all(ids.map((id) => fetchItem(id, useCache)));
}

async function fetchItem(id: number, useCache: boolean): Promise<HackerNewsItem | null> {
  const cached = itemCache.get(id);
  if (useCache && cached !== undefined) {
    return cached;
  }

  try {
    const item = await fetchJson<HackerNewsItem | null>(`${API_ROOT}/item/${id}.json`);
    itemCache.set(id, item);
    return item;
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: REQUEST_HEADERS,
        signal: AbortSignal.timeout(12_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      await sleep(150 * (attempt + 1));
    }
  }

  throw lastError;
}

function filterStoriesByCutoff(stories: Story[], cutoffMs: number): Story[] {
  return stories.filter((story) => (story.time * 1000) >= cutoffMs);
}

function ageCoverageDays(stories: Story[]): number {
  if (stories.length === 0) {
    return 0;
  }

  const oldestStoryTime = Math.min(...stories.map((story) => story.time * 1000));
  return (Date.now() - oldestStoryTime) / (24 * 60 * 60 * 1000);
}

function dayLabel(days: number): string {
  return `the last ${days} day${days === 1 ? "" : "s"}`;
}

function feedLabel(feed: StoryFeed): string {
  return feed === "topstories" ? "top stories" : feed;
}

function getCachePath(feed: StoryFeed, days: number): string {
  return path.join(CACHE_DIRECTORY, `${feed}-${days}d.json`);
}

function isRenderableStory(item: HackerNewsItem): boolean {
  return item.type === "story" && !item.dead && !item.deleted && Boolean(item.title);
}

function mapStory(item: HackerNewsItem): Story {
  return {
    by: item.by ?? "unknown",
    comments: item.descendants ?? 0,
    domain: extractDomain(item.url),
    id: item.id,
    score: item.score ?? 0,
    textHtml: item.text,
    time: item.time,
    title: item.title ?? "(untitled story)",
    url: item.url,
  };
}

async function readCache(cachePath: string, options: StoryLoadOptions): Promise<StoryCache | null> {
  try {
    const raw = await readFile(cachePath, "utf8");
    const parsed = JSON.parse(raw) as StoryCache;

    if (
      parsed.version !== CACHE_VERSION ||
      parsed.feed !== options.feed ||
      parsed.days !== options.days ||
      !Array.isArray(parsed.stories) ||
      typeof parsed.maxItem !== "number"
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function writeCache(cachePath: string, cache: StoryCache): Promise<void> {
  await mkdir(CACHE_DIRECTORY, { recursive: true });
  await writeFile(cachePath, JSON.stringify(cache, null, 2));
}
