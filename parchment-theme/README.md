# Parchment theme

A warm, low-contrast paper palette for the Harness Web UI, sitting between
ChatGPT Desktop's clean neutral chrome and Claude Desktop's warm editorial
surfaces.

- **Light:** parchment canvas, stone sidebar, warm ink labels, sand message
  bubbles, and a clay accent for links, focus rings, selections, and activity.
- **Dark:** espresso base, warm stone raised surfaces, cream labels, and a
  lighter clay accent.
- Slightly rounder corners, warm diffuse shadows, and a calmer translucent menu
  material.

The theme is implemented as a Client-side theme token override layer
(`ctx.theme.overrideTokens`) covering both light and dark palettes, so the
standard Appearance choice (Light / Dark / System) keeps working and both modes
receive the same design language.

## Enable or disable

Installing the bundle applies the theme immediately. Disable or remove the
`parchment-theme` bundle in Settings → Plugins to return to the stock palette;
the override layer is disposed with the plugin and no preference is persisted.

## Files

- `index.js` — Host half of the bundle; provides nothing.
- `client.js` — Client half; registers the palette override layer with
  `ctx.theme`.
- `cordis.patch.yml` — inserts the `parchment-theme` Loader row.
- `locale/en.json`, `locale/ru.json` — plugin row title and description.
- `icon.svg` — original plugin artwork.
