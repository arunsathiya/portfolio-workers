import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Replicate, { ApiError, validateWebhook } from 'replicate';
import Anthropic from "@anthropic-ai/sdk";

import { Buffer } from 'node:buffer';

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
  GITHUB_PAT: string;
}

interface CachedSignedUrl {
  url: string;
  refreshTime: number;
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
      "Date slug combo frontmatter": {
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
					"text": `This is the prompt I have for the attached image:\n\n${basePrompt}\n\nCan you generate a similar prompt with creative materials relating to the blog post titled "${title}", but with a darker background? Dark background doesn't necessarily have to be black, blue or purple. It can be any dark color. Aim to match the same font styling as in the base prompt.`,
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

    // Extract required fields
    const dateSlugCombo = latestPage.properties["Date slug combo frontmatter"].formula.string;
    const titleElements = latestPage.properties.Title.title.map(t => t.plain_text.trim());
    const title = titleElements.length > 0 ? titleElements.join('') : 'Untitled';

    // Extract date and slug from dateSlugCombo
    const [date, ...slugParts] = dateSlugCombo.split('-');
    const slug = slugParts.join('-');

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

const handleGitHubWorkflow = async (request: Request, env: Env) => {
  const authToken = request.headers.get('Authorization');
  if (!authToken || authToken !== `Bearer ${env.IMAGE_GENERATION_SECRET}`) {
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    // Fetch latest from Notion
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

    // Extract fields
    const dateSlugCombo = latestPage.properties["Date slug combo frontmatter"].formula.string;
    const titleElements = latestPage.properties.Title.title.map(t => t.plain_text.trim());
    const title = titleElements.length > 0 ? titleElements.join('') : 'Untitled';

    // Trigger GitHub workflow
    const workflowDispatch: GitHubWorkflowDispatch = {
      ref: 'main',
      inputs: {
        commit_message: title,
        date_slug_combo: dateSlugCombo
      }
    };

    const githubResponse = await fetch(
      `https://api.github.com/repos/arunsathiya/portfolio/actions/workflows/cover-image.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/vnd.github+json',
          'Authorization': `Bearer ${env.GITHUB_PAT}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'Content-Type': 'application/json',
          'User-Agent': 'Cloudflare-Worker'
        },
        body: JSON.stringify(workflowDispatch)
      }
    );

    if (!githubResponse.ok) {
      throw new Error(`GitHub API error: ${githubResponse.statusText}`);
    }

    return new Response(JSON.stringify({
      date_slug_combo: dateSlugCombo,
      title,
      status: 'GitHub workflow triggered'
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

const handleReplicateWebhook = async (request: Request, env: Env) => {
	const valid = await validateWebhook(request, env.REPLICATE_WEBHOOK_SIGNING_KEY);
	if (!valid) {
		return new Response('Invalid webhook signature', { status: 401 });
	}
  const url = new URL(request.url);
  const date = url.searchParams.get('date');
  const slug = url.searchParams.get('slug');
  if (!date || !slug) {
    return new Response('Missing blog post date or slug', { status: 400 });
  }

  const payload: ReplicatePrediction = await request.json();
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
      case '/api/trigger-github-workflow':
        if (request.method !== 'POST') {
          return new Response('Method not allowed', { status: 405 });
        }
        return handleGitHubWorkflow(request, env);
      case '/webhooks/replicate':
        return handleReplicateWebhook(request, env);
      default:
        return new Response('Not Found', { status: 404 });
    }
  },
} satisfies ExportedHandler<Env>;
