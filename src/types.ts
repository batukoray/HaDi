export interface HackerNewsItem {
  id: number;
  type: string;
  by?: string;
  descendants?: number;
  dead?: boolean;
  deleted?: boolean;
  score?: number;
  text?: string;
  time: number;
  title?: string;
  url?: string;
}

export interface Story {
  id: number;
  title: string;
  by: string;
  comments: number;
  domain: string;
  score: number;
  textHtml?: string;
  time: number;
  url?: string;
}

export type StoryFeed = "topstories";

export interface StoryLoadOptions {
  days: number;
  feed: StoryFeed;
  forceRefresh?: boolean;
}

export interface StoryCache {
  days: number;
  feed: StoryFeed;
  format: number;
  generatedAt: string;
  maxItem: number;
  stories: Story[];
}

export interface StoryLoadProgress {
  coverageDays: number;
  currentId: number;
  examined: number;
  found: number;
  maxItem: number;
  message: string;
  phase: "cache" | "network";
}

export interface ArticleParagraphBlock {
  text: string;
  type: "paragraph";
}

export interface ArticleHeadingBlock {
  level: number;
  text: string;
  type: "heading";
}

export interface ArticleListBlock {
  items: string[];
  ordered: boolean;
  type: "list";
}

export interface ArticleQuoteBlock {
  blocks: ArticleBlock[];
  type: "quote";
}

export interface ArticleCodeBlock {
  text: string;
  type: "code";
}

export interface ArticleRuleBlock {
  type: "rule";
}

export type ArticleBlock =
  | ArticleParagraphBlock
  | ArticleHeadingBlock
  | ArticleListBlock
  | ArticleQuoteBlock
  | ArticleCodeBlock
  | ArticleRuleBlock;

export interface ArticleContent {
  blocks: ArticleBlock[];
  footer: string;
  title: string;
}
