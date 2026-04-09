import { createRequire } from "node:module";

import blessed from "blessed";

import { loadArticle } from "./article.js";
import { renderArticleBlocks } from "./article-format.js";
import { loadRecentStories } from "./hn-api.js";
import type { ArticleContent, Story, StoryLoadProgress } from "./types.js";
import { escapeTags, formatAge, formatCount, htmlToPlainText, padLeft, padRight, truncate } from "./utils.js";

const require = createRequire(import.meta.url);

const blessedColors = require("blessed/lib/colors") as {
  _cache: Record<number, number | undefined>;
  colors: string[];
  hexToRGB: (hex: string) => [number, number, number];
};

function forceTerminalColor(hex: string, fallbackIndex: number): void {
  const [r, g, b] = blessedColors.hexToRGB(hex);
  blessedColors._cache[(r << 16) | (g << 8) | b] = fallbackIndex;
}

// Blessed quantizes hex colors into the xterm palette. Without this override,
// #0c2c29 collapses into grayscale in the current terminal stack.
forceTerminalColor("#0c2c29", 23);

const DAY_WINDOWS = [1, 2, 3, 7] as const;
const FEED = "topstories";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const ARTICLE_ZOOM_PRESETS = [
  {
    blockSpacing: 1,
    bodyBold: false,
    label: "Dense",
    lineSpacing: 0,
    measureTighten: -6,
  },
  {
    blockSpacing: 1,
    bodyBold: false,
    label: "Standard",
    lineSpacing: 0,
    measureTighten: 0,
  },
  {
    blockSpacing: 2,
    bodyBold: false,
    label: "Comfort",
    lineSpacing: 0,
    measureTighten: 12,
  },
  {
    blockSpacing: 3,
    bodyBold: true,
    label: "Large",
    lineSpacing: 1,
    measureTighten: 24,
  },
] as const;
const THEME = {
  accent: "#ff9a52",
  accentMuted: "#f4c095",
  bg: "#07131d",
  border: "#294053",
  borderSoft: "#1b3142",
  highlight: "#26867c",
  panel: "#10202d",
  panelAlt: "#0c1824",
  selected: "#26867c",
  selectedAccent: "#26867c",
  text: "#f6f2e9",
  textMuted: "#8ba3b7",
  textSoft: "#c7d7e2",
};

type DayWindow = typeof DAY_WINDOWS[number];
type ViewState = "article" | "article-loading" | "fatal" | "list" | "loading";
type InternalScrollableBox = blessed.Widgets.BoxElement & {
  _clines?: {
    content?: string;
    width?: number;
  };
  content?: string;
  iwidth?: number;
  parseContent: (noTags?: boolean) => boolean;
  width?: number | string;
};

export class HackerNewsCli {
  private activeArticle?: ArticleContent;
  private readonly articleBody: blessed.Widgets.BoxElement;
  private readonly articleFooter: blessed.Widgets.BoxElement;
  private readonly articleHeader: blessed.Widgets.BoxElement;
  private readonly articleShell: blessed.Widgets.BoxElement;
  private clockFrameIndex = 0;
  private articleZoomIndex = 1;
  private pendingArticleScrollDelta = 0;
  private articleScrollTimer?: NodeJS.Timeout;
  private readonly articleRenderCache = new Map<string, string>();
  private activeArticleStory?: Story;
  private activeArticleFooter = "";
  private currentArticleRequest = 0;
  private readonly clockBox: blessed.Widgets.BoxElement;
  private clockTimer?: NodeJS.Timeout;
  private dayWindow: DayWindow = 7;
  private readonly feed = FEED;
  private readonly footer: blessed.Widgets.BoxElement;
  private readonly header: blessed.Widgets.BoxElement;
  private lastRefreshAt?: number;
  private readonly list: blessed.Widgets.ListElement;
  private readonly listPanel: blessed.Widgets.BoxElement;
  private listRows: string[] = [];
  private listRowsDirty = true;
  private readonly loadingBody: blessed.Widgets.BoxElement;
  private readonly loadingShell: blessed.Widgets.BoxElement;
  private pendingStoryCount = 0;
  private readonly previewExcerptCache = new Map<number, string>();
  private readonly preview: blessed.Widgets.BoxElement;
  private readonly previewPanel: blessed.Widgets.BoxElement;
  private previewUpdateTimer?: NodeJS.Timeout;
  private refreshInFlight = false;
  private renderScheduled = false;
  private renderTimer?: NodeJS.Timeout;
  private refreshTimer?: NodeJS.Timeout;
  private selectedIndex = 0;
  private readonly screen: blessed.Widgets.Screen;
  private spinnerFrameIndex = 0;
  private spinnerTimer?: NodeJS.Timeout;
  private stories: Story[] = [];
  private view: ViewState = "loading";

