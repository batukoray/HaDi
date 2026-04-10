<img src="https://raw.githubusercontent.com/batukoray/assets_of_mine/refs/heads/main/HaDi_Banner.png" width="600"/>


**Ha**cker**Di**spatch, or **HaDi** is a full-screen terminal client for Hacker News built with TypeScript and `blessed`.

The main idea was a friend of mine was always trying to convince me to transition my main source of news from Youtube to HackerNews, but I found HackerNews' interface really uninspired I should say. Therefore I got this idea to just re-make their interface, but as a CLI application. 

**HaDi** loads ranked stories from the official Hacker News API, filters them to a recent time window, keeps the list live with background refresh, and renders full articles directly inside the terminal.

## What It Does

- Uses the official Hacker News Firebase API
- Shows `topstories` filtered to the last `1`, `2`, `3`, or `7` days
- Preserves Hacker News ranking order inside the selected time window
- Refreshes the story list every 60 seconds while the app is open
- Opens the selected story inside an in-terminal article reader
- Extracts readable article content with Mozilla Readability
- Supports Hacker News self-posts, external articles, and rendering fallbacks
- Caches story data locally to speed up later launches

## Interface
<img src="https://raw.githubusercontent.com/batukoray/assets_of_mine/refs/heads/main/HaDi_GUI.png" width="600"/>


## Requirements

- Node.js 20 or newer
- npm
- A terminal with decent Unicode support

## Install

```bash
npm install
```

## Run

Start the app from the project directory:

```bash
npm start
```

Build the project:

```bash
npm run build
```

## Global `hadi` Command

This repository includes a local CLI entrypoint named `hadi`.

After cloning the repository, a user can make `hadi` available globally on their own machine with:

```bash
npm install
npm run build
npm link
```

Then the app can be launched from anywhere with:

```bash
hadi
```

`npm link` is local to each machine. Cloning the repository alone does not automatically install the command globally.

## Controls

### Main List

| Key | Action |
| --- | --- |
| `↑` / `↓` | Move selection |
| `Enter` / `Space` / `→` | Open selected story |
| `1` / `2` / `3` / `7` | Change the date window |
| `Esc` | Exit |
| `Ctrl-C` | Exit immediately |

### Article Reader

| Key | Action |
| --- | --- |
| `Esc` / `←` | Return to the story list |
| `↑` / `↓` | Scroll |
| `PgUp` / `PgDn` | Jump by page |
| `Space` | Page down |
| `Home` / `End` | Jump to top or bottom |
| `+` / `-` | Change reading density |

## How It Works

### Story Loading

HackerDispatch requests ranked IDs from the official Hacker News API and then fetches story items in batches. It filters those stories by age and keeps only items inside the selected time window.

The app stores a local cache under `.cache/` so repeated launches do not need to rebuild everything from scratch.

### Background Refresh

While the main list is open, HackerDispatch refreshes every 60 seconds. New stories are merged into the list without dropping your current selection when possible.

### Article Rendering

When a story is opened:

1. The linked page is fetched.
2. Mozilla Readability extracts the primary article content.
3. The HTML is converted into semantic terminal blocks such as headings, paragraphs, lists, quotes, and code blocks.
4. The article is rendered in the terminal reader.

If a page cannot be rendered cleanly, HackerDispatch falls back to a readable error message and any available Hacker News self-text.

## Project Structure

| Path | Purpose |
| --- | --- |
| `src/index.ts` | CLI entrypoint |
| `src/ui.ts` | Terminal UI, navigation, refresh loop, and rendering |
| `src/hn-api.ts` | Hacker News API loading and cache handling |
| `src/article.ts` | Article fetching and readability extraction |
| `src/article-format.ts` | Semantic block parsing and terminal formatting |
| `src/utils.ts` | Shared text and formatting helpers |
| `bin/hadi.js` | Linked global command entrypoint |

## Notes

- The story feed currently targets Hacker News `topstories`.
- The list is intentionally terminal-only. It does not open a browser or display raw links in the main view.
- Rendering quality depends on the source page. Some sites extract cleanly, others require fallback handling.
- The interface is designed for monospaced terminal fonts. Proportional fonts will break alignment.

## Credits
Built by *Batu Koray Masak* · *CS & AI Engineering* @ *Özyeğin University*

[![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat&logo=github&logoColor=white)](https://github.com/batukoray)
[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/batu-koray-masak/)
[![Email](https://img.shields.io/badge/Email-EA4335?style=flat&logo=gmail&logoColor=white)](mailto:batukoraymasak@gmail.com)
