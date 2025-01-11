import { DataRedundancy, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Replicate, { ApiError, validateWebhook } from 'replicate';
import Anthropic from "@anthropic-ai/sdk";
import { Client } from '@notionhq/client';

import { Buffer } from 'node:buffer';
import { BlockObjectResponse, ImageBlockObjectResponse, PageObjectResponse, PartialBlockObjectResponse, RichTextItemResponse, TextRichTextItemResponse } from '@notionhq/client/build/src/api-endpoints';
import { NotionToMarkdown } from 'notion-to-md';
import path from 'node:path';

interface Env {
  CLOUDFLARE_ACCOUNT_ID: string;
  R2_BUCKET_NAME: string;
  CLOUDFLARE_R2_ACCESS_KEY_ID: string;
  CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
  REPLICATE_WEBHOOK_SIGNING_KEY: string;
  REPLICATE_API_TOKEN: string;
  IMAGE_GENERATION_SECRET: string;
  IMAGE_GENERATION_BASE_PROMPT: string;
  BlogAssets: KVNamespace;
  PORTFOLIO_BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  NOTION_TOKEN: string;
	NOTION_DATABASE_ID: string;
  GITHUB_PAT: string;
  DISPATCH_SECRET: string;
	NOTION_QUEUE: Queue<NotionWebhookPayload>;
	NOTION_SIGNATURE_SECRET: string;
}

interface CachedSignedUrl {
  url: string;
  refreshTime: number;
}

interface DispatchRequest {
  commit_message?: string;
}

interface GitHubDispatch {
  event_type: string;
  client_payload: {
    commit_message: string;
  };
}

interface ReplicatePrediction {
  id: string;
  version: string;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  status: string;
  input: {
    [key: string]: any;
  };
  output: any | null;
  error: string | null;
  logs: string | null;
  metrics: {
    [key: string]: any;
  };
}

interface NotionResponse {
  results: {
    properties: {
      "Date frontmatter": {
        formula: {
          string: string;
        };
      };
      "Slug frontmatter": {
        formula: {
          string: string;
        };
      };
      Title: {
        title: {
          plain_text: string;
        }[];
      };
      "Generate Image Title": {
        rich_text: {
          plain_text: string;
        }[];
      };
    };
    last_edited_time: string;
  }[];
}

interface GitHubWorkflowDispatch {
  ref: string;
  inputs: {
    commit_message: string;
    date_slug_combo: string;
  };
}

const createS3Client = (env: Env) => new S3Client({
  region: 'auto',
  endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
  },
});

const handleAssets = async (request: Request, env: Env, s3Client: S3Client) => {
  const url = new URL(request.url);
  const key = url.pathname.slice(1);
  console.log('Key:', key);

  try {
    let cache = await env.BlogAssets.get<CachedSignedUrl>(key, `json`);
    let signedUrl: string;

    if (!cache || Date.now() > cache.refreshTime) {
      const command = new GetObjectCommand({ Bucket: env.R2_BUCKET_NAME, Key: key });
      signedUrl = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
      await env.BlogAssets.put(key, JSON.stringify({
        url: signedUrl,
        refreshTime: Date.now() + 55 * 60 * 1000,
      }));
    } else {
      console.log(`Used cached signed URL for ${key}`);
      signedUrl = cache.url;
    }

    const response = await fetch(signedUrl);
    return new Response(response.body as BodyInit, {
      status: response.status,
      headers: response.headers,
    });
  } catch (error) {
    console.error('Error generating signed URL:', error);
    return new Response('Failed to generate signed URL', { status: 500 });
  }
};