  public constructor() {
    this.screen = blessed.screen({
      autoPadding: false,
      fastCSR: true,
      fullUnicode: true,
      smartCSR: true,
      title: "HackerDispatch",
    });

    this.screen.program.hideCursor();
    this.screen.key(["C-c"], () => this.exit());
    this.screen.key(["up"], () => {
      this.handleUp();
    });
    this.screen.key(["down"], () => {
      this.handleDown();
    });
    this.screen.on("key right", () => {
      this.suppressFocusedKeyHandling();
      void this.handleRight();
    });
    this.screen.on("key left", () => {
      this.suppressFocusedKeyHandling();
      this.handleLeft();
    });
    this.screen.key(["enter"], () => {
      void this.handleEnter();
    });
    this.screen.key(["escape"], () => {
      this.handleEscape();
    });
    this.screen.key(["pageup"], () => {
      this.scrollArticle(-Math.max(8, this.screenHeight() - 14));
    });
    this.screen.key(["pagedown", "space"], () => {
      this.scrollArticle(Math.max(8, this.screenHeight() - 14));
    });
    this.screen.key(["+", "="], () => {
      this.handleArticleZoom(1);
    });
    this.screen.key(["-", "_"], () => {
      this.handleArticleZoom(-1);
    });
    this.screen.key(["home"], () => {
      this.handleHome();
    });
    this.screen.key(["end"], () => {
      this.handleEnd();
    });
    this.screen.key(["1"], () => {
      void this.handleDayWindow(1);
    });
    this.screen.key(["2"], () => {
      void this.handleDayWindow(2);
    });
    this.screen.key(["3"], () => {
      void this.handleDayWindow(3);
    });
    this.screen.key(["7"], () => {
      void this.handleDayWindow(7);
    });
    this.screen.on("resize", () => {
      if (this.view === "list") {
        this.markListRowsDirty();
        this.renderList();
        this.updatePreview();
      }
      if (this.view === "article" && this.activeArticle && this.activeArticleStory) {
        this.renderActiveArticle(this.activeArticleStory, this.activeArticle, false);
      }
      this.renderHeader();
      this.renderFooter();
      this.screen.render();
    });

    this.header = blessed.box({
      height: 3,
      left: 0,
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        bg: THEME.panel,
        fg: THEME.text,
      },
      tags: true,
      top: 0,
      width: "100%",
    });

    this.listPanel = blessed.box({
      border: "line",
      height: "100%-6",
      label: " Top Stories · Last 7 Days ",
      left: 0,
      style: {
        bg: THEME.panel,
        border: {
          fg: THEME.border,
        },
        fg: THEME.text,
      },
      tags: true,
      top: 3,
      width: "66%",
    });

    this.list = blessed.list({
      alwaysScroll: true,
      bottom: 0,
      keys: false,
      left: 1,
      mouse: false,
      padding: {
        left: 0,
        right: 0,
      },
      scrollbar: {
        ch: " ",
        track: {
          bg: THEME.panel,
        },
        style: {
          bg: THEME.accent,
        },
      },
      style: {
        bg: THEME.panel,
        fg: THEME.textSoft,
        item: {
          bg: THEME.panel,
          fg: THEME.textSoft,
        },
        selected: {
          bg: THEME.selected,
          bold: true,
          fg: THEME.text,
        },
      },
      tags: true,
      top: 1,
      vi: false,
      width: "100%-2",
    });

    this.previewPanel = blessed.box({
      border: "line",
      height: "100%-6",
      label: " Story Focus ",
      left: "66%",
      style: {
        bg: THEME.panelAlt,
        border: {
          fg: THEME.border,
        },
        fg: THEME.text,
      },
      tags: true,
      top: 3,
      width: "34%",
    });

    this.preview = blessed.box({
      bottom: 0,
      left: 1,
      scrollable: true,
      style: {
        bg: THEME.panelAlt,
        fg: THEME.text,
      },
      tags: true,
      top: 1,
      width: "100%-2",
      wrap: true,
    });

    this.footer = blessed.box({
      bottom: 0,
      height: 3,
      left: 0,
      padding: {
        left: 1,
        right: 1,
      },
      style: {
        bg: THEME.panel,
        fg: THEME.textMuted,
      },
      tags: true,
      width: "100%",
    });

    this.clockBox = blessed.box({
      align: "center",
      bottom: 1,
      height: 1,
      hidden: true,
      right: 1,
      style: {
        bg: THEME.panel,
        fg: THEME.textSoft,
      },
      tags: true,
      width: 26,
    });

    this.loadingShell = blessed.box({
      align: "left",
      border: "line",
      height: 12,
      left: "center",
      style: {
        bg: THEME.panel,
        border: {
          fg: THEME.border,
        },
        fg: THEME.text,
      },
      tags: true,
      top: "center",
      width: "70%",
    });

    this.loadingBody = blessed.box({
      bottom: 1,
      left: 2,
      right: 2,
      style: {
        bg: THEME.panel,
        fg: THEME.textSoft,
      },
      tags: true,
      top: 1,
      wrap: true,
    });

    this.articleShell = blessed.box({
      bg: THEME.bg,
      height: "100%",
      hidden: true,
      left: 0,
      top: 0,
      width: "100%",
    });

    this.articleHeader = blessed.box({
      align: "center",
      height: 5,
      left: 0,
      padding: {
        left: 2,
        right: 2,
      },
      style: {
        bg: THEME.bg,
        fg: THEME.text,
      },
      tags: true,
      top: 0,
      width: "100%",
      wrap: true,
    });

