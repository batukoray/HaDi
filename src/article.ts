import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { blocksFromHtml, blocksFromPlainText, mergeArticleBlocks, trimDuplicateLeadingHeading } from "./article-format.js";
import type { ArticleContent, Story } from "./types.js";
import { extractDomain, htmlToPlainText, normalizeText } from "./utils.js";

const REQUEST_HEADERS = {
  "user-agent": "HackerDispatch CLI",
};

const articleCache = new Map<number, ArticleContent>();

export async function loadArticle(story: Story): Promise<ArticleContent> {
  const cached = articleCache.get(story.id);
  if (cached) {
    return cached;
  }

  const article = story.url ? await loadRemoteArticle(story) : buildTextPostArticle(story);
  articleCache.set(story.id, article);
  return article;
}

async function loadRemoteArticle(story: Story): Promise<ArticleContent> {
  try {
    const response = await fetch(story.url!, {
      headers: REQUEST_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!isTextLikeResponse(contentType)) {
      throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url: story.url });

    try {
      const parsed = new Readability(dom.window.document).parse();
      const mainHtml = parsed?.content ?? dom.window.document.body?.innerHTML ?? html;
      const title = resolveArticleTitle(parsed?.title, story.title);
      const storyBlocks = story.textHtml ? blocksFromHtml(story.textHtml) : [];
      const extractedBlocks = blocksFromHtml(mainHtml);
      const fallbackBlocks = extractedBlocks.length > 0 ? [] : blocksFromPlainText(htmlToPlainText(mainHtml, false));
      const blocks = trimDuplicateLeadingHeading(
        mergeArticleBlocks(storyBlocks, extractedBlocks.length > 0 ? extractedBlocks : fallbackBlocks),
        title,
      );

      return {
        blocks: blocks.length > 0
          ? blocks
          : blocksFromPlainText("The article loaded, but no readable text could be extracted for terminal display."),
        footer: `${extractDomain(story.url)} · terminal rendering`,
        title,
      };
    } finally {
      dom.window.close();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown fetch error";
    const fallbackBlocks = story.textHtml ? blocksFromHtml(story.textHtml) : [];
    const errorBlocks = blocksFromPlainText(
      `Article rendering fallback\n\nThe linked page could not be rendered cleanly in the terminal.\nReason: ${message}`,
    );

    return {
      blocks: mergeArticleBlocks(fallbackBlocks, errorBlocks),
      footer: `${story.domain} · fallback rendering`,
      title: story.title,
    };
  }
}

function buildTextPostArticle(story: Story): ArticleContent {
  return {
    blocks: story.textHtml
      ? blocksFromHtml(story.textHtml)
      : blocksFromPlainText("This HN story does not contain an external article or a self-post body."),
    footer: "Hacker News self-post",
    title: story.title,
  };
}

function isTextLikeResponse(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || contentType.includes("text/plain");
}

function resolveArticleTitle(parsedTitle: string | null | undefined, storyTitle: string): string {
  const normalizedStoryTitle = normalizeText(storyTitle);
  const normalizedParsedTitle = normalizeText(parsedTitle ?? "");

  if (!normalizedParsedTitle) {
    return normalizedStoryTitle;
  }

  const cleanedParsedTitle = stripSiteSuffix(normalizedParsedTitle);
  if (!cleanedParsedTitle) {
    return normalizedStoryTitle;
  }

  const comparableParsed = comparableText(cleanedParsedTitle);
  const comparableStory = comparableText(normalizedStoryTitle);

  if (
    comparableParsed &&
    comparableStory &&
    comparableStory.includes(comparableParsed) &&
    normalizedStoryTitle.length > cleanedParsedTitle.length + 8
  ) {
    return normalizedStoryTitle;
  }

  return cleanedParsedTitle;
}

function stripSiteSuffix(title: string): string {
  return title
    .replace(/\s+[|·•-]\s+[^|·•-]{2,40}$/u, "")
    .trim();
}

function comparableText(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