const generateImagePrompt = async (title: string, env: Env) => {
  const basePrompt = env.IMAGE_GENERATION_BASE_PROMPT;
  if (!basePrompt) {
    throw new Error('IMAGE_GENERATION_BASE_PROMPT not found in environment variables');
  }
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const image_url = "https://closet.tools/uploads/poshmark-algorithm.png"
  const image_media_type = "image/png"
  const image_array_buffer = await ((await fetch(image_url)).arrayBuffer());
  const image_data = Buffer.from(image_array_buffer).toString('base64');
  const msg = await anthropic.messages.create({
    model: "claude-3-5-sonnet-latest",
    max_tokens: 1000,
    temperature: 0,
    system: "Reply only with the generated prompt and not anything else, including any prefix message that the requested prompt is generated.",
    messages: [
      {
        "role": "user",
        "content": [{
          "type": "text",
          "text": `This is the prompt I have for the attached image:\n\n${basePrompt}\n\nCan you generate a similar prompt with creative materials relating to the blog post titled "${title}", but with a darker background? It can be any dark color. Aim to match the same font styling as in the base prompt.`,
        }]
      },
      {
        "role": "user",
        "content": [{
          "type": "image",
          "source": {
            "type": "base64",
            "media_type": image_media_type,
            "data": image_data,
          },
        }]
      },
    ]
  });
  return msg.content[0].type === "text" ? msg.content[0].text : "";
};

function isReplicateApiError(error: unknown): error is ApiError {
  return (
    error instanceof Error &&
    error !== null &&
    typeof error === 'object' &&
    'request' in error &&
    'response' in error &&
    error.request instanceof Request &&
    error.response instanceof Response
  );
}