    this.articleBody = blessed.box({
      alwaysScroll: true,
      bottom: 2,
      keys: false,
      left: 0,
      padding: {
        left: 2,
        right: 2,
      },
      scrollable: true,
      scrollbar: {
        ch: " ",
        track: {
          bg: THEME.bg,
        },
        style: {
          bg: THEME.accent,
        },
      },
      style: {
        bg: THEME.bg,
        fg: THEME.textSoft,
      },
      tags: true,
      top: 5,
      vi: false,
      width: "100%",
      wrap: false,
    });

    this.articleFooter = blessed.box({
      bottom: 0,
      height: 2,
      left: 0,
      style: {
        bg: THEME.bg,
        fg: THEME.textMuted,
      },
      tags: true,
      width: "100%",
    });

    this.installArticleBodyOptimizations();

    this.listPanel.append(this.list);
    this.previewPanel.append(this.preview);
    this.loadingShell.append(this.loadingBody);
    this.articleShell.append(this.articleHeader);
    this.articleShell.append(this.articleBody);
    this.articleShell.append(this.articleFooter);

    this.screen.append(this.header);
    this.screen.append(this.listPanel);
    this.screen.append(this.previewPanel);
    this.screen.append(this.footer);
    this.screen.append(this.clockBox);
    this.screen.append(this.loadingShell);
    this.screen.append(this.articleShell);

