# Project Instructions

## Package Manager
- **Bun**: Use `bun` for all package operations
  - `bun install` - Install dependencies
  - `bun add <pkg>` - Add a dependency
  - `bun remove <pkg>` - Remove a dependency
  - `bunx <cmd>` - Run a package binary (instead of npx/yarn dlx)

## Git Workflow

### Commits
Use conventional commit format with the `--prompt` flag:

```bash
git add -A && git commit -m "$(cat <<'EOF'
<type>: <description>

<optional body>

Co-Authored-By: Claude Opus 4.5 <noreply@anthropic.com>
EOF
)" --prompt "<brief description of what was requested>"
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
