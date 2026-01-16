This project has been retired and merged into the [portfolio monorepo](https://github.com/arunsathiya/portfolio).

A Cloudflare Worker that handled blog asset management, automated AI image generation via Replicate, Notion-to-MDX content syncing, and GitHub workflow automation for my personal blog at arun.blog. The worker served assets from R2 storage with signed URLs, processed Notion webhooks to convert pages to MDX and commit them to GitHub, and orchestrated an image generation pipeline using Claude for prompt generation and Replicate for image creation.