const handleGitHubDispatch = async (request: Request, env: Env) => {
  const authToken = request.headers.get('Authorization');
  if (!authToken || authToken !== `Bearer ${env.DISPATCH_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    const body = await request.json() as DispatchRequest;
    const commit_message = body.commit_message || "chore: update from Notion";

    const dispatch: GitHubDispatch = {
      event_type: "chore: fetch and commit Notion changes",
      client_payload: {
        commit_message
      }
    };

    const githubResponse = await fetch(
      `https://api.github.com/repos/arunsathiya/portfolio/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${env.DISPATCH_SECRET}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'Cloudflare-Worker'
        },
        body: JSON.stringify(dispatch)
      }
    );

    if (!githubResponse.ok) {
      throw new Error(`GitHub API error: ${githubResponse.statusText}`);
    }

    return new Response(JSON.stringify({
      commit_message,
      status: 'GitHub repository dispatch triggered'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Error:', error);
    return new Response(
      JSON.stringify({ error: error instanceof Error ? error.message : 'Unknown error occurred' }),
      {
        status: 500,
        headers: { 'Content-Type': 'application/json' }
      }
    );
  }
};

const handleImageGeneration = async (request: Request, env: Env) => {
  const authToken = request.headers.get('Authorization');
  if (!authToken || authToken !== `Bearer ${env.IMAGE_GENERATION_SECRET}`) {
    return new Response(`Unauthorized`, { status: 401 });
  }

  try {
    // Fetch latest data from Notion
    const notionResponse = await fetch(
      'https://api.notion.com/v1/databases/8d627174-9239-4deb-ab4b-ea9262e3c066/query',
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.NOTION_TOKEN}`,
          'Notion-Version': '2022-06-28',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ page_size: 100 })
      }
    );

    if (!notionResponse.ok) {
      throw new Error(`Notion API error: ${notionResponse.statusText}`);
    }

    const notionData: NotionResponse = await notionResponse.json();
    const latestPage = notionData.results
      .sort((a, b) => b.last_edited_time.localeCompare(a.last_edited_time))[0];

    // Extract date and slug
    const date = latestPage.properties["Date frontmatter"].formula.string;
    const slug = latestPage.properties["Slug frontmatter"].formula.string;

    // Extract image generation prompt
    const imageTitle = latestPage.properties["Generate Image Title"].rich_text[0].plain_text;

    // Generate and trigger image creation
    const prompt = await generateImagePrompt(imageTitle, env);
    const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });
    const callbackUrl = `https://www.arun.blog/webhooks/replicate?date=${date}&slug=${slug}`;

    await replicate.predictions.create({
      model: "black-forest-labs/flux-schnell",
      input: { prompt, num_outputs: 4, aspect_ratio: "16:9" },
      webhook: callbackUrl,
      webhook_events_filter: ["completed"]
    });

    return new Response(JSON.stringify({
      imageTitle,
      date,
      slug,
      status: 'Image generation requested'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    if (isReplicateApiError(error)) {
      const status = error.response.status;
      switch (status) {
        case 402:
          return new Response('Monthly spend limit reached.', { status: 402 });
        case 429:
          return new Response('Rate limit reached. Please try again later.', { status: 429 });
        default:
          return new Response('API error occurred', { status: status });
      }
    }
    console.error('Unexpected error:', error);
    return new Response('An unexpected error occurred', { status: 500 });
  }
};

const handleReplicateWebhook = async (request: Request, env: Env) => {
  const rawBody = await request.text();
  const valid = await validateWebhook(new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody
  }), env.REPLICATE_WEBHOOK_SIGNING_KEY);
  if (!valid) {
    return new Response('Invalid webhook signature', { status: 401 });
  }
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const slug = url.searchParams.get('slug');
  if (!date || !slug) {
    return new Response('Missing blog post date or slug', { status: 400 });
  }
  const payload: ReplicatePrediction = JSON.parse(rawBody)
  if (!Array.isArray(payload.output)) {
    return new Response('Invalid output format', { status: 400 });
  }
  const uploadPromises = payload.output.map(async (output, index) => {
    const imageBody = await fetch(output).then(r => r.arrayBuffer());
    const fileExtension = output.split('.').pop() || 'webp';
    const fileName = `sandbox/${date}-${slug}/${payload.id}_${index}.${fileExtension}`;
    return env.PORTFOLIO_BUCKET.put(fileName, imageBody);
  });
  await Promise.all(uploadPromises);
  return new Response('OK', { status: 200 });
};

interface R2EventMessage {
  account: string;
  bucket: string;
  eventTime: string;
  action: 'PutObject' | 'DeleteObject' | 'CopyObject';
  object: {
    key: string;
    size: number;
    eTag: string;
  };
  copySource?: {
    bucket: string;
    object: string;
  };
}

interface Message<Body = unknown> {
  readonly id: string;
  readonly timestamp: Date;
  readonly body: Body;
  readonly attempts: number;
  ack(): void;
  retry(options?: QueueRetryOptions): void;
}

interface MessageBatch<Body = unknown> {
  readonly queue: string;
  readonly messages: Message<Body>[];
  ackAll(): void;
  retryAll(options?: QueueRetryOptions): void;
}

async function commitToGitHub(
  filePath: string,
  content: string,
  message: string,
  env: Env
): Promise<void> {
  const query = `
    mutation CreateCommitOnBranch($input: CreateCommitOnBranchInput!) {
      createCommitOnBranch(input: $input) {
        commit {
          url
        }
      }
    }
  `;

  const variables = {
    input: {
      branch: {
        repositoryNameWithOwner: 'arunsathiya/portfolio',
        branchName: 'main'
      },
      message: {
        headline: message,
        body: `Commit created by github-actions[bot]\n\nCo-authored-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>`
      },
      fileChanges: {
        additions: [{
          path: filePath,
          contents: content
        }]
      },
      expectedHeadOid: await getLatestCommitOid(env)
    }
  };

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Cloudflare-Worker'
    },
    body: JSON.stringify({
      query,
      variables
    })
  });

  if (!response.ok) {
    throw new Error(`GitHub API error: ${await response.text()}`);
  }

  const result = await response.json();
  if (result.errors) {
    throw new Error(`GraphQL Error: ${JSON.stringify(result.errors)}`);
  }
}

async function getLatestCommitOid(env: Env): Promise<string> {
  const query = `
    query GetLatestCommit {
      repository(owner: "arunsathiya", name: "portfolio") {
        defaultBranchRef {
          target {
            oid
          }
        }
      }
    }
  `;

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_PAT}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Cloudflare-Worker'
    },
    body: JSON.stringify({ query })
  });

  const result = await response.json();
  return result.data.repository.defaultBranchRef.target.oid;
}

