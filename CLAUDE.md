# Project Instructions

## Package Manager
- **Bun**: Use `bun` for all package operations
  - `bun install` - Install dependencies
  - `bun add <pkg>` - Add a dependency
  - `bun remove <pkg>` - Remove a dependency
  - `bunx <cmd>` - Run a package binary (instead of npx/yarn dlx)

## Git Workflow

**Always commit and push after making code changes.** Do not leave changes uncommitted.

### Commits
Use conventional commit format:

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <description>

<optional body>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)"
```

**Commit types:**
- `feat:` - New feature
- `fix:` - Bug fix
- `chore:` - Maintenance, dependencies, tooling
- `refactor:` - Code restructuring without behavior change
- `docs:` - Documentation only

### Push
Always push to GitHub after committing:
```bash
git push
```

## Cloudflare Workers Deployment

No build step required - Wrangler handles TypeScript bundling automatically.

### Development
```bash
bun run dev
```

### Deploy to Production
```bash
bun run deploy
```
This runs `wrangler deploy` which deploys to Cloudflare Workers.

### Other Commands
- `bun run test` - Run tests with Vitest
- `bun run cf-typegen` - Generate Cloudflare types
- `bun run format` - Format code with Biome
- `bun run check` - Run Biome checks
- `bun run lint` - Run Biome linter
