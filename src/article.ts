import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import type { ArticleContent, Story } from "./types.js";
import { extractDomain, htmlToPlainText, normalizeText } from "./utils.js";

const REQUEST_HEADERS = {
  "user-agent": "HN Weekline CLI/1.0",
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
      const storyText = story.textHtml ? htmlToPlainText(story.textHtml, false) : "";
      const extractedText = htmlToPlainText(mainHtml, false);
      const body = mergeTextSections(storyText, extractedText);

      return {
        body: body || "The article loaded, but no readable text could be extracted for terminal display.",
        footer: `${extractDomain(story.url)} · terminal rendering`,
        title: normalizeText(parsed?.title ?? story.title),
      };
    } finally {
      dom.window.close();
    }
  } catch (error) {
    const fallbackText = story.textHtml ? htmlToPlainText(story.textHtml) : "";
    const message = error instanceof Error ? error.message : "Unknown fetch error";
    const body = fallbackText
      ? `${fallbackText}\n\nArticle rendering fallback\n\nThe linked page could not be rendered cleanly in the terminal.\nReason: ${message}`
      : `The linked page could not be rendered cleanly in the terminal.\n\nReason: ${message}`;

    return {
      body,
      footer: `${story.domain} · fallback rendering`,
      title: story.title,
    };
  }
}

function buildTextPostArticle(story: Story): ArticleContent {
  return {
    body: story.textHtml
      ? htmlToPlainText(story.textHtml, false)
      : "This HN story does not contain an external article or a self-post body.",
    footer: "Hacker News self-post",
    title: story.title,
  };
}

function isTextLikeResponse(contentType: string): boolean {
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml") || contentType.includes("text/plain");
}

function mergeTextSections(storyText: string, extractedText: string): string {
  const sections = [storyText, extractedText].filter(Boolean);
  return normalizeText(sections.join("\n\n"));
}
