declare module "html-to-text" {
  export function convert(html: string, options?: unknown): string;
}

declare module "jsdom" {
  export class JSDOM {
    public constructor(html?: string, options?: { url?: string });
    public readonly window: {
      close(): void;
      document: Document;
    };
  }
}