interface NotionWebhookPayload {
  source: {
    type: 'automation';
    automation_id: string;
    action_id: string;
    event_id: string;
    attempt: number;
  };
  data: {
    object: 'page';
    id: string;
    created_time: string;
    last_edited_time: string;
    parent: {
      type: 'database_id';
      database_id: string;
    };
    properties: Record<string, any>;
    url: string;
    request_id: string;
  };
}

function formatDate(dateString: string): string {
	const date = new Date(dateString);
	const month = date.toLocaleString('default', { month: 'short', timeZone: 'UTC' });
	const day = date.getUTCDate().toString().padStart(2, '0');
	const year = date.getUTCFullYear();
	return `${month} ${day} ${year}`;
}

function formatDateForFolder(dateString: string): string {
	return new Date(dateString).toISOString().split('T')[0];
}

type NotionClient = InstanceType<typeof Client>;
type UpdateBlockParameters = Parameters<NotionClient['blocks']['update']>[0];

function isTextRichTextItem(item: RichTextItemResponse): item is TextRichTextItemResponse {
	return item.type === 'text';
}

function isParagraphBlock(block: BlockObjectResponse | PartialBlockObjectResponse): block is BlockObjectResponse & { type: 'paragraph' } {
	return 'type' in block && block.type === 'paragraph';
}

import { Client } from '@notionhq/client';

async function processPage(page: PageObjectResponse, env: Env) {
  const notion = new Client({ auth: env.NOTION_TOKEN });
  const n2m = new NotionToMarkdown({ notionClient: notion });

  const mdblocks = await n2m.pageToMarkdown(page.id);

  // Extract page properties
  const title = page.properties.Title.type === 'title' && page.properties.Title.title.length > 1
    ? page.properties.Title.title.map((t) => t.plain_text.trim()).join(' ')
    : page.properties.Title.type === 'title'
      ? page.properties.Title.title[0]?.plain_text.trim()
      : 'Untitled';

  const slug = page.properties.Slug.type === 'formula' && page.properties.Slug?.formula?.type == 'string'
    ? (page.properties.Slug.formula?.string as string)
    : '';

  const description = page.properties.Description.type === 'rich_text'
    ? page.properties.Description.rich_text[0]?.plain_text.trim()
    : '';

  // Process images in the markdown blocks
  for (let i = 0; i < mdblocks.length; i++) {
    const block = mdblocks[i];
    if (block.type === 'image') {
      const imageUrl = block.parent.match(/\((.*?)\)/)?.[1];
      if (imageUrl) {
        try {
          const blockId = block.blockId || `fallback-${i}`;
          const imageKey = `${slug}-${blockId}${new URL(imageUrl).pathname.split('.').pop()}`;
          const { signedUrl } = await uploadImage(imageUrl, slug, blockId, env);
          const blockObj = await notion.blocks.retrieve({ block_id: blockId }) as ImageBlockObjectResponse;
          const caption = blockObj.image?.caption[0]?.plain_text || '';
          mdblocks[i].parent = `<R2Image imageKey="assets/${imageKey}" alt="${caption}" />`;
        } catch (error) {
          console.error(`Failed to upload image: ${imageUrl}`, error);
        }
      }
    }
  }

  const mdString = n2m.toMarkdownString(mdblocks);
  const convertedMdString = mdString.parent.replace(/\[(embed|video)\]\((https?:\/\/\S+)\)/g, '$2');

  // Get dates
  const pubDate = page.properties.Date?.type === 'date' && page.properties.Date.date?.start
    ? formatDate(page.properties.Date.date.start)
    : formatDate(page.created_time);

  const updatedDate = formatDate(page.last_edited_time);

  // Get tags
  const tags = page.properties.Tags?.type === 'multi_select'
    ? page.properties.Tags.multi_select.map((tag) => tag.name)
    : [];

  // Get folder date
  const folderDate = page.properties.Date?.type === 'date' && page.properties.Date.date?.start
    ? formatDateForFolder(page.properties.Date.date.start)
    : formatDateForFolder(page.created_time);

  const postContainsImages = mdblocks.some((block) => block.parent.includes('R2Image'));

  const content = `---
title: "${title}"
seoTitle: "${title}"
slug: "${slug}"
description: "${description}"
pubDate: '${pubDate}'
updatedDate: '${updatedDate}'
tags: ${JSON.stringify(tags)}
coverImage: "./image.webp"
---

${postContainsImages ? `import R2Image from 'src/components/R2Image.astro';` : ''}

${convertedMdString.replace(/\n\n/g, '\n')}`;

  return {
    content,
    path: `src/content/blog/${folderDate}-${slug}/index.mdx`
  };
}

