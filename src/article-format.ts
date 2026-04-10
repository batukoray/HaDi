import { JSDOM } from "jsdom";

import type { ArticleBlock } from "./types.js";
import { escapeTags, normalizeText } from "./utils.js";

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const BLOCK_TAGS = new Set([
  "article",
  "aside",
  "blockquote",
  "body",
  "caption",
  "dd",
  "details",
  "div",
  "dl",
  "dt",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const INLINE_BREAK_TAGS = new Set(["br"]);
const PARAGRAPH_TAGS = new Set(["caption", "dd", "dt", "figcaption", "p", "summary"]);
const SKIP_TAGS = new Set(["button", "form", "iframe", "img", "input", "noscript", "picture", "script", "style", "svg"]);

type DomNodeLike = {
  childNodes?: ArrayLike<DomNodeLike>;
  children?: ArrayLike<DomElementLike>;
  getAttribute?: (name: string) => string | null;
  nodeType: number;
  parentElement?: DomElementLike | null;
  tagName?: string;
  textContent?: string | null;
};

type DomElementLike = DomNodeLike & {
  nodeType: 1;
  tagName: string;
};

interface ArticleRenderTheme {
  body: string;
  codeBg: string;
  codeText: string;
  headingPrimary: string;
  headingSecondary: string;
  inlineCodeBg: string;
  inlineCodeText: string;
  listBullet: string;
  quoteRail: string;
  quoteText: string;
  rule: string;
}

export interface ArticleRenderOptions {
  blockSpacing?: number;
  bodyBold?: boolean;
  lineSpacing?: number;
  measureTighten?: number;
}

const DEFAULT_RENDER_THEME: ArticleRenderTheme = {
  body: "#dcecf2",
  codeBg: "#15303a",
  codeText: "#f6f2e9",
  headingPrimary: "#ffbe72",
  headingSecondary: "#49cbbb",
  inlineCodeBg: "#183142",
  inlineCodeText: "#ffd39b",
  listBullet: "#49cbbb",
  quoteRail: "#49cbbb",
  quoteText: "#b3d7de",
  rule: "#36707a",
};

export function blocksFromHtml(html: string): ArticleBlock[] {
  if (!normalizeText(html)) {
    return [];
  }

  const dom = new JSDOM(`<body>${html}</body>`);

  try {
    return normalizeBlocks(readBlocks(childNodesOf(dom.window.document.body as unknown as DomNodeLike)));
  } finally {
    dom.window.close();
  }
}

export function blocksFromPlainText(text: string): ArticleBlock[] {
  const normalized = normalizeText(text);
  if (!normalized) {
    return [];
  }

  return normalizeBlocks(
    normalized.split(/\n{2,}/).map((section) => {
      if (looksLikeCode(section)) {
        return {
          text: normalizeCodeText(section),
          type: "code" as const,
        };
      }

      return {
        text: normalizeParagraphText(section),
        type: "paragraph" as const,
      };
    }),
  );
}

export function mergeArticleBlocks(...sections: ArticleBlock[][]): ArticleBlock[] {
  const merged: ArticleBlock[] = [];

  for (const section of sections) {
    if (section.length === 0) {
      continue;
    }

    if (merged.length > 0) {
      merged.push({ type: "rule" });
    }

    merged.push(...section);
  }

  return normalizeBlocks(merged);
}

export function trimDuplicateLeadingHeading(blocks: ArticleBlock[], title: string): ArticleBlock[] {
  const [first, ...rest] = blocks;
  if (!first) {
    return blocks;
  }

  if (first.type !== "heading" && first.type !== "paragraph") {
    return blocks;
  }

  return comparableText(first.text) === comparableText(title) ? rest : blocks;
}

export function renderArticleBlocks(blocks: ArticleBlock[], width: number, options: ArticleRenderOptions = {}): string {
  const viewportWidth = Math.max(28, width);
  const contentWidth = Math.max(28, Math.min(viewportWidth, preferredContentWidth(viewportWidth) - (options.measureTighten ?? 0)));
  const gutter = Math.max(0, Math.floor((viewportWidth - contentWidth) / 2));
  const blockSpacing = Math.max(1, Math.min(3, options.blockSpacing ?? 1));
  const lineSpacing = Math.max(0, Math.min(2, options.lineSpacing ?? 0));
  return trimBlankLines(
    applyGutter(renderBlocks(blocks, contentWidth, DEFAULT_RENDER_THEME, blockSpacing, lineSpacing, options.bodyBold ?? false), gutter),
  ).join("\n");
}

function childNodesOf(node: DomNodeLike): DomNodeLike[] {
  return Array.from(node.childNodes ?? []);
}

function childElementsOf(node: DomNodeLike): DomElementLike[] {
  return Array.from(node.children ?? []) as DomElementLike[];
}

function comparableText(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function hasBlockChildren(node: DomElementLike): boolean {
  return childElementsOf(node).some((child) => BLOCK_TAGS.has(tagNameOf(child)));
}

function isElement(node: DomNodeLike): node is DomElementLike {
  return node.nodeType === ELEMENT_NODE && typeof node.tagName === "string";
}

function looksLikeCode(section: string): boolean {
  const lines = section.split("\n");
  return (
    /\t/.test(section) ||
    (lines.length > 1 &&
      lines.some((line) => /^\s{2,}\S/.test(line)) &&
      /[{}();:=<>[\]]/.test(section))
  );
}

function normalizeBlocks(blocks: ArticleBlock[]): ArticleBlock[] {
  const normalized: ArticleBlock[] = [];

  for (const block of blocks) {
    if (block.type === "paragraph") {
      const text = normalizeParagraphText(block.text);
      if (!text) {
        continue;
      }

      normalized.push({ text, type: "paragraph" });
      continue;
    }

    if (block.type === "heading") {
      const text = normalizeParagraphText(block.text);
      if (!text) {
        continue;
      }

      normalized.push({
        level: Math.max(1, Math.min(6, block.level)),
        text,
        type: "heading",
      });
      continue;
    }

    if (block.type === "list") {
      const items = block.items
        .map((item) => normalizeParagraphText(item))
        .filter(Boolean);

      if (items.length === 0) {
        continue;
      }

      normalized.push({
        items,
        ordered: block.ordered,
        type: "list",
      });
      continue;
    }

    if (block.type === "quote") {
      const quoteBlocks = normalizeBlocks(block.blocks);
      if (quoteBlocks.length === 0) {
        continue;
      }

      normalized.push({
        blocks: quoteBlocks,
        type: "quote",
      });
      continue;
    }

    if (block.type === "code") {
      const text = normalizeCodeText(block.text);
      if (!text) {
        continue;
      }

      normalized.push({
        text,
        type: "code",
      });
      continue;
    }

    if (normalized.length === 0 || normalized[normalized.length - 1]?.type === "rule") {
      continue;
    }

    normalized.push(block);
  }

  while (normalized[normalized.length - 1]?.type === "rule") {
    normalized.pop();
  }

  return normalized;
}

function normalizeCodeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\t/g, "  ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/^\n+|\n+$/g, "");
}

function normalizeInlineText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n");
}

function normalizeParagraphText(value: string): string {
  return normalizeInlineText(value)
    .replace(/\n+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function readBlocks(nodes: DomNodeLike[]): ArticleBlock[] {
  return nodes.flatMap((node) => readNode(node));
}

function readNode(node: DomNodeLike): ArticleBlock[] {
  if (node.nodeType === TEXT_NODE) {
    const text = normalizeParagraphText(node.textContent ?? "");
    return text ? [{ text, type: "paragraph" }] : [];
  }

  if (!isElement(node)) {
    return [];
  }

  const tag = tagNameOf(node);
  if (SKIP_TAGS.has(tag) || INLINE_BREAK_TAGS.has(tag)) {
    return [];
  }

  if (/^h[1-6]$/.test(tag)) {
    const text = normalizeParagraphText(collectInlineText(node));
    return text
      ? [{
          level: Number.parseInt(tag.slice(1), 10),
          text,
          type: "heading",
        }]
      : [];
  }

  if (PARAGRAPH_TAGS.has(tag)) {
    const text = normalizeParagraphText(collectInlineText(node));
    return text ? [{ text, type: "paragraph" }] : [];
  }

  if (tag === "blockquote") {
    const blocks = normalizeBlocks(readBlocks(childNodesOf(node)));
    const fallback = normalizeParagraphText(collectInlineText(node));
    return blocks.length > 0
      ? [{ blocks, type: "quote" }]
      : fallback
        ? [{
            blocks: [{ text: fallback, type: "paragraph" }],
            type: "quote",
          }]
        : [];
  }

  if (tag === "ul" || tag === "ol") {
    const items = childElementsOf(node)
      .filter((child) => tagNameOf(child) === "li")
      .map((child) => normalizeParagraphText(collectInlineText(child)))
      .filter(Boolean);

    return items.length > 0
      ? [{
          items,
          ordered: tag === "ol",
          type: "list",
        }]
      : [];
  }

  if (tag === "pre" || tag === "table") {
    const text = normalizeCodeText(node.textContent ?? "");
    return text ? [{ text, type: "code" }] : [];
  }

  if (tag === "hr") {
    return [{ type: "rule" }];
  }

  if (hasBlockChildren(node)) {
    return readBlocks(childNodesOf(node));
  }

  const text = normalizeParagraphText(collectInlineText(node));
  return text ? [{ text, type: "paragraph" }] : [];
}

function collectInlineText(node: DomNodeLike): string {
  if (node.nodeType === TEXT_NODE) {
    return node.textContent ?? "";
  }

  if (!isElement(node)) {
    return "";
  }

  const tag = tagNameOf(node);
  if (SKIP_TAGS.has(tag)) {
    return "";
  }

  if (isHeadingAnchorLink(node)) {
    return "";
  }

  if (tag === "br") {
    return "\n";
  }

  if (tag === "pre") {
    return normalizeCodeText(node.textContent ?? "");
  }

  const content = childNodesOf(node).map((child) => collectInlineText(child)).join("");
  const inline = normalizeInlineText(content);

  if (tag === "code" && tagNameOf(node.parentElement) !== "pre") {
    const code = normalizeParagraphText(inline);
    return code ? `\`${code}\`` : "";
  }

  return inline;
}

function isHeadingAnchorLink(node: DomElementLike): boolean {
  if (tagNameOf(node) !== "a") {
    return false;
  }

  const parentTag = tagNameOf(node.parentElement);
  if (!/^h[1-6]$/.test(parentTag)) {
    return false;
  }

  const href = node.getAttribute?.("href") ?? "";
  const headingId = node.parentElement?.getAttribute?.("id") ?? "";
  const text = normalizeParagraphText(node.textContent ?? "").toLowerCase();
  const className = node.getAttribute?.("class") ?? "";

  return (
    className.includes("header-anchor") ||
    (headingId !== "" && href === `#${headingId}`) ||
    text === parentTag
  );
}

function renderBlocks(
  blocks: ArticleBlock[],
  width: number,
  theme: ArticleRenderTheme,
  blockSpacing: number,
  lineSpacing: number,
  bodyBold: boolean,
): string[] {
  const lines: string[] = [];

  for (const block of blocks) {
    const rendered = renderBlock(block, width, theme, lineSpacing, bodyBold);
    if (rendered.length === 0) {
      continue;
    }

    if (lines.length > 0) {
      for (let index = 0; index < blockSpacing; index += 1) {
        lines.push("");
      }
    }

    lines.push(...rendered);
  }

  return lines;
}

function renderBlock(
  block: ArticleBlock,
  width: number,
  theme: ArticleRenderTheme,
  lineSpacing: number,
  bodyBold: boolean,
): string[] {
  if (block.type === "paragraph") {
    return withLineSpacing(
      wrapText(block.text, width).map((line) => renderBodyLine(line, theme, bodyBold)),
      lineSpacing,
    );
  }

  if (block.type === "heading") {
    const color = block.level <= 2 ? theme.headingPrimary : theme.headingSecondary;
    const wrappedHeadingLines = wrapText(block.text, width);
    const headingLines = wrappedHeadingLines.map((line) => `{bold}${renderInlineText(line, color, theme)}{/bold}`);

    if (block.level <= 2) {
      const underlineWidth = Math.max(
        20,
        Math.min(width, Math.max(...wrappedHeadingLines.map((line) => visibleTextLength(line)), 0)),
      );
      headingLines.push(`{${theme.rule}-fg}${"─".repeat(underlineWidth)}{/}`);
    }

    return headingLines;
  }

  if (block.type === "list") {
    return block.items.flatMap((item, index) => {
      const prefix = block.ordered ? `${index + 1}. ` : "• ";
      const indent = " ".repeat(prefix.length);
      return withLineSpacing(wrapText(item, width, prefix, indent).map((line) => {
        const bullet = escapeTags(prefix.trimEnd());
        if (line.startsWith(prefix)) {
          return `{${theme.listBullet}-fg}${bullet}{/} ${renderBodyLine(line.slice(prefix.length), theme, bodyBold)}`;
        }

        return `${indent}${renderBodyLine(line.slice(indent.length), theme, bodyBold)}`;
      }), lineSpacing);
    });
  }

  if (block.type === "quote") {
    const innerLines = renderBlocks(block.blocks, Math.max(20, width - 4), {
      ...theme,
      body: theme.quoteText,
      codeText: theme.quoteText,
      headingPrimary: theme.quoteText,
      headingSecondary: theme.quoteText,
      listBullet: theme.quoteRail,
      rule: theme.quoteRail,
    }, 1, lineSpacing, bodyBold);
    return innerLines.map((line) => {
      if (!line) {
        return `{${theme.quoteRail}-fg}▍{/}`;
      }

      return `{${theme.quoteRail}-fg}▍{/} ${line}`;
    });
  }

  if (block.type === "code") {
    const codeLines = wrapCodeText(block.text, Math.max(16, width - 6));
    const panelWidth = Math.min(Math.max(24, Math.max(...codeLines.map((line) => line.length), 0)), Math.max(24, width - 4));
    const chrome = "─".repeat(panelWidth + 2);

    return [
      `{${theme.rule}-fg}╭${chrome}╮{/}`,
      ...codeLines.map((line) => {
        const padded = line.padEnd(panelWidth, " ");
        return `{${theme.rule}-fg}│{/}{${theme.codeBg}-bg}{${theme.codeText}-fg} ${escapeTags(padded)} {/}{/}{${theme.rule}-fg}│{/}`;
      }),
      `{${theme.rule}-fg}╰${chrome}╯{/}`,
    ];
  }

  const ruleWidth = Math.max(18, Math.min(width, 64));
  return [`{${theme.rule}-fg}${"─".repeat(ruleWidth)}{/}`];
}

function applyGutter(lines: string[], gutter: number): string[] {
  if (gutter <= 0) {
    return lines;
  }

  const margin = " ".repeat(gutter);
  return lines.map((line) => (line ? `${margin}${line}` : ""));
}

function renderBodyLine(text: string, theme: ArticleRenderTheme, bodyBold: boolean): string {
  const rendered = renderInlineText(text, theme.body, theme);
  return bodyBold ? `{bold}${rendered}{/bold}` : rendered;
}

function preferredContentWidth(viewportWidth: number): number {
  if (viewportWidth >= 132) {
    return 96;
  }

  if (viewportWidth >= 112) {
    return 92;
  }

  if (viewportWidth >= 96) {
    return viewportWidth - 14;
  }

  return viewportWidth;
}

function renderInlineText(text: string, color: string, theme: ArticleRenderTheme): string {
  const segments = text.split(/(`[^`]+`)/g);

  return segments.map((segment) => {
    if (!segment) {
      return "";
    }

    if (segment.startsWith("`") && segment.endsWith("`")) {
      const code = segment.slice(1, -1).trim();
      if (!code) {
        return "";
      }

      return `{${theme.inlineCodeBg}-bg}{${theme.inlineCodeText}-fg} ${escapeTags(code)} {/}{/}`;
    }

    return `{${color}-fg}${escapeTags(segment)}{/}`;
  }).join("");
}

function withLineSpacing(lines: string[], spacing: number): string[] {
  if (spacing <= 0 || lines.length <= 1) {
    return lines;
  }

  const spaced: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      for (let count = 0; count < spacing; count += 1) {
        spaced.push("");
      }
    }

    spaced.push(line);
  }

  return spaced;
}

function visibleTextLength(text: string): number {
  return text.replace(/`([^`]+)`/g, "$1").length;
}

function tagNameOf(node?: DomNodeLike | null): string {
  return node?.tagName?.toLowerCase() ?? "";
}

function trimBlankLines(lines: string[]): string[] {
  const trimmed = [...lines];

  while (trimmed[0] === "") {
    trimmed.shift();
  }

  while (trimmed[trimmed.length - 1] === "") {
    trimmed.pop();
  }

  return trimmed;
}

function wrapCodeText(text: string, width: number): string[] {
  const lines = normalizeCodeText(text).split("\n");
  const wrapped: string[] = [];

  for (const line of lines) {
    if (line.length === 0) {
      wrapped.push("");
      continue;
    }

    for (let index = 0; index < line.length; index += width) {
      wrapped.push(line.slice(index, index + width));
    }
  }

  return wrapped.length > 0 ? wrapped : [""];
}

function wrapText(text: string, width: number, firstPrefix = "", restPrefix = firstPrefix): string[] {
  const words = normalizeParagraphText(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let prefix = firstPrefix;
  let currentLine = prefix;

  for (const word of words) {
    const candidate = currentLine.trimEnd() === prefix.trimEnd()
      ? `${currentLine}${word}`
      : `${currentLine} ${word}`;

    if (candidate.length <= width || currentLine.trim() === "") {
      currentLine = candidate;
      continue;
    }

    lines.push(currentLine.trimEnd());
    prefix = restPrefix;
    currentLine = `${prefix}${word}`;
  }

  lines.push(currentLine.trimEnd());
  return lines;
}