    this.renderHeader();
    this.renderFooter();
    this.startClock();
    this.showLoadingShell();
    this.startSpinner();
    this.screen.render();
  }

  public async start(): Promise<void> {
    try {
      this.updateLoading({
        coverageDays: 0,
        currentId: 0,
        examined: 0,
        found: 0,
        maxItem: 0,
        message: "Loading the ranked Hacker News top stories...",
        phase: "network",
      });
      this.stories = await loadRecentStories(this.storyQuery(), (progress) => this.updateLoading(progress));

      if (this.stories.length === 0) {
        throw new Error(`No stories were returned for ${this.dayWindowLabel().toLowerCase()}.`);
      }

      this.showListView();
      this.lastRefreshAt = Date.now();
      this.selectedIndex = Math.min(this.selectedIndex, this.stories.length - 1);
      this.markListRowsDirty();
      this.renderHeader();
      this.renderFooter();
      this.renderList();
      this.updatePreview();
      this.startBackgroundRefresh();
      this.screen.render();
    } catch (error) {
      this.stopSpinner();
      this.view = "fatal";
      this.loadingShell.show();
      this.listPanel.hide();
      this.previewPanel.hide();
      this.articleShell.hide();
      const message = error instanceof Error ? error.message : "Unknown startup error";
      this.loadingBody.setContent(
        `{bold}Unable to start {${THEME.selectedAccent}-fg}HackerDispatch{/}{/bold}\n\n${message}\n\nPress {bold}Esc{/bold} to exit.`,
      );
      this.renderHeader();
      this.renderFooter();
      this.screen.render();
    }
  }

  private currentStory(): Story {
    return this.stories[this.selectedIndex]!;
  }

  private currentSpinner(): string {
    return SPINNER_FRAMES[this.spinnerFrameIndex] ?? SPINNER_FRAMES[0]!;
  }

  private exit(): void {
    this.stopArticleScrollScheduler();
    this.stopBackgroundRefresh();
    this.stopClock();
    this.stopPreviewScheduler();
    this.stopSpinner();
    this.stopRenderScheduler();
    this.screen.destroy();
    process.exit(0);
  }

  private handleDown(): void {
    if (this.view === "list") {
      this.moveSelection(1);
      return;
    }

    if (this.view === "article") {
      this.scrollArticle(4);
    }
  }

  private async handleDayWindow(days: DayWindow): Promise<void> {
    if (this.view !== "list" || this.dayWindow === days || this.refreshInFlight) {
      return;
    }

    this.stopPreviewScheduler();
    const previousDayWindow = this.dayWindow;
    const previousStories = this.stories;
    const previousSelectedId = previousStories[this.selectedIndex]?.id;

    this.dayWindow = days;
    this.pendingStoryCount = 0;
    this.updateLoading({
      coverageDays: 0,
      currentId: 0,
      examined: 0,
      found: 0,
      maxItem: 0,
      message: `Loading ${this.feedLabel()} for ${this.dayWindowLabel().toLowerCase()}...`,
      phase: "network",
    });

    try {
      this.refreshInFlight = true;
      this.stories = await loadRecentStories(this.storyQuery(), (progress) => this.updateLoading(progress));
      this.lastRefreshAt = Date.now();
      this.markListRowsDirty();
      this.showListView(previousSelectedId);
      this.renderList();
      this.updatePreview();
      this.screen.render();
    } catch {
      this.dayWindow = previousDayWindow;
      this.stories = previousStories;
      this.markListRowsDirty();
      this.showListView(previousSelectedId);
      this.renderList();
      this.updatePreview();
      this.screen.render();
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async handleEnter(): Promise<void> {
    if (this.view !== "list" || this.stories.length === 0) {
      return;
    }

    this.stopPreviewScheduler();
    const story = this.currentStory();
    this.currentArticleRequest += 1;
    const requestId = this.currentArticleRequest;
    this.view = "article-loading";
    this.activeArticle = undefined;
    this.activeArticleStory = story;
    this.listPanel.hide();
    this.previewPanel.hide();
    this.loadingShell.hide();
    this.articleShell.show();
    this.activeArticleFooter = "";
    this.renderArticleLoadingState(story);
    this.renderHeader();
    this.screen.render();

    const article = await loadArticle(story);
    if (requestId !== this.currentArticleRequest) {
      return;
    }

    this.showArticle(story, article);
  }

  private handleArticleZoom(delta: number): void {
    if (this.view !== "article" && this.view !== "article-loading") {
      return;
    }

    const nextIndex = Math.max(0, Math.min(ARTICLE_ZOOM_PRESETS.length - 1, this.articleZoomIndex + delta));
    if (nextIndex === this.articleZoomIndex) {
      return;
    }

    this.articleZoomIndex = nextIndex;
    this.renderHeader();

    if (this.view === "article" && this.activeArticle && this.activeArticleStory) {
      this.renderActiveArticle(this.activeArticleStory, this.activeArticle, false);
      this.screen.render();
      return;
    }

    if (this.view === "article-loading" && this.activeArticleStory) {
      this.articleHeader.setContent(
        this.renderArticleHeader(
          this.activeArticleStory.title,
          `by ${this.activeArticleStory.by} · ${this.activeArticleStory.domain} · ${formatAge(this.activeArticleStory.time)} old`,
        ),
      );
    }
    this.renderArticleFooter();
    this.scheduleRender(0);
  }

  private handleLeft(): void {
    if (this.view === "list") {
      return;
    }

    if (this.view === "article" || this.view === "article-loading") {
      this.handleEscape();
    }
  }

  private async handleRight(): Promise<void> {
    if (this.view === "list") {
      await this.handleEnter();
    }
  }

  private handleEscape(): void {
    if (this.view === "article" || this.view === "article-loading") {
      this.currentArticleRequest += 1;
      this.view = "list";
      this.stopArticleScrollScheduler();
      this.activeArticle = undefined;
      this.activeArticleStory = undefined;
      this.pendingStoryCount = 0;
      this.articleShell.hide();
      this.loadingShell.hide();
      this.listPanel.show();
      this.previewPanel.show();
      this.renderHeader();
      this.renderFooter();
      this.renderList();
      this.updatePreview();
      this.screen.render();
      return;
    }

    this.exit();
  }

  private suppressFocusedKeyHandling(): void {
    if (this.screen.grabKeys) {
      return;
    }

    this.screen.grabKeys = true;
    process.nextTick(() => {
      this.screen.grabKeys = false;
    });
  }

  private handleEnd(): void {
    if (this.view === "list") {
      this.selectedIndex = this.stories.length - 1;
      this.syncListSelection();
      this.renderHeader();
      this.schedulePreviewUpdate();
      this.scheduleRender();
      return;
    }

    if (this.view === "article") {
      this.stopArticleScrollScheduler();
      this.articleBody.setScrollPerc(100);
      this.screen.render();
    }
  }

  private handleHome(): void {
    if (this.view === "list") {
      this.selectedIndex = 0;
      this.syncListSelection();
      this.renderHeader();
      this.schedulePreviewUpdate();
      this.scheduleRender();
      return;
    }

    if (this.view === "article") {
      this.stopArticleScrollScheduler();
      this.articleBody.setScrollPerc(0);
      this.screen.render();
    }
  }

  private handleUp(): void {
    if (this.view === "list") {
      this.moveSelection(-1);
      return;
    }

    if (this.view === "article") {
      this.scrollArticle(-4);
    }
  }

  private moveSelection(delta: number): void {
    if (this.stories.length === 0) {
      return;
    }

    const nextIndex = Math.max(0, Math.min(this.stories.length - 1, this.selectedIndex + delta));
    if (nextIndex === this.selectedIndex) {
      return;
    }

    this.selectedIndex = nextIndex;
    this.syncListSelection();
    this.renderHeader();
    this.schedulePreviewUpdate();
    this.scheduleRender();
  }

  private renderArticleHeader(title: string, subtitle: string): string {
    const dividerWidth = Math.max(24, Math.min(this.screenWidth() - 18, 68));
    return (
      `\n{bold}${escapeTags(title)}{/bold}\n` +
      `{gray-fg}${escapeTags(subtitle)}{/gray-fg}\n` +
      `{${THEME.borderSoft}-fg}${"─".repeat(dividerWidth)}{/}`
    );
  }

  private renderArticleLoadingState(story: Story): void {
    this.articleHeader.setContent(
      this.renderArticleHeader(story.title, `by ${story.by} · ${story.domain} · ${formatAge(story.time)} old`),
    );
    this.articleBody.setContent(
      `${this.currentSpinner()} Rendering article...\n\nPulling the page into a readable terminal layout.`,
    );
    this.renderArticleFooter();
  }

  private renderFooter(): void {
    if (this.view === "article" || this.view === "article-loading") {
      this.footer.hide();
      this.clockBox.hide();
      return;
    }

    const selector = this.renderDayWindowSelector();
    const dividerWidth = Math.max(24, this.screenWidth() - 4);
    const storiesLabel = `{bold}${this.stories.length}{/bold} {gray-fg}stories{/gray-fg}`;

    this.footer.show();
    this.footer.setContent(
      `{${THEME.border}-fg}${"─".repeat(dividerWidth)}{/}\n` +
      ` {${THEME.textMuted}-fg}NAV{/} {${THEME.textSoft}-fg}↑{/}/{${THEME.textSoft}-fg}↓{/} move  {gray-fg}•{/} ` +
      `{${THEME.textMuted}-fg}OPEN{/} {${THEME.textSoft}-fg}Enter{/}/{${THEME.textSoft}-fg}→{/}  {gray-fg}•{/} ` +
      `{${THEME.textMuted}-fg}RANGE{/} ${selector}  {gray-fg}•{/} ` +
      `{${THEME.textMuted}-fg}EXIT{/} {${THEME.textSoft}-fg}Esc{/}  {gray-fg}•{/} ${storiesLabel}`,
    );
    this.renderClock();
  }

  private renderHeader(): void {
    const totalStories = this.stories.length;
    const selected = totalStories > 0 ? this.selectedIndex + 1 : 0;
    const subtitle = this.view === "article" || this.view === "article-loading"
      ? "Full article reader"
      : `${this.feedLabel()} · ${this.dayWindowLabel()}`;
    const marker = this.view === "loading" || this.view === "article-loading" || this.view === "fatal"
      ? this.currentSpinner()
      : "◆";
    const refreshStatus = this.pendingStoryCount > 0
      ? `{${THEME.highlight}-fg}${this.pendingStoryCount} new{/} {gray-fg}waiting{/gray-fg}`
      : this.lastRefreshAt
        ? `{gray-fg}synced ${this.formatClock(this.lastRefreshAt)}{/gray-fg}`
        : "{gray-fg}standby{/gray-fg}";
    const dividerWidth = Math.max(24, this.screenWidth() - 4);

    this.header.setContent(
      `{bold}{${THEME.selectedAccent}-fg}${marker} HackerDispatch{/}{/bold} {${THEME.accentMuted}-fg}•{/} {gray-fg}${subtitle}{/gray-fg}\n` +
      `{${THEME.highlight}-fg}${selected}/${totalStories}{/} {gray-fg}selected{/gray-fg}   {${THEME.accent}-fg}${this.feedLabel()}{/}   ${refreshStatus}\n` +
      `{${THEME.borderSoft}-fg}${"─".repeat(dividerWidth)}{/}`,
    );
  }

  private renderList(): void {
    this.ensureListRows();
    this.syncListSelection();
    this.renderHeader();
    this.renderFooter();
  }

  private ensureListRows(): void {
    if (!this.listRowsDirty) {
      return;
    }

    const width = Math.max(36, Math.floor(this.screenWidth() * 0.66) - 6);
    const ageWidth = 4;
    const domainWidth = Math.min(18, Math.max(14, Math.floor(width * 0.2)));
    const scoreWidth = 6;
    const commentsWidth = 6;
    const titleWidth = Math.max(10, width - ageWidth - domainWidth - scoreWidth - commentsWidth - 10);

    const rows = this.stories.map((story) => {
      const age = escapeTags(padLeft(formatAge(story.time), ageWidth));
      const title = escapeTags(padRight(truncate(story.title, titleWidth), titleWidth));
      const domain = escapeTags(padRight(truncate(story.domain, domainWidth), domainWidth));
      const score = escapeTags(padLeft(`${formatCount(story.score)}↑`, scoreWidth));
      const comments = escapeTags(padLeft(`${formatCount(story.comments)}c`, commentsWidth));

      return `{${THEME.borderSoft}-fg}▏{/} {#9db4c7-fg}${age}{/} {bold}${title}{/bold} {gray-fg}·{/} {#7ab8e0-fg}${domain}{/} {gray-fg}·{/} {#f7d28a-fg}${score}{/} {#ffb787-fg}${comments}{/}`;
    });

    this.listPanel.setLabel(` {${THEME.accent}-fg}Newswire{/} {gray-fg}· ${this.dayWindowLabel()}{/} `);
    this.listRows = rows;
    this.list.setItems(this.listRows);
    this.listRowsDirty = false;
  }

  private markListRowsDirty(): void {
    this.listRowsDirty = true;
  }

  private syncListSelection(): void {
    this.ensureListRows();

    if (this.stories.length === 0) {
      this.list.select(0);
      this.list.scrollTo(0);
      return;
    }

    this.list.select(this.selectedIndex);
    this.list.scrollTo(Math.max(0, this.selectedIndex - Math.floor((this.screenHeight() - 9) / 2)));
  }

  private scrollArticle(delta: number): void {
    if (this.view !== "article") {
      return;
    }

    this.pendingArticleScrollDelta += delta;
    this.scheduleArticleScroll();
  }

  private showArticle(story: Story, article: ArticleContent): void {
    this.view = "article";
    this.stopArticleScrollScheduler();
    this.activeArticle = article;
    this.activeArticleStory = story;
    this.renderActiveArticle(story, article, true);
    this.articleBody.focus();
    this.renderHeader();
    this.screen.render();
  }

  private renderActiveArticle(story: Story, article: ArticleContent, resetScroll: boolean): void {
    this.activeArticleFooter = article.footer;
    const subtitle = `by ${story.by} · ${story.domain} · ${formatAge(story.time)} old · ${formatCount(story.score)} points · ${formatCount(story.comments)} comments`;
    const previousScrollPerc = this.articleBody.getScrollPerc();

    this.articleHeader.setContent(this.renderArticleHeader(article.title, subtitle));
    this.articleBody.setContent(this.renderArticleBody(article));
    if (resetScroll) {
      this.articleBody.setScrollPerc(0);
    } else {
      this.articleBody.setScrollPerc(previousScrollPerc);
    }
    this.renderArticleFooter();
  }

  private showLoadingShell(): void {
    this.view = "loading";
    this.articleShell.hide();
    this.clockBox.hide();
    this.listPanel.hide();
    this.previewPanel.hide();
    this.footer.hide();
    this.loadingShell.show();
  }

  private startSpinner(): void {
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;

      if (this.view === "loading" || this.view === "article-loading" || this.view === "fatal") {
        if (this.view === "article-loading" && this.activeArticleStory) {
          this.renderArticleLoadingState(this.activeArticleStory);
        }
        this.renderHeader();
        this.scheduleRender();
      }
    }, 500);
  }

  private startClock(): void {
    this.stopClock();
    this.clockFrameIndex = 0;
    this.renderClock();
    this.clockTimer = setInterval(() => {
      if (this.view !== "list") {
        return;
      }

      this.clockFrameIndex = (this.clockFrameIndex + 1) % 4;
      this.renderClock();
      this.scheduleRender(0);
    }, 1_000);
  }

  private startBackgroundRefresh(): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshStories();
    }, 60_000);
  }

  private stopClock(): void {
    if (this.clockTimer) {
      clearInterval(this.clockTimer);
      this.clockTimer = undefined;
    }
  }

  private stopArticleScrollScheduler(): void {
    this.pendingArticleScrollDelta = 0;

    if (this.articleScrollTimer) {
      clearTimeout(this.articleScrollTimer);
      this.articleScrollTimer = undefined;
    }
  }

  private stopSpinner(): void {
    if (this.spinnerTimer) {
      clearInterval(this.spinnerTimer);
      this.spinnerTimer = undefined;
    }
  }

  private stopBackgroundRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }

  private stopPreviewScheduler(): void {
    if (this.previewUpdateTimer) {
      clearTimeout(this.previewUpdateTimer);
      this.previewUpdateTimer = undefined;
    }
  }

  private stopRenderScheduler(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }

    this.renderScheduled = false;
  }

  private installArticleBodyOptimizations(): void {
    const articleBody = this.articleBody as InternalScrollableBox;
    const originalParseContent = articleBody.parseContent.bind(articleBody);

    articleBody.parseContent = (noTags?: boolean): boolean => {
      const width = typeof articleBody.width === "number"
        ? articleBody.width - (articleBody.iwidth ?? 0)
        : this.screenWidth() - 4;

      if (
        this.view === "article" &&
        this.activeArticle &&
        articleBody._clines &&
        articleBody._clines.width === width &&
        articleBody._clines.content === articleBody.content
      ) {
        return false;
      }

      return originalParseContent(noTags);
    };
  }

  private updateLoading(progress: StoryLoadProgress): void {
    this.view = "loading";
    this.showLoadingShell();
    this.renderHeader();

    const coverage = Math.min(7, progress.coverageDays).toFixed(1);
    const remaining = progress.maxItem > 0 ? formatCount(Math.max(0, progress.currentId)) : "0";
    const lineWidth = this.loadingLineWidth();
    const title = truncate(`${this.currentSpinner()} Building the ${this.feedLabel().toLowerCase()} feed`, lineWidth);
    const message = truncate(progress.message, lineWidth);
    const storiesLine = truncate(`${formatCount(progress.found)} stories found`, lineWidth);
    const examinedLine = truncate(`${formatCount(progress.examined)} HN items examined`, lineWidth);
    const coverageLine = truncate(`${coverage} / ${this.dayWindow.toFixed(1)} days covered`, lineWidth);
    const remainingLine = truncate(`${remaining} ranked stories left to inspect`, lineWidth);

    this.loadingBody.setContent(
      `{bold}${escapeTags(title)}{/bold}\n\n${escapeTags(message)}\n\n` +
      `{#7ab8e0-fg}${escapeTags(storiesLine)}{/}\n` +
      `{#f7d28a-fg}${escapeTags(examinedLine)}{/}\n` +
      `{#ffb787-fg}${escapeTags(coverageLine)}{/}\n` +
      `{gray-fg}${escapeTags(remainingLine)}{/gray-fg}`,
    );

    this.screen.render();
  }

  private updatePreview(): void {
    if (this.stories.length === 0) {
      this.preview.setContent("No story selected.");
      return;
    }

    const story = this.currentStory();
    const dividerWidth = Math.max(16, Math.min(28, this.screenWidth() - Math.floor(this.screenWidth() * 0.66) - 8));
    const excerpt = story.textHtml
      ? this.cachedPreviewExcerpt(story)
      : "No self-post text is attached to this story. Press Enter to render the linked page directly in the terminal reader.";

    this.previewPanel.setLabel(` {${THEME.highlight}-fg}Story Focus{/} {gray-fg}· ${escapeTags(story.domain)}{/} `);

    this.preview.setContent(
      `{bold}${escapeTags(story.title)}{/bold}\n` +
      `{${THEME.borderSoft}-fg}${"─".repeat(dividerWidth)}{/}\n\n` +
      `{#7ab8e0-fg}${formatCount(story.score)}{/} {gray-fg}points{/gray-fg}   ` +
      `{#ffb787-fg}${formatCount(story.comments)}{/} {gray-fg}comments{/gray-fg}   ` +
      `{#f7d28a-fg}${formatAge(story.time)}{/} {gray-fg}old{/gray-fg}\n` +
      `{gray-fg}by ${escapeTags(story.by)} · ${escapeTags(story.domain)}{/gray-fg}\n\n` +
      `${excerpt}\n\n` +
      `{${THEME.borderSoft}-fg}${"─".repeat(dividerWidth)}{/}\n` +
      `{#9db4c7-fg}Press Enter or Right Arrow to open the reader. Esc or Left Arrow returns from the reader back to this list.{/}`,
    );
    this.preview.setScrollPerc(0);
  }

  private async refreshStories(): Promise<void> {
    if (this.refreshInFlight || this.view === "fatal" || this.view === "loading") {
      return;
    }

    this.refreshInFlight = true;

    try {
      const previousStories = this.stories;
      const previousSelectedId = previousStories[this.selectedIndex]?.id;
      const previousIds = new Set(previousStories.map((story) => story.id));
      const refreshedStories = await loadRecentStories(this.storyQuery(true));

      if (refreshedStories.length === 0) {
        return;
      }

      const newStoryCount = refreshedStories.reduce((count, story) => count + Number(!previousIds.has(story.id)), 0);

      this.stories = refreshedStories;
      this.lastRefreshAt = Date.now();

      const preservedIndex = previousSelectedId
        ? refreshedStories.findIndex((story) => story.id === previousSelectedId)
        : -1;

      this.selectedIndex = preservedIndex >= 0
        ? preservedIndex
        : Math.min(this.selectedIndex, Math.max(0, refreshedStories.length - 1));

      if (this.view === "list") {
        this.pendingStoryCount = 0;
        this.markListRowsDirty();
        this.renderList();
        this.updatePreview();
        this.screen.render();
        return;
      }

      if (newStoryCount > 0) {
        this.pendingStoryCount += newStoryCount;
      }

      if (this.view === "article" || this.view === "article-loading") {
        this.renderHeader();
        this.renderArticleFooter();
        this.screen.render();
      }
    } catch {
      this.lastRefreshAt = Date.now();
      this.renderHeader();
      this.renderFooter();
      if (this.view === "article" || this.view === "article-loading") {
        this.renderArticleFooter();
      }
      this.screen.render();
    } finally {
      this.refreshInFlight = false;
    }
  }

  private formatClock(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  private renderClock(): void {
    if (this.view !== "list") {
      this.clockBox.hide();
      return;
    }

    const now = new Date();
    const time = now.toLocaleTimeString([], {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const weekday = now.toLocaleDateString([], {
      weekday: "short",
    }).toUpperCase();
    const monthDay = now.toLocaleDateString([], {
      day: "2-digit",
      month: "short",
    }).toUpperCase();
    const pulseFrames = ["◜", "◝", "◞", "◟"] as const;
    const pulse = `{${THEME.selectedAccent}-fg}${pulseFrames[this.clockFrameIndex]}{/}`;

    this.clockBox.setContent(
      ` ${pulse} {${THEME.textSoft}-fg}${escapeTags(time)}{/} {gray-fg}${escapeTags(`${weekday} ${monthDay}`)}{/gray-fg}`,
    );
    this.clockBox.show();
  }

  private renderArticleFooter(): void {
    const refreshStatus = this.pendingStoryCount > 0
      ? `{${THEME.highlight}-fg}${this.pendingStoryCount} new{/} {gray-fg}waiting{/gray-fg}`
      : this.lastRefreshAt
        ? `{gray-fg}synced ${this.formatClock(this.lastRefreshAt)} · auto-refresh 60s{/gray-fg}`
        : "{gray-fg}auto-refresh 60s{/gray-fg}";
    const zoomStatus = `{${THEME.highlight}-fg}[-]{/} {${THEME.highlight}-fg}[+]{/} {gray-fg}${escapeTags(this.currentArticleZoomPreset().label)}{/gray-fg}`;
    const modeStatus = `{${THEME.accentMuted}-fg}reading view{/} {gray-fg}·{/} {${THEME.highlight}-fg}${escapeTags(this.currentArticleZoomPreset().label.toLowerCase())}{/}`;
    const storyFooter = this.activeArticleFooter
      ? `   {gray-fg}${escapeTags(this.activeArticleFooter)}{/gray-fg}`
      : "";

    this.articleFooter.setContent(
      `  {bold}Esc{/bold}/{bold}←{/bold} back   {bold}↑{/bold}/{bold}↓{/bold} scroll   {bold}PgUp{/bold}/{bold}PgDn{/bold} jump   ${zoomStatus} text   ${refreshStatus}   ${modeStatus}${storyFooter}  `,
    );
  }

  private dayWindowLabel(): string {
    return `Last ${this.dayWindow} Day${this.dayWindow === 1 ? "" : "s"}`;
  }

  private feedLabel(): string {
    return "Top Stories";
  }

  private renderDayWindowSelector(): string {
    return DAY_WINDOWS.map((days) => {
      if (days === this.dayWindow) {
        return `{${THEME.highlight}-fg}[${days}d]{/}`;
      }

      return `{gray-fg}${days}d{/gray-fg}`;
    }).join(" ");
  }

  private showListView(preferredStoryId?: number): void {
    this.view = "list";
    this.loadingShell.hide();
    this.articleShell.hide();
    this.listPanel.show();
    this.previewPanel.show();

    const preferredIndex = preferredStoryId
      ? this.stories.findIndex((story) => story.id === preferredStoryId)
      : -1;

    if (preferredIndex >= 0) {
      this.selectedIndex = preferredIndex;
    } else {
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.stories.length - 1));
    }

    this.list.focus();
  }

  private storyQuery(forceRefresh = false): { days: number; feed: "topstories"; forceRefresh: boolean } {
    return {
      days: this.dayWindow,
      feed: this.feed,
      forceRefresh,
    };
  }

  private screenHeight(): number {
    return process.stdout.rows ?? 40;
  }

  private screenWidth(): number {
    return process.stdout.columns ?? 120;
  }

  private loadingLineWidth(): number {
    return Math.max(20, Math.floor(this.screenWidth() * 0.7) - 10);
  }

  private renderArticleBody(article: ArticleContent): string {
    const storyId = this.activeArticleStory?.id ?? 0;
    const width = Math.max(36, this.screenWidth() - 8);
    const zoomIndex = this.articleZoomIndex;
    const cacheKey = `${storyId}:${width}:${zoomIndex}`;
    const cached = this.articleRenderCache.get(cacheKey);

    if (cached) {
      return cached;
    }

    const zoomPreset = this.currentArticleZoomPreset();
    const rendered = renderArticleBlocks(article.blocks, width, {
      blockSpacing: zoomPreset.blockSpacing,
      bodyBold: zoomPreset.bodyBold,
      lineSpacing: zoomPreset.lineSpacing,
      measureTighten: zoomPreset.measureTighten,
    });
    this.articleRenderCache.set(cacheKey, rendered);

    if (this.articleRenderCache.size > 24) {
      const firstKey = this.articleRenderCache.keys().next().value;
      if (firstKey) {
        this.articleRenderCache.delete(firstKey);
      }
    }

    return rendered;
  }

  private currentArticleZoomPreset(): typeof ARTICLE_ZOOM_PRESETS[number] {
    return ARTICLE_ZOOM_PRESETS[this.articleZoomIndex] ?? ARTICLE_ZOOM_PRESETS[1];
  }

  private cachedPreviewExcerpt(story: Story): string {
    const cached = this.previewExcerptCache.get(story.id);
    if (cached) {
      return cached;
    }

    const excerpt = escapeTags(truncate(htmlToPlainText(story.textHtml ?? "").replace(/\n+/g, " "), 320));
    this.previewExcerptCache.set(story.id, excerpt);

    if (this.previewExcerptCache.size > 256) {
      const firstKey = this.previewExcerptCache.keys().next().value;
      if (firstKey !== undefined) {
        this.previewExcerptCache.delete(firstKey);
      }
    }

    return excerpt;
  }

  private schedulePreviewUpdate(delayMs = 32): void {
    this.stopPreviewScheduler();
    this.previewUpdateTimer = setTimeout(() => {
      this.previewUpdateTimer = undefined;

      if (this.view !== "list") {
        return;
      }

      this.updatePreview();
      this.scheduleRender(0);
    }, delayMs);
  }

  private scheduleRender(delayMs = 16): void {
    if (this.renderScheduled) {
      return;
    }

    this.renderScheduled = true;
    this.renderTimer = setTimeout(() => {
      this.renderScheduled = false;
      this.renderTimer = undefined;
      this.screen.render();
    }, delayMs);
  }

  private scheduleArticleScroll(): void {
    if (this.articleScrollTimer) {
      return;
    }

    this.articleScrollTimer = setTimeout(() => {
      this.articleScrollTimer = undefined;

      if (this.view !== "article") {
        this.pendingArticleScrollDelta = 0;
        return;
      }

      const delta = this.pendingArticleScrollDelta;
      this.pendingArticleScrollDelta = 0;

      if (delta === 0) {
        return;
      }

      const previousScroll = this.articleBody.getScroll();
      this.articleBody.scroll(delta);

      if (this.articleBody.getScroll() !== previousScroll) {
        this.scheduleRender(0);
      }
    }, 8);
  }
}