async function uploadImage(imageUrl: string, pageSlug: string, blockId: string): Promise<{ uploaded: boolean; signedUrl: string }> {
	try {
		const S3 = new S3Client({
			region: 'auto',
			endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID!,
				secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY!,
			},
		});

		// Generate a unique filename using blockId
		const filename = `${pageSlug}-${blockId}${path.extname(imageUrl.split('?')[0])}`;
		const key = `assets/${filename}`;

		// Check if the file already exists in the bucket
		try {
			const headCommand = new HeadObjectCommand({
				Bucket: env.R2_BUCKET_NAME!,
				Key: key,
			});
			await S3.send(headCommand);

			// If we reach here, the file exists. Generate and return a signed URL.
			console.log('Image already exists in the bucket. Generating signed URL.');
			const signedUrl = await getSignedUrlForObject(key);
			return { uploaded: false, signedUrl };
		} catch (error) {
			// If the file doesn't exist, we'll get an error. Proceed with upload.
			console.log('Image does not exist in the bucket. Proceeding with upload.');
		}

		// Download the image
		const response = await fetch(imageUrl, {
			headers: {
				Accept: 'image/*',
			},
		});
		if (!response.ok) {
			throw new Error(`HTTP error! status: ${response.status}`);
		}
		const buffer = await response.arrayBuffer();

		// Upload to R2
		const uploadCommand = new PutObjectCommand({
			Bucket: env.R2_BUCKET_NAME!,
			Key: key,
			Body: Buffer.from(buffer),
			ContentType: response.headers.get('content-type') || 'image/png',
		});

		const result = await S3.send(uploadCommand);

		if (result.$metadata.httpStatusCode !== 200) {
			throw new Error(`Upload failed with status code: ${result.$metadata.httpStatusCode}`);
		}

		// Generate a signed URL
		const signedUrl = await getSignedUrlForObject(key);

		console.log('Upload successful. Signed URL:', signedUrl);
		return { uploaded: true, signedUrl };
	} catch (error) {
		console.error('Error uploading image to R2:', error);
		if (error instanceof Error) {
			console.error('Error message:', error.message);
			console.error('Error stack:', error.stack);
		}
		throw error;
	}
}

async function getSignedUrlForObject(key: string): Promise<string> {
	const getObjectCommand = new GetObjectCommand({
		Bucket: env.R2_BUCKET_NAME!,
		Key: key,
	});

	return getSignedUrl(S3, getObjectCommand, { expiresIn: 3600 }); // URL expires in 1 hour
}

interface NotionWebhookPayload {
  source: {
    type: 'automation';
    automation_id: string;
    action_id: string;
    event_id: string;
    attempt: number;
  };
  data: {
    object: 'page';
    id: string;
    created_time: string;
    last_edited_time: string;
    parent: {
      type: 'database_id';
      database_id: string;
    };
    properties: Record<string, any>;
    url: string;
    request_id: string;
  };
}

// Type guard to check if a message is a Notion webhook payload
function isNotionWebhookPayload(payload: any): payload is NotionWebhookPayload {
  return payload
    && 'data' in payload
    && 'id' in payload.data
    && 'parent' in payload.data
    && 'database_id' in payload.data.parent;
}

