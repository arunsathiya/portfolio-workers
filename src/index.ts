import { GetObjectCommand, RequestProgress, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import Replicate, { validateWebhook } from "replicate";
import Anthropic from "@anthropic-ai/sdk";

interface Env {
	CLOUDFLARE_ACCOUNT_ID: string;
	R2_BUCKET_NAME: string;
	CLOUDFLARE_R2_ACCESS_KEY_ID: string;
	CLOUDFLARE_R2_SECRET_ACCESS_KEY: string;
	REPLICATE_WEBHOOK_SIGNING_KEY: string;
	REPLICATE_API_TOKEN: string;
	IMAGE_GENERATION_SECRET: string;
	IMAGE_GENERATION_BASE_PROMPT: string;
	BlogAssets: KVNamespace,
	PORTFOLIO_BUCKET: R2Bucket,
	ANTHROPIC_API_KEY: string;
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

const createS3Client = (env: Env) => new S3Client({
	region: 'auto',
	endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
	credentials: {
		accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
		secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
	},
});

const handleCDNRequest = async (request: Request, env: Env, s3Client: S3Client) => {
	const url = new URL(request.url);
	const key = url.pathname.slice(5);
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
	const basePrompt = env.IMAGE_GENERATION_BASE_PROMPT
	if (!basePrompt) {
		throw new Error('IMAGE_GENERATION_BASE_PROMPT not found in environment variables');
	}
	const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
	const msg = await anthropic.messages.create({
		model: "claude-3-5-sonnet-20240620",
		max_tokens: 1000,
		temperature: 0,
		system: "reply only with the generated prompt and nothing else",
		messages: [{
			"role": "user",
			"content": [{
				"type": "text",
				"text": `this is the prompt I have for the attached image:\n\n${basePrompt}\n\ncan you generate a similar prompt with creative materials relating to the blog post titled "${title}"?`
			}]
		}]
	});
	return msg.content[0].type === "text" ? msg.content[0].text : "";
};

const handleImageGeneration = async (request: Request, env: Env) => {
	const url = new URL(request.url);
	const authToken = request.headers.get('Authorization');
	if (!authToken || authToken !== `Bearer ${env.IMAGE_GENERATION_SECRET}`) {
		return new Response('Missing authorization header', { status: 401 });
	}

	let data: Record<string, string>;
	const contentType = request.headers.get('content-type');

	if (contentType?.includes('application/json')) {
		try {
			data = await request.json();
		} catch (error) {
			return new Response('Invalid JSON', { status: 400 });
		}
	} else if (contentType?.includes('application/x-www-form-urlencoded')) {
		const formData = await request.formData();
		data = Object.fromEntries(formData) as Record<string, string>;
	} else {
		return new Response('Unsupported input', { status: 415 });
	}

	if (typeof data !== 'object' || data === null) {
		return new Response('Invalid data format', { status: 400 });
	}

	const { title, date, slug } = data;
	if (!title || !date || !slug) {
		return new Response('Missing required parameters', { status: 400 });
	}

	const prompt = await generateImagePrompt(title, env);
	const replicate = new Replicate({ auth: env.REPLICATE_API_TOKEN });
	const callbackUrl = `https://www.arun.blog/webhooks/replicate?date=${date}&slug=${slug}`;

	const output = await replicate.predictions.create({
		model: "black-forest-labs/flux-schnell",
		input: { prompt, num_outputs: 4, aspect_ratio: "16:9" },
		webhook: callbackUrl,
		webhook_events_filter: ["completed"]
	});

	console.log('Replicate output:', output);
	return new Response(`Requested image generation for ${title}`, { status: 200 });
};

const handleReplicateWebhook = async (request: Request, env: Env) => {
	const url = new URL(request.url);
	const date = url.searchParams.get('date');
	const slug = url.searchParams.get('slug');
	if (!date || !slug) {
		return new Response('Missing blog post date or slug', { status: 400 });
	}

	const payload: ReplicatePrediction = await request.json();
	for (const output of payload.output) {
		const imageBody = await fetch(output).then(r => r.arrayBuffer());
		await env.PORTFOLIO_BUCKET.put(
			`blog/sandbox/${date}-${slug}/${payload.id}.${output.split('.').pop()}`,
			imageBody
		);
	}
	return new Response('OK', { status: 200 });
};

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		const s3Client = createS3Client(env);

		if (url.pathname.startsWith('/cdn/')) {
			return handleCDNRequest(request, env, s3Client);
		}

		switch (url.pathname) {
			case '/api/generate-image':
				if (request.method !== 'POST') {
					return new Response('Method not allowed', { status: 405 });
				}
				return handleImageGeneration(request, env);
			case '/webhooks/replicate':
				if (request.method !== 'POST') {
					return new Response('Method not allowed', { status: 405 });
				}
				return handleReplicateWebhook(request, env);
			default:
				return new Response('Not Found', { status: 404 });
		}
	},
} satisfies ExportedHandler<Env>;