# Blog Asset Management and Image Generation Service

> **Note**: This is a personal project designed specifically for my own blog infrastructure and workflow. The setup, architecture, and design choices are tailored to my specific needs and are not intended for general public use or as a template for other blog systems.

This service is a Cloudflare Worker that handles blog asset management, automated image generation, and GitHub workflow automation. It provides several endpoints for managing blog-related assets and automating the content pipeline.

## Features

- **Asset Management**: Serves blog assets from R2 storage with signed URLs and caching
- **Automated Image Generation**: Creates blog post images using Replicate's AI models
- **GitHub Workflow Integration**: Automates repository updates for new blog posts
- **Notion Integration**: Fetches blog post data from Notion database

## API Endpoints

### `/assets/*`
- Serves blog assets from R2 storage
- Implements URL signing and caching for optimal performance

### `/api/generate-image` (POST)
- Generates blog post images using AI
- Requires authentication via bearer token
- Integrates with Notion to fetch post details
- Uses Claude AI to generate custom prompts
- Triggers image generation via Replicate

### `/api/trigger-github-workflow` (POST)
- Triggers GitHub workflow for blog updates
- Requires authentication via bearer token
- Fetches latest post data from Notion
- Updates repository with new content

### `/webhooks/replicate`
- Handles webhooks from Replicate after image generation
- Stores generated images in R2 bucket
- Organizes images by date and slug

## Environment Variables Required

```env
CLOUDFLARE_ACCOUNT_ID=
R2_BUCKET_NAME=
CLOUDFLARE_R2_ACCESS_KEY_ID=
CLOUDFLARE_R2_SECRET_ACCESS_KEY=
REPLICATE_WEBHOOK_SIGNING_KEY=
REPLICATE_API_TOKEN=
IMAGE_GENERATION_SECRET=
IMAGE_GENERATION_BASE_PROMPT=
ANTHROPIC_API_KEY=
NOTION_TOKEN=
GITHUB_PAT=
```

## Dependencies

- @aws-sdk/client-s3
- @aws-sdk/s3-request-presigner
- replicate
- @anthropic-ai/sdk

## Infrastructure Requirements

- Cloudflare Workers
- Cloudflare R2 Storage
- KV Namespace for BlogAssets
- Notion Database
- GitHub Repository
- Replicate Account
- Anthropic API Access

## Security

- Endpoints are protected with bearer token authentication
- Uses signed URLs for asset access
- Implements webhook validation for Replicate callbacks

## Error Handling

- Comprehensive error handling for API calls
- Specific handling for API rate limits and quota exceeded scenarios
- Detailed error logging for debugging

## Usage

Deploy this worker to Cloudflare Workers platform with the required environment variables configured. The service will automatically handle asset serving and image generation for your blog pipeline.

For local development, ensure all environment variables are properly set in your wrangler.toml or through the Cloudflare dashboard.
