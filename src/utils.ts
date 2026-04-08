import { convert } from "html-to-text";

const DAY_MS = 24 * 60 * 60 * 1000;

export function cutoffDaysAgo(days: number): number {
  return Date.now() - (days * DAY_MS);
}

export function extractDomain(url?: string): string {
  if (!url) {
    return "text post";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "external";
  }
}

export function formatAge(unixSeconds: number): string {
  const deltaSeconds = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);

  if (deltaSeconds < 60) {
    return `${deltaSeconds}s`;
  }

  const deltaMinutes = Math.floor(deltaSeconds / 60);
  if (deltaMinutes < 60) {
    return `${deltaMinutes}m`;
  }

  const deltaHours = Math.floor(deltaMinutes / 60);
  if (deltaHours < 24) {
    return `${deltaHours}h`;
  }

  const deltaDays = Math.floor(deltaHours / 24);
  return `${deltaDays}d`;
}

export function formatCount(value: number): string {
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }

  return String(value);
}

export function htmlToPlainText(html: string, wordwrap: number | false = 110): string {
  return normalizeText(
    convert(html, {
      preserveNewlines: true,
      selectors: [
        {
          selector: "a",
          options: {
            ignoreHref: true,
          },
        },
        {
          format: "skip",
          selector: "img",
        },
        {
          format: "skip",
          selector: "script",
        },
        {
          format: "skip",
          selector: "style",
        },
      ],
      wordwrap,
    }),
  );
}

export function escapeTags(value: string): string {
  return value.replace(/[{}]/g, "\\$&");
}

export function normalizeText(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function padRight(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }

  return `${value}${" ".repeat(width - value.length)}`;
}

export function padLeft(value: string, width: number): string {
  if (value.length >= width) {
    return value;
  }

  return `${" ".repeat(width - value.length)}${value}`;
}

export function truncate(value: string, width: number): string {
  if (width <= 1) {
    return value.slice(0, width);
  }

  if (value.length <= width) {
    return value;
  }

  return `${value.slice(0, width - 1)}…`;
}

export function reflowPlainText(value: string, width: number): string {
  if (width < 20) {
    return value;
  }

  return normalizeText(value)
    .split(/\n{2,}/)
    .map((paragraph) => reflowParagraph(paragraph, width))
    .join("\n\n");
}

function reflowParagraph(paragraph: string, width: number): string {
  const lines = paragraph.split("\n").map((line) => line.replace(/\s+$/g, ""));
  if (lines.length <= 1) {
    return paragraph;
  }

  if (lines.some((line) => isPreformattedLine(line))) {
    return lines.join("\n");
  }

  const bulletMatch = lines[0]?.match(/^(\s*(?:[-*•]|\d+[.)]))\s+(.*)$/);
  if (bulletMatch) {
    const prefix = bulletMatch[1];
    const content = [bulletMatch[2], ...lines.slice(1).map((line) => line.trim())]
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return wrapWords(content, width, `${prefix} `, " ".repeat(`${prefix} `.length));
  }

  const content = lines
    .map((line) => line.trim())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();

  return wrapWords(content, width);
}

function isPreformattedLine(line: string): boolean {
  return /^\s{4,}\S/.test(line) || /\t/.test(line) || /\S {2,}\S/.test(line);
}

function wrapWords(value: string, width: number, firstPrefix = "", restPrefix = firstPrefix): string {
  const words = value.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return "";
  }

  const lines: string[] = [];
  let currentPrefix = firstPrefix;
  let currentLine = currentPrefix;

  for (const word of words) {
    const nextLine = currentLine.trimEnd() === currentPrefix.trimEnd()
      ? `${currentLine}${word}`
      : `${currentLine} ${word}`;

    if (nextLine.length <= width || currentLine.trim() === "") {
      currentLine = nextLine;
      continue;
    }

    lines.push(currentLine.trimEnd());
    currentPrefix = restPrefix;
    currentLine = `${currentPrefix}${word}`;
  }

  lines.push(currentLine.trimEnd());
  return lines.join("\n");
}
