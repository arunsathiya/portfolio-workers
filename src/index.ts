/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const s3Client = new S3Client({
			region: 'auto',
			endpoint: `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
			credentials: {
				accessKeyId: env.CLOUDFLARE_R2_ACCESS_KEY_ID,
				secretAccessKey: env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
			},
		});
		const url = new URL(request.url);
		let blogPostDate: string | null = null;
		let blogPostSlug: string | null = null;
		let authToken: string | null = null;
		let shortBlogPostTitleForPromptGeneration: string | null = null;
		switch (url.pathname) {
			case '/cdn/':
				const key = url.pathname.slice(5);
				console.log('Key:', key);
				try {
					let cache = await env.BlogAssets.get<CachedSignedUrl>(key, `json`);
					let signedUrl: string;
					if (!cache || Date.now() > cache.refreshTime) {
						const command = new GetObjectCommand({
							Bucket: env.R2_BUCKET_NAME,
							Key: key,
						});
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
			case '/api/generate-image':
				if (request.method !== 'POST') {
					return new Response('Method not allowed', { status: 405 });
				}
				authToken = request.headers.get('Authorization');
				if (!authToken || authToken !== `Bearer ${env.IMAGE_GENERATION_SECRET}`) {
					return new Response('Missing authorization header', { status: 401 });
				}
				shortBlogPostTitleForPromptGeneration = url.searchParams.get('shortBlogPostTitleForPromptGeneration');
				if (!shortBlogPostTitleForPromptGeneration) {
					return new Response('Missing short blog post title for prompt generation', { status: 400 });
				}
				const anthropic = new Anthropic({
					apiKey: env.ANTHROPIC_API_KEY,
				})
				const msg = await anthropic.messages.create({
					model: "claude-3-5-sonnet-20240620",
					max_tokens: 1000,
					temperature: 0,
					system: "reply only with the generated prompt and nothing else",
					messages: [
						{
							"role": "user",
							"content": [
								{
									"type": "text",
									"text": `this is the prompt I have for the attached image:\n\nWatercolor style image on a textured white paper background. In the center, elegant hand-lettered text reads 'POSHMARK ALGORITHM REVEALED' in a deep purple color with a slight watercolor bleed effect. Surrounding the text, soft watercolor illustrations represent key aspects of the algorithm: a magnifying glass (for search), a clock face (for timing of shares), a golden trophy (for Poshmark Ambassador status), and a stylized feed icon (for feed visibility). Use a muted color palette with purple, teal, gold, and soft pink tones. The watercolor elements should have gentle color gradients and subtle bleeding effects, with some areas of the white paper showing through. Add a few splatter effects in the background for texture. In the bottom right corner, a small graph with a rising trend line painted in a loose, artistic style.\n\ncan you generate a similar prompt with creative materials relating to the blog post titled \"${shortBlogPostTitleForPromptGeneration}"?`
								}
							]
						}
					]
				});
				blogPostDate = url.searchParams.get('blogPostDate');
				blogPostSlug = url.searchParams.get('blogPostSlug');
				if (!blogPostDate || !blogPostSlug) {
					return new Response('Missing blog post date or slug', { status: 400 });
				}
				const replicate = new Replicate({
					auth: env.REPLICATE_API_TOKEN,
				});
				const input = {
					prompt: msg.content[0].type == "text" ? msg.content[0].text : "",
					num_outputs: 2,
					aspect_ratio: "16:9",
				}
				const callbackUrl = `https://www.arun.blog/webhooks/replicate/?blogPostDate=${blogPostDate}&blogPostSlug=${blogPostSlug}`;
				const output = await replicate.predictions.create({
					model: "black-forest-labs/flux-schnell",
					input: input,
					webhook: callbackUrl,
					webhook_events_filter: ["completed"]
				})
				console.log('Replicate output:', output);
				return new Response(`Requested image generation for ${shortBlogPostTitleForPromptGeneration}`, { status: 200 });
			case '/webhooks/replicate/':
				if (request.method !== 'POST') {
					return new Response('Method not allowed', { status: 405 });
				}
				const payload: ReplicatePrediction = await request.json();
				blogPostDate = url.searchParams.get('blogPostDate');
				blogPostSlug = url.searchParams.get('blogPostSlug');
				if (!blogPostDate || !blogPostSlug) {
					return new Response('Missing blog post date or slug', { status: 400 });
				}
				for (const output of payload.output) {
					const imageBody = await fetch(output).then(r => r.arrayBuffer());
					await env.PORTFOLIO_BUCKET.put(`blog/sandbox/${blogPostDate}-${blogPostSlug}/${payload.id}.${output.split('.').pop()}`, imageBody);
				}
				return new Response('OK', { status: 200 });
			default:
				const response = await fetch(request);
				return new Response(response.body as BodyInit, {
					status: response.status,
					headers: response.headers,
				});
		}
	},
} satisfies ExportedHandler<Env>;