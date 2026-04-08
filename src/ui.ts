import blessed from "blessed";

import { loadArticle } from "./article.js";
import { loadRecentStories } from "./hn-api.js";
import type { ArticleContent, Story, StoryLoadProgress } from "./types.js";
import { escapeTags, formatAge, formatCount, htmlToPlainText, padLeft, padRight, reflowPlainText, truncate } from "./utils.js";

const DAY_WINDOWS = [1, 2, 3, 7] as const;
const FEED = "topstories";
const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];
const THEME = {
  accent: "#ff9a52",
  accentMuted: "#f4c095",
  bg: "#07131d",
  border: "#294053",
  highlight: "#40E0D0",
  panel: "#10202d",
  panelAlt: "#0c1824",
  selected: 23,
  text: "#f6f2e9",
  textMuted: "#8ba3b7",
  textSoft: "#c7d7e2",
};

type DayWindow = typeof DAY_WINDOWS[number];
type ViewState = "article" | "article-loading" | "fatal" | "list" | "loading";

export class HackerNewsCli {
  private activeArticle?: ArticleContent;
  private readonly articleBody: blessed.Widgets.BoxElement;
  private readonly articleFooter: blessed.Widgets.BoxElement;
  private readonly articleHeader: blessed.Widgets.BoxElement;
  private readonly articleShell: blessed.Widgets.BoxElement;
  private activeArticleStory?: Story;
  private activeArticleFooter = "";
  private currentArticleRequest = 0;
  private dayWindow: DayWindow = 7;
  private readonly feed = FEED;
  private readonly footer: blessed.Widgets.BoxElement;
  private readonly header: blessed.Widgets.BoxElement;
  private lastRefreshAt?: number;
  private readonly list: blessed.Widgets.ListElement;
  private readonly listPanel: blessed.Widgets.BoxElement;
  private readonly loadingBody: blessed.Widgets.BoxElement;
  private readonly loadingShell: blessed.Widgets.BoxElement;
  private pendingStoryCount = 0;
  private readonly preview: blessed.Widgets.BoxElement;
  private readonly previewPanel: blessed.Widgets.BoxElement;
  private refreshInFlight = false;
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
      fullUnicode: true,
      smartCSR: true,
      title: "HN Weekline",
    });

    this.screen.program.hideCursor();
    this.screen.key(["C-c"], () => this.exit());
    this.screen.key(["up"], () => {
      this.handleUp();
    });
    this.screen.key(["down"], () => {
      this.handleDown();
    });
    this.screen.key(["right"], () => {
      void this.handleRight();
    });
    this.screen.key(["left"], () => {
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
      style: {
        bg: THEME.bg,
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
          bg: THEME.panelAlt,
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
      style: {
        bg: THEME.bg,
        fg: THEME.textMuted,
      },
      tags: true,
      width: "100%",
    });

    this.loadingShell = blessed.box({
      align: "left",
      border: "line",
      height: 11,
      left: "center",
      padding: {
        left: 2,
        right: 2,
      },
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
      height: 7,
      left: 0,
      style: {
        bg: THEME.panel,
        fg: THEME.textSoft,
      },
      tags: true,
      top: 1,
      width: "100%",
      wrap: true,
    });

    this.articleShell = blessed.box({
      bg: THEME.panelAlt,
      height: "100%",
      hidden: true,
      left: 0,
      top: 0,
      width: "100%",
    });

    this.articleHeader = blessed.box({
      height: 4,
      left: 0,
      padding: {
        left: 1,
        right: 1,
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
        left: 1,
        right: 1,
      },
      scrollable: true,
      scrollbar: {
        ch: " ",
        track: {
          bg: THEME.panelAlt,
        },
        style: {
          bg: THEME.accent,
        },
      },
      style: {
        bg: THEME.panelAlt,
        fg: THEME.textSoft,
      },
      tags: false,
      top: 4,
      vi: false,
      width: "100%",
      wrap: true,
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
    this.screen.append(this.loadingShell);
    this.screen.append(this.articleShell);

    this.renderHeader();
    this.renderFooter();
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
        `{bold}${this.currentSpinner()} Unable to start HN Weekline{/bold}\n\n${message}\n\nPress {bold}Esc{/bold} to exit.`,
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
    this.stopBackgroundRefresh();
    this.stopSpinner();
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
      this.showListView(previousSelectedId);
      this.screen.render();
    } catch {
      this.dayWindow = previousDayWindow;
      this.stories = previousStories;
      this.showListView(previousSelectedId);
      this.screen.render();
    } finally {
      this.refreshInFlight = false;
    }
  }

  private async handleEnter(): Promise<void> {
    if (this.view !== "list" || this.stories.length === 0) {
      return;
    }

    const story = this.currentStory();
    this.currentArticleRequest += 1;
    const requestId = this.currentArticleRequest;
    this.view = "article-loading";
    this.activeArticle = undefined;
    this.activeArticleStory = undefined;
    this.listPanel.hide();
    this.previewPanel.hide();
    this.loadingShell.hide();
    this.articleShell.show();
    this.activeArticleFooter = "";
    this.articleHeader.setContent(this.renderArticleHeader(story.title, `by ${story.by} · ${story.domain} · ${formatAge(story.time)} old`));
    this.articleBody.setContent(`${this.currentSpinner()} Rendering article...\n\nPulling the page into a readable terminal layout.`);
    this.renderArticleFooter();
    this.renderHeader();
    this.screen.render();

    const article = await loadArticle(story);
    if (requestId !== this.currentArticleRequest) {
      return;
    }

    this.showArticle(story, article);
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

  private handleEnd(): void {
    if (this.view === "list") {
      this.selectedIndex = this.stories.length - 1;
      this.renderList();
      this.updatePreview();
      this.screen.render();
      return;
    }

    if (this.view === "article") {
      this.articleBody.setScrollPerc(100);
      this.screen.render();
    }
  }

  private handleHome(): void {
    if (this.view === "list") {
      this.selectedIndex = 0;
      this.renderList();
      this.updatePreview();
      this.screen.render();
      return;
    }

    if (this.view === "article") {
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
    this.renderList();
    this.updatePreview();
    this.screen.render();
  }

  private renderArticleHeader(title: string, subtitle: string): string {
    return ` {bold}${escapeTags(title)}{/bold}\n {gray-fg}${escapeTags(subtitle)}{/gray-fg}`;
  }

  private renderFooter(): void {
    if (this.view === "article" || this.view === "article-loading") {
      this.footer.hide();
      return;
    }

    const refreshStatus = this.lastRefreshAt
      ? `synced ${this.formatClock(this.lastRefreshAt)}`
      : "auto-refresh 60s";

    this.footer.show();
    this.footer.setContent(
      `  {bold}↑{/bold}/{bold}↓{/bold} move   {bold}Enter{/bold}/{bold}→{/bold} read   {bold}1{/bold}/{bold}2{/bold}/{bold}3{/bold}/{bold}7{/bold} range   {bold}Esc{/bold} exit   {bold}${this.stories.length}{/bold} stories   {gray-fg}${refreshStatus} · auto-refresh 60s{/gray-fg}   ${this.renderDayWindowSelector()}`,
    );
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
      ? ` · {${THEME.highlight}-fg}${this.pendingStoryCount} new{/} {gray-fg}waiting{/gray-fg}`
      : this.lastRefreshAt
        ? ` · {gray-fg}synced ${this.formatClock(this.lastRefreshAt)}{/gray-fg}`
        : "";

    this.header.setContent(
      `{bold}${marker} HN Weekline{/bold} {gray-fg}· ${subtitle}{/gray-fg}\n{cyan-fg}${selected}/${totalStories}{/cyan-fg} {gray-fg}selected{/gray-fg}${refreshStatus}`,
    );
  }

  private renderList(): void {
    const width = Math.max(36, Math.floor(this.screenWidth() * 0.66) - 6);
    const ageWidth = 4;
    const domainWidth = Math.min(18, Math.max(14, Math.floor(width * 0.2)));
    const scoreWidth = 6;
    const commentsWidth = 6;
    const titleWidth = Math.max(12, width - ageWidth - domainWidth - scoreWidth - commentsWidth - 4);

    const rows = this.stories.map((story) => {
      const age = escapeTags(padLeft(formatAge(story.time), ageWidth));
      const title = escapeTags(padRight(truncate(story.title, titleWidth), titleWidth));
      const domain = escapeTags(padRight(truncate(story.domain, domainWidth), domainWidth));
      const score = escapeTags(padLeft(`${formatCount(story.score)}↑`, scoreWidth));
      const comments = escapeTags(padLeft(`${formatCount(story.comments)}c`, commentsWidth));

      return `{#9db4c7-fg}${age}{/} {bold}${title}{/bold} {#7ab8e0-fg}${domain}{/} {#f7d28a-fg}${score}{/} {#ffb787-fg}${comments}{/}`;
    });

    this.listPanel.setLabel(` ${this.feedLabel()} · ${this.dayWindowLabel()} `);
    this.list.setItems(rows);
    this.list.select(this.selectedIndex);
    this.list.scrollTo(Math.max(0, this.selectedIndex - Math.floor((this.screenHeight() - 9) / 2)));
    this.renderHeader();
    this.renderFooter();
  }

  private scrollArticle(delta: number): void {
    if (this.view !== "article") {
      return;
    }

    this.articleBody.scroll(delta);
    this.screen.render();
  }

  private showArticle(story: Story, article: ArticleContent): void {
    this.view = "article";
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
    const previousScroll = this.articleBody.getScroll();

    this.articleHeader.setContent(this.renderArticleHeader(article.title, subtitle));
    this.articleBody.setContent(this.renderArticleBody(article.body || "No readable article text was available."));
    if (resetScroll) {
      this.articleBody.setScrollPerc(0);
    } else {
      this.articleBody.setScroll(previousScroll);
    }
    this.renderArticleFooter();
  }

  private showLoadingShell(): void {
    this.view = "loading";
    this.articleShell.hide();
    this.listPanel.hide();
    this.previewPanel.hide();
    this.footer.hide();
    this.loadingShell.show();
  }

  private startSpinner(): void {
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrameIndex = (this.spinnerFrameIndex + 1) % SPINNER_FRAMES.length;

      if (this.view === "loading" || this.view === "article-loading" || this.view === "fatal") {
        this.renderHeader();
        this.screen.render();
      }
    }, 120);
  }

  private startBackgroundRefresh(): void {
    if (this.refreshTimer) {
      return;
    }

    this.refreshTimer = setInterval(() => {
      void this.refreshStories();
    }, 60_000);
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

  private updateLoading(progress: StoryLoadProgress): void {
    this.view = "loading";
    this.showLoadingShell();
    this.renderHeader();

    const coverage = Math.min(7, progress.coverageDays).toFixed(1);
    const remaining = progress.maxItem > 0 ? formatCount(Math.max(0, progress.currentId)) : "0";

    this.loadingBody.setContent(
      `{bold}${this.currentSpinner()} Building the ${this.feedLabel().toLowerCase()} feed{/bold}\n\n${progress.message}\n\n` +
      `{#7ab8e0-fg}${formatCount(progress.found)}{/} stories found\n` +
      `{#f7d28a-fg}${formatCount(progress.examined)}{/} HN items examined\n` +
      `{#ffb787-fg}${coverage} / ${this.dayWindow.toFixed(1)}{/} days covered\n` +
      `{gray-fg}${remaining} ranked stories left to inspect{/gray-fg}`,
    );

    this.screen.render();
  }

  private updatePreview(): void {
    if (this.stories.length === 0) {
      this.preview.setContent("No story selected.");
      return;
    }

    const story = this.currentStory();
    const excerpt = story.textHtml
      ? escapeTags(truncate(htmlToPlainText(story.textHtml).replace(/\n+/g, " "), 320))
      : "No self-post text is attached to this story. Press Enter to render the linked page directly in the terminal reader.";

    this.preview.setContent(
      `{bold}${escapeTags(story.title)}{/bold}\n\n` +
      `{#7ab8e0-fg}${formatCount(story.score)}{/} points   ` +
      `{#ffb787-fg}${formatCount(story.comments)}{/} comments   ` +
      `{#f7d28a-fg}${formatAge(story.time)}{/} old\n` +
      `{gray-fg}by ${escapeTags(story.by)} · ${escapeTags(story.domain)}{/gray-fg}\n\n` +
      `${excerpt}\n\n` +
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

  private renderArticleFooter(): void {
    const refreshStatus = this.pendingStoryCount > 0
      ? `{${THEME.highlight}-fg}${this.pendingStoryCount} new{/} {gray-fg}waiting{/gray-fg}`
      : this.lastRefreshAt
        ? `{gray-fg}synced ${this.formatClock(this.lastRefreshAt)} · auto-refresh 60s{/gray-fg}`
        : "{gray-fg}auto-refresh 60s{/gray-fg}";
    const storyFooter = this.activeArticleFooter
      ? `   {gray-fg}${escapeTags(this.activeArticleFooter)}{/gray-fg}`
      : "";

    this.articleFooter.setContent(
      `  {bold}Esc{/bold}/{bold}←{/bold} back   {bold}↑{/bold}/{bold}↓{/bold} scroll   {bold}PgUp{/bold}/{bold}PgDn{/bold} jump   ${refreshStatus}${storyFooter}  `,
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

  private renderArticleBody(text: string): string {
    return reflowPlainText(text, Math.max(40, this.screenWidth() - 4));
  }
}
