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
  generatedAt: string;
  maxItem: number;
  stories: Story[];
  version: number;
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

export interface ArticleContent {
  body: string;
  footer: string;
  title: string;
}