// Type guard for R2 event
function isR2Event(payload: any): payload is R2EventMessage {
  return payload && 'action' in payload && 'object' in payload;
}

// Helper function to process Notion webhooks
async function processNotionWebhook(payload: NotionWebhookPayload, env: Env) {
  const pageId = payload.data.id;
  const databaseId = payload.data.parent.database_id;

  if (databaseId !== env.NOTION_DATABASE_ID) {
    console.log('Ignoring webhook - not from target database');
    return;
  }

  const notion = new Client({ auth: env.NOTION_TOKEN });
  const page = await notion.pages.retrieve({ page_id: pageId });

  const { content, path } = await processPage(page as PageObjectResponse, env);

  await commitToGitHub(
    path,
    content,
    `chore: update ${path.split('/').pop()?.split('.')[0]} from Notion`,
    env
  );

  console.log('Successfully processed Notion webhook for page:', pageId);
}

// Helper function to process R2 events
async function processR2Event(event: R2EventMessage, env: Env) {
  console.log('Processing R2 event:', {
    action: event.action,
    sourceKey: event.copySource?.object,
    destinationKey: event.object.key,
    size: event.object.size,
    eTag: event.object.eTag
  });

  const pathParts = event.object.key.split('/');
  if (pathParts.length >= 2) {
    const dateSlugPart = pathParts[1];
    const r2Object = await env.PORTFOLIO_BUCKET.get(event.object.key);

    if (r2Object === null) {
      throw new Error(`Object not found in R2: ${event.object.key}`);
    }

    const arrayBuffer = await r2Object.arrayBuffer();
    const base64Content = Buffer.from(arrayBuffer).toString('base64');
    const imagePath = `src/content/blog/${dateSlugPart}/image.webp`;

    await commitToGitHub(
      imagePath,
      base64Content,
      `chore: update cover image for ${dateSlugPart}`,
      env
    );

    console.log('Successfully processed image:', {
      r2Path: event.object.key,
      gitPath: imagePath,
      size: event.object.size
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const s3Client = createS3Client(env);

    if (url.pathname.startsWith('/assets/')) {
      return handleAssets(request, env, s3Client);
    }

    switch (url.pathname) {
      case '/api/generate-image':
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleImageGeneration(request, env);
      case '/api/dispatch':
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleGitHubDispatch(request, env);
      case '/webhooks/replicate':
        return handleReplicateWebhook(request, env);
			case '/webhooks/notion':
				const notionSignature = request.headers.get('X-Notion-Signature');
				if (!notionSignature || notionSignature !== `Bearer ${env.NOTION_SIGNATURE_SECRET}`) {
					return new Response('Unauthorized', { status: 401 });
				}
				const payload = await request.json() as NotionWebhookPayload;
				await env.NOTION_QUEUE.send(payload);
				return new Response(JSON.stringify({
					status: 'accepted',
					message: 'Webhook received and queued for processing'
				}), {
					status: 200,
					headers: { 'Content-Type': 'application/json' }
				});
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
	async queue(batch: MessageBatch, env: Env, ctx: ExecutionContext): Promise<void> {
    for (const message of batch.messages) {
      try {
        const payload = message.body;

        // Handle Notion webhook messages
        if (isNotionWebhookPayload(payload)) {
          await processNotionWebhook(payload, env);
          message.ack();
          continue;
        }

        // Handle R2 events
        if (isR2Event(payload) && payload.action === 'CopyObject' && payload.object.key.endsWith('image.webp')) {
          await processR2Event(payload, env);
          message.ack();
          continue;
        }

        // Unknown message type
        console.warn('Unknown message type received:', payload);
        message.ack();

      } catch (error) {
        console.error('Error processing message:', error);
        if (message.attempts < 3) {
          message.retry({
            delaySeconds: Math.pow(2, message.attempts) // 2s, 4s, 8s
          });
        } else {
          console.error(`Failed to process message after ${message.attempts} attempts:`, message.body);
          message.ack();
        }
      }
    }
  }
} satisfies ExportedHandler<Env>;
