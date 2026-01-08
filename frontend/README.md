# MC-AWS Frontend

Web control panel for managing the Minecraft server infrastructure.

## Development

```bash
# Install dependencies
pnpm install

# Run development server
pnpm dev

# Lint and format
pnpm lint
pnpm format
pnpm check
```

## Environment Variables

This frontend reads environment variables from the parent directory's `.env` file.
Required variables are listed in `../.env.template`.

## Tech Stack

- **Next.js 15** with App Router
- **TypeScript**
- **Tailwind CSS**
- **Biome** for linting and formatting
